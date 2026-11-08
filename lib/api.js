/**
 * 配置/管理界面的 HTTP 数据源。
 *
 * 路由挂在 DSH 自带的 webServer 上，和 Web 页面同源。鉴权沿用 DSH 的
 * connection.browserAuth（签名 cookie），同时做同源校验；桌面端没有这个
 * 服务时只做同源校验，保持可用。
 */
import { loadConfig } from './life.js'
import { publicConfig } from './engine.js'

const PREFIX = '/dsh-companion/api'
const MAX_BODY = 1024 * 1024

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function text(res, status, value) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(value)
}

function sameOrigin(req) {
  const headers = req?.headers ?? {}
  const host = String(headers.host ?? '')
  if (!host) return false
  const check = (raw) => {
    if (raw === undefined || raw === null || raw === '') return true
    if (String(raw) === 'null') return false
    try { return new URL(String(raw)).host === host } catch { return false }
  }
  return check(headers.origin) === true && check(headers.referer) === true
}

function createGuard(ctx, log) {
  let warned = false
  return (req, res) => {
    if (!sameOrigin(req)) {
      text(res, 401, 'cross-origin request denied\n')
      return false
    }
    let auth = null
    for (const name of ['connection', 'client-connection']) {
      try {
        const connection = ctx.get?.(name)
        if (connection?.browserAuth?.isAuthenticated) {
          auth = connection.browserAuth
          break
        }
      } catch { /* 试下一个名字 */ }
    }
    if (!auth) {
      if (!warned) {
        warned = true
        log('[companion] 没有找到 connection.browserAuth，HTTP 路由只做同源校验')
      }
      return true
    }
    let secure = false
    try { secure = ctx.get?.('webServer')?.protocol === 'https:' } catch { /* ignore */ }
    let ok = false
    try { ok = auth.isAuthenticated(req, secure) === true } catch { ok = false }
    if (!ok) {
      text(res, 401, 'dsh web authentication required\n')
      return false
    }
    return true
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function pathOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://dsh.invalid').pathname
  } catch {
    return ''
  }
}

export function registerApi({ ctx, engine, log }) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    return { ok: false, error: 'webServer 服务不可用' }
  }
  const guard = createGuard(ctx, log)

  const handler = async (req, res) => {
    if (!guard(req, res)) return
    const path = pathOf(req)
    const method = String(req.method ?? 'GET').toUpperCase()
    const sub = path.slice(PREFIX.length) || '/'

    try {
      if (method === 'GET' && (sub === '/' || sub === '/overview')) {
        json(res, 200, await engine.overview())
        return
      }

      if (method === 'GET' && sub === '/config') {
        const cfg = await loadConfig(engine.root)
        json(res, 200, { ok: true, config: publicConfig(cfg) })
        return
      }

      if (method === 'POST' && sub === '/config') {
        const body = await readBody(req)
        const cfg = await engine.saveConfig(body)
        json(res, 200, { ok: true, config: cfg })
        return
      }

      if (method === 'POST' && sub === '/persona') {
        const body = await readBody(req)
        if (typeof body?.soul !== 'string') {
          json(res, 400, { ok: false, error: '缺少 soul 字段' })
          return
        }
        json(res, 200, await engine.savePersona(body.soul))
        return
      }

      if (method === 'GET' && sub === '/session') {
        json(res, 200, { ok: true, session: await engine.sessionStatus() })
        return
      }

      if (method === 'POST' && sub === '/session/new') {
        json(res, 200, await engine.newSession())
        return
      }

      if (method === 'POST' && sub === '/bind/reset') {
        json(res, 200, await engine.unbindOwner())
        return
      }

      if (method === 'POST' && sub === '/chat') {
        const body = await readBody(req)
        const result = await engine.chatFromUi(body?.text)
        json(res, result.ok ? 200 : 400, result)
        return
      }

      if (method === 'POST' && sub === '/say') {
        const body = await readBody(req)
        const result = await engine.sayNow({ preview: body?.preview === true, force: body?.force !== false })
        json(res, result.ok ? 200 : 400, result)
        return
      }

      if (method === 'GET' && sub === '/memories') {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        json(res, 200, await engine.listMemories(url.searchParams.get('q') ?? ''))
        return
      }

      if (method === 'POST' && sub === '/memories') {
        const body = await readBody(req)
        const result = await engine.createMemory(body)
        json(res, result.ok ? 200 : 400, result)
        return
      }

      if (method === 'GET' && sub === '/memories/maintenance') {
        json(res, 200, await engine.maintenanceMemories())
        return
      }

      if (method === 'POST' && sub === '/memories/confirm') {
        const body = await readBody(req)
        const result = await engine.confirmMemory(body?.id, body?.boost === true)
        json(res, result.ok ? 200 : 404, result)
        return
      }

      if (method === 'POST' && sub === '/memories/merge') {
        const body = await readBody(req)
        const result = await engine.mergeMemories(body?.keepId, body?.dropIds)
        json(res, result.ok ? 200 : 404, result)
        return
      }

      if (method === 'POST' && sub === '/memories/restore') {
        const body = await readBody(req)
        const result = await engine.restoreMemory(body?.id)
        json(res, result.ok ? 200 : 404, result)
        return
      }

      if (method === 'DELETE' && sub.startsWith('/memories/')) {
        const id = decodeURIComponent(sub.slice('/memories/'.length))
        const result = await engine.removeMemory(id)
        json(res, result.ok ? 200 : 404, result)
        return
      }

      if (method === 'GET' && sub === '/diary') {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        json(res, 200, await engine.getDiary(url.searchParams.get('date') ?? ''))
        return
      }

      if (method === 'POST' && sub === '/diary') {
        const body = await readBody(req)
        json(res, 200, await engine.writeDiary({ force: body?.force === true }))
        return
      }

      if (method === 'POST' && sub === '/state') {
        const body = await readBody(req)
        json(res, 200, await engine.setManualState(body))
        return
      }

      if (method === 'POST' && sub === '/test-qq') {
        const cfg = await loadConfig(engine.root)
        json(res, 200, await engine.qq.check(cfg))
        return
      }

      json(res, 404, { ok: false, error: `未知接口：${method} ${sub}` })
    } catch (error) {
      log(`[companion] API ${method} ${sub} 失败：${error?.message ?? error}`)
      json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
  return { ok: true, dispose, path: PREFIX }
}

export const __internals = { sameOrigin, createGuard, PREFIX }
