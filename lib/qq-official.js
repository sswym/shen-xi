/**
 * QQ 官方机器人（QQ 开放平台 API v2）通道。
 *
 * 只做三件事：
 *   1. 用 AppID / AppSecret 换 access_token（2 小时有效，提前刷新）；
 *   2. 连官方 WebSocket 网关，收 C2C_MESSAGE_CREATE（私聊）事件；
 *   3. 调 `/v2/users/{openid}/messages` 发私聊文本。
 *
 * 身份：官方 API 的 user_id 是 OpenID，不是 QQ 号。主人第一次私聊时用
 * 界面里显示的绑定码完成绑定，之后只认这个 OpenID。
 *
 * 主动消息：不传 msg_id 就是主动消息，受开放平台频控；回复某条消息时传
 * 事件里的 msg_id + 递增 msg_seq，走 5 分钟被动回复窗口。
 *
 * 协议参考：https://bot.q.qq.com/wiki/develop/api-v2/
 */
import { bubbleGap, sanitize, typoFix, typoize } from './humanize.js'

const API_BASE = 'https://api.bot.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const HTTP_TIMEOUT = 15_000
const SEND_TIMEOUT = 15_000
const RECONNECT_MIN = 1_500
const RECONNECT_MAX = 30_000
const TOKEN_MARGIN = 60_000
const DEFAULT_INTENTS = 100663296 // PUBLIC_MESSAGES | INTERACTION
const TEXT_CHUNK = 1_800
const MAX_BUBBLES = 4
const EVENT_TTL = 5 * 60_000
const SEQ_TTL = 5 * 60_000

function asText(value) {
  return String(value ?? '').trim()
}

function errorText(error) {
  return asText(error?.message ?? error) || '未知错误'
}

function readJsonSafe(response) {
  return response.text().then((text) => {
    if (!text) return null
    try { return JSON.parse(text) } catch { return { raw: text } }
  })
}

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (timer.unref) timer.unref()
  return { controller, done: () => clearTimeout(timer) }
}

/** 官方消息正文里的 @ 形如 <@member_openid> / <@all>；机器人自己已被平台剥离。 */
export function stripMentions(text) {
  return String(text ?? '')
    .replace(/<@!?[^>\s]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** RFC3339 / 秒 / 毫秒 -> 毫秒时间戳。 */
export function eventTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/** 把一条 WS 事件投影成插件内部消息；不是私聊消息时返回 null。 */
export function officialMessage(payload) {
  if (payload === null || typeof payload !== 'object') return null
  if (String(payload.t ?? '') !== 'C2C_MESSAGE_CREATE') return null
  const d = payload.d !== null && typeof payload.d === 'object' ? payload.d : {}
  const author = d.author !== null && typeof d.author === 'object' ? d.author : {}
  const userId = asText(author.user_openid ?? author.id)
  const eventId = asText(d.id ?? payload.id)
  let text = stripMentions(d.content)
  const attachments = Array.isArray(d.attachments) ? d.attachments : []
  if (attachments.length > 0) text = `${text}${text ? ' ' : ''}[图片/附件]`
  if (userId === '' || text === '') return null
  return {
    userId,
    text,
    eventId,
    timestamp: eventTime(d.timestamp),
    raw: payload,
  }
}

export function splitText(text, limit = TEXT_CHUNK) {
  const body = String(text ?? '').trim()
  if (!body) return []
  const max = Math.max(200, Number(limit) || TEXT_CHUNK)
  if (body.length <= max) return [body]
  const out = []
  let rest = body
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf('。', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    const piece = rest.slice(0, cut).trim()
    if (piece) out.push(piece)
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

/**
 * 把一条生成结果拆成多个 QQ 消息气泡。
 *
 * 模型用换行分隔“想分开发的话”；如果整段塞进一个 content，QQ 只显示一个
 * 气泡里的两行。这里按换行拆开，再对每个气泡做长度切分；最多 4 个，
 * 多出来的段落合并进最后一个气泡，避免一次刷屏。
 */
export function splitBubbles(text, limit = TEXT_CHUNK, maxBubbles = MAX_BUBBLES) {
  const body = String(text ?? '').trim()
  if (!body) return []
  const max = Math.max(1, Math.floor(Number(maxBubbles) || MAX_BUBBLES))
  const parts = body.split(/\n+/).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return []
  if (parts.length > max) {
    const head = parts.slice(0, max - 1)
    const tail = parts.slice(max - 1).join('\n')
    parts.length = 0
    parts.push(...head, tail)
  }
  const out = []
  for (const part of parts) out.push(...splitText(part, limit))
  if (out.length > max) {
    const head = out.slice(0, max - 1)
    const tail = out.slice(max - 1).join('\n')
    return [...head, ...splitText(tail, limit)]
  }
  return out
}

export class QqOfficialClient {
  constructor({ loadConfig, onPrivateMessage, log, fetchImpl, wsFactory } = {}) {
    this.loadConfig = typeof loadConfig === 'function' ? loadConfig : async () => ({})
    this.onPrivateMessage = typeof onPrivateMessage === 'function' ? onPrivateMessage : async () => {}
    this.log = typeof log === 'function' ? log : () => {}
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch?.bind(globalThis)
    this.wsFactory = typeof wsFactory === 'function'
      ? wsFactory
      : (url) => {
        if (typeof WebSocket !== 'function') throw new Error('当前 Node 没有内置 WebSocket')
        return new WebSocket(url)
      }

    this.ws = null
    this.stopped = true
    this.connected = false
    this.connecting = false
    this.lastError = ''
    this.lastEventAt = 0
    this.key = ''
    this.lastCfg = null
    this.selfId = ''
    this.botName = ''

    this.token = ''
    this.tokenExpiresAt = 0
    this.tokenInflight = null

    this.seq = null
    this.sessionId = null
    this.heartbeatTimer = null
    this.heartbeatAckTimer = null
    this.reconnectTimer = null
    this.retry = RECONNECT_MIN
    this.ready = false

    this.seen = new Map()
    this.sequences = new Map()
  }

  status() {
    return {
      connected: this.connected,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      mode: 'official',
      selfId: this.selfId,
      botName: this.botName,
      sessionId: this.sessionId,
      ready: this.ready,
    }
  }

  keyOf(cfg) {
    const qq = cfg?.qq ?? {}
    return [
      qq.enabled ? '1' : '0',
      asText(qq.appId),
      asText(qq.appSecret),
      asText(qq.apiBase) || API_BASE,
      asText(qq.tokenUrl) || TOKEN_URL,
      String(Number(qq.intents) || DEFAULT_INTENTS),
    ].join('|')
  }

  configure(cfg) {
    if (cfg) this.lastCfg = cfg
    const key = this.keyOf(cfg)
    if (key === this.key) return
    this.key = key
    if (!this.stopped) this.restart(cfg)
  }

  async start(cfg) {
    this.stopped = false
    const current = cfg ?? await this.loadConfig()
    this.lastCfg = current
    this.configure(current)
    if (!this.stopped && !this.ws && !this.connecting && this.key.startsWith('1|')) {
      await this.connect(current)
    }
  }

  stop() {
    this.stopped = true
    this.connected = false
    this.ready = false
    this.clearHeartbeat()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws !== null) {
      try { this.ws.close() } catch { /* 已经关了 */ }
      this.ws = null
    }
    this.seq = null
    this.sessionId = null
    this.retry = RECONNECT_MIN
    this.token = ''
    this.tokenExpiresAt = 0
  }

  restart(cfg) {
    this.stop()
    this.stopped = false
    this.key = this.keyOf(cfg)
    if (cfg?.qq?.enabled) {
      void this.connect(cfg).catch((error) => {
        this.lastError = errorText(error)
        this.scheduleReconnect(cfg)
      })
    }
  }

  scheduleReconnect(cfg) {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = Math.round(this.retry + Math.random() * 500)
    this.retry = Math.min(RECONNECT_MAX, Math.round(this.retry * 1.8))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect(cfg).catch((error) => {
        this.lastError = errorText(error)
        this.scheduleReconnect(cfg)
      })
    }, delay)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  async getToken(force = false) {
    const qq = (await this.loadConfig())?.qq ?? {}
    const appId = asText(qq.appId)
    const appSecret = asText(qq.appSecret)
    if (!appId || !appSecret) throw new Error('还没有配置 QQ 官方机器人的 AppID / AppSecret')
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token
    if (this.tokenInflight !== null) return this.tokenInflight
    if (typeof this.fetch !== 'function') throw new Error('当前环境没有 fetch')

    const tokenUrl = asText(qq.tokenUrl) || TOKEN_URL
    this.tokenInflight = (async () => {
      const { controller, done } = withTimeout(HTTP_TIMEOUT)
      try {
        const response = await this.fetch(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: appSecret }),
          signal: controller.signal,
        })
        const data = await readJsonSafe(response)
        if (!response.ok) throw new Error(`access_token 接口 HTTP ${response.status}`)
        if (data && data.code !== undefined && data.code !== null && Number(data.code) !== 0) {
          throw new Error(`access_token 获取失败 code=${data.code} ${asText(data.message)}`)
        }
        const token = asText(data?.access_token)
        if (!token) throw new Error('access_token 响应缺少 access_token')
        const ttl = Number(data?.expires_in)
        const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 7_200_000
        this.token = token
        this.tokenExpiresAt = Date.now() + Math.max(60_000, ttlMs - TOKEN_MARGIN)
        return token
      } finally {
        done()
        this.tokenInflight = null
      }
    })()
    return this.tokenInflight
  }

  async api(method, path, body, retry = true) {
    const qq = (await this.loadConfig())?.qq ?? {}
    const base = (asText(qq.apiBase) || API_BASE).replace(/\/+$/, '')
    let token
    try {
      token = await this.getToken()
    } catch (error) {
      return { ok: false, status: null, error: `获取 access_token 失败：${errorText(error)}`, code: null, data: null }
    }
    const { controller, done } = withTimeout(HTTP_TIMEOUT)
    try {
      const response = await this.fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await readJsonSafe(response)
      if (response.status === 401 && retry) {
        this.token = ''
        this.tokenExpiresAt = 0
        return this.api(method, path, body, false)
      }
      const code = data && data.code !== undefined && data.code !== null ? Number(data.code) : 0
      if (!response.ok || (Number.isFinite(code) && code !== 0)) {
        const reason = asText(data?.message ?? data?.msg) || `HTTP ${response.status}`
        return { ok: false, status: response.status, error: `${reason}${code ? `（code ${code}）` : ''}`, code: code || null, data }
      }
      return { ok: true, status: response.status, data, error: null, code: null }
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error?.name === 'AbortError' ? '请求超时' : errorText(error),
        code: null,
        data: null,
      }
    } finally {
      done()
    }
  }

  async connect(cfg) {
    const qq = cfg?.qq ?? {}
    if (cfg) this.lastCfg = cfg
    if (!qq.enabled) return
    if (this.connecting) return
    if (this.ws !== null) return
    if (!asText(qq.appId) || !asText(qq.appSecret)) {
      this.lastError = '还没有配置 QQ 官方机器人 AppID / AppSecret'
      return
    }
    this.connecting = true
    try {
      const gateway = await this.api('GET', '/gateway')
      if (!gateway.ok) throw new Error(gateway.error || '获取 WebSocket 网关失败')
      const url = asText(gateway.data?.url)
      if (!url) throw new Error('网关响应缺少 url')
      if (this.stopped) return
      const ws = this.wsFactory(url)
      this.ws = ws
      this.bindSocket(ws, cfg)
      this.log(`[companion] QQ 官方网关连接中 ${url}`)
    } catch (error) {
      this.lastError = errorText(error)
      this.ws = null
      this.scheduleReconnect(cfg)
    } finally {
      this.connecting = false
    }
  }

  bindSocket(ws, cfg) {
    const on = (name, fn) => {
      if (typeof ws.addEventListener === 'function') ws.addEventListener(name, fn)
      else if (typeof ws.on === 'function') ws.on(name, fn)
    }
    on('open', () => {
      this.lastError = ''
      this.log('[companion] QQ 官方网关已连接，等待 READY')
    })
    on('message', (event) => {
      if (this.ws !== ws) return
      const raw = event && typeof event === 'object' && 'data' in event ? event.data : event
      this.handlePayload(raw, cfg)
    })
    on('error', (event) => {
      if (this.ws !== ws) return
      this.connected = false
      this.lastError = asText(event?.message) || 'QQ 官方网关连接异常'
    })
    on('close', () => {
      if (this.ws !== ws) return
      this.connected = false
      this.ready = false
      this.ws = null
      this.clearHeartbeat()
      if (!this.stopped) this.scheduleReconnect(this.lastCfg ?? cfg)
    })
  }

  handlePayload(raw, cfg) {
    let payload
    try {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      payload = JSON.parse(text)
    } catch {
      return
    }
    if (payload === null || typeof payload !== 'object') return
    if (typeof payload.s === 'number') this.seq = payload.s

    switch (payload.op) {
      case 10:
        this.startHeartbeat(Number(payload.d?.heartbeat_interval) || 45_000)
        void this.identify(cfg)
        return
      case 11:
        if (this.heartbeatAckTimer !== null) {
          clearTimeout(this.heartbeatAckTimer)
          this.heartbeatAckTimer = null
        }
        return
      case 1:
        this.sendFrame({ op: 1, d: this.seq })
        return
      case 0:
        this.handleDispatch(payload)
        return
      case 7:
        this.log('[companion] QQ 网关要求重连（op7）')
        this.closeSocket()
        return
      case 9:
        this.log('[companion] QQ 网关会话失效（op9），重新 Identify')
        this.sessionId = null
        this.seq = null
        this.closeSocket()
        return
      default:
        return
    }
  }

  handleDispatch(payload) {
    const eventName = asText(payload.t)
    if (eventName === 'READY') {
      const d = payload.d !== null && typeof payload.d === 'object' ? payload.d : {}
      this.sessionId = asText(d.session_id) || null
      this.selfId = asText(d.user?.id) || this.selfId
      this.connected = true
      this.ready = true
      this.retry = RECONNECT_MIN
      this.lastError = ''
      this.log(`[companion] QQ 官方网关 READY（self=${this.selfId || '?'}）`)
      return
    }
    if (eventName === 'RESUMED') {
      this.connected = true
      this.ready = true
      this.retry = RECONNECT_MIN
      this.lastError = ''
      return
    }
    if (eventName !== 'C2C_MESSAGE_CREATE') return
    this.lastEventAt = Date.now()
    const message = officialMessage(payload)
    if (message === null) return
    if (this.isDuplicate(message.eventId)) return
    Promise.resolve(this.onPrivateMessage(message)).catch((error) => {
      this.log(`[companion] 处理 QQ 私聊失败：${errorText(error)}`)
    })
  }

  isDuplicate(eventId) {
    const id = asText(eventId)
    if (!id) return false
    const now = Date.now()
    for (const [key, at] of this.seen) {
      if (now - at > EVENT_TTL) this.seen.delete(key)
    }
    if (this.seen.has(id)) return true
    this.seen.set(id, now)
    while (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value)
    return false
  }

  async identify(cfg) {
    let token
    try {
      token = await this.getToken()
    } catch (error) {
      this.lastError = `网关登录失败：${errorText(error)}`
      this.closeSocket()
      return
    }
    const auth = `QQBot ${token}`
    if (this.sessionId !== null && this.seq !== null) {
      this.sendFrame({ op: 6, d: { token: auth, session_id: this.sessionId, seq: this.seq } })
      return
    }
    const qq = cfg?.qq ?? {}
    const intents = Number(qq.intents) || DEFAULT_INTENTS
    this.sendFrame({
      op: 2,
      d: {
        token: auth,
        intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh', $device: 'dsh' },
      },
    })
  }

  sendFrame(frame) {
    if (this.ws === null || typeof this.ws.send !== 'function') return false
    try {
      this.ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  startHeartbeat(interval) {
    this.clearHeartbeat()
    const ms = Math.max(5_000, Number(interval) || 45_000)
    this.heartbeatTimer = setInterval(() => {
      if (!this.sendFrame({ op: 1, d: this.seq })) return
      if (this.heartbeatAckTimer !== null) clearTimeout(this.heartbeatAckTimer)
      this.heartbeatAckTimer = setTimeout(() => {
        this.lastError = '心跳没有收到 op11 回执，准备重连'
        this.closeSocket()
      }, Math.max(ms * 2, 8_000))
      if (this.heartbeatAckTimer.unref) this.heartbeatAckTimer.unref()
    }, ms)
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
  }

  clearHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.heartbeatAckTimer !== null) {
      clearTimeout(this.heartbeatAckTimer)
      this.heartbeatAckTimer = null
    }
  }

  closeSocket() {
    const ws = this.ws
    this.ws = null
    this.connected = false
    this.clearHeartbeat()
    if (ws !== null) {
      try { ws.close() } catch { /* ignore */ }
    }
    if (!this.stopped) this.scheduleReconnect(this.lastCfg)
  }

  nextSeq(msgId) {
    const key = asText(msgId)
    const now = Date.now()
    for (const [id, row] of this.sequences) {
      if (now - row.at > SEQ_TTL) this.sequences.delete(id)
    }
    const used = this.sequences.get(key)?.seq ?? 0
    const next = used + 1
    this.sequences.set(key, { seq: next, at: now })
    while (this.sequences.size > 300) this.sequences.delete(this.sequences.keys().next().value)
    return next
  }

  /** 发一条私聊。replyTo 存在时走 5 分钟被动回复窗口。 */
  async send(text, cfg, options = {}) {
    const qq = cfg?.qq ?? {}
    const raw = String(text ?? '').trim()
    if (!raw) return { ok: false, error: '消息为空' }
    if (!qq.enabled) return { ok: false, simulated: true, error: 'QQ 未启用，已记为模拟消息' }
    const targetId = asText(options.targetId ?? qq.ownerId)
    if (!targetId) return { ok: false, error: '还没有绑定主人（去「陪伴 → 设置」看绑定码）' }
    if (!asText(qq.appId) || !asText(qq.appSecret)) return { ok: false, error: '还没有配置 AppID / AppSecret' }

    const replyTo = asText(options.replyTo)
    // 拟人层：markdown 清洗 + 偶发错字（带修正气泡）。配置关闭时全部直通。
    const humanize = cfg?.persona?.humanize !== false
    const clean = sanitize(raw)
    if (!clean) return { ok: false, error: '消息为空' }
    const typo = humanize ? typoize(clean) : { text: clean, typo: false }
    const bubbles = splitBubbles(typo.text)
    if (typo.typo && bubbles.length < MAX_BUBBLES) bubbles.push(typoFix(typo))
    let lastId = null
    for (let i = 0; i < bubbles.length; i += 1) {
      if (i > 0 && humanize) {
        const gap = bubbleGap(bubbles[i - 1], { clock: options.clock ?? '' })
        await new Promise((resolve) => setTimeout(resolve, gap))
      }
      const bubble = bubbles[i]
      const payload = { content: bubble, msg_type: 0 }
      if (replyTo) {
        payload.msg_id = replyTo
        payload.msg_seq = this.nextSeq(replyTo)
      }
      const result = await this.api('POST', `/v2/users/${encodeURIComponent(targetId)}/messages`, payload)
      if (!result.ok) {
        this.lastError = result.error || '发送失败'
        return { ok: false, error: this.lastError, status: result.status, code: result.code, targetId, bubbles: bubbles.length }
      }
      lastId = result.data?.id ?? lastId
    }
    return { ok: true, messageId: lastId, targetId, bubbles: bubbles.length, chunks: bubbles.length, typo: typo.typo }
  }

  /** 测试连接：换 token，再取机器人自己的资料。 */
  async check(cfg) {
    const qq = cfg?.qq ?? {}
    if (!asText(qq.appId) || !asText(qq.appSecret)) {
      return { ok: false, error: '还没有配置 AppID / AppSecret' }
    }
    try {
      await this.getToken()
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
    const me = await this.api('GET', '/users/@me')
    if (me.ok) {
      const info = me.data ?? null
      this.botName = asText(info?.username) || this.botName
      this.selfId = asText(info?.id) || this.selfId
      return { ok: true, info }
    }
    const gateway = await this.api('GET', '/gateway')
    if (gateway.ok) return { ok: true, info: { gateway: gateway.data?.url ?? null } }
    return { ok: false, error: me.error || gateway.error || '连接失败' }
  }
}

export const __internals = {
  API_BASE,
  TOKEN_URL,
  DEFAULT_INTENTS,
  MAX_BUBBLES,
  splitText,
  splitBubbles,
  stripMentions,
  officialMessage,
  eventTime,
}
