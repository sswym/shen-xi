/**
 * 陪伴角色的持久状态：心情、精力、好感度、记忆、聊天记录。
 *
 * 所有文件都在 `$DSH_HOME/companion/` 下，纯 JSON / JSONL，用户可以直接看、
 * 直接备份，也可以用界面管理。这里不依赖 DSH。
 */
import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWrite, dayKey, readJson, zoned } from './life.js'

let memoryQueue = Promise.resolve()

/** 记忆的读-改-写必须串行，否则自动提取和检索计数会互相覆盖。 */
function serializeMemory(task) {
  const run = memoryQueue.then(task, task)
  memoryQueue = run.catch(() => {})
  return run
}

const fileOf = {
  state: (root) => join(root, 'state.json'),
  memories: (root) => join(root, 'memories.json'),
  chat: (root) => join(root, 'chat.jsonl'),
  guestChat: (root, owner) => join(root, `guests/chat-${String(owner).replace(/[^a-zA-Z0-9_-]/g, '')}.jsonl`),
}

async function ensureDir(file) {
  await mkdir(dirname(file), { recursive: true })
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function defaultState(cfg, now = Date.now()) {
  return {
    mood: 0,
    energy: 70,
    activity: '',
    affection: clamp(cfg?.affection?.start, 0, 100, 12),
    note: '',
    lastOwnerAt: 0,
    lastProactiveAt: 0,
    lastBeatKey: '',
    beatDate: '',
    beatCount: 0,
    gainDate: '',
    gainToday: 0,
    createdAt: now,
    updatedAt: 0,
    stats: {
      ownerMessages: 0,
      proactiveMessages: 0,
      days: 1,
    },
  }
}

/** 读取状态，并处理跨天计数器的归零。 */
export async function readState(root, cfg, now = Date.now()) {
  const raw = await readJson(fileOf.state(root), {})
  const state = { ...defaultState(cfg, now), ...(raw && typeof raw === 'object' ? raw : {}) }
  state.stats = { ...defaultState(cfg, now).stats, ...(raw?.stats ?? {}) }
  const today = dayKey(new Date(now), cfg.timezone)
  if (state.beatDate !== today) {
    state.beatDate = today
    state.beatCount = 0
  }
  if (state.gainDate !== today) {
    state.gainDate = today
    state.gainToday = 0
  }
  if (!state.createdAt) state.createdAt = now
  return state
}

export async function writeState(root, state) {
  const next = { ...state, updatedAt: Date.now() }
  await atomicWrite(fileOf.state(root), JSON.stringify(next, null, 2) + '\n')
  return next
}

export async function updateState(root, cfg, patch) {
  const current = await readState(root, cfg)
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  if (patch?.stats) next.stats = { ...current.stats, ...patch.stats }
  return writeState(root, next)
}

/** 好感度变化；正增长受每日上限约束，负增长不设限。 */
export async function changeAffection(root, cfg, delta, reason = '') {
  const state = await readState(root, cfg)
  const amount = Number(delta) || 0
  let applied = amount
  if (amount > 0) {
    const cap = Number(cfg?.affection?.dailyGainCap) || 0
    const room = Math.max(0, cap - (Number(state.gainToday) || 0))
    applied = Math.min(amount, room)
    state.gainToday = Math.round(((Number(state.gainToday) || 0) + applied) * 100) / 100
  }
  state.affection = Math.round(clamp((Number(state.affection) || 0) + applied, 0, 100, 0) * 100) / 100
  if (reason) state.lastAffectionReason = reason
  return writeState(root, state)
}

export async function changeMood(root, cfg, delta) {
  const state = await readState(root, cfg)
  state.mood = Math.round(clamp((Number(state.mood) || 0) + (Number(delta) || 0), -2, 2, 0) * 100) / 100
  return writeState(root, state)
}

export async function touchOwner(root, cfg, at = Date.now()) {
  const state = await readState(root, cfg)
  state.lastOwnerAt = at
  state.stats.ownerMessages = (Number(state.stats.ownerMessages) || 0) + 1
  return writeState(root, state)
}

export async function touchProactive(root, cfg, beatKey, at = Date.now()) {
  const state = await readState(root, cfg)
  state.lastProactiveAt = at
  state.lastBeatKey = beatKey || state.lastBeatKey
  state.beatCount = (Number(state.beatCount) || 0) + 1
  state.stats.proactiveMessages = (Number(state.stats.proactiveMessages) || 0) + 1
  return writeState(root, state)
}

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

const MEMORY_KINDS = new Set(['fact', 'preference', 'promise', 'event', 'feeling', 'note'])
const MEMORY_STATUSES = new Set(['active', 'superseded', 'archived'])
export const OWNER_KEY = 'owner' // 主人的记忆命名空间；guest 用其标识。
const SENSITIVE_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email
  /\b\d{11}\b/, // CN mobile
  /\b\d{16,19}\b/, // bank card
  /(密码|验证码|银行卡|身份证|信用卡|支付密码|password|passcode|secret|api[_ -]?key)/i,
]

export function isSensitiveMemory(text) {
  const body = String(text ?? '')
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(body))
}

export function normalizeMemory(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const text = String(source.text ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return null
  const kind = MEMORY_KINDS.has(source.kind) ? source.kind : 'fact'
  const origin = ['chat', 'manual', 'life', 'system'].includes(source.source) ? source.source : 'manual'
  const at = Number(source.at) || now
  const status = MEMORY_STATUSES.has(source.status)
    ? source.status
    : (typeof source.supersededBy === 'string' && source.supersededBy ? 'superseded' : 'active')
  return {
    id: String(source.id ?? `mem-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    at,
    lastConfirmedAt: Number(source.lastConfirmedAt) || at,
    lastAccessed: Number(source.lastAccessed) || at,
    accessCount: Math.max(0, Math.floor(Number(source.accessCount) || 0)),
    confidence: clamp(source.confidence, 0, 1, origin === 'manual' ? 1 : origin === 'chat' ? 0.7 : 0.85),
    kind,
    text: text.slice(0, 500),
    tags: Array.isArray(source.tags) ? source.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    importance: Math.round(clamp(source.importance, 1, 5, 3)),
    source: origin,
    durable: source.durable !== false,
    status,
    owner: String(source.owner ?? OWNER_KEY),
    supersedes: typeof source.supersedes === 'string' && source.supersedes ? source.supersedes : null,
    supersededBy: typeof source.supersededBy === 'string' && source.supersededBy ? source.supersededBy : null,
  }
}


export async function readMemories(root, owner = OWNER_KEY) {
  const raw = await readJson(fileOf.memories(root), [])
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => normalizeMemory(item))
    .filter(Boolean)
    .filter((item) => item.owner === owner)
}

/** 全部记忆（维护页用）。 */
export async function readAllMemories(root) {
  const raw = await readJson(fileOf.memories(root), [])
  if (!Array.isArray(raw)) return []
  return raw.map((item) => normalizeMemory(item)).filter(Boolean)
}

async function writeMemories(root, list) {
  const file = fileOf.memories(root)
  await ensureDir(file)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return list
}

/** 综合权重：重要度 × 时间衰减 × 使用增强 × 置信度。 */
export function memoryWeight(memory, now = Date.now()) {
  const importance = clamp(memory?.importance, 1, 5, 3)
  const last = Number(memory?.lastConfirmedAt) || Number(memory?.at) || now
  const ageDays = Math.max(0, (now - last) / 86400000)
  const lambda = 0.02 - ((importance - 1) / 4) * 0.018
  const decay = Math.exp(-lambda * ageDays)
  const usage = Math.log(1 + Math.max(0, Number(memory?.accessCount) || 0)) * 0.3
  const confidence = clamp(memory?.confidence, 0, 1, 0.7)
  return (0.5 + importance / 5) * decay * (1 + usage) * confidence
}

/** 记住这些记忆刚被检索过；使用频率会反过来提高下次权重。 */
export function touchMemories(root, ids, now = Date.now()) {
  return serializeMemory(async () => {
    const wanted = new Set(Array.isArray(ids) ? ids.map(String) : [])
    if (wanted.size === 0) return 0
    const all = await readAllMemories(root)
    let touched = 0
    for (const item of all) {
      if (!wanted.has(item.id) || item.status !== 'active') continue
      item.accessCount += 1
      item.lastAccessed = now
      touched += 1
    }
    if (touched > 0) await writeMemories(root, all)
    return touched
  })
}

function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let common = 0
  for (const gram of A) if (B.has(gram)) common += 1
  return common / (A.size + B.size - common)
}

/**
 * 加一条记忆。
 * - 自动聊天记忆遇到敏感信息直接拒绝（手动添加不受限）。
 * - 完全相同文本做确认更新；高相似同一类记忆合并或形成 supersedes 版本链。
 */
export function addMemory(root, raw, now = Date.now()) {
  return serializeMemory(async () => {
  const memory = normalizeMemory(raw, now)
  if (!memory) return null
  if (memory.source !== 'manual' && isSensitiveMemory(memory.text)) return null

  const all = await readAllMemories(root)
  const owner = memory.owner
  const list = all.filter((item) => item.owner === owner)
  const others = all.filter((item) => item.owner !== owner)
  const key = memory.text.toLowerCase()
  const exact = list.find((item) => item.status === 'active' && item.text.toLowerCase() === key)
  if (exact) {
    exact.lastConfirmedAt = now
    exact.lastAccessed = now
    exact.importance = Math.max(exact.importance, memory.importance)
    exact.confidence = Math.max(exact.confidence, memory.confidence)
    exact.durable = exact.durable !== false || memory.durable !== false
    if (memory.tags.length > 0) exact.tags = Array.from(new Set([...exact.tags, ...memory.tags])).slice(0, 8)
    await writeMemories(root, [...others, ...list])
    return exact
  }

  const similar = list
    .filter((item) => item.status === 'active' && item.kind === memory.kind)
    .map((item) => ({ item, score: similarity(item.text, memory.text) }))
    .filter((row) => row.score >= 0.82)
    .sort((a, b) => b.score - a.score)[0]

  if (similar) {
    const { item, score } = similar
    if (score >= 0.95) {
      // 近似重复：保留原 id，用信息更完整的那句确认一次。
      if (memory.text.length >= item.text.length) item.text = memory.text
      item.lastConfirmedAt = now
      item.lastAccessed = now
      item.importance = Math.max(item.importance, memory.importance)
      item.confidence = Math.max(item.confidence, memory.confidence)
      item.durable = item.durable !== false || memory.durable !== false
      if (memory.tags.length > 0) item.tags = Array.from(new Set([...item.tags, ...memory.tags])).slice(0, 8)
      await writeMemories(root, [...others, ...list])
      return item
    }
    // 可能是事实更新：保留旧版本，建立版本链。
    item.status = 'superseded'
    item.supersededBy = memory.id
    memory.supersedes = item.id
  }

  list.push(memory)
  // 上限 500 条：先淘汰旧版本，再按重要度/确认时间淘汰。
  if (list.length > 500) {
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return (b.importance - a.importance) || ((b.lastConfirmedAt || b.at) - (a.lastConfirmedAt || a.at))
    })
    list.length = 500
    list.sort((a, b) => a.at - b.at)
  }
  await writeMemories(root, [...others, ...list])
  return memory
  })
}

export function deleteMemory(root, id) {
  return serializeMemory(async () => {
    const all = await readAllMemories(root)
    const next = all.filter((item) => item.id !== id)
    if (next.length === all.length) return false
    await writeMemories(root, next)
    return true
  })
}

/** 确认一条记忆：刷新确认时间/置信度；boost 时把低重要度自动记忆提升到可注入级别。 */
export function confirmMemory(root, id, { boost = false } = {}, now = Date.now()) {
  return serializeMemory(async () => {
    const list = await readAllMemories(root)
    const item = list.find((row) => row.id === id)
    if (!item) return null
    item.lastConfirmedAt = now
    item.lastAccessed = now
    item.confidence = clamp(item.confidence + 0.05, 0, 1, 0.8)
    if (boost) item.importance = Math.max(3, item.importance)
    item.status = 'active'
    await writeMemories(root, list)
    return item
  })
}

/** 合并一组记忆：保留 keep，其余标记 superseded，并汇总重要度/标签/使用次数。 */
export function mergeMemories(root, keepId, dropIds, now = Date.now()) {
  return serializeMemory(async () => {
    const list = await readAllMemories(root)
    const keep = list.find((row) => row.id === keepId && row.status === 'active')
    if (!keep) return null
    const wanted = Array.isArray(dropIds) ? dropIds.map(String) : []
    const drops = list.filter((row) => row.status === 'active' && wanted.includes(row.id) && row.id !== keep.id)
    if (drops.length === 0) return keep
    if (!keep.text) keep.text = [keep, ...drops].map((row) => row.text).sort((a, b) => b.length - a.length)[0]
    keep.importance = Math.max(keep.importance, ...drops.map((row) => row.importance))
    keep.confidence = Math.max(keep.confidence, ...drops.map((row) => row.confidence))
    keep.accessCount += drops.reduce((sum, row) => sum + row.accessCount, 0)
    keep.lastConfirmedAt = now
    keep.lastAccessed = now
    keep.tags = Array.from(new Set([...keep.tags, ...drops.flatMap((row) => row.tags)])).slice(0, 8)
    keep.supersedes = keep.supersedes || drops[0].id
    for (const drop of drops) {
      drop.status = 'superseded'
      drop.supersededBy = keep.id
    }
    await writeMemories(root, list)
    return keep
  })
}

/** 恢复一个旧版本：它重新 active，之后的版本链里被它替代的记忆重新标记为 superseded。 */
export function restoreMemory(root, id, now = Date.now()) {
  return serializeMemory(async () => {
    const list = await readAllMemories(root)
    const item = list.find((row) => row.id === id)
    if (!item) return null
    let successorId = item.supersededBy
    item.status = 'active'
    item.supersededBy = null
    item.lastConfirmedAt = now
    item.lastAccessed = now
    item.confidence = clamp(item.confidence + 0.05, 0, 1, 0.8)
    const seen = new Set([item.id])
    while (successorId && !seen.has(successorId)) {
      seen.add(successorId)
      const successor = list.find((row) => row.id === successorId)
      if (!successor) break
      const nextId = successor.supersededBy
      successor.status = 'superseded'
      successor.supersededBy = item.id
      successorId = nextId
    }
    await writeMemories(root, list)
    return item
  })
}

/** 维护视图：低价值、可能重复、低权重、旧版本。 */
export function memoryMaintenance(list, now = Date.now()) {
  const active = list.filter((item) => item.status === 'active')
  const lowValue = active.filter((item) => item.source === 'chat' && item.importance < 3)
  const stale = active.filter((item) => {
    const ageDays = Math.max(0, (now - (Number(item.lastConfirmedAt) || Number(item.at) || now)) / 86400000)
    return ageDays > 120 || memoryWeight(item, now) < 0.15
  })
  const duplicates = []
  const used = new Set()
  for (let i = 0; i < active.length; i += 1) {
    if (used.has(active[i].id)) continue
    const group = [active[i]]
    for (let j = i + 1; j < active.length; j += 1) {
      if (used.has(active[j].id)) continue
      if (similarity(active[i].text, active[j].text) >= 0.82) {
        group.push(active[j])
        used.add(active[j].id)
      }
    }
    if (group.length > 1) {
      used.add(active[i].id)
      duplicates.push(group)
    }
  }
  const history = list
    .filter((item) => item.status === 'superseded')
    .sort((a, b) => (b.lastConfirmedAt || b.at) - (a.lastConfirmedAt || a.at))
    .slice(0, 100)
  const score = (item) => Math.round(memoryWeight(item, now) * 100) / 100
  return {
    lowValue: lowValue.map((item) => ({ ...item, weight: score(item) })),
    duplicates: duplicates.map((group) => group.map((item) => ({ ...item, weight: score(item) }))),
    stale: stale.map((item) => ({ ...item, weight: score(item) })),
    history: history.map((item) => ({ ...item, weight: score(item) })),
  }
}

function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[\s，。！？、,.!?;；:：""''（）()《》【】[\]{}]/g, '')
  const out = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

/** 关键词 + 重要度 + 时间衰减 + 使用频率 + 置信度的检索；只返回 active。 */
export function searchMemories(list, query, limit = 10, now = Date.now()) {
  const requested = Number(limit)
  const take = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 10
  if (take === 0) return []
  const q = String(query ?? '').trim()
  const grams = bigrams(q)
  const scored = list
    .filter((item) => item.status === 'active')
    .map((item) => {
      let relevance = 0
      if (q) {
        const text = item.text.toLowerCase()
        if (text.includes(q.toLowerCase())) relevance += 20
        for (const gram of grams) if (text.includes(gram)) relevance += 2
      }
      const importance = Number(item.importance) || 3
      // 自动提取的低重要度闲聊事实：默认不注入；只有当前话题确实命中时才带。
      if (item.source === 'chat' && importance < 3 && (!q || relevance === 0)) return null
      const weight = memoryWeight(item, now)
      const confidence = clamp(item.confidence, 0, 1, 0.7)
      const score = relevance + importance * 1.5 + weight * 4 + confidence
      return { item, score }
    })
    .filter(Boolean)
  scored.sort((a, b) => b.score - a.score || ((b.item.lastConfirmedAt || b.item.at) - (a.item.lastConfirmedAt || a.item.at)))
  return scored.slice(0, take).map((row) => row.item)
}

/* ------------------------------------------------------------------ */
/* 聊天记录                                                            */
/* ------------------------------------------------------------------ */

export function normalizeChat(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const text = String(source.text ?? '').trim()
  if (!text) return null
  return {
    id: String(source.id ?? `msg-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
    at: Number(source.at) || now,
    role: source.role === 'her' ? 'her' : 'owner',
    text: text.slice(0, 4000),
    channel: ['qq', 'ui', 'proactive', 'system'].includes(source.channel) ? source.channel : 'qq',
  }
}

export async function appendChat(root, entry, now = Date.now(), owner = OWNER_KEY) {
  const message = normalizeChat(entry, now)
  if (!message) return null
  const file = owner === OWNER_KEY ? fileOf.chat(root) : fileOf.guestChat(root, owner)
  await ensureDir(file)
  await appendFile(file, JSON.stringify(message) + '\n', 'utf8')
  return message
}

/** 读最近 limit 条消息（按时间正序返回）。owner 非 owner 时读访客聊天文件。 */
export async function readChat(root, limit = 50, owner = OWNER_KEY) {
  let raw = ''
  const file = owner === OWNER_KEY ? fileOf.chat(root) : fileOf.guestChat(root, owner)
  try { raw = await readFile(file, 'utf8') } catch { return [] }
  const lines = raw.split('\n').filter(Boolean)
  const slice = lines.slice(-Math.max(1, limit))
  const out = []
  for (const line of slice) {
    try {
      const item = normalizeChat(JSON.parse(line))
      if (item) out.push(item)
    } catch { /* 坏行跳过 */ }
  }
  return out
}


/** 今天主人说了多少句、她主动说了多少句。 */
export function countToday(chat, cfg, now = Date.now()) {
  const today = dayKey(new Date(now), cfg.timezone)
  let owner = 0
  let her = 0
  let proactive = 0
  for (const item of chat) {
    if (dayKey(new Date(item.at), cfg.timezone) !== today) continue
    if (item.role === 'owner') owner += 1
    else {
      her += 1
      if (item.channel === 'proactive') proactive += 1
    }
  }
  return { owner, her, proactive }
}

export { fileOf }
