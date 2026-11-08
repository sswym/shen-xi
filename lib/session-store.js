/**
 * DSH Session 存储层：QQ 陪伴对话的权威记录。
 *
 * 不再把聊天写进插件自己的 chat.jsonl。每次 QQ/界面消息都：
 *   1. 取一个专用 DSH Session（`companion-qq-*`），它出现在 DSH 的会话列表里；
 *   2. 追加 turn/step + user/message + assistant/message 事件；
 *   3. 从 Session surface 读取最近消息给模型和陪伴页。
 *
 * 会话的删除/归档/重命名交给 DSH 自己；插件只保存“当前用哪一个 Session”的
 * 指针（session.json）。会话被删/归档后，下一次 ensure() 会换一个新的。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadConfig, readJson } from './life.js'

const POINTER_VERSION = 1
const POINTER_FILE = 'session.json'
const LEGACY_CHAT_FILE = 'chat.jsonl'
const LEGACY_ARCHIVE_FILE = 'chat.legacy.jsonl'
const LEGACY_IMPORT_LIMIT = 200
const MAX_TITLE = 120
// 会话存活校验：persistence.stat 直接读磁盘；list() 只作降级（它会把 attached 活体并进列表）。
// 缓存几秒，避免每轮消息都扫盘；DSH 的删除事件会立即清空缓存。
const LIVENESS_TTL = 10_000
const LIST_TIMEOUT = 8_000

function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function channelOfSource(source) {
  const rpcId = String(source?.rpcId ?? '')
  if (rpcId.startsWith('ui:')) return 'ui'
  if (rpcId.startsWith('proactive')) return 'proactive'
  if (rpcId.startsWith('qq:') || rpcId.startsWith('legacy:qq')) return 'qq'
  return 'ui'
}

function mintSessionId(ownerId) {
  const hash = createHash('sha1').update('companion:' + String(ownerId || 'owner')).digest('hex').slice(0, 8)
  return `companion-qq-${hash}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
}

function asTurnValue(event) {
  const turn = Number(event?.data?.turn)
  return Number.isInteger(turn) && turn > 0 ? turn : 0
}

export class SessionStore {
  constructor({ ctx, root, log, livenessTtlMs } = {}) {
    this.ctx = ctx
    this.root = root
    this.log = typeof log === 'function' ? log : () => {}
    this.session = null
    this.agent = null
    this.pointer = null
    this.nextTurn = 1
    this.ensuring = null
    this.adoptedAt = 0
    this.adopting = false
    this.livenessTtlMs = Number.isFinite(Number(livenessTtlMs)) ? Math.max(0, Number(livenessTtlMs)) : LIVENESS_TTL
    this.listedIds = null
    this.listedAt = 0
  }

  get pointerFile() {
    return join(this.root, POINTER_FILE)
  }

  controller() {
    try {
      return this.ctx?.get?.('sessionController') ?? this.ctx?.sessionController ?? null
    } catch {
      return null
    }
  }

  available() {
    const controller = this.controller()
    return Boolean(controller && typeof controller.create === 'function' && typeof controller.resolveAgent === 'function')
  }

  async loadPointer() {
    if (this.pointer) return this.pointer
    const raw = await readJson(this.pointerFile, {})
    this.pointer = {
      version: POINTER_VERSION,
      id: typeof raw?.id === 'string' ? raw.id : '',
      title: typeof raw?.title === 'string' ? raw.title : '',
      ownerId: typeof raw?.ownerId === 'string' ? raw.ownerId : '',
      nextTurn: Math.max(1, Number(raw?.nextTurn) || 1),
      titled: raw?.titled === true,
      migrated: raw?.migrated === true,
    }
    return this.pointer
  }

  async savePointer() {
    if (!this.pointer) return
    const file = this.pointerFile
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.pointer, null, 2) + '\n', 'utf8')
    await rename(tmp, file)
  }

  async ensure() {
    if (!this.available()) return null
    if (this.ensuring) return this.ensuring
    this.ensuring = this.doEnsure().finally(() => { this.ensuring = null })
    return this.ensuring
  }

  isArchived(id) {
    try {
      const registry = this.ctx?.get?.('workspaceRegistry') ?? null
      const list = registry?.archivedSessionIds
      return Array.isArray(list) && list.includes(id)
    } catch {
      return false
    }
  }

  /**
   * 会话是否仍在 DSH 的可见会话表里。
   *
   * 注意：list() 会把 attached 的活体会话并进来，所以它识别不了
   * “内存还活着、磁盘目录已被删除”的情况。这里只作为 persistence.stat
   * 不可用时的降级检查。列表读失败时返回 true，交给后续轮询。
   */
  async listed(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return false
    const controller = this.controller()
    if (!controller || typeof controller.list !== 'function') return true
    if (this.listedIds !== null && Date.now() - this.listedAt < this.livenessTtlMs) {
      return this.listedIds.has(id)
    }
    let signal
    try {
      signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(LIST_TIMEOUT)
        : undefined
    } catch {
      signal = undefined
    }
    try {
      const result = await controller.list({}, signal)
      const items = Array.isArray(result?.items) ? result.items : []
      const ids = new Set()
      for (const item of items) {
        const key = String(item?.sessionId ?? '')
        if (key) ids.add(key)
      }
      this.listedIds = ids
      this.listedAt = Date.now()
      return ids.has(id)
    } catch {
      return true
    }
  }

  /**
   * 持久化层里是否还有这个会话。
   *
   * list() 会把 attached 活体并进列表；inspect() 也优先返回内存对象。只有
   * sessionPersistence.stat(id) 是直接读磁盘的：目录被移走/删掉后返回 undefined。
   * 返回 null 表示无法判断（服务不存在或瞬时 IO 错误），调用方回退到 listed()。
   */
  async persisted(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return false
    let persistence = null
    try {
      persistence = this.ctx?.get?.('sessionPersistence') ?? null
    } catch {
      persistence = null
    }
    if (!persistence || typeof persistence.stat !== 'function') return null
    let options
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options = { signal: AbortSignal.timeout(LIST_TIMEOUT) }
      }
    } catch {
      options = undefined
    }
    try {
      const snapshot = await persistence.stat(id, options)
      return snapshot !== undefined
    } catch {
      return null
    }
  }

  /** 丢掉内存会话与指针；下一条消息/概览会重新 ensure。 */
  dropSession(reason = '') {
    const id = this.session?.id ?? this.pointer?.id ?? ''
    this.session = null
    this.agent = null
    this.nextTurn = 1
    this.listedIds = null
    this.listedAt = 0
    if (this.pointer) {
      this.pointer.id = ''
      this.pointer.titled = false
      this.pointer.nextTurn = 1
    }
    if (reason) this.log(`[companion] DSH 会话 ${id || '?'} ${reason}，下一条消息会新建会话`)
  }

  /** 当前内存会话是否仍然有效；无效时清空，交给 ensure 新建。 */
  async verifyCurrent() {
    if (!this.session) return false
    const id = this.session.id
    if (this.isArchived(id)) {
      this.dropSession('已被归档')
      return false
    }
    const persisted = await this.persisted(id)
    if (persisted === false) {
      this.dropSession('已从 DSH 持久化中消失（可能被删除）')
      return false
    }
    if (persisted === true) return true
    if (await this.listed(id)) return true
    this.dropSession('已从 DSH 会话列表中消失（可能被删除）')
    return false
  }

  /**
   * 取当前可用会话：没有就创建；有则按 TTL 校验一次是否还在 DSH 列表里。
   * 校验失败会在本轮内直接新建，避免继续往已删除的会话追加。
   */
  async currentSession() {
    if (!this.session) return this.ensure()
    if (!this.adopting && Date.now() - this.listedAt >= this.livenessTtlMs) {
      if (!(await this.verifyCurrent())) return this.ensure()
    }
    return this.session
  }

  /**
   * 订阅 DSH 的会话销毁事件。删除插件能成功 evict 时会发 api-session/removed；
   * 冷会话/宿主内部销毁走 session/disposed。两者都立刻丢掉内存指针。
   */
  watchDisposal() {
    const ctx = this.ctx
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    const offs = []
    const drop = (payload) => {
      const id = typeof payload === 'string' ? payload : (payload?.id ?? payload?.session?.id)
      if (!id || !this.session || String(id) !== String(this.session.id)) return
      this.dropSession('已被 DSH 关闭或删除')
    }
    for (const name of ['api-session/removed', 'session/disposed']) {
      try {
        const off = ctx.on(name, drop)
        if (typeof off === 'function') offs.push(off)
        else if (off && typeof off.dispose === 'function') offs.push(() => off.dispose())
      } catch { /* 宿主没有提供这个事件 */ }
    }
    return () => {
      for (const off of offs) {
        try { off() } catch { /* ignore */ }
      }
    }
  }

  async adopt(cfg, pointer, resolved) {
    this.adopting = true
    try {
      this.agent = resolved.agent
      this.session = resolved.agent.session
      this.adoptedAt = Date.now()
      // 刚 resume/新建成功的会话先信任 TTL 窗口，避免持久化列表的瞬时滞后把新会话判死。
      this.listedIds = new Set([String(this.session.id)])
      this.listedAt = Date.now()
      this.nextTurn = Math.max(pointer.nextTurn || 1, await this.maxTurn(this.session) + 1)
      pointer.nextTurn = this.nextTurn
      if (!pointer.titled) {
        const title = this.titleOf(cfg)
        pointer.title = title
        pointer.titled = await this.rename(title)
      }
      await this.savePointer()
      if (!pointer.migrated) {
        pointer.migrated = true
        await this.savePointer()
        await this.migrateLegacy(cfg)
      }
      return this.session
    } finally {
      this.adopting = false
    }
  }

  async doEnsure() {
    const cfg = await loadConfig(this.root)
    const ownerId = String(cfg.qq.ownerId ?? '').trim()
    // 没有绑定主人时不建会话，避免留下一个空壳；绑定后的第一条消息/概览再建。
    if (!ownerId) return null

    const pointer = await this.loadPointer()
    if (pointer.ownerId && pointer.ownerId !== ownerId) {
      pointer.id = ''
      pointer.titled = false
      this.session = null
      this.agent = null
    }
    pointer.ownerId = ownerId
    this.pointer = pointer

    const controller = this.controller()

    // 已经活着且没被归档：直接复用，绝不再调 create（create 对已开始的会话会新建）。
    if (this.session) {
      // inspect()/list() 都会把内存里的 attached 会话当成活着；persistence.stat 才读磁盘。
      // 刚 adopt 的会话先信任 TTL，避开持久化写入的瞬时滞后。
      const fresh = Date.now() - this.listedAt < this.livenessTtlMs
      let alive = fresh ? true : await this.verifyCurrent()
      if (alive && typeof controller.inspect === 'function' && Date.now() - this.adoptedAt > 3000) {
        try {
          await controller.inspect(this.session.id)
        } catch (error) {
          alive = false
          this.log(`[companion] DSH 会话 ${this.session.id} 已不可读（可能被删除）：${error?.message ?? error}`)
        }
      }
      if (alive) {
        const changed = pointer.id !== this.session.id
        pointer.id = this.session.id
        if (!pointer.title) {
          pointer.title = this.titleOf(cfg)
          pointer.titled = true
        }
        if (changed) await this.savePointer()
        return this.session
      }
      if (this.session) this.dropSession('')
      await this.savePointer()
    }

    // 已有指针：优先 resume（不能对已开始的会话用 create，否则会换一个新会话）。
    if (pointer.id && !this.isArchived(pointer.id)) {
      try {
        const resolved = await controller.resolveAgent(pointer.id)
        if (!resolved || resolved.error || !resolved.agent?.session) {
          const reason = resolved?.error?.message ?? resolved?.error?.code ?? 'resolveAgent 没有返回 agent'
          throw new Error(reason)
        }
        return await this.adopt(cfg, pointer, resolved)
      } catch (error) {
        this.log(`[companion] 会话 ${pointer.id} 无法恢复（${error?.message ?? error}），准备新建`)
      }
    }

    // 新会话：保留 migrated 标记；首次运行才导入旧 chat.jsonl。
    pointer.id = mintSessionId(ownerId)
    pointer.title = this.titleOf(cfg)
    pointer.titled = false
    pointer.nextTurn = 1
    this.nextTurn = 1
    await this.savePointer()

    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const created = await controller.create({ sessionId: pointer.id, cwd: this.root })
        const actualId = String(created?.sessionId ?? pointer.id)
        if (actualId !== pointer.id) {
          pointer.id = actualId
          pointer.titled = false
        }
        const resolved = await controller.resolveAgent(actualId)
        if (!resolved || resolved.error || !resolved.agent?.session) {
          const reason = resolved?.error?.message ?? resolved?.error?.code ?? 'resolveAgent 没有返回 agent'
          throw new Error(reason)
        }
        return await this.adopt(cfg, pointer, resolved)
      } catch (error) {
        lastError = error
        this.log(`[companion] 创建 DSH 会话 ${pointer.id} 失败（${error?.message ?? error}），换一个 ID`)
        pointer.id = mintSessionId(ownerId)
        pointer.titled = false
        pointer.nextTurn = 1
        this.nextTurn = 1
        await this.savePointer()
      }
    }
    this.log(`[companion] 无法创建 DSH 会话：${lastError?.message ?? lastError}`)
    return null
  }

  titleOf(cfg) {
    const name = String(cfg?.name ?? '陪伴').trim() || '陪伴'
    return `陪伴 · ${name}（QQ）`.slice(0, MAX_TITLE)
  }

  async rename(title) {
    const titles = (() => {
      try { return this.ctx?.get?.('sessionTitle') ?? null } catch { return null }
    })()
    if (titles && typeof titles.rename === 'function') {
      try {
        await titles.rename(this.session, title)
        return true
      } catch (error) {
        this.log(`[companion] 会话改名失败：${error?.message ?? error}`)
      }
    }
    const controller = this.controller()
    if (controller && typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId: this.session.id, title })
        return true
      } catch { /* 没有标题服务 */ }
    }
    return false
  }

  async maxTurn(session) {
    try {
      const events = session.snapshotEvents()
      let max = 0
      for (const event of events) max = Math.max(max, asTurnValue(event))
      return max
    } catch {
      return 0
    }
  }

  /**
   * 只从日志尾部往回找最近的 turn/start（最多 200 条事件）。
   * 用于每轮开始前对齐 turn 号，避免和 DSH Web 端产生的 turn 冲突。
   */
  async lastTurn(session) {
    try {
      const end = session.seq
      for (let seq = end - 1; seq >= 0 && seq >= end - 200; seq -= 1) {
        const event = session.eventAt(seq)
        if (event?.type === 'turn/start' || event?.type === 'turn/end') {
          const turn = Number(event.data?.turn)
          if (Number.isInteger(turn) && turn > 0) return turn
        }
      }
    } catch { /* 读取失败就用内存计数 */ }
    return 0
  }

  /**
   * 追加一个 turn/step 的开头；userText 为空表示主动发言（没有 user 消息）。
   * 返回的 handle 交给 finishTurn / abortTurn。
   */
  async beginTurn({ userText = '', channel = 'qq', rpcId = '' } = {}) {
    const session = await this.currentSession()
    if (!session) return null
    const lastTurn = await this.lastTurn(session)
    if (lastTurn >= this.nextTurn) this.nextTurn = lastTurn + 1
    const turn = this.nextTurn
    this.nextTurn += 1
    if (this.pointer) {
      this.pointer.nextTurn = this.nextTurn
      await this.savePointer()
    }
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (userText) {
      const text = String(userText).trim()
      session.append('user/message', {
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text }],
        source: {
          kind: 'user',
          rpcId: rpcId || (channel === 'ui' ? `ui:${randomUUID()}` : `qq:${Date.now()}`),
        },
      }, { surfaceOp: 'append' })
    }
    return { session, turn, step: 1, closed: false }
  }

  async finishTurn(handle, text, { model = null } = {}) {
    if (!handle || handle.closed) return
    const body = String(text ?? '').trim()
    try {
      if (body) {
        const now = Date.now()
        handle.session.append('assistant/message', {
          turn: handle.turn,
          step: handle.step,
          message: {
            role: 'assistant',
            id: randomUUID(),
            content: [{ type: 'text', text: body }],
            source: {
              kind: 'model',
              provider: String(model?.provider || 'companion'),
              model: String(model?.model || 'companion'),
            },
          },
          stream: [{ type: 'text-chunks', time0: now, index: 0, dt: [0], texts: [body] }],
        }, { surfaceOp: 'append' })
      }
      handle.session.append('step/end', { turn: handle.turn, step: handle.step })
      handle.session.append('turn/end', { turn: handle.turn, reason: { kind: 'completed' } })
    } finally {
      handle.closed = true
    }
  }

  async abortTurn(handle) {
    if (!handle || handle.closed) return
    try {
      handle.session.append('step/end', { turn: handle.turn, step: handle.step })
      handle.session.append('turn/end', { turn: handle.turn, reason: { kind: 'blocked' } })
    } finally {
      handle.closed = true
    }
  }

  /** 从 Session surface 投影出陪伴页/模型用的聊天数组。 */
  mapMessages(session, limit = 50) {
    const out = []
    let lastUserChannel = ''
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes)) return out
    // 只投影尾部：长会话不应在每一轮把整份 surface 重走一遍。
    const tail = nodes.slice(-Math.max(8, (Number(limit) || 50) * 2 + 4))
    for (const seq of tail) {
      let event = null
      try { event = session.eventAt(seq) } catch { event = null }
      if (!event) continue
      if (event.type === 'user/message') {
        const text = textOf(event.data)
        if (!text) continue
        const channel = channelOfSource(event.data.source)
        out.push({
          id: String(event.data.id ?? `user-${seq}`),
          at: Number(event.time) || 0,
          role: 'owner',
          text,
          channel,
        })
        lastUserChannel = channel
        continue
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data.message)
        if (!text) continue
        const channel = lastUserChannel || 'proactive'
        out.push({
          id: String(event.data.message?.id ?? `assistant-${seq}`),
          at: Number(event.time) || 0,
          role: 'her',
          text,
          channel,
        })
        lastUserChannel = ''
      }
    }
    return out.slice(-Math.max(1, Number(limit) || 50))
  }

  async history(limit = 50) {
    const session = await this.currentSession()
    if (!session) return null
    return this.mapMessages(session, limit)
  }

  async status() {
    const pointer = await this.loadPointer()
    let live = false
    let error = ''
    try {
      const session = await this.ensure()
      live = Boolean(session)
    } catch (err) {
      error = String(err?.message ?? err)
    }
    return {
      available: this.available(),
      id: pointer?.id ?? '',
      title: pointer?.title ?? '',
      ownerId: pointer?.ownerId ?? '',
      live,
      turns: Math.max(0, this.nextTurn - 1),
      error,
    }
  }

  /** 新建一个陪伴会话并切过去；旧会话留在 DSH 里。 */
  async newSession() {
    const cfg = await loadConfig(this.root)
    const ownerId = String(cfg.qq.ownerId ?? '').trim()
    if (!ownerId) return { ok: false, error: '先绑定主人，再新建陪伴会话' }
    const pointer = await this.loadPointer()
    pointer.id = mintSessionId(ownerId)
    pointer.ownerId = ownerId
    pointer.title = this.titleOf(cfg)
    pointer.titled = false
    pointer.migrated = true
    pointer.nextTurn = 1
    this.pointer = pointer
    this.session = null
    this.agent = null
    this.nextTurn = 1
    await this.savePointer()
    const session = await this.ensure()
    if (!session) return { ok: false, error: 'DSH 没有创建会话（sessionController 不可用？）' }
    return { ok: true, session: await this.status() }
  }

  async migrateLegacy(cfg) {
    const legacy = await this.readLegacyChat()
    if (legacy.length === 0) {
      await this.archiveLegacy()
      return
    }
    this.log(`[companion] 把 ${legacy.length} 条旧聊天导入 DSH 会话`)
    let handle = null
    for (const item of legacy) {
      try {
        if (item.role === 'owner') {
          if (handle) await this.abortTurn(handle)
          handle = await this.beginTurn({
            userText: item.text,
            channel: item.channel === 'ui' ? 'ui' : 'qq',
            rpcId: `legacy:${item.channel}`,
          })
        } else {
          if (!handle) handle = await this.beginTurn({ channel: item.channel === 'proactive' ? 'proactive' : 'qq', rpcId: 'legacy' })
          await this.finishTurn(handle, item.text, { model: null })
          handle = null
        }
      } catch (error) {
        this.log(`[companion] 导入旧聊天失败一条：${error?.message ?? error}`)
      }
    }
    if (handle) await this.abortTurn(handle)
    await this.archiveLegacy()
  }

  async readLegacyChat() {
    let raw = ''
    try {
      raw = await readFile(join(this.root, LEGACY_CHAT_FILE), 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of raw.split('\n').filter(Boolean).slice(-LEGACY_IMPORT_LIMIT)) {
      try {
        const item = JSON.parse(line)
        const text = String(item?.text ?? '').trim()
        if (!text) continue
        out.push({
          role: item?.role === 'her' ? 'her' : 'owner',
          text,
          channel: ['qq', 'ui', 'proactive'].includes(item?.channel) ? item.channel : 'qq',
        })
      } catch { /* 坏行跳过 */ }
    }
    return out
  }

  async archiveLegacy() {
    try {
      await rename(join(this.root, LEGACY_CHAT_FILE), join(this.root, LEGACY_ARCHIVE_FILE))
    } catch { /* 已经没有旧文件 */ }
  }
}

export const __internals = { mintSessionId, textOf, channelOfSource, POINTER_FILE, LEGACY_CHAT_FILE }
