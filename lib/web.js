/**
 * 联网取资料（实验）。
 *
 * 这一层只做两件事：
 *   - 主人消息里有 http(s) 链接 → ctx.web.fetch 取正文；
 *   - 主人明确说“帮我查/搜一下 …” → ctx.web.search 取几条来源。
 *
 * 不做模型 tool-call 协议：触发是确定性的，结果作为“资料”注入本轮 prompt。
 * 这样不改变现有单轮生成/拟人/会话链路，失败也只是退回无联网回复。
 */
const MAX_URLS = 2
const MAX_RESULTS = 5
const MAX_FETCH_CHARS = 4_000
const MAX_SNIPPET_CHARS = 240
const MAX_CONTEXT_CHARS = 6_000
const FETCH_TIMEOUT = 15_000
const SEARCH_TIMEOUT = 15_000

const URL_RE = /https?:\/\/[^\s<>"'，。；：！？、（）()【】《》]+/gi

/** 从一段话里取前两个合法 http(s) 链接（去掉句末标点）。 */
export function extractUrls(text) {
  const out = []
  const source = String(text ?? '')
  for (const raw of source.match(URL_RE) ?? []) {
    const candidate = raw.replace(/[.,;:!?，。；：！？、]+$/g, '')
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (!url.hostname) continue
      const normalized = url.toString()
      if (!out.includes(normalized)) out.push(normalized)
      if (out.length >= MAX_URLS) break
    } catch { /* 不是合法 URL */ }
  }
  return out
}

const SEARCH_PREFIX = /^(?:帮我|给我|替我|麻烦(?:你)?)?\s*(?:查一下|查下|查查|搜一下|搜下|搜搜|搜索一下|搜索下|搜索|找一下|找找)\s*[，,：:]?\s*/i

/** 是否是明确的搜索请求（避免把普通聊天误判）。 */
export function isSearchRequest(text) {
  const body = String(text ?? '').trim()
  if (!body || extractUrls(body).length > 0) return false
  return SEARCH_PREFIX.test(body)
}

/** 去掉“帮我查一下”等前缀后的查询词；太短则返回空串。 */
export function searchQueryFrom(text) {
  const body = String(text ?? '').trim()
  if (!body || !isSearchRequest(body)) return ''
  const query = body.replace(SEARCH_PREFIX, '').replace(/[。！？?!]+$/g, '').trim()
  if (query.length < 2) return ''
  return query.slice(0, 100)
}

/** 简单的 HTML → 文本；只用于给模型看，不追求完整解析。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

function clip(text, max) {
  const body = String(text ?? '').trim()
  if (body.length <= max) return body
  return `${body.slice(0, max).trimEnd()}…`
}

function hostOf(url) {
  try { return new URL(url).hostname } catch { return url }
}

function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined
  } catch {
    return undefined
  }
}

function webService(ctx) {
  try {
    return ctx?.get?.('web') ?? ctx?.web ?? null
  } catch {
    return null
  }
}

function fetchBlock(url, result) {
  const body = result?.body ?? {}
  const raw = body.kind === 'html' ? htmlToText(body.content) : String(body.content ?? '')
  const text = clip(raw, MAX_FETCH_CHARS)
  const status = Number(result?.statusCode) || 0
  const header = status >= 200 && status < 300
    ? `【链接】${url}`
    : `【链接】${url}（HTTP ${status || '?'}）`
  return text ? `${header}\n${text}` : `${header}\n（正文为空）`
}

function searchBlock(query, result) {
  const sources = Array.isArray(result?.sources) ? result.sources.slice(0, MAX_RESULTS) : []
  const lines = [`【搜索】${query}`]
  if (result?.content) lines.push(clip(result.content, 800))
  if (sources.length === 0) lines.push('（没有搜到结果）')
  for (const source of sources) {
    const title = String(source?.title ?? '').trim() || hostOf(source?.url)
    const snippet = String(source?.snippet ?? '').trim()
    lines.push(`- ${title}${snippet ? `：${clip(snippet, MAX_SNIPPET_CHARS)}` : ''}`)
    if (source?.url) lines.push(`  ${source.url}`)
  }
  return lines.join('\n')
}

/**
 * 为一条主人消息收集联网资料。
 * @returns {Promise<{ text: string, urls: string[], query: string } | null>}
 *   null 表示未启用/无触发/没有可用资料。
 */
export async function collectWebContext({ ctx, cfg, text, log = () => {} } = {}) {
  if (cfg?.persona?.web !== true) return null
  const web = webService(ctx)
  if (!web) {
    log('[companion] 联网已开启，但宿主没有 web 服务')
    return null
  }

  const urls = extractUrls(text)
  const query = urls.length === 0 && cfg?.persona?.webSearch === true ? searchQueryFrom(text) : ''
  if (urls.length === 0 && !query) return null

  const blocks = []
  if (urls.length > 0 && typeof web.fetch === 'function') {
    for (const url of urls) {
      try {
        const result = await web.fetch({ url }, timeoutSignal(FETCH_TIMEOUT))
        blocks.push(fetchBlock(url, result))
      } catch (error) {
        blocks.push(`【链接】${url}\n（读取失败：${String(error?.message ?? error).slice(0, 120)}）`)
        log(`[companion] 读取链接失败 ${url}：${error?.message ?? error}`)
      }
    }
  }

  if (query && typeof web.search === 'function') {
    try {
      const result = await web.search({ query, maxResults: MAX_RESULTS }, timeoutSignal(SEARCH_TIMEOUT))
      blocks.push(searchBlock(query, result))
    } catch (error) {
      blocks.push(`【搜索】${query}\n（搜索失败：${String(error?.message ?? error).slice(0, 120)}）`)
      log(`[companion] 搜索失败 ${query}：${error?.message ?? error}`)
    }
  }

  if (blocks.length === 0) return null
  return {
    text: clip(blocks.join('\n\n'), MAX_CONTEXT_CHARS),
    urls,
    query,
  }
}

export const __internals = {
  MAX_URLS, MAX_RESULTS, MAX_FETCH_CHARS, MAX_CONTEXT_CHARS,
  SEARCH_PREFIX, hostOf, clip, fetchBlock, searchBlock,
}
