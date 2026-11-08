/**
 * QQ 通道门面：官方 API（推荐）与 OneBot 11 / NapCat（兼容）二选一。
 *
 * 官方模式在 qq-official.js；本文件保留 OneBot 实现，并负责按配置切换。
 * 没有连接时不会抛错，插件进入「模拟模式」：消息只写进本地聊天记录。
 */
import { QqOfficialClient } from './qq-official.js'
import { sanitize } from './humanize.js'
const RECONNECT_MIN = 1500
const RECONNECT_MAX = 30_000
const SEND_TIMEOUT = 15_000

function stripCq(text) {
  return String(text ?? '').replace(/\[CQ:[^\]]+\]/g, '').trim()
}

function extractText(event) {
  const message = event?.message
  if (Array.isArray(message)) {
    const parts = []
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type === 'text' && segment.data && typeof segment.data.text === 'string') parts.push(segment.data.text)
      if (segment.type === 'face') parts.push('')
    }
    const joined = parts.join('').trim()
    if (joined) return joined
  }
  if (typeof message === 'string') {
    const cleaned = stripCq(message)
    if (cleaned) return cleaned
  }
  return stripCq(event?.raw_message)
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function readJsonSafe(response) {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text } }
}

class OneBotBridge {
  constructor({ loadConfig, onPrivateMessage, log } = {}) {
    this.loadConfig = typeof loadConfig === 'function' ? loadConfig : async () => ({})
    this.onPrivateMessage = typeof onPrivateMessage === 'function' ? onPrivateMessage : async () => {}
    this.log = typeof log === 'function' ? log : () => {}
    this.ws = null
    this.timer = null
    this.stopped = true
    this.connected = false
    this.lastError = ''
    this.lastEventAt = 0
    this.key = ''
    this.retry = RECONNECT_MIN
  }

  status() {
    return {
      connected: this.connected,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      mode: 'onebot11',
    }
  }

  configure(cfg) {
    const qq = cfg?.qq ?? {}
    const key = `${qq.enabled ? '1' : '0'}|${qq.wsUrl ?? ''}|${qq.accessToken ?? ''}|${qq.ownerId ?? ''}`
    if (key !== this.key) {
      this.key = key
      if (!this.stopped) this.restart(cfg)
    }
  }

  async start(cfg) {
    this.stopped = false
    this.configure(cfg ?? await this.loadConfig())
    if (!this.stopped && !this.ws && this.key.startsWith('1|')) this.connect(cfg ?? await this.loadConfig())
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* 已经关了 */ }
      this.ws = null
    }
    this.connected = false
  }

  restart(cfg) {
    this.stop()
    this.stopped = false
    if (cfg?.qq?.enabled) this.connect(cfg)
  }

  connect(cfg) {
    const qq = cfg?.qq ?? {}
    if (!qq.enabled) return
    if (typeof WebSocket !== 'function') {
      this.lastError = '当前 Node 没有内置 WebSocket，无法接收 QQ 消息（发送仍可用）'
      return
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return

    let url
    try {
      const parsed = new URL(qq.wsUrl)
      if (qq.accessToken) parsed.searchParams.set('access_token', qq.accessToken)
      url = parsed.toString()
    } catch {
      this.lastError = `WebSocket 地址无效：${qq.wsUrl}`
      return
    }

    let ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.lastError = `WebSocket 连接失败：${error?.message ?? error}`
      this.scheduleReconnect(cfg)
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connected = true
      this.lastError = ''
      this.retry = RECONNECT_MIN
      this.log(`[companion] QQ WebSocket 已连接 ${qq.wsUrl}`)
    })

    ws.addEventListener('message', (event) => {
      this.lastEventAt = Date.now()
      let payload
      try { payload = JSON.parse(String(event.data)) } catch { return }
      if (payload?.post_type !== 'message' || payload?.message_type !== 'private') return
      const userId = String(payload.user_id ?? payload.sender?.user_id ?? '')
      const selfId = String(payload.self_id ?? '')
      if (!userId || userId === selfId) return
      const text = extractText(payload)
      if (!text) return
      Promise.resolve(this.onPrivateMessage({ userId, text, raw: payload })).catch((error) => {
        this.log(`[companion] 处理 QQ 私聊失败：${error?.message ?? error}`)
      })
    })

    ws.addEventListener('close', () => {
      this.connected = false
      this.ws = null
      if (!this.stopped) this.scheduleReconnect(cfg)
    })

    ws.addEventListener('error', (event) => {
      this.connected = false
      this.lastError = event?.message ? String(event.message) : 'QQ WebSocket 连接异常'
    })
  }

  scheduleReconnect(cfg) {
    if (this.stopped || this.timer) return
    const delay = Math.round(this.retry + Math.random() * 500)
    this.retry = Math.min(RECONNECT_MAX, Math.round(this.retry * 1.8))
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect(cfg)
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  /** 发一条私聊；QQ 没启用时返回 simulated，由上层决定是否只落本地。 */
  async send(text, cfg, options = {}) {
    const qq = cfg?.qq ?? {}
    const body = sanitize(String(text ?? '').trim())
    if (!body) return { ok: false, error: '消息为空' }
    if (!qq.enabled) return { ok: false, simulated: true, error: 'QQ 未启用，已记为模拟消息' }
    const targetId = String(options.targetId ?? qq.ownerId ?? '').trim()
    if (!targetId) return { ok: false, error: '还没有填主人的 QQ 号' }

    const base = String(qq.httpUrl ?? '').replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: `QQ HTTP 地址无效：${qq.httpUrl}` }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT)
    try {
      const response = await fetch(`${base}/send_private_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(qq.accessToken),
        },
        body: JSON.stringify({
          user_id: /^\d+$/.test(targetId) ? Number(targetId) : targetId,
          message: [{ type: 'text', data: { text: body } }],
        }),
        signal: controller.signal,
      })
      const data = await readJsonSafe(response)
      const ok = response.ok && (data?.retcode === 0 || data?.status === 'ok' || data?.status === 'async')
      if (!ok) {
        const reason = data?.wording || data?.message || data?.raw || `HTTP ${response.status}`
        this.lastError = String(reason).slice(0, 300)
        return { ok: false, error: this.lastError, status: response.status }
      }
      return { ok: true, messageId: data?.data?.message_id ?? null, targetId }
    } catch (error) {
      this.lastError = error?.name === 'AbortError' ? '发送超时' : String(error?.message ?? error)
      return { ok: false, error: this.lastError }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 测试连接：拿 QQ 登录信息。 */
  async check(cfg) {
    const qq = cfg?.qq ?? {}
    if (!qq.enabled) return { ok: false, error: 'QQ 未启用' }
    const base = String(qq.httpUrl ?? '').replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) return { ok: false, error: `QQ HTTP 地址无效：${qq.httpUrl}` }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT)
    try {
      const response = await fetch(`${base}/get_login_info`, {
        headers: authHeaders(qq.accessToken),
        signal: controller.signal,
      })
      const data = await readJsonSafe(response)
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
      if (data?.retcode !== 0 && data?.status !== 'ok') {
        return { ok: false, error: String(data?.wording || data?.message || 'OneBot 返回失败').slice(0, 300) }
      }
      return { ok: true, info: data?.data ?? null }
    } catch (error) {
      return { ok: false, error: error?.name === 'AbortError' ? '连接超时' : String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }
}

export class QqBridge {
  constructor(options = {}) {
    this.onebot = new OneBotBridge(options)
    this.official = new QqOfficialClient(options)
    this.loadConfig = typeof options.loadConfig === 'function' ? options.loadConfig : null
    this.mode = 'official'
  }

  _mode(cfg) {
    return cfg?.qq?.mode === 'onebot11' ? 'onebot11' : 'official'
  }

  _client(cfg) {
    return this._mode(cfg) === 'onebot11' ? this.onebot : this.official
  }

  _switch(cfg) {
    const mode = this._mode(cfg)
    if (mode === this.mode) return false
    this.mode = mode
    this.onebot.stop()
    this.official.stop()
    return true
  }

  configure(cfg) {
    const changed = this._switch(cfg)
    const client = this._client(cfg)
    client.configure(cfg)
    if (changed) void client.start(cfg).catch(() => {})
  }

  async start(cfg) {
    const current = cfg ?? (this.loadConfig ? await this.loadConfig() : undefined)
    this._switch(current)
    await this._client(current).start(current)
  }

  stop() {
    this.onebot.stop()
    this.official.stop()
  }

  send(text, cfg, options = {}) {
    return this._client(cfg).send(text, cfg, options)
  }

  check(cfg) {
    return this._client(cfg).check(cfg)
  }

  status() {
    const client = this.mode === 'onebot11' ? this.onebot : this.official
    return { ...client.status(), mode: this.mode }
  }
}

export const __internals = { extractText, stripCq, OneBotBridge }
