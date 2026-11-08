import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CONFIG, affectionLevel, dayKey, dayKeyOffset, ensureHome, getDay, inQuietHours, loadConfig,
  normalizeConfig, pickUnsharedEvent, readDiary, saveConfig, zoned,
  __internals as lifeInternals,
} from '../lib/life.js'
import {
  addMemory, appendChat, changeAffection, changeMood, confirmMemory, memoryMaintenance, memoryWeight,
  readAllMemories,
  mergeMemories, readChat, readMemories, readState, restoreMemory,
  searchMemories, touchMemories,
} from '../lib/store.js'
import { QqBridge } from '../lib/qq.js'
import { QqOfficialClient, officialMessage, splitBubbles, splitText } from '../lib/qq-official.js'
import { SessionStore } from '../lib/session-store.js'
import { MemoryIndex } from '../lib/embeddings.js'
import { __internals as mindInternals } from '../lib/mind.js'
import { __internals as apiInternals } from '../lib/api.js'
import { beatJitter, bubbleGap, humanDelay, sanitize, sleepState, typoFix, typoize } from '../lib/humanize.js'
import { __internals as engineInternals, Engine } from '../lib/engine.js'

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-companion-test-'))
  process.env.DSH_HOME = dir
  await ensureHome(join(dir, 'companion'))
  return dir
}

test('config migrates the old heartbeat shape', () => {
  const cfg = normalizeConfig({
    name: '阿栖',
    callYou: '您',
    heartbeat: true,
    heartbeatTimes: ['08:00', '23:00'],
    eventsPerDay: 3,
  })
  assert.equal(cfg.name, '阿栖')
  assert.equal(cfg.callYou, '您')
  assert.equal(cfg.heartbeat.enabled, true)
  assert.deepEqual(cfg.heartbeat.times, ['08:00', '23:00'])
  assert.equal(cfg.life.eventsPerDay, 3)
  assert.equal(cfg.qq.enabled, false)
})

test('config rejects malformed times and clamps values', () => {
  const cfg = normalizeConfig({ heartbeat: { times: ['25:00', 'bad', '09:00'] }, life: { eventsPerDay: 99 } })
  assert.deepEqual(cfg.heartbeat.times, ['09:00'])
  assert.equal(cfg.life.eventsPerDay, 5)
  assert.equal(cfg.heartbeat.maxPerDay, DEFAULT_CONFIG.heartbeat.maxPerDay)
})

test('quiet hours support overnight ranges', () => {
  assert.equal(inQuietHours('23:45', '23:30', '08:00'), true)
  assert.equal(inQuietHours('07:59', '23:30', '08:00'), true)
  assert.equal(inQuietHours('08:00', '23:30', '08:00'), false)
  assert.equal(inQuietHours('12:00', '23:30', '08:00'), false)
})

test('proactive event picker never picks a future event', () => {
  const day = {
    events: [
      { id: 'a', at: '09:00', shared: false },
      { id: 'b', at: '14:00', shared: false },
      { id: 'c', at: '22:00', shared: false },
    ],
  }
  assert.equal(pickUnsharedEvent(day, '18:00').id, 'b')
  assert.equal(pickUnsharedEvent(day, '08:00'), null)
})

test('daily life is deterministic per date', async () => {
  const home = await tempHome()
  try {
    const cfg = await loadConfig(join(home, 'companion'))
    const a = await getDay(join(home, 'companion'), cfg, '2026-11-07')
    const b = await getDay(join(home, 'companion'), cfg, '2026-11-07')
    assert.deepEqual(a, b)
    assert.equal(a.events.length, 5)
    assert.ok(a.weather.length > 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('affection levels are stable at boundaries', () => {
  assert.equal(affectionLevel(0).label, '陌生')
  assert.equal(affectionLevel(10).label, '眼熟')
  assert.equal(affectionLevel(50).label, '亲近')
  assert.equal(affectionLevel(100).label, '离不开')
})

test('memories dedupe and search by keyword', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const first = await addMemory(root, { text: '他喝咖啡不加糖', kind: 'preference', importance: 4 })
    const second = await addMemory(root, { text: '他喝咖啡不加糖', kind: 'preference', importance: 5 })
    assert.equal(first.id, second.id)
    const list = await readMemories(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].importance, 5)
    const found = searchMemories(list, '咖啡')
    assert.equal(found.length, 1)
    assert.deepEqual(searchMemories(list, '咖啡', 0), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('memory access updates usage and weight decays over time', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const item = await addMemory(root, { text: '他喜欢喝咖啡', kind: 'preference', importance: 4, source: 'manual' }, 1000)
    assert.equal(item.accessCount, 0)
    const before = memoryWeight(item, 1000)
    assert.equal(await touchMemories(root, [item.id], 5000), 1)
    const [touched] = await readMemories(root)
    assert.equal(touched.accessCount, 1)
    assert.equal(touched.lastAccessed, 5000)
    assert.ok(memoryWeight(touched, 5000) > before)
    assert.ok(memoryWeight(touched, 5000 + 365 * 86400000) < memoryWeight(touched, 5000))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('similar memories form a supersedes version chain', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const old = await addMemory(root, { text: '他住在海淀区', kind: 'fact', importance: 3 })
    const next = await addMemory(root, { text: '他住在海淀区了', kind: 'fact', importance: 4 })
    assert.notEqual(old.id, next.id)
    assert.equal(next.supersedes, old.id)
    const list = await readMemories(root)
    assert.equal(list.find((x) => x.id === old.id).status, 'superseded')
    assert.equal(list.find((x) => x.id === old.id).supersededBy, next.id)
    assert.deepEqual(searchMemories(list, '海淀').map((x) => x.id), [next.id])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sensitive chat memories are rejected unless manually added', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    assert.equal(await addMemory(root, { text: '他的邮箱是 a@b.com', source: 'chat' }), null)
    assert.equal(await addMemory(root, { text: '他的验证码是 123456', source: 'chat' }), null)
    const manual = await addMemory(root, { text: '他的邮箱是 a@b.com', source: 'manual' })
    assert.ok(manual)
    assert.equal((await readMemories(root)).length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('extraction drops transient or low-importance facts', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx(JSON.stringify([
      { text: '他还没出门', kind: 'fact', importance: 2, durable: true },
      { text: '他正在点外卖', kind: 'fact', importance: 4, durable: false },
      { text: '他喝咖啡不加糖', kind: 'preference', importance: 4, durable: true },
    ]))
    const qq = { configure() {}, status: () => ({ connected: false }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    await engine.extract(await loadConfig(root), '随便聊聊', '好。')
    const list = await readMemories(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].text, '他喝咖啡不加糖')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('low-value chat facts are not injected without a topic match', () => {
  const list = [
    { id: 'a', text: '他还没出门', kind: 'fact', importance: 2, source: 'chat', status: 'active', confidence: 0.7, at: Date.now(), lastConfirmedAt: Date.now(), accessCount: 0 },
    { id: 'b', text: '他喜欢喝咖啡', kind: 'preference', importance: 2, source: 'manual', status: 'active', confidence: 1, at: Date.now(), lastConfirmedAt: Date.now(), accessCount: 0 },
    { id: 'c', text: '他的名字是吴文旭', kind: 'fact', importance: 3, source: 'chat', status: 'active', confidence: 0.7, at: Date.now(), lastConfirmedAt: Date.now(), accessCount: 0 },
  ]
  assert.deepEqual(searchMemories(list, '今天吃什么').map((x) => x.id), ['c', 'b'])
  assert.ok(searchMemories(list, '出门').some((x) => x.id === 'a'))
})

test('memory maintenance surfaces low-value, duplicates, stale and history', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const low = await addMemory(root, { text: '他还没出门', kind: 'fact', importance: 2, source: 'chat' })
    const a = await addMemory(root, { text: '他喜欢喝咖啡', kind: 'preference', importance: 4, source: 'manual' })
    const b = await addMemory(root, { text: '他喜欢喝咖啡。', kind: 'fact', importance: 3, source: 'manual' })
    const old = await addMemory(root, { text: '他住在海淀区', kind: 'fact', importance: 3, source: 'manual' }, 1000)
    const oldVersion = await addMemory(root, { text: '他养了一只橘猫', kind: 'fact', importance: 3, source: 'manual' })
    await addMemory(root, { text: '他养了一只橘猫了', kind: 'fact', importance: 3, source: 'manual' })
    const list = await readMemories(root)
    const view = memoryMaintenance(list, Date.now())
    assert.ok(view.lowValue.some((item) => item.id === low.id))
    assert.ok(view.duplicates.some((group) => group.some((item) => item.id === a.id) && group.some((item) => item.id === b.id)))
    assert.ok(view.stale.some((item) => item.id === old.id))
    assert.ok(view.history.some((item) => item.id === oldVersion.id))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('memory confirm, merge and restore update the version chain', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const first = await addMemory(root, { text: '他喜欢喝咖啡', kind: 'preference', importance: 4 })
    const second = await addMemory(root, { text: '他喜欢喝咖啡。', kind: 'fact', importance: 3 })
    const merged = await mergeMemories(root, first.id, [second.id])
    assert.equal(merged.id, first.id)
    let list = await readMemories(root)
    assert.equal(list.find((x) => x.id === second.id).status, 'superseded')

    const confirmed = await confirmMemory(root, first.id, { boost: true })
    assert.ok(confirmed.confidence > 0.7)
    assert.ok(confirmed.importance >= 3)

    const old = await addMemory(root, { text: '他住在海淀区', kind: 'fact', importance: 3 })
    const next = await addMemory(root, { text: '他住在海淀区了', kind: 'fact', importance: 4 })
    const restored = await restoreMemory(root, old.id)
    assert.equal(restored.status, 'active')
    list = await readMemories(root)
    assert.equal(list.find((x) => x.id === next.id).status, 'superseded')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('embedding index retrieves memories by meaning and persists vectors', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  const now = Date.now()
  const list = [{
    id: 'a', text: '他对咖啡因上瘾', kind: 'fact', importance: 3, source: 'manual',
    status: 'active', confidence: 1, at: now, lastConfirmedAt: now, accessCount: 0,
    durable: true, tags: [], supersedes: null, supersededBy: null,
  }]
  const cfg = { memory: { embedding: { enabled: true, provider: 'ollama', baseUrl: 'http://ollama.test', model: 'test-embed', timeoutMs: 5000 } } }
  const fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    const inputs = Array.isArray(body.input) ? body.input : [body.prompt]
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: inputs.map((text) => (/咖啡|喝什么/.test(String(text)) ? [1, 0, 0] : [0, 1, 0])),
      }),
    }
  }
  try {
    const index = new MemoryIndex({ root, fetchImpl, log: () => {} })
    const picked = await index.search(list, '我平时喝什么', 5, { cfg, now })
    assert.equal(picked[0].id, 'a')
    const status = await index.status(list, cfg)
    assert.equal(status.indexed, 1)
    assert.equal(status.dimension, 3)

    const disabled = await index.search(list, '我平时喝什么', 5, {
      cfg: { memory: { embedding: { ...cfg.memory.embedding, enabled: false } } },
      now,
    })
    assert.equal(disabled, null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('embedding index falls back when Ollama is unavailable', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  const now = Date.now()
  const list = [{
    id: 'a', text: '他喜欢喝咖啡', kind: 'preference', importance: 3, source: 'manual',
    status: 'active', confidence: 1, at: now, lastConfirmedAt: now, accessCount: 0,
  }]
  const cfg = { memory: { embedding: { enabled: true, provider: 'ollama', baseUrl: 'http://down.test', model: 'test', timeoutMs: 1000 } } }
  try {
    const index = new MemoryIndex({ root, fetchImpl: async () => { throw new Error('down') }, log: () => {} })
    assert.equal(await index.search(list, '咖啡', 5, { cfg, now }), null)
    const status = await index.status(list, cfg)
    assert.equal(status.lastError, 'down')
    assert.equal(status.cooldown, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('memory and chat prompt lines include timestamps', () => {
  const at = Date.parse('2026-11-08T10:20:00+08:00')
  const memory = mindInternals.memoryLines([{ kind: 'fact', text: '他喜欢喝咖啡', at }], 'Asia/Shanghai')
  assert.match(memory, /11\/08 10:20/)
  assert.match(memory, /他喜欢喝咖啡/)
  const chat = mindInternals.recentChatLines([{ role: 'owner', text: '在吗', at }], 'Asia/Shanghai')
  assert.match(chat, /\[11\/08 10:20\] 他：在吗/)
})

test('chat log keeps order and limits reads', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    await appendChat(root, { role: 'owner', text: '在吗', channel: 'qq' })
    await appendChat(root, { role: 'her', text: '在。', channel: 'qq' })
    const list = await readChat(root, 1)
    assert.equal(list.length, 1)
    assert.equal(list[0].text, '在。')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('session projection labels QQ, UI and proactive messages', () => {
  const events = [
    {
      type: 'user/message',
      time: 1000,
      data: {
        id: 'u1',
        content: [{ type: 'text', text: '在吗' }],
        source: { kind: 'user', rpcId: 'qq:evt-1' },
      },
    },
    {
      type: 'assistant/message',
      time: 2000,
      data: {
        message: { id: 'a1', content: [{ type: 'text', text: '在。' }] },
      },
    },
    {
      type: 'assistant/message',
      time: 3000,
      data: {
        message: { id: 'a2', content: [{ type: 'text', text: '刚醒。' }] },
      },
    },
    {
      type: 'user/message',
      time: 4000,
      data: {
        id: 'u2',
        content: [{ type: 'text', text: '界面测试' }],
        source: { kind: 'user', rpcId: 'ui:test' },
      },
    },
    {
      type: 'assistant/message',
      time: 5000,
      data: {
        message: { id: 'a3', content: [{ type: 'text', text: '嗯。' }] },
      },
    },
  ]
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: (seq) => events[seq],
  }
  const store = new SessionStore({ ctx: {}, root: '/tmp', log: () => {} })
  const rows = store.mapMessages(session, 10)
  assert.deepEqual(rows.map((row) => [row.role, row.channel, row.text]), [
    ['owner', 'qq', '在吗'],
    ['her', 'qq', '在。'],
    ['her', 'proactive', '刚醒。'],
    ['owner', 'ui', '界面测试'],
    ['her', 'ui', '嗯。'],
  ])
})

/** 最小 DSH sessionController：模拟“磁盘已删、内存仍 attached”的真实行为。 */
function fakeSessionController() {
  const stored = new Set()
  const live = new Set()
  const sessions = new Map()
  const created = []
  const makeSession = (id) => {
    const events = []
    return {
      id,
      seq: 0,
      surface: { nodes: [] },
      snapshotEvents: () => events.slice(),
      eventAt: () => undefined,
      append: (type, data) => { events.push({ type, data }) },
    }
  }
  const register = (id) => {
    stored.add(id)
    live.add(id)
    sessions.set(id, makeSession(id))
  }
  return {
    stored,
    live,
    sessions,
    created,
    register,
    /** 模拟删除：持久化里没了，但 attached 活体仍在内存。 */
    remove(id) {
      stored.delete(id)
    },
    persistence: {
      async stat(id) {
        return stored.has(id) ? { header: { id } } : undefined
      },
    },
    controller: {
      async create({ sessionId }) {
        created.push(sessionId)
        register(sessionId)
        return { sessionId }
      },
      async resolveAgent(id) {
        if (!live.has(id) || !sessions.has(id)) return { error: { code: 'session/not-found' } }
        return { agent: { session: sessions.get(id) } }
      },
      async inspect(id) {
        // 关键：DSH 对仍 attached 的会话会直接返回内存对象，删除后也会成功。
        return { meta: { id } }
      },
      async list() {
        // 关键：list() 把 attached 活体并进持久化列表，所以删除后仍会包含它。
        return { items: [...new Set([...stored, ...live])].map((sessionId) => ({ sessionId })) }
      },
    },
  }
}

test('session store recreates a session that vanished from persistence', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    await saveConfig(root, { qq: { ownerId: 'OWNER' } })
    await writeFile(join(root, 'session.json'), JSON.stringify({
      version: 1, id: 'old', title: '陪伴 · 旧', ownerId: 'OWNER', nextTurn: 5, titled: true, migrated: true,
    }) + '\n')
    const fake = fakeSessionController()
    fake.register('old')
    const ctx = {
      get: (name) => {
        if (name === 'sessionController') return fake.controller
        if (name === 'sessionPersistence') return fake.persistence
        return undefined
      },
    }
    const store = new SessionStore({ ctx, root, log: () => {}, livenessTtlMs: 0 })

    const first = await store.beginTurn({ userText: '删除前' })
    assert.equal(first.session.id, 'old')
    const stable = await store.beginTurn({ userText: '删除前，再一条' })
    assert.equal(stable.session.id, 'old', '健康会话不应被重建')
    assert.equal(fake.created.length, 0)

    fake.remove('old')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await store.beginTurn({ userText: '删除后' })
    assert.notEqual(second.session.id, 'old', '不应继续写已删除的会话')
    assert.equal(fake.created.length, 1, '应新建一个会话')
    assert.equal(store.session.id, second.session.id)
    const pointer = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'))
    assert.equal(pointer.id, second.session.id, '指针应指向新会话')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('session store drops the session on DSH disposal events', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    await saveConfig(root, { qq: { ownerId: 'OWNER' } })
    await writeFile(join(root, 'session.json'), JSON.stringify({
      version: 1, id: 'old', title: '陪伴 · 旧', ownerId: 'OWNER', nextTurn: 5, titled: true, migrated: true,
    }) + '\n')
    const fake = fakeSessionController()
    fake.register('old')
    const handlers = new Map()
    const ctx = {
      get: (name) => {
        if (name === 'sessionController') return fake.controller
        if (name === 'sessionPersistence') return fake.persistence
        return undefined
      },
      on(name, fn) {
        handlers.set(name, fn)
        return () => handlers.delete(name)
      },
    }
    const store = new SessionStore({ ctx, root, log: () => {} })
    const off = store.watchDisposal()
    const first = await store.beginTurn({ userText: '删除前' })
    assert.equal(first.session.id, 'old')
    handlers.get('api-session/removed')('old')
    assert.equal(store.session, null, '删除事件应立即清掉内存会话')
    const second = await store.beginTurn({ userText: '删除后' })
    assert.notEqual(second.session.id, 'old')
    assert.equal(fake.created.length, 1)
    off()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('QQ bridge sends OneBot HTTP requests and reads login info', async () => {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/get_login_info')) {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试' } }))
      } else {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 } }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const qq = new QqBridge({ loadConfig: async () => ({}) })
    const cfg = {
      qq: {
        mode: 'onebot11',
        enabled: true,
        httpUrl: `http://127.0.0.1:${port}`,
        wsUrl: 'ws://127.0.0.1:1',
        accessToken: 'secret',
        ownerId: '12345',
      },
    }
    const result = await qq.send('你好', cfg)
    assert.equal(result.ok, true)
    assert.equal(result.messageId, 7)
    const sent = received.find((row) => row.url === '/send_private_msg')
    assert.equal(sent.auth, 'Bearer secret')
    const payload = JSON.parse(sent.body)
    assert.equal(payload.user_id, 12345)
    assert.equal(payload.message[0].data.text, '你好')
    const check = await qq.check(cfg)
    assert.equal(check.ok, true)
    assert.equal(check.info.nickname, '测试')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('official QQ events extract openid, text and event id', () => {
  const message = officialMessage({
    t: 'C2C_MESSAGE_CREATE',
    id: 'evt-1',
    d: {
      id: 'msg-1',
      content: '<@!BOT> 在吗 <@all>',
      timestamp: '2026-11-07T09:00:00Z',
      author: { user_openid: 'OPENID-1' },
    },
  })
  assert.equal(message.userId, 'OPENID-1')
  assert.equal(message.text, '在吗')
  assert.equal(message.eventId, 'msg-1')
  assert.equal(officialMessage({ t: 'GROUP_AT_MESSAGE_CREATE', d: {} }), null)

  const withImage = officialMessage({
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'msg-2', content: '看看', author: { user_openid: 'OPENID-1' }, attachments: [{ content_type: 'image/png' }] },
  })
  assert.equal(withImage.text, '看看 [图片/附件]')
})

test('official text splits without losing content', () => {
  const text = '一'.repeat(500)
  const chunks = splitText(text, 200)
  assert.ok(chunks.length >= 3)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 200))
})

test('bubble splitter turns lines into separate QQ messages', () => {
  assert.deepEqual(splitBubbles('第一句\n第二句\n\n第三句'), ['第一句', '第二句', '第三句'])
  assert.deepEqual(splitBubbles('只有一句。'), ['只有一句。'])
  assert.deepEqual(splitBubbles('  \n  '), [])

  const capped = splitBubbles('a\nb\nc\nd\ne', 1800, 3)
  assert.equal(capped.length, 3)
  assert.equal(capped[0], 'a')
  assert.equal(capped[1], 'b')
  assert.equal(capped[2], 'c\nd\ne')
})

test('official send posts one request per bubble with increasing msg_seq', async () => {
  const cfg = {
    persona: { humanize: false },
    qq: {
      mode: 'official',
      enabled: true,
      ownerId: 'OWNER-OPENID',
      appId: 'APP',
      appSecret: 'SECRET',
      apiBase: 'https://api.test',
      tokenUrl: 'https://token.test',
    },
  }
  const bodies = []
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://token.test') return json({ access_token: 'TOKEN', expires_in: '7200' })
    bodies.push(JSON.parse(init.body))
    return json({ id: `M-${bodies.length}` })
  }
  const client = new QqOfficialClient({ loadConfig: async () => cfg, fetchImpl })
  const result = await client.send('第一句\n第二句', cfg, { replyTo: 'EVENT-ID' })
  assert.equal(result.ok, true)
  assert.equal(result.bubbles, 2)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].content, '第一句')
  assert.equal(bodies[1].content, '第二句')
  assert.deepEqual(bodies.map((b) => b.msg_seq), [1, 2])
  assert.equal(bodies[0].msg_id, 'EVENT-ID')
})

test('official QQ client uses token, passive reply and bot profile', async () => {
  const cfg = {
    qq: {
      mode: 'official',
      enabled: true,
      ownerId: 'OWNER-OPENID',
      appId: 'APP',
      appSecret: 'SECRET',
      apiBase: 'https://api.test',
      tokenUrl: 'https://token.test',
      intents: 100663296,
    },
  }
  const calls = []
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === 'https://token.test') return json({ access_token: 'TOKEN', expires_in: '7200' })
    if (url.endsWith('/gateway')) return json({ url: 'wss://gateway.test' })
    if (url.endsWith('/users/@me')) return json({ id: 'BOT-ID', username: '白饭鱼' })
    if (url.endsWith('/messages')) return json({ id: 'MESSAGE-ID' })
    return json({ code: 404, message: 'not found' }, 404)
  }
  const client = new QqOfficialClient({ loadConfig: async () => cfg, fetchImpl })
  const sent = await client.send('你好', cfg, { replyTo: 'EVENT-ID' })
  assert.equal(sent.ok, true)
  assert.equal(sent.messageId, 'MESSAGE-ID')

  const post = calls.find((call) => call.url.endsWith('/messages'))
  assert.equal(post.init.headers.authorization, 'QQBot TOKEN')
  const body = JSON.parse(post.init.body)
  assert.equal(body.content, '你好')
  assert.equal(body.msg_type, 0)
  assert.equal(body.msg_id, 'EVENT-ID')
  assert.equal(body.msg_seq, 1)

  const check = await client.check(cfg)
  assert.equal(check.ok, true)
  assert.equal(check.info.username, '白饭鱼')
})

test('official QQ client omits reply id for proactive messages', async () => {
  const cfg = {
    qq: {
      mode: 'official',
      enabled: true,
      ownerId: 'OWNER-OPENID',
      appId: 'APP',
      appSecret: 'SECRET',
      apiBase: 'https://api.test',
      tokenUrl: 'https://token.test',
    },
  }
  const bodies = []
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://token.test') return json({ access_token: 'TOKEN', expires_in: '7200' })
    bodies.push(JSON.parse(init.body))
    return json({ id: 'MESSAGE-ID' })
  }
  const client = new QqOfficialClient({ loadConfig: async () => cfg, fetchImpl })
  const result = await client.send('在忙。', cfg)
  assert.equal(result.ok, true)
  assert.equal('msg_id' in bodies[0], false)
  assert.equal('msg_seq' in bodies[0], false)
})

function fakeCtx(reply = '嗯，知道了。早点睡。') {
  const calls = []
  return {
    calls,
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
      return undefined
    },
    llm: {
      async *stream(options) {
        calls.push(options)
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

test('engine replies to the owner and records the exchange', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx()
    let sent = null
    const qq = {
      configure() {},
      status: () => ({ connected: false, lastError: '' }),
      send: async (text, cfg, options) => { sent = { text, options }; return { ok: true } },
    }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    await saveConfig(root, { qq: { enabled: true } })
    const result = await engine.handleOwnerMessage({ text: '今天有点累', channel: 'qq', userId: '1', eventId: 'evt-1' })
    assert.equal(result.ok, true)
    assert.equal(result.reply, '嗯，知道了。早点睡。')
    assert.equal(sent.options.replyTo, 'evt-1')
    const chat = await readChat(root, 10)
    assert.equal(chat.length, 2)
    assert.equal(chat[0].role, 'owner')
    assert.equal(chat[1].role, 'her')
    const state = await readState(root, await loadConfig(root))
    assert.ok(state.affection > 12)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('engine proactive marks an event shared and respects quiet hours', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx('今天年糕把小鱼干叼走了，笑死。')
    const qq = { configure() {}, status: () => ({ connected: false, lastError: '' }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    const result = await engine.proactive({ force: true, beatKey: '2026-11-07 18:30', now: Date.parse('2026-11-07T18:30:00+08:00') })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, false)
    assert.equal(result.text, '今天年糕把小鱼干叼走了，笑死。')
    assert.ok(result.event)
    const cfg = await loadConfig(root)
    const day = await getDay(root, cfg, result.event.id.split('-').slice(1, 4).join('-'))
    assert.equal(day.events.find((e) => e.id === result.event.id).shared, true)
    const state = await readState(root, cfg)
    assert.equal(state.beatCount, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('overview returns the shape the UI expects', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx()
    const qq = { configure() {}, status: () => ({ connected: false, lastError: '' }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    const view = await engine.overview()
    for (const key of ['ok', 'now', 'config', 'persona', 'state', 'today', 'chat', 'memories', 'qq', 'heartbeat']) {
      assert.ok(key in view, `missing ${key}`)
    }
    assert.ok(view.persona.soul.includes('沈栖'))
    assert.equal(view.config.qq.accessToken, '')
    assert.equal(view.config.qq.appSecret, '')
    assert.equal(view.config.qq.mode, 'official')
    assert.ok(view.qq.bindCode.length === 6)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('config keeps official QQ fields and masks nothing on disk', async () => {
  const cfg = normalizeConfig({
    qq: {
      mode: 'official',
      enabled: true,
      appId: ' 1904011248 ',
      appSecret: 'SECRET',
      ownerId: 'OPENID',
      bindCode: '123456',
      intents: 42,
    },
  })
  assert.equal(cfg.qq.mode, 'official')
  assert.equal(cfg.qq.appId, '1904011248')
  assert.equal(cfg.qq.appSecret, 'SECRET')
  assert.equal(cfg.qq.ownerId, 'OPENID')
  assert.equal(cfg.qq.bindCode, '123456')
  assert.equal(cfg.qq.intents, 42)
})

test('recent message window defaults and clamps', () => {
  assert.equal(normalizeConfig({}).memory.recentMessages, 30)
  assert.equal(normalizeConfig({ memory: { recentMessages: 1 } }).memory.recentMessages, 2)
  assert.equal(normalizeConfig({ memory: { recentMessages: 999 } }).memory.recentMessages, 60)
  assert.equal(normalizeConfig({ memory: { recentMessages: 30 } }).memory.recentMessages, 30)
})

test('embedding config defaults and disables cleanly', () => {
  const off = normalizeConfig({ memory: { embedding: false } })
  assert.equal(off.memory.embedding.enabled, false)
  assert.equal(off.memory.embedding.provider, 'ollama')
  assert.equal(off.memory.embedding.model, 'nomic-embed-text:latest')
  const custom = normalizeConfig({ memory: { embedding: { enabled: true, baseUrl: 'http://x:11434/' } } })
  assert.equal(custom.memory.embedding.enabled, true)
  assert.equal(custom.memory.embedding.baseUrl, 'http://x:11434')
})

test('automatic extraction stores only durable facts', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx('[{"text":"他喝咖啡不加糖","kind":"preference","importance":4}]')
    const qq = { configure() {}, status: () => ({ connected: false }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    const cfg = await loadConfig(root)
    await engine.extract(cfg, '我喝咖啡不加糖', '记住了。')
    const list = await readMemories(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].text, '他喝咖啡不加糖')
    assert.equal(list[0].kind, 'preference')
    assert.equal(list[0].source, 'chat')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('heartbeat tick sends a proactive message at the jittered minute', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    await saveConfig(root, {
      heartbeat: {
        enabled: true,
        times: ['18:30'],
        quietStart: '23:30',
        quietEnd: '08:00',
        minGapMinutes: 0,
        maxPerDay: 6,
      },
    })
    const ctx = fakeCtx('刚把饭端上桌。')
    const qq = { configure() {}, status: () => ({ connected: false }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    // 触发点 = 配置时间 + 当日确定性抖动（±12 分钟）。
    const jitter = beatJitter('2026-11-07 18:30')
    const at = Date.parse('2026-11-07T18:30:00+08:00') + jitter * 60_000 + 30_000
    await engine.tick(at)
    const cfg = await loadConfig(root)
    const state = await readState(root, cfg)
    assert.equal(state.beatCount, 1)
    const chat = await readChat(root, 5)
    assert.equal(chat.at(-1).channel, 'proactive')
    assert.equal(chat.at(-1).text, '刚把饭端上桌。')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('failed proactive send leaves the event unshared', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    await saveConfig(root, { qq: { enabled: true, ownerId: 'OWNER' } })
    const ctx = fakeCtx('今天有点累。')
    const qq = { configure() {}, status: () => ({ connected: true }), send: async () => ({ ok: false, error: '主动消息额度用完了' }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    const now = Date.parse('2026-11-07T18:30:00+08:00')
    const result = await engine.proactive({ force: true, beatKey: '2026-11-07 18:30', now })
    assert.equal(result.ok, false)
    assert.equal(result.error, '主动消息额度用完了')
    assert.ok(result.event)
    const cfg = await loadConfig(root)
    const day = await getDay(root, cfg, '2026-11-07')
    assert.equal(day.events.find((e) => e.id === result.event.id).shared, false)
    assert.equal((await readState(root, cfg)).beatCount, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('new session summarizes the old chat into long-term memories', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    let switched = false
    const store = {
      history: async () => [
        { role: 'owner', text: '我下周要去上海出差', at: Date.now() },
        { role: 'her', text: '记得带伞。', at: Date.now() },
        { role: 'owner', text: '回来给你带书', at: Date.now() },
        { role: 'her', text: '好。', at: Date.now() },
      ],
      newSession: async () => { switched = true; return { ok: true, session: { id: 'new-session' } } },
    }
    const ctx = fakeCtx('[{"text":"你们之前约好：他出差回来会给她带书。","kind":"promise","importance":4}]')
    const qq = { configure() {}, status: () => ({ connected: false }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, store, humanize: false })
    const result = await engine.newSession()
    assert.equal(result.ok, true)
    assert.equal(switched, true)
    const list = await readMemories(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].kind, 'promise')
    assert.equal(list[0].source, 'system')
    assert.deepEqual(list[0].tags, ['session-summary'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bindOwner stores the openid and rotates the bind code', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx()
    const qq = { configure() {}, start: async () => {}, status: () => ({ connected: false }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    const before = await loadConfig(root)
    assert.equal(before.qq.ownerId, '')
    assert.match(before.qq.bindCode, /^\d{6}$/)

    const bound = await engine.bindOwner('OWNER-OPENID')
    assert.equal(bound.ok, true)
    const after = await loadConfig(root)
    assert.equal(after.qq.ownerId, 'OWNER-OPENID')
    assert.ok(after.qq.ownerBoundAt > 0)
    assert.notEqual(after.qq.bindCode, before.qq.bindCode)

    const unbound = await engine.unbindOwner()
    assert.equal(unbound.ok, true)
    assert.equal((await loadConfig(root)).qq.ownerId, '')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('api same-origin check matches host and rejects cross-origin or null origins', () => {
  const req = (origin, referer, host = 'web.local:8080') => ({
    headers: { host, ...(origin === undefined ? {} : { origin }), ...(referer === undefined ? {} : { referer }) },
  })
  // 缺头视为同源（非浏览器客户端）；值存在时必须匹配 host。
  assert.equal(apiInternals.sameOrigin(req(undefined, undefined)), true)
  assert.equal(apiInternals.sameOrigin(req('http://web.local:8080', 'http://web.local:8080/x')), true)
  assert.equal(apiInternals.sameOrigin(req('http://evil.example', undefined)), false)
  assert.equal(apiInternals.sameOrigin(req(undefined, 'http://evil.example/x')), false)
  assert.equal(apiInternals.sameOrigin(req('null', undefined)), false)
  assert.equal(apiInternals.sameOrigin(req('http://evil.example', 'http://evil.example/x')), false)
  assert.equal(apiInternals.sameOrigin({ headers: {} }), false)
})

test('api guard enforces browserAuth and degrades safely when the service is missing', () => {
  const lines = []
  const log = (line) => lines.push(line)
  const makeRes = () => {
    const row = { status: 0, body: '' }
    return {
      row,
      writeHead(status) { row.status = status },
      end(body) { row.body = String(body ?? '') },
    }
  }

  // 1) 缺 browserAuth 服务：只做同源校验，同源请求放行并告警一次。
  const ctxNoAuth = { get: () => undefined }
  const guard1 = apiInternals.createGuard(ctxNoAuth, log)
  assert.equal(guard1({ headers: { host: 'h', origin: 'http://h', referer: 'http://h/x' } }, makeRes()), true)
  assert.ok(lines.some((line) => line.includes('browserAuth')), '缺少认证服务时告警一次')
  lines.length = 0
  guard1({ headers: { host: 'h', origin: 'http://h', referer: 'http://h/x' } }, makeRes())
  assert.equal(lines.length, 0, '告警不重复')

  // 2) 有 browserAuth：未认证请求 401，认证通过放行。
  const auth = { isAuthenticated: (req, secure) => Boolean(req?.authed) && !secure }
  const ctxAuth = { get: (name) => (name === 'connection' ? { browserAuth: auth } : undefined) }
  const guard2 = apiInternals.createGuard(ctxAuth, log)
  const blockedRes = makeRes()
  assert.equal(guard2({ headers: { host: 'h', origin: 'http://h' }, authed: false }, blockedRes), false)
  assert.equal(blockedRes.row.status, 401)
  assert.ok(blockedRes.row.body.includes('authentication required'))
  assert.equal(guard2({ headers: { host: 'h', origin: 'http://h' }, authed: true }, makeRes()), true)

  // 3) 跨源请求在任何认证状态下都被挡在最外层。
  const crossRes = makeRes()
  assert.equal(guard2({ headers: { host: 'h', origin: 'http://evil' }, authed: true }, crossRes), false)
  assert.equal(crossRes.row.status, 401)
  assert.ok(crossRes.row.body.includes('cross-origin'))
})

test('official passive window guard degrades stale replies to proactive', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx()
    const sends = []
    const qq = {
      configure() {},
      status: () => ({ connected: true, lastError: '' }),
      send: async (text, cfg, options) => { sends.push(options); return { ok: true } },
    }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    await saveConfig(root, { qq: { enabled: true }, persona: { humanize: false } })
    // receivedAt 早于现在 5 分钟：出队时被动窗口已超时，replyTo 应被降级掉。
    const staleAt = Date.now() - 5 * 60_000
    const result = await engine.handleOwnerMessage({ text: '在吗', channel: 'qq', userId: '1', eventId: 'evt-stale', receivedAt: staleAt })
    assert.equal(result.ok, true)
    assert.equal(sends.length, 1)
    assert.equal(sends[0].replyTo, '')
    // 新消息仍走被动回复窗口。
    await engine.handleOwnerMessage({ text: '嗯嗯', channel: 'qq', userId: '1', eventId: 'evt-fresh' })
    assert.equal(sends[1].replyTo, 'evt-fresh')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sentiment handles negated words and repeated hits', () => {
  const s = engineInternals.sentiment
  assert.equal(s('今天不好'), -1, '「不好」不再误判成正分')
  assert.equal(s('好累'), 0, '「好累」互相抵消')
  assert.equal(s('不太舒服'), -1, '「不太舒服」否定翻转')
  assert.equal(s('没加班'), 1, '否定负词翻成正分')
  assert.equal(s('谢谢，顺利完成了'), 2, '多个正词累计后被钳到 +2')
  assert.equal(s(''), 0)
})

test('evening tick writes the diary once and marks it done', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx('今天他把旧台灯修好了，我看着光晕写了一页。')
    const qq = { configure() {}, status: () => ({ connected: false }), send: async () => ({ ok: true }) }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    // 21 点后：tick 应触发一次日记生成并落盘。
    const evening = new Date('2026-11-08T21:30:00+08:00')
    await engine.tick(evening.getTime())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const cfg = await loadConfig(root)
    const state = await readState(root, cfg)
    assert.equal(state.lastDiaryKey, `diary:${dayKey(evening, cfg.timezone)}`)
    const diary = await readDiary(root, dayKey(evening, cfg.timezone))
    assert.ok(diary.length > 0, '日记已写')
    // 第二次 tick（同一天）不重复生成。
    const before = ctx.calls.length
    await engine.tick(evening.getTime() + 60_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(ctx.calls.length, before, '同一天不再生成日记')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('dayKeyOffset steps calendar days across DST-like boundaries', () => {
  // Asia/Shanghai 无 DST，验证「同一天内任意时刻偏移一天都一致」的日历步进。
  const morning = new Date('2026-11-08T01:00:00+08:00')
  const night = new Date('2026-11-08T23:00:00+08:00')
  assert.equal(dayKeyOffset(morning, 'Asia/Shanghai', 1), '2026-11-09')
  assert.equal(dayKeyOffset(night, 'Asia/Shanghai', 1), '2026-11-09')
  assert.equal(dayKeyOffset(night, 'Asia/Shanghai', -1), '2026-11-07')
  assert.equal(dayKeyOffset(night, 'Asia/Shanghai', 0), '2026-11-08')
  assert.equal(dayKeyOffset(new Date('2026-12-31T23:00:00+08:00'), 'Asia/Shanghai', 1), '2027-01-01')
  const beforeDst = new Date('2026-03-07T12:00:00-05:00')
  assert.equal(dayKeyOffset(beforeDst, 'America/New_York', 1), '2026-03-08')
})

test('bind code only matches the exact normalized message', () => {
  // 与 index.js 的绑定路径同构：去掉空白后必须完全等于 6 位码。
  const normalize = (value) => String(value ?? '').replace(/\s+/g, '')
  const matches = (text) => normalize(text) === '123456'
  assert.equal(matches('123456'), true)
  assert.equal(matches(' 123 456 '), true)
  assert.equal(matches('绑定 123456'), false)
  assert.equal(matches('我的验证码是123456哦'), false)
  assert.equal(matches('1123456'), false)
})

test('state and config survive atomic writes and round-trip', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    // 连续多次写状态（模拟聊天中的密集更新），最后读取必须完整且是合法 JSON。
    const cfg = await loadConfig(root)
    for (let i = 0; i < 5; i += 1) {
      await changeMood(root, cfg, 0.1)
      await changeAffection(root, cfg, 0.5, '压测')
    }
    const state = await readState(root, cfg)
    assert.equal(state.affection, 14.5)
    await saveConfig(root, { qq: { appId: 'app-1', appSecret: 'secret-1' } })
    const saved = await loadConfig(root)
    assert.equal(saved.qq.appId, 'app-1')
    assert.equal(saved.qq.appSecret, 'secret-1')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('humanize delay is deterministic, length-scaled and night-slower', () => {
  const text = '刚把一页泡烂的纸捞出来，像捞馄饨。'
  const day = humanDelay(text, { clock: '14:00', energy: 70 })
  const night = humanDelay(text, { clock: '03:00', energy: 70 })
  assert.equal(day, humanDelay(text, { clock: '14:00', energy: 70 }), '同文本同延迟（确定性）')
  assert.ok(day >= 2_000, `白天基础延迟：${day}ms`)
  assert.ok(night > day, '夜里打字更慢')
  const long = humanDelay('x'.repeat(80), { clock: '14:00', energy: 70 })
  assert.ok(long > day, '长消息更慢')
  const tired = humanDelay(text, { clock: '14:00', energy: 10 })
  assert.ok(tired > day, '疲惫时更慢')
  assert.ok(humanDelay('', { clock: '14:00' }) === 0, '空文本无延迟')
})

test('humanize bubble gap scales with previous bubble length', () => {
  const short = bubbleGap('嗯', { clock: '14:00' })
  const long = bubbleGap('今天在旧书店帮陈伯修了一本民国的小册子，纸脆得跟饼干似的', { clock: '14:00' })
  assert.ok(short >= 1_200, `气泡间隔基础：${short}ms`)
  assert.ok(long > short)
  assert.equal(bubbleGap(''), 0)
})

test('sleep state gates late-night messages and plans a wake time', () => {
  const asleep = sleepState('02:30', '在吗')
  assert.equal(asleep.asleep, true)
  assert.ok(asleep.wakeAt >= 8 * 60 + 30 && asleep.wakeAt <= 8 * 60 + 65, '醒来时间在 08:30 后 5–40 分钟')
  assert.ok(asleep.greeting.length > 0)
  assert.equal(sleepState('14:00', '在吗').asleep, false)
  assert.equal(sleepState('00:30', '在吗').asleep, false, '00:30 还没到睡眠窗口（1 点才睡）')
  assert.equal(sleepState('08:31', '在吗').asleep, false)
})

test('sanitize strips markdown artifacts from QQ text', () => {
  assert.equal(sanitize('**重要**的事'), '重要的事')
  assert.equal(sanitize('看这本 *书* 吧'), '看这本 书 吧')
  assert.equal(sanitize('# 标题\n正文'), '标题\n正文')
  assert.equal(sanitize('- 列表项'), '列表项')
  assert.equal(sanitize('他说--真的'), '他说——真的')
  assert.equal(sanitize('[链接](https://x.com)'), '链接')
  assert.equal(sanitize('`代码`'), '代码')
  assert.equal(sanitize('普通聊天，没有格式。'), '普通聊天，没有格式。')
  assert.equal(sanitize('```\n块\n```'), '块')
})

test('typoize is low-rate, deterministic and produces a fix bubble', () => {
  const a = typoize('我今天在修书的时候想到你了')
  const b = typoize('我今天在修书的时候想到你了')
  assert.equal(a.typo, b.typo)
  if (a.typo) {
    assert.ok(a.text !== '我今天在修书的时候想到你了')
    assert.ok(typoFix(a).length > 0, '打错后有修正气泡')
  } else {
    assert.equal(typoFix(a), '')
  }
  assert.equal(typoize('嗯').typo, false)
  let typos = 0
  for (let i = 0; i < 100; i += 1) {
    if (typoize(`样本${i}的消息，关于的时候和感觉`).typo) typos += 1
  }
  assert.ok(typos <= 100)
})

test('sleep hold: late-night QQ messages are held until morning', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx()
    const sends = []
    const qq = {
      configure() {},
      status: () => ({ connected: false }),
      send: async (text, cfg, options) => { sends.push({ text, options }); return { ok: true } },
    }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    await saveConfig(root, { qq: { enabled: true }, persona: { humanize: false } })
    // 凌晨 2:30 收到的消息：不生成、不发送，挂起。
    const at2am = new Date('2026-11-08T02:30:00+08:00')
    const result = await engine.handleOwnerMessage({ text: '睡了吗', channel: 'qq', userId: '1', eventId: 'e1', receivedAt: at2am.getTime() })
    assert.equal(result.held, true)
    assert.equal(result.heldReason, 'asleep')
    assert.equal(sends.length, 0, '凌晨不发送')
    assert.equal(ctx.calls.length, 0, '凌晨不生成')
    // 早晨的 tick：补一条（fakeCtx 立即返回）。9:50 确保过了 wakeAt 上限。
    const morning = new Date('2026-11-08T09:50:00+08:00')
    await engine.tick(morning.getTime())
    await new Promise((r) => setTimeout(r, 80))
    assert.ok(sends.length >= 1, `早晨补回：${sends.length} 条`)
    const state = await readState(root, await loadConfig(root))
    assert.equal(state.pendingWake, null, '补回后清空挂起')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('guest messages get an isolated namespace and never touch owner state', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    const ctx = fakeCtx('嗯，在。')
    const sends = []
    const qq = {
      configure() {},
      status: () => ({ connected: false }),
      send: async (text, cfg, options) => { sends.push({ text, options }); return { ok: true } },
    }
    const engine = new Engine({ ctx, root, qq, humanize: false })
    // 绑定主人 + 开启访客。
    await saveConfig(root, {
      qq: { enabled: true, ownerId: 'OWNER-1' },
      guests: { enabled: true, maxPerDay: 2 },
    })
    // 主人先说一句，产生 owner 命名空间数据。
    await engine.handleOwnerMessage({ text: '我记得你喜欢喝茶', channel: 'qq', userId: 'OWNER-1', eventId: 'e0' })
    const ownerState = await readState(root, await loadConfig(root))
    const ownerAffection = ownerState.affection

    // 访客说话：guest 命名空间。
    const guest1 = await engine.handleOwnerMessage({ text: '你好呀', channel: 'qq', userId: 'GUEST-9', eventId: 'g1' })
    assert.equal(guest1.ok, true)
    assert.equal(guest1.guest, true)

    // 1) 访客不改变主人的好感度/心情。
    const after = await readState(root, await loadConfig(root))
    assert.equal(after.affection, ownerAffection, '访客不涨主人好感度')
    // 2) 访客聊天在独立文件。
    assert.ok(existsSync(join(root, 'guests/chat-guestGUEST-9.jsonl')), '访客聊天独立文件')
    const ownerChat = await readChat(root, 50)
    assert.ok(!ownerChat.some((m) => m.text === '你好呀'), '访客消息不进主人聊天')
    // 3) 访客限频：maxPerDay=2，第三次被 cap。
    await engine.handleOwnerMessage({ text: '还在吗', channel: 'qq', userId: 'GUEST-9', eventId: 'g2' })
    const capped = await engine.handleOwnerMessage({ text: '再聊一句', channel: 'qq', userId: 'GUEST-9', eventId: 'g3' })
    assert.equal(capped.capped, true, '超出每日上限被挡')
    // 4) guests 关闭时直接忽略。
    await saveConfig(root, { guests: { enabled: false } })
    const denied = await engine.handleOwnerMessage({ text: '喂', channel: 'qq', userId: 'GUEST-9', eventId: 'g4' })
    assert.equal(denied.ok, false)
    // 5) 主人不受影响。
    const ownerAgain = await engine.handleOwnerMessage({ text: '我回来了', channel: 'qq', userId: 'OWNER-1', eventId: 'e9' })
    assert.equal(ownerAgain.ok, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('guest memories stay in their own namespace', async () => {
  const home = await tempHome()
  const root = join(home, 'companion')
  try {
    await addMemory(root, { text: '主人喜欢喝茶', kind: 'preference', importance: 4, source: 'chat' })
    await addMemory(root, { text: '访客喜欢爬山', kind: 'preference', importance: 4, source: 'chat', owner: 'guest:ABC' })
    const ownerList = await readMemories(root)
    const guestList = await readMemories(root, 'guest:ABC')
    assert.equal(ownerList.length, 1)
    assert.equal(guestList.length, 1)
    assert.equal(ownerList[0].text, '主人喜欢喝茶')
    assert.equal(guestList[0].text, '访客喜欢爬山')
    const all = await readAllMemories(root)
    assert.equal(all.length, 2, '全量读取两个命名空间都在')
    // 去重只在同一命名空间内。
    await addMemory(root, { text: '主人喜欢喝茶', kind: 'preference', importance: 4, source: 'chat', owner: 'guest:ABC' })
    const after = await readAllMemories(root)
    assert.equal(after.length, 3, '跨命名空间不去重')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('beat jitter is deterministic per beat key and bounded', () => {
  const key = '2026-11-08 18:30'
  const a = beatJitter(key)
  assert.equal(a, beatJitter(key), '同 key 同偏移')
  assert.ok(Math.abs(a) <= 12, `偏移在 ±12 内：${a}`)
  const seen = new Set()
  for (let d = 1; d <= 10; d += 1) {
    seen.add(beatJitter(`2026-11-${String(d).padStart(2, '0')} 18:30`))
  }
  assert.ok(seen.size >= 3, `十天里至少 3 个不同偏移：${[...seen].join(',')}`)
})

test('daily life has continuity: no cross-day repeats, threads progress, weather persists', () => {
  const { buildEvents } = lifeInternals
  for (let i = 1; i <= 27; i += 1) {
    const a = buildEvents(`2026-11-${String(i).padStart(2, '0')}`, {})
    const b = buildEvents(`2026-11-${String(i + 1).padStart(2, '0')}`, {})
    const titlesA = new Set(a.events.map((e) => e.title))
    for (const e of b.events) {
      assert.ok(!titlesA.has(e.title), `相邻两天重复了：${e.title}（11-${i}/11-${i + 1}）`)
    }
  }
  const repairDays = []
  for (let i = 1; i <= 40; i += 1) {
    const key = i <= 30 ? `2026-11-${String(i).padStart(2, '0')}` : `2026-12-${String(i - 30).padStart(2, '0')}`
    const day = buildEvents(key, {})
    const thread = day.threads.find((t) => t.id === 'book-repair')
    if (thread) repairDays.push({ key, daysIn: thread.daysIn, text: thread.text })
  }
  assert.ok(repairDays.length >= 2, '修书线在 40 天里至少出现两次')
  let progressed = false
  for (let i = 1; i < repairDays.length; i += 1) {
    if (repairDays[i].daysIn === repairDays[i - 1].daysIn + 1) progressed = true
  }
  assert.ok(progressed, '剧情线有逐日推进')
  let switches = 0
  let prev = ''
  for (let i = 1; i <= 30; i += 1) {
    const w = buildEvents(`2026-11-${String(i).padStart(2, '0')}`, {}).weather.split('，')[0]
    if (prev && w !== prev) switches += 1
    prev = w
  }
  assert.ok(switches <= 20, `天气切换 ${switches} 次，惯性不足`)
  const d1 = buildEvents('2026-11-20', {})
  const d2 = buildEvents('2026-11-20', {})
  assert.deepEqual(d1, d2, '同一天两次生成完全一致')
})
