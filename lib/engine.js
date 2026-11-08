/**
 * 编排层：把「主人说话」「到点主动说」「界面里聊一句」三件事，统一成
 * 读状态 → 生成 → 落聊天记录 → 发 QQ → 更新心情/好感度 的流程。
 */
import {
  affectionLevel,
  dayKey,
  dayKeyOffset,
  ensureHome,
  getDay,
  inQuietHours,
  liveState,
  loadConfig,
  minutesOf,
  moodEmoji,
  moodWord,
  pickUnsharedEvent,
  readDiary,
  readSoul,
  renderLifeContext,
  markEventShared,
  saveConfig,
  saveSoul,
  writeJournal,
  zoned,
} from './life.js'
import {
  OWNER_KEY,
  addMemory,
  appendChat,
  changeAffection,
  changeMood,
  confirmMemory as confirmStoredMemory,
  countToday,
  deleteMemory,
  memoryMaintenance,
  mergeMemories as mergeStoredMemories,
  readChat,
  readMemories,
  readState,
  restoreMemory as restoreStoredMemory,
  touchMemories,
  touchOwner,
  touchProactive,
  updateState,
} from './store.js'
import { extractMemories, generateDiary, generateProactive, generateReply, relevantMemories, resolveModel, summarizeSession } from './mind.js'
import { beatJitter, humanDelay, sleepState } from './humanize.js'

import { MemoryIndex } from './embeddings.js'
import { randomUUID } from 'node:crypto'

const POSITIVE = ['开心', '高兴', '好', '喜欢', '笑', '顺利', '不错', '棒', '谢谢', '爱', '舒服', '完成', '放假', '期待', '好玩']
const NEGATIVE = ['累', '难过', '烦', '糟糕', '加班', '压力', '生气', '哭', '病', '疼', '失眠', '焦虑', '闷', '孤独']
const NEGATORS = ['不', '没', '别', '无', '非']

function sentiment(text) {
  const source = String(text ?? '')
  let score = 0
  for (const word of POSITIVE) {
    let from = 0
    for (let at = source.indexOf(word, from); at !== -1; at = source.indexOf(word, from)) {
      // 「不好」「没喜欢」「不太舒服」：否定词在紧邻 1–2 字内就把极性翻转。
      const before = source.slice(Math.max(0, at - 2), at)
      const negated = [...before].some((ch) => NEGATORS.includes(ch))
      score += negated ? -1 : 1
      from = at + word.length
    }
  }
  for (const word of NEGATIVE) {
    let from = 0
    for (let at = source.indexOf(word, from); at !== -1; at = source.indexOf(word, from)) {
      const before = source.slice(Math.max(0, at - 2), at)
      const negated = [...before].some((ch) => NEGATORS.includes(ch))
      score += negated ? 1 : -1
      from = at + word.length
    }
  }
  return Math.max(-2, Math.min(2, score))
}

function publicConfig(cfg) {
  return {
    ...cfg,
    qq: {
      ...cfg.qq,
      appSecret: '',
      accessToken: '',
      hasAppSecret: Boolean(cfg.qq.appSecret),
      hasSecret: Boolean(cfg.qq.appSecret),
      hasToken: Boolean(cfg.qq.accessToken),
      ownerBound: Boolean(cfg.qq.ownerId),
    },
  }
}

function nextBeat(cfg, z) {
  const times = cfg?.heartbeat?.times ?? []
  if (!cfg?.heartbeat?.enabled || times.length === 0) return null
  const now = z.hour * 60 + z.minute
  const future = times.find((time) => (minutesOf(time) ?? 0) > now)
  if (future) return `${z.key} ${future}`
  return `${dayKeyOffset(new Date(), cfg.timezone, 1)} ${times[0]}`
}

export class Engine {
  constructor({ ctx, root, qq, store = null, log, humanize = null } = {}) {
    this.ctx = ctx
    this.root = root
    this.qq = qq
    this.store = store
    this.log = typeof log === 'function' ? log : () => {}
    this.humanize = humanize
    this.memoryIndex = new MemoryIndex({ root, log: this.log })
    this.queue = Promise.resolve()
    this.generating = false
  }

  /** 串行化生成，避免两条 QQ 消息同时进来时互相覆盖状态。 */
  serial(task) {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  async load() {
    const cfg = await loadConfig(this.root)
    const state = await readState(this.root, cfg)
    const soul = await readSoul(this.root, cfg.callYou)
    return { cfg, state, soul }
  }

  async recall(cfg, query, limit = 10, owner = 'owner') {
    const list = await readMemories(this.root, owner)
    let picked = null
    try {
      picked = await this.memoryIndex.search(list, query, limit, { cfg })
    } catch (error) {
      this.log(`[companion] 语义记忆检索失败，回退关键词：${error?.message ?? error}`)
    }
    if (!Array.isArray(picked)) picked = relevantMemories(list, query, limit)
    if (picked.length > 0) {
      void touchMemories(this.root, picked.map((item) => item.id)).catch(() => {})
    }
    return picked
  }

  async chatContext(cfg, limit = 12) {
    if (this.store) {
      try {
        const chat = await this.store.history(limit)
        if (Array.isArray(chat)) return chat
      } catch (error) {
        this.log(`[companion] 读取 DSH 会话失败，退回旧记录：${error?.message ?? error}`)
      }
    }
    return readChat(this.root, limit)
  }

  async handleOwnerMessage({ text, channel = 'qq', userId = '', eventId = '', receivedAt = Date.now() }) {
    const message = String(text ?? '').trim()
    if (!message) return { ok: false, error: '消息为空' }
    const received = Number(receivedAt) || Date.now()
    const cfg0 = await loadConfig(this.root)
    const z0 = zoned(new Date(received), cfg0.timezone)
    // 作息门控：凌晨她该在睡觉。主人的话头存起来早上补；访客直接不回（已读不睡）。
    if (channel === 'qq' && sleepState(z0.clock).asleep) {
      const isOwnerMsg = !cfg0.qq.ownerId || String(userId) === String(cfg0.qq.ownerId)
      if (isOwnerMsg) {
        await updateState(this.root, cfg0, {
          pendingWake: { text: message.slice(0, 500), at: received, channel },
        })
        this.log(`[companion] 凌晨收到消息，她睡着没回（${z0.clock}）`)
      } else {
        this.log(`[companion] 凌晨收到访客消息，不回（${z0.clock}）`)
      }
      return { ok: true, held: true, heldReason: 'asleep', heldUntil: sleepState(z0.clock).wakeAt }
    }
    // 访客分流：主人之外的 QQ 用户。guests.enabled 开着才理；独立命名空间。
    const isOwner = channel === 'ui' || !cfg0.qq.ownerId || String(userId) === String(cfg0.qq.ownerId)
    if (!isOwner) {
      if (!cfg0.guests?.enabled) return { ok: false, error: '不是主人，忽略' }
      return this.handleGuestMessage({ text: message, userId: String(userId), eventId, receivedAt: received })
    }
    return this.serial(async () => {
      const { cfg, state, soul } = await this.load()
      if (channel === 'qq' && cfg.qq.ownerId && userId && String(userId) !== String(cfg.qq.ownerId)) {
        return { ok: false, error: '不是主人，忽略' }
      }


      const recentMessages = Math.max(2, Math.min(60, Number(cfg.memory.recentMessages) || 12))
      const chat = await this.chatContext(cfg, recentMessages)
      const lifeText = await renderLifeContext(this.root, cfg)
      const memories = await this.recall(cfg, message, cfg.memory.maxInjected)
      const now = Date.now()

      let sessionTurn = null
      if (this.store) {
        try {
          sessionTurn = await this.store.beginTurn({
            userText: message,
            channel: channel === 'ui' ? 'ui' : 'qq',
            rpcId: channel === 'ui' ? `ui:${randomUUID()}` : `qq:${eventId || now}`,
          })
        } catch (error) {
          this.log(`[companion] 写入 DSH 会话失败，退回旧记录：${error?.message ?? error}`)
        }
      }
      if (!sessionTurn) {
        await appendChat(this.root, { role: 'owner', text: message, channel: channel === 'ui' ? 'ui' : 'qq', at: now })
      }
      await touchOwner(this.root, cfg, now)
      const moodDelta = Math.max(-0.25, Math.min(0.25, sentiment(message) * 0.1 + 0.05))
      await changeMood(this.root, cfg, moodDelta)
      await changeAffection(this.root, cfg, 0.35 + Math.min(0.3, message.length / 300) + 0.12, '他来找你说话，回了他一句')

      let reply
      try {
        reply = await generateReply(this.ctx, { cfg, soul, lifeText, state, memories, chat, ownerText: message, channel })
      } catch (error) {
        // 生成失败也要把主人的话留在记录里，并把错误交给界面。
        if (sessionTurn) {
          try { await this.store.abortTurn(sessionTurn) } catch { /* 会话已被卸载 */ }
        }
        return { ok: false, error: String(error?.message ?? error) }
      }

      if (sessionTurn) {
        try {
          await this.store.finishTurn(sessionTurn, reply, { model: resolveModel(this.ctx, cfg) })
        } catch (error) {
          this.log(`[companion] 保存回复到 DSH 会话失败：${error?.message ?? error}`)
        }
      } else {
        await appendChat(this.root, { role: 'her', text: reply, channel: channel === 'ui' ? 'ui' : 'qq', at: Date.now() })
      }
      // QQ 被动回复窗口约 5 分钟；队列积压时等不起，超时的回复降级成主动消息。
      const stale = channel === 'qq' && Boolean(eventId) && now - received > 4 * 60_000
      if (stale) this.log('[companion] 回复生成时被动窗口已超时，改走主动消息额度')
      const delivery = await this.deliver(reply, cfg, channel === 'qq' ? 'qq' : 'ui', { replyTo: stale ? '' : eventId, clock: zoned(new Date(), cfg.timezone).clock, mood: state.mood, energy: state.energy })

      if (cfg.memory.autoExtract) {
        void this.extract(cfg, message, reply)
      }

      const next = await readState(this.root, cfg)
      return { ok: true, reply, delivery, state: this.stateView(next, cfg) }
    })
  }

  async extract(cfg, ownerText, replyText) {
    try {
      const items = await extractMemories(this.ctx, { cfg, ownerText, replyText })
      for (const item of items) await addMemory(this.root, item)
    } catch { /* 记忆提取失败不影响聊天 */ }
  }

  /** 访客消息：独立记忆/聊天命名空间，不动主人状态与 DSH 会话。 */
  async handleGuestMessage({ text, userId, eventId = '', receivedAt = Date.now() }) {
    return this.serial(async () => {
      const cfg = await loadConfig(this.root)
      const guestKey = `guest:${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}`
      // 访客限频：当天超过 maxPerDay 就只回一句客气的「今天聊得够多了」。
      const today = new Date()
      const dayKeyNow = dayKey(today, cfg.timezone)
      const state = await readState(this.root, cfg)
      const guests = state.guests ?? {}
      const guestCount = guests[guestKey]?.date === dayKeyNow ? (guests[guestKey].count || 0) : 0
      if (guestCount >= (Number(cfg.guests?.maxPerDay) || 40)) {
        const capped = await this.deliver('今天说得有点多了，改天聊。', cfg, 'qq', { replyTo: eventId, targetId: userId })
        return { ok: true, capped: true, delivery: capped, guest: true }
      }
      const nextGuests = { ...guests, [guestKey]: { date: dayKeyNow, count: guestCount + 1 } }
      await updateState(this.root, cfg, { guests: nextGuests })
      const chat = await readChat(this.root, 30, guestKey)
      const soul = await readSoul(this.root, cfg.callYou)
      const lifeText = await renderLifeContext(this.root, cfg)
      const memories = await this.recall(cfg, text, cfg.memory.maxInjected, guestKey)

      let reply
      try {
        reply = await generateReply(this.ctx, { cfg, soul, lifeText, state, memories, chat, ownerText: text, channel: 'qq' })
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      await appendChat(this.root, { role: 'owner', text, channel: 'qq', at: receivedAt }, Date.now(), guestKey)
      await appendChat(this.root, { role: 'her', text: reply, channel: 'qq', at: Date.now() }, Date.now(), guestKey)
      if (cfg.guests?.extract) {
        void this.extractGuest(cfg, guestKey, text, reply)
      }
      const delivery = await this.deliver(reply, cfg, 'qq', { replyTo: eventId, targetId: userId, clock: zoned(new Date(), cfg.timezone).clock, mood: state.mood, energy: state.energy })
      return { ok: true, reply, delivery, guest: true }
    })
  }

  async extractGuest(cfg, guestKey, ownerText, replyText) {
    try {
      const items = await extractMemories(this.ctx, { cfg, ownerText, replyText })
      for (const item of items) {
        await addMemory(this.root, { ...item, owner: guestKey })
      }
    } catch { /* 记忆提取失败不影响聊天 */ }
  }

  async deliver(text, cfg, channel, options = {}) {
    if (channel === 'ui') return { ok: true, simulated: true, channel: 'ui' }
    if (!cfg.qq.enabled) return { ok: false, simulated: true, channel: 'qq', error: 'QQ 未启用' }
    const humanize = this.humanize !== null ? this.humanize : cfg.persona?.humanize !== false
    // 人工节奏：她不是生成完就发——像人在打字。睡眠窗口由调用方门控。
    const delay = humanDelay(text, {
      clock: options.clock ?? '',
      mood: options.mood ?? 0,
      energy: options.energy ?? 60,
      enabled: humanize,
    })
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const result = await this.qq.send(text, cfg, options)
    return { ...result, channel: 'qq', humanDelay: delay }
  }

  /** 主动说一句。force 用于界面按钮；preview 只生成不发送、不落记录。 */
  async proactive({ force = false, preview = false, beatKey = '', reason = 'manual', now = Date.now() } = {}) {
    return this.serial(async () => {
      if (this.generating) return { ok: false, skipped: true, reason: 'busy' }
      this.generating = true
      try {
        const { cfg, state, soul } = await this.load()
        const z = zoned(new Date(now), cfg.timezone)

        if (!force) {
          if (!cfg.heartbeat.enabled) {
            await updateState(this.root, cfg, { lastBeatKey: beatKey || state.lastBeatKey })
            return { ok: false, skipped: true, reason: 'heartbeat-disabled' }
          }
          if (inQuietHours(z.clock, cfg.heartbeat.quietStart, cfg.heartbeat.quietEnd)) {
            await updateState(this.root, cfg, { lastBeatKey: beatKey || state.lastBeatKey })
            return { ok: false, skipped: true, reason: 'quiet-hours' }
          }
          const gap = (now - (Number(state.lastProactiveAt) || 0)) / 60000
          if (gap < (Number(cfg.heartbeat.minGapMinutes) || 0)) {
            await updateState(this.root, cfg, { lastBeatKey: beatKey || state.lastBeatKey })
            return { ok: false, skipped: true, reason: 'min-gap' }
          }
          if ((Number(state.beatCount) || 0) >= (Number(cfg.heartbeat.maxPerDay) || 0)) {
            await updateState(this.root, cfg, { lastBeatKey: beatKey || state.lastBeatKey })
            return { ok: false, skipped: true, reason: 'daily-cap' }
          }
        }

        const day = await getDay(this.root, cfg, z.key)
        const lifeText = await renderLifeContext(this.root, cfg, new Date(now))
        const unshared = pickUnsharedEvent(day, z.clock)
        const recentMessages = Math.max(2, Math.min(60, Number(cfg.memory.recentMessages) || 12))
        const chat = await this.chatContext(cfg, recentMessages)
        const memories = await this.recall(cfg, '', cfg.memory.maxInjected)

        let result
        try {
          result = await generateProactive(this.ctx, { cfg, soul, lifeText, state, memories, chat, day, unshared, now })
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }

        if (result.skipped) {
          if (!preview) await updateState(this.root, cfg, { lastBeatKey: beatKey || state.lastBeatKey })
          return { ok: true, skipped: true, reason: 'she-chose-silence' }
        }

        if (preview) return { ok: true, text: result.text, preview: true, event: unshared ?? null }

        let sessionTurn = null
        if (this.store) {
          try {
            sessionTurn = await this.store.beginTurn({ channel: 'proactive', rpcId: 'proactive' })
          } catch (error) {
            this.log(`[companion] 写入 DSH 会话失败，退回旧记录：${error?.message ?? error}`)
          }
        }
        const delivery = await this.deliver(result.text, cfg, cfg.qq.enabled ? 'qq' : 'ui', { clock: z.clock, mood: state.mood, energy: state.energy })
        if (sessionTurn) {
          try {
            await this.store.finishTurn(sessionTurn, result.text, { model: resolveModel(this.ctx, cfg) })
          } catch (error) {
            this.log(`[companion] 保存主动消息到 DSH 会话失败：${error?.message ?? error}`)
          }
        } else {
          await appendChat(this.root, { role: 'her', text: result.text, channel: 'proactive', at: Date.now() })
        }
        const delivered = delivery.ok === true || delivery.simulated === true
        if (!delivered) {
          await updateState(this.root, cfg, { lastBeatKey: beatKey || state.lastBeatKey })
          const failed = await readState(this.root, cfg)
          return {
            ok: false,
            skipped: false,
            text: result.text,
            delivery,
            event: unshared ?? null,
            error: delivery.error || '发送失败',
            state: this.stateView(failed, cfg),
          }
        }
        if (unshared) await markShared(this.root, z.key, unshared.id)
        await touchProactive(this.root, cfg, beatKey || '', Date.now())
        await changeAffection(this.root, cfg, 0.08, '主动找他说了一句')

        const next = await readState(this.root, cfg)
        return {
          ok: true,
          skipped: false,
          text: result.text,
          delivery,
          event: unshared ?? null,
          state: this.stateView(next, cfg),
        }
      } finally {
        this.generating = false
      }
    })
  }

  async tick(now = Date.now()) {
    const { cfg, state } = await this.load()
    this.maybeWriteDiary(cfg, state, now)
    await this.maybeReplyPendingWake(cfg, state, now)
    if (!cfg.heartbeat.enabled) return
    const z = zoned(new Date(now), cfg.timezone)
    const nowMinutes = z.hour * 60 + z.minute
    const due = []
    for (const time of cfg.heartbeat.times) {
      const minutes = minutesOf(time)
      if (minutes === null) continue

      // 拟人抖动：每个心跳点在 ±12 分钟内有一个按日期确定的偏移；
      // 人不会每天都在同一分钟想起同一个人。
      const jitter = beatJitter(`${z.key} ${time}`)
      const diff = nowMinutes - (minutes + jitter)
      if (diff < 0 || diff > 12) continue
      const key = `${z.key} ${time}`
      if (key === state.lastBeatKey) continue
      due.push({ key, time, diff })
    }
    if (due.length === 0) return
    due.sort((a, b) => a.diff - b.diff)
    const beat = due[due.length - 1]
    await this.proactive({ force: false, beatKey: beat.key, reason: `heartbeat:${beat.time}`, now })
  }

  /**
   * 晨起补回：凌晨收到过消息（pendingWake），现在过了醒来时间，用
   * 「刚醒」的口吻补一条。清掉 pendingWake，避免重复。
   */
  async maybeReplyPendingWake(cfg, state, now = Date.now()) {
    const pending = state.pendingWake
    if (!pending?.text) return
    const z = zoned(new Date(now), cfg.timezone)
    const held = zoned(new Date(pending.at), cfg.timezone)
    const wake = sleepState(`${held.clock}`, pending.text)
    if (z.key !== held.key && z.hour >= 8) {
      // 已经是第二天早上：直接补。
    } else {
      const nowMinutes = z.hour * 60 + z.minute
      if (nowMinutes < wake.wakeAt) return
    }
    this.generating = true
    try {
      const { soul } = await this.load()
      const lifeText = await renderLifeContext(this.root, cfg)
      const memories = await this.recall(cfg, pending.text, cfg.memory.maxInjected)
      const reply = await generateReply(this.ctx, {
        cfg, soul, lifeText, state, memories, chat: [],
        ownerText: pending.text, channel: 'qq',
        hint: `（补回：他凌晨 ${held.clock} 发来这条，你当时在睡觉没看到。${sleepState(held.clock, pending.text).greeting}）`,
      })
      await updateState(this.root, cfg, { pendingWake: null })
      const clockNow = zoned(new Date(), cfg.timezone).clock
      await this.deliver(`${reply}`, cfg, 'qq', { clock: clockNow, mood: state.mood, energy: state.energy })
      this.log(`[companion] 早晨补回了凌晨的消息（${held.clock} → ${clockNow}）`)
    } catch (error) {
      this.log(`[companion] 补回凌晨消息失败：${error?.message ?? error}`)
    } finally {
      this.generating = false
    }
  }

  /** 晚间自动写一次日记：当天 21 点后、还没写、且当前没有别的生成在跑。 */
  maybeWriteDiary(cfg, state, now = Date.now()) {
    if (this.generating) return
    const z = zoned(new Date(now), cfg.timezone)
    if (z.hour < 21) return
    const diaryKey = `diary:${z.key}`
    if (state.lastDiaryKey === diaryKey) return
    this.generating = true
    void this.writeDiary()
      .then((result) => {
        if (result.ok) {
          // 成功或“今天已写过”都算完成；失败保留 retry 空间（不写 lastDiaryKey）。
          return updateState(this.root, cfg, { lastDiaryKey: diaryKey })
        }
        this.log(`[companion] 晚间日记生成失败：${result.error ?? '未知错误'}`)
      })
      .catch((error) => this.log(`[companion] 晚间日记异常：${error?.message ?? error}`))
      .finally(() => { this.generating = false })
  }

  async sayNow({ preview = false, force = true } = {}) {
    return this.proactive({ force, preview, reason: 'manual' })
  }

  async chatFromUi(text) {
    return this.handleOwnerMessage({ text, channel: 'ui' })
  }

  stateView(state, cfg) {
    const level = affectionLevel(state?.affection)
    return {
      mood: Math.round((Number(state?.mood) || 0) * 100) / 100,
      moodLabel: moodWord(Number(state?.mood) || 0),
      moodEmoji: moodEmoji(Number(state?.mood) || 0),
      energy: Math.round(Number(state?.energy) || 0),
      activity: state?.activity || '',
      affection: Math.round((Number(state?.affection) || 0) * 10) / 10,
      affectionLevel: level.label,
      affectionTone: level.tone,
      affectionHint: level.hint,
      note: state?.note || '',
      lastOwnerAt: state?.lastOwnerAt || 0,
      lastProactiveAt: state?.lastProactiveAt || 0,
      beatCount: state?.beatCount || 0,
      stats: state?.stats ?? {},
    }
  }

  async overview() {
    const { cfg, state, soul } = await this.load()
    const now = Date.now()
    const z = zoned(new Date(now), cfg.timezone)
    const day = await getDay(this.root, cfg, z.key)
    const live = await liveState(this.root, cfg, z, now)
    // 读取窗口放大到 400：聊天视图仍按 recentMessages 截断，但 countToday 需要覆盖全天。
    const countLimit = 400
    const [chat, fullChat] = await Promise.all([
      this.chatContext(cfg, Math.max(40, Number(cfg.memory.recentMessages) || 12)),
      this.chatContext(cfg, countLimit),
    ])
    const memories = await readMemories(this.root)
    const activeMemories = memories.filter((item) => item.status === 'active')
    const diary = await readDiary(this.root, z.key)
    const counts = countToday(fullChat, cfg, now)
    const session = this.store ? await this.store.status() : null
    const memoryIndex = await this.memoryIndex.status(activeMemories, cfg)
    const model = resolveModel(this.ctx, cfg)
    const stateView = this.stateView({ ...state, mood: live.mood, energy: live.energy, activity: live.activity }, cfg)
    return {
      ok: true,
      now: { key: z.key, weekday: z.weekday, clock: z.clock, timezone: cfg.timezone },
      config: publicConfig(cfg),
      persona: { name: cfg.name, callYou: cfg.callYou, soul },
      state: { ...stateView, mood: live.mood, energy: live.energy, activity: live.activity },
      today: {
        date: day.date,
        weather: day.weather,
        world: day.world,
        events: day.events,
        threads: Array.isArray(day.threads) ? day.threads : [],
      },
      chat,
      memories: {
        total: activeMemories.length,
        history: memories.length - activeMemories.length,
        recent: activeMemories.slice().sort((a, b) => b.at - a.at).slice(0, 8),
      },
      diary,
      qq: {
        ...this.qq.status(),
        enabled: cfg.qq.enabled,
        mode: cfg.qq.mode,
        appId: cfg.qq.appId,
        ownerId: cfg.qq.ownerId,
        ownerBound: Boolean(cfg.qq.ownerId),
        ownerBoundAt: cfg.qq.ownerBoundAt,
        bindCode: cfg.qq.bindCode,
        hasAppSecret: Boolean(cfg.qq.appSecret),
        hasSecret: Boolean(cfg.qq.appSecret),
        httpUrl: cfg.qq.httpUrl,
        wsUrl: cfg.qq.wsUrl,
        hasToken: Boolean(cfg.qq.accessToken),
      },
      heartbeat: {
        enabled: cfg.heartbeat.enabled,
        times: cfg.heartbeat.times,
        next: nextBeat(cfg, z),
        todayCount: Number(state.beatCount) || 0,
        maxPerDay: cfg.heartbeat.maxPerDay,
        quiet: inQuietHours(z.clock, cfg.heartbeat.quietStart, cfg.heartbeat.quietEnd),
      },
      model: model ? { ...model, resolved: true } : { resolved: false },
      counts,
      session,
      memoryIndex,
    }
  }

  async sessionStatus() {
    if (!this.store) return { available: false, id: '', title: '', live: false, error: '当前 profile 没有 sessionController' }
    return this.store.status()
  }

  async newSession() {
    if (!this.store) return { ok: false, error: '当前 profile 没有 sessionController' }
    const cfg = await loadConfig(this.root)
    let chat = null
    try {
      chat = await this.store.history(60)
    } catch (error) {
      this.log(`[companion] 新建会话前读取旧聊天失败：${error?.message ?? error}`)
    }
    if (Array.isArray(chat) && chat.length >= 4) {
      try {
        const items = await summarizeSession(this.ctx, { cfg, chat })
        for (const item of items) {
          await addMemory(this.root, {
            ...item,
            source: 'system',
            tags: ['session-summary'],
            durable: true,
          })
        }
        if (items.length > 0) this.log(`[companion] 轮换会话前写入了 ${items.length} 条情景记忆`)
      } catch (error) {
        this.log(`[companion] 轮换会话摘要失败（继续新建）：${error?.message ?? error}`)
      }
    }
    return this.store.newSession()
  }

  async saveConfig(patch) {
    const cfg = await saveConfig(this.root, patch)
    this.qq.configure(cfg)
    if (cfg.qq.enabled) {
      void this.qq.start(cfg).catch((error) => {
        this.log(`[companion] QQ 启动失败：${error?.message ?? error}`)
      })
    }
    return publicConfig(cfg)
  }

  /** 把发来绑定码的 OpenID 记成主人；绑定码同时轮换，旧码立即作废。 */
  async bindOwner(openId) {
    const ownerId = String(openId ?? '').trim()
    if (!ownerId) return { ok: false, error: 'OpenID 为空' }
    const current = await loadConfig(this.root)
    const cfg = await saveConfig(this.root, {
      qq: { ...current.qq, ownerId, ownerBoundAt: Date.now(), bindCode: '' },
    })
    this.qq.configure(cfg)
    if (cfg.qq.enabled) {
      void this.qq.start(cfg).catch((error) => {
        this.log(`[companion] QQ 启动失败：${error?.message ?? error}`)
      })
    }
    return { ok: true, config: publicConfig(cfg) }
  }

  async unbindOwner() {
    const current = await loadConfig(this.root)
    const cfg = await saveConfig(this.root, {
      qq: { ...current.qq, ownerId: '', ownerBoundAt: 0, bindCode: '' },
    })
    return { ok: true, config: publicConfig(cfg) }
  }

  async savePersona(soul) {
    await saveSoul(this.root, soul)
    return { ok: true }
  }

  async listMemories(query = '') {
    const all = await readMemories(this.root)
    const active = all.filter((item) => item.status === 'active')
    let picked = null
    if (query) {
      const cfg = await loadConfig(this.root)
      try {
        picked = await this.memoryIndex.search(active, query, 100, { cfg })
      } catch (error) {
        this.log(`[companion] 记忆页语义检索失败，回退关键词：${error?.message ?? error}`)
      }
      if (!Array.isArray(picked)) picked = relevantMemories(active, query, 100)
    } else {
      picked = active.slice().sort((a, b) => b.at - a.at)
    }
    return { ok: true, total: active.length, history: all.length - active.length, items: picked }
  }

  async createMemory(body) {
    const item = await addMemory(this.root, {
      text: body?.text,
      kind: body?.kind,
      importance: body?.importance,
      tags: body?.tags,
      source: 'manual',
    })
    if (!item) return { ok: false, error: '记忆内容为空' }
    return { ok: true, item }
  }

  async removeMemory(id) {
    const ok = await deleteMemory(this.root, id)
    return ok ? { ok: true } : { ok: false, error: '没有找到这条记忆' }
  }

  async maintenanceMemories() {
    const list = await readMemories(this.root)
    return { ok: true, ...memoryMaintenance(list) }
  }

  async confirmMemory(id, boost = false) {
    const item = await confirmStoredMemory(this.root, String(id ?? ''), { boost: boost === true })
    return item ? { ok: true, item } : { ok: false, error: '没有找到这条记忆' }
  }

  async mergeMemories(keepId, dropIds) {
    const item = await mergeStoredMemories(this.root, String(keepId ?? ''), Array.isArray(dropIds) ? dropIds : [])
    return item ? { ok: true, item } : { ok: false, error: '没有找到可合并的记忆' }
  }

  async restoreMemory(id) {
    const item = await restoreStoredMemory(this.root, String(id ?? ''))
    return item ? { ok: true, item } : { ok: false, error: '没有找到这条记忆' }
  }

  async getDiary(date) {
    const { cfg } = await this.load()
    const z = zoned(new Date(), cfg.timezone)
    const key = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? String(date) : z.key
    return { ok: true, date: key, text: await readDiary(this.root, key) }
  }

  async writeDiary({ force = false } = {}) {
    const { cfg, state, soul } = await this.load()
    const z = zoned(new Date(), cfg.timezone)
    const existing = await readDiary(this.root, z.key)
    if (existing && !force) return { ok: true, text: existing, existed: true }
    const day = await getDay(this.root, cfg, z.key)
    try {
      const text = await generateDiary(this.ctx, { cfg, soul, state, day })
      if (!text) return { ok: false, error: '她今天写不出来。' }
      await writeJournal(this.root, z, text)
      return { ok: true, text: await readDiary(this.root, z.key) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async setManualState(body) {
    return this.serial(async () => {
      const { cfg } = await this.load()
      const patch = {}
      if (typeof body?.mood === 'number') patch.mood = Math.max(-2, Math.min(2, body.mood))
      if (typeof body?.affection === 'number') patch.affection = Math.max(0, Math.min(100, body.affection))
      if (typeof body?.activity === 'string') patch.activity = body.activity.trim()
      if (typeof body?.note === 'string') patch.note = body.note.trim()
      const next = await updateState(this.root, cfg, patch)
      return { ok: true, state: this.stateView(next, cfg) }
    })
  }
}

async function markShared(root, key, id) {
  await markEventShared(root, key, id)
}

export { publicConfig, nextBeat, sentiment as __sentiment }

export const __internals = { sentiment, nextBeat, publicConfig, POSITIVE, NEGATIVE, NEGATORS }
