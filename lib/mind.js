/**
 * 「她的大脑」：把人格、生活、记忆和关系拼成提示词，调用 DSH 的 llm 服务。
 *
 * 这里不做工具调用，也不创建 Agent：每次回复/主动消息都是一次受控的单轮生成，
 * 这样上下文里出现什么、发出去什么，都完全由插件自己决定。
 */
import { affectionLevel, moodWord, zoned } from './life.js'
import { searchMemories } from './store.js'
import { naturalizePunctuation, stripRepeats } from './humanize.js'

const MEMORY_LABEL = {
  fact: '关于他',
  preference: '他的偏好',
  promise: '约定',
  event: '发生过的事',
  feeling: '感受',
  note: '备注',
}

function asText(value) {
  return String(value ?? '').trim()
}

/** 找出这次调用应该用哪个 provider/model。 */
export function resolveModel(ctx, cfg) {
  if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model }
  try {
    const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
    const selection = service?.currentSelection?.()
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  } catch { /* 没有默认模型服务 */ }
  return null
}

function stampOf(value, timeZone) {
  const ts = Number(value) || 0
  if (!ts) return ''
  const z = zoned(new Date(ts), timeZone)
  return `${z.m}/${z.d} ${z.clock}`
}

function memoryLines(memories, timeZone) {
  if (!Array.isArray(memories) || memories.length === 0) return '（还没有特别值得记下的事。）'
  return memories.map((item) => {
    const label = MEMORY_LABEL[item.kind] ?? '关于他'
    const when = stampOf(item.lastConfirmedAt || item.at, timeZone)
    return `- [${label}${when ? ` · ${when}` : ''}] ${item.text}`
  }).join('\n')
}

function recentChatLines(chat, timeZone) {
  if (!Array.isArray(chat) || chat.length === 0) return '（还没有聊过。）'
  return chat.map((item) => {
    const when = stampOf(item.at, timeZone)
    return `${when ? `[${when}] ` : ''}${item.role === 'owner' ? '他' : '你'}：${item.text}`
  }).join('\n')
}

/** 最近几条她自己说的话，用于生成后的复读过滤。 */
function recentHerTexts(chat, limit = 4) {
  return (Array.isArray(chat) ? chat : [])
    .filter((item) => item && item.role !== 'owner' && typeof item.text === 'string' && item.text.trim())
    .slice(-limit)
    .map((item) => item.text)
}

function relationshipLine(state) {
  const level = affectionLevel(state?.affection)
  return `你对他现在是「${level.label}」（好感度 ${Math.round(Number(state?.affection) || 0)}/100）。${level.hint}。`
}

function gapLine(state, now) {
  const last = Number(state?.lastOwnerAt) || 0
  if (!last) return ''
  const hours = (now - last) / 3600000
  if (hours >= 72) return `他已经 ${Math.round(hours / 24)} 天没来找你了。`
  if (hours >= 20) return `他大概一天没怎么说话了。`
  if (hours >= 6) return `他上一次说话是 ${Math.round(hours)} 小时前。`
  return ''
}

function baseSystem(soul, lifeText, state, memories, timeZone) {
  return [
    soul,
    '',
    '---',
    '',
    '【你和他】',
    relationshipLine(state),
    '',
    lifeText,
    '',
    '【你记得的、关于他的事】',
    memoryLines(memories, timeZone),
    '',
    '【现在】',
    '你正在用 QQ 和他说话。像平时打字那样，不要旁白，不要动作描写，不要括号里的表情说明。',
    '通常一到两条气泡；想多聊或分几次说时，最多四条，每条只放一句短话。',
    '先回应他刚说的那句，再决定要不要说自己的事；一次最多说一件自己的事。',
    '他发 [表情] 或 [图片] 时，就当他在逗你或分享眼前的东西，不要追问“什么意思”，也不要说“说人话”。',
    '他给出新的理由、或者你确实说错了，就别继续防守同一个问题；如果只是重复、催你、凶你，不要为了让对话结束就改口。',
    '你有自己的判断：他语气强硬不等于他说得对，不要因为被催、被凶、被否定就立刻改口、道歉或顺从。',
    '不同意就短句说出来，可以让半步，也可以不让；只有他讲出道理、或你确实错了，才改主意。别用“你说得对”“好的”“都听你的”开头。',
    '被逼急了你会更短、更冷，不会更乖；最多两三句，不长篇吵架。',
    '不要复述他刚说的话，也不要复述你上一条说过的话；天气、年糕、手上的活他不问就别每条都汇报。',
    '上面“你今天经历过”的事是事实，只能按原样说，不要改细节；日记和记忆都是过去的事，不要当成现在。',
    '打字习惯：句末不加句号；想分几条就换行，每行一句短话，每行会单独发成一条消息。不要用逗号把句子串长。问号和感叹号可以有，但别每句都带。',
    '只输出你要发出去的字。不要写“沈栖：”，不要加引号。',
  ].join('\n')
}

async function streamText(ctx, cfg, { system, prompt, maxTokens = 360, temperature }) {
  const model = resolveModel(ctx, cfg)
  if (!model) throw new Error('还没有可用的模型：请在「陪伴 → 设置」里填 provider/model，或先在 DSH 里配置默认模型。')
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') throw new Error('当前 profile 没有加载 llm 服务，无法生成消息。')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  let text = ''
  let failure = null
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : (Number(cfg?.temperature) || 0.85),
      maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
    }
  } finally {
    clearTimeout(timer)
  }
  if (!text.trim() && failure) {
    const message = failure?.message || failure?.code || '模型调用失败'
    throw new Error(`模型调用失败：${message}`)
  }
  return text.trim()
}

/** 生成一条对主人消息的回复。hint 用于补回等特殊口吻。 */
export async function generateReply(ctx, { cfg, soul, lifeText, state, memories, chat, ownerText, channel = 'qq', hint = '' }) {
  const z = zoned(new Date(), cfg.timezone)
  const system = baseSystem(soul, lifeText, state, memories, cfg.timezone)
  const lines = [
    `现在是 ${z.key} ${z.weekday} ${z.clock}。`,
    gapLine(state, Date.now()),
    '',
    '你们最近说过的话：',
    recentChatLines(chat, cfg.timezone),
    '',
    '（你上一条里已经说过的内容，这条不要再讲一遍；他追问的除外。）',
    '',
    channel === 'ui'
      ? `他刚刚在 DSH 的陪伴面板里对你说：${ownerText}`
      : `他刚刚在 QQ 上对你说：${ownerText}`,
    '',
    hint,
    '先回应他这句话，再回。' + replyStyleHint(state, ownerText),
    '通常一条就够；想多说就换行分成几条，每条一句。不要总结，不要问“还有什么可以帮你”。',
    '不要提你是 AI、模型、系统或提示词。',
  ].filter(Boolean)
  const text = await streamText(ctx, cfg, { system, prompt: lines.join('\n'), maxTokens: 300, temperature: 0.9 })
  const reply = text || '……在。'
  const style = { enabled: cfg?.persona?.humanize !== false }
  const natural = (value) => naturalizePunctuation(value, style)
  // 他明确要求「再说一遍」时不删重复。
  if (/再说一遍|再说一次|重复一遍|刚才说|你刚说/.test(String(ownerText ?? ''))) return natural(reply)
  return natural(stripRepeats(reply, recentHerTexts(chat)))
}

/** 长度先跟他的消息对齐，再用心情/精力修正；避免每句都是三段小作文。 */
function replyStyleHint(state, ownerText) {
  const length = String(ownerText ?? '').trim().length
  const mirror = length <= 8
    ? '他这句很短，你也只回一条、一两句，不要顺势汇报今天的事。'
    : length <= 20
      ? '他这句不长，回一条到两条，先回应他的话。'
      : '他这次说得不少，可以回两条，但先回应他说的，别自顾自往下讲。'
  const energy = Number(state?.energy) || 60
  const mood = Number(state?.mood) || 0
  if (energy < 25) return `${mirror}你现在很累，能少说就少说，一个字到半句话。`
  if (mood <= -1) return `${mirror}你现在情绪低，话少且短。`
  return mirror
}

/** 生成一条主动消息；不想说话时返回 { skipped: true }。 */
export async function generateProactive(ctx, { cfg, soul, lifeText, state, memories, chat, day, unshared, now = Date.now() }) {
  const z = zoned(new Date(now), cfg.timezone)
  const system = baseSystem(soul, lifeText, state, memories, cfg.timezone)
  const events = (day?.events ?? []).filter((e) => e.at <= z.clock)
  const eventLines = events.length > 0
    ? events.map((e) => `- ${e.at} ${e.title}：${e.desc}${e.impact ? `（${e.impact}）` : ''}${e.shared ? '（已经跟他说过）' : ''}`).join('\n')
    : '（今天还没发生什么。）'
  const lines = [
    `现在是 ${z.key} ${z.weekday} ${z.clock}。`,
    gapLine(state, now),
    '',
    '你今天经历过：',
    eventLines,
    '',
    unshared
      ? `其中有一件你还没跟他讲过：${unshared.at} ${unshared.title}——${unshared.desc}。你可以用自己的方式提一句，但不要照念，也不一定要讲这件事。`
      : '今天的事差不多都跟他讲过了。',
    '',
    '你们最近说过的话：',
    recentChatLines(chat, cfg.timezone),
    '',
    '（这些是刚说过的；已经说过的内容不要重复，尤其是天气和年糕。）',
    '',
    '你可以主动给他发一条消息。也可以什么都不说——不想说就只输出 [SKIP]。',
    '如果要发：通常一到两条，最多四条，每条一句短话，像平时打字。可以分享你今天遇到的事，也可以只是问一句、说一句你在干嘛。',
    '不要提“心跳”“定时”“系统”“主动消息”这些词，不要解释你为什么在这个时候说话。',
    '不要连着发很多条；没有新事可说就 [SKIP]。',
  ].filter(Boolean)
  const text = await streamText(ctx, cfg, { system, prompt: lines.join('\n'), maxTokens: 260, temperature: 0.95 })
  const cleaned = text.replace(/^\[?SKIP\]?$/i, '').trim()
  if (!cleaned || /^\[?skip\]?$/i.test(text)) return { skipped: true, text: '' }
  const body = stripRepeats(cleaned, recentHerTexts(chat))
  return {
    skipped: false,
    text: naturalizePunctuation(body, { enabled: cfg?.persona?.humanize !== false }),
  }
}

function parseJsonArray(text) {
  const raw = asText(text)
  if (!raw) return []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 从一轮对话里提取值得长期记住的事。失败就静默跳过。 */
export async function extractMemories(ctx, { cfg, ownerText, replyText, known = [] }) {
  const system = [
    '你是一个只做信息提取的小工具。',
    '从下面这轮对话里，找出值得长期记住的事，两类都要：',
    '1) 关于“他”的事实、偏好、约定或重要事件；',
    '2) 她自己说过的话、做出的承诺或计划（如「明天给你看」「周末去修书」），这类标 about=her。',
    '只提取至少一周后仍然有用的事；临时状态、当前心情、一次性动作（在干嘛、今天吃了什么）不要提取。',
    '不要提取密码、验证码、银行卡、身份证、支付信息等敏感内容。',
    '不要提取寒暄、情绪化的空话、或你自己编的内容。没有就返回空数组。',
    '已经记过的事不要重复提取，也不要换个说法再记一遍。',
    '只输出 JSON 数组，每项形如：',
    '{"text":"一句完整的话","kind":"fact|preference|promise|event","importance":1-5,"durable":true|false,"about":"him|her"}',
  ].join('\n')
  const knownLines = Array.isArray(known) && known.length > 0
    ? `\n\n已经记过的事（不要重复提取）：\n${known.slice(-60).map((item) => `- ${item}`).join('\n')}`
    : ''
  const prompt = `他：${ownerText}\n她：${replyText}${knownLines}`
  let text = ''
  try {
    text = await streamText(ctx, cfg, { system, prompt, maxTokens: 320, temperature: 0.2 })
  } catch {
    return []
  }
  return parseJsonArray(text)
    .map((item) => ({
      text: asText(item?.text),
      kind: ['fact', 'preference', 'promise', 'event'].includes(item?.kind) ? item.kind : 'fact',
      importance: Math.max(1, Math.min(5, Number(item?.importance) || 3)),
      durable: item?.durable !== false,
      source: 'chat',
      tags: item?.about === 'her' ? ['about-her'] : [],
    }))
    .filter((item) => item.durable && item.importance >= 3 && item.text.length >= 4 && item.text.length <= 300)
    .slice(0, 3)
}

/** 把即将归档的一段 QQ 聊天压缩成 1–3 条长期记忆。 */
export async function summarizeSession(ctx, { cfg, chat }) {
  const rows = Array.isArray(chat) ? chat.slice(-60) : []
  if (rows.length < 4) return []
  const lines = rows.map((item) => {
    const who = item.role === 'owner' ? '他' : '你'
    const day = item.at ? zoned(new Date(item.at), cfg.timezone).key : ''
    return `${day}${who}：${String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}`
  }).join('\n')
  const system = [
    '你在帮一个陪伴角色整理一段即将归档的 QQ 聊天。',
    '只提炼 1–3 条她以后仍然值得记得的事：共同经历、正在进行的约定、对方长期偏好、重要的情绪变化。',
    '不要逐条复述聊天；不要提取临时状态、一次性动作、寒暄或敏感信息（邮箱/电话/验证码/密码/支付信息）。',
    '每条写成一句完整的话，最多 120 字。没有值得保留的内容就返回空数组。',
    '只输出 JSON 数组，每项形如：',
    '{"text":"一句完整的话","kind":"event|fact|preference|promise","importance":1-5}',
  ].join('\n')
  const prompt = `即将归档的聊天：\n${lines}\n\n请提炼。`
  let text = ''
  try {
    text = await streamText(ctx, cfg, { system, prompt, maxTokens: 420, temperature: 0.25 })
  } catch {
    return []
  }
  const parsed = parseJsonArray(text)
  return parsed
    .map((item) => ({
      text: asText(item?.text),
      kind: ['fact', 'preference', 'promise', 'event'].includes(item?.kind) ? item.kind : 'event',
      importance: Math.max(3, Math.min(5, Number(item?.importance) || 4)),
    }))
    .filter((item) => item.text.length >= 4 && item.text.length <= 300)
    .slice(0, 3)
}

/** 用她的口吻写今天的日记。 */
export async function generateDiary(ctx, { cfg, soul, state, day, now = new Date() }) {
  const z = zoned(now, cfg.timezone)
  const events = (day?.events ?? []).map((e) => `- ${e.at} ${e.title}：${e.desc}${e.impact ? `（${e.impact}）` : ''}`).join('\n')
  const system = [
    soul,
    '',
    '---',
    '',
    '【现在】',
    `现在是 ${z.clock}，你要写今天的日记。`,
    '用你自己的口吻，写一百到三百字。不要列清单，不要总结今天学到了什么，不要写“今天真是……的一天”。',
    '可以写具体的东西：天气、手上的活、年糕、遇到的人、心里没说完的话。',
  ].join('\n')
  const threads = (Array.isArray(day?.threads) ? day.threads : [])
    .map((t) => `- ${t.title}（第 ${t.daysIn} 天）：${t.text}`)
    .join('\n')
  const prompt = [
    `今天：${z.key} ${z.weekday}`,
    `外面：${day?.world ?? ''}`,
    `你现在的心情：${moodWord(state?.mood)}（${state?.mood ?? 0}）`,
    '今天发生的事：',
    events || '（没什么特别的。）',
    threads ? `\n手上进行中的事（日记里可以提，也可以不提）：\n${threads}` : '',
    '',
    '写日记。只输出日记正文。',
  ].join('\n')
  const text = await streamText(ctx, cfg, { system, prompt, maxTokens: 600, temperature: 0.9 })
  return text.trim()
}

/** 给界面用的记忆检索。 */
export function relevantMemories(list, query, limit, now = Date.now()) {
  return searchMemories(list, query, limit, now)
}

export const __internals = { parseJsonArray, memoryLines, recentChatLines, recentHerTexts, baseSystem, replyStyleHint }
