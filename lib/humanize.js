/**
 * 拟人层：让她「像人打字」的那部分。
 *
 * 全部纯函数 + 显式注入时间，不碰文件、不发网络：
 *   - humanDelay / bubbleGap：回复与气泡的节奏（同文本确定性，可测）；
 *   - sleepState：作息门控（凌晨该不该回、早上怎么补）；
 *   - sanitize：QQ 纯文本不允许 markdown 泄漏；
 *   - typoize：小概率注入打字错误，配一条修正气泡；
 *   - lengthHint：按心情/精力给生成 prompt 的长度指示。
 *
 * 配置开关 persona.humanize（默认开，测试时可关）；关闭时 humanDelay
 * 返回 0、typoize 原样返回，行为退回「生成即发」。
 */
import { inQuietHours, minutesOf, zoned } from './life.js'
import { createHash } from 'node:crypto'

const TYPES = {
  // 常见错字：同音/近形替换（拼音输入法的典型错误）。
  的: '得', 在: '再', 那: '哪', 知道: '只道', 什么: '神马', 现在: '现再',
  时候: '时侯', 以为: '已为', 因为: '因味', 感觉: '感角',
  想: '像', 做: '作', 陪: '赔', 睡: '谁', 给: '跟',
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/** 确定性种子：同一段文本永远得到同一个「人的节奏」。 */
function seedOf(text, salt = '') {
  return createHash('sha1').update(`${salt}|${String(text ?? '')}`).digest()
}
/** QQ 纯文本：剥掉 markdown 记号，人不会发这些。 */
export function sanitize(text) {
  let body = String(text ?? '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '').trim())
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/(\S)\s*[-*]{2}\s*(\S)/g, '$1——$2')
    .replace(/^\s*[-=]{3,}\s*$/gm, '')
    .trim()
  body = body.replace(/\n{3,}/g, '\n\n')
  return body
}
/** 0..1 的确定性伪随机数（对 seed 取两字节）。 */
function rollOf(text, salt) {
  const hash = seedOf(text, salt)
  return ((hash[0] << 8) | hash[1]) / 65536
}

/**
 * 「打字时间」：基础 + 字数×每字耗时 + 噪声，夜里更慢。
 * 长消息（>60 字）按她重新组织语言算，更慢。
 */
export function humanDelay(text, { clock = '', mood = 0, energy = 60, enabled = true } = {}) {
  if (!enabled) return 0
  const length = String(text ?? '').length
  if (length === 0) return 0
  const night = isNight(clock)
  const base = night ? 6_000 : 2_000
  const tired = clamp(1 - energy / 100, 0, 1)
  const per = night ? 90 : 45
  const noise = rollOf(text, 'delay') * 4_000
  const long = length > 60 ? 6_000 : 0
  const total = base + length * per * (1 + tired * 0.6) + noise + long
  return Math.round(Math.min(total, night ? 120_000 : 60_000))
}

/**
 * 心跳时间抖动：对 beat key 哈希出 ±maxMinutes 内的偏移（三角分布近似
 * 正态——两个均匀数平均）。同一天同一个心跳点偏移固定，跨天不同。
 */
export function beatJitter(beatKey, maxMinutes = 12) {
  const a = rollOf(beatKey, 'jitter-a')
  const b = rollOf(beatKey, 'jitter-b')
  const tri = (a + b) / 2 // 0..1，中间密两头疏
  return Math.round((tri * 2 - 1) * maxMinutes)
}

/** 两个气泡之间的间隔：人在发完一条后看一眼再打下一条。 */
export function bubbleGap(prevText, { clock = '' } = {}) {
  const length = String(prevText ?? '').length
  if (length === 0) return 0
  const night = isNight(clock)
  const base = night ? 2_500 : 1_200
  return Math.round(base + length * 30 + rollOf(prevText, 'gap') * 2_000)
}

const SLEEP_WINDOW = { start: '01:00', end: '08:30' }

/**
 * 作息门控：凌晨她应该在睡觉。
 * - asleep：此刻在睡眠窗口内（消息会积压到早上）；
 * - wakeAt：醒来后补第一条回复的分钟数（08:30 后 5–40 分钟内，确定性）；
 * - greeting：补回复时该带的口吻提示。
 */
export function sleepState(clock, text = '') {
  const asleep = inQuietHours(clock, SLEEP_WINDOW.start, SLEEP_WINDOW.end)
  if (!asleep) return { asleep: false, wakeAt: 0, greeting: '' }
  const wakeMinute = 8 * 60 + 30 + Math.round(rollOf(text, 'wake') * 35)
  return {
    asleep: true,
    wakeAt: wakeMinute,
    greeting: '刚醒，还没完全清醒。不用解释你为什么现在才回，也不用为深夜没回道歉。',
  }
}

/** 凌晨 00:00–06:00 算「夜里」。 */
export function isNight(clock) {
  const m = minutesOf(clock)
  if (m === null) return false
  return m < 6 * 60
}


/**
 * 错字注入：小概率（默认 6%）把一个词打错，返回新文本 + 是否打错。
 * 只处理第一条气泡，且文本足够长（>4 字）才动手。
 */
export function typoize(text, { rate = 0.06 } = {}) {
  const body = String(text ?? '')
  if (body.length < 5) return { text: body, typo: false }
  if (rollOf(body, 'typo') >= rate) return { text: body, typo: false }
  const words = Object.keys(TYPES)
  // 找到文本中第一个可替换的词。
  let target = null
  let at = -1
  for (const word of words) {
    const found = body.indexOf(word)
    if (found !== -1 && (at === -1 || found < at)) {
      target = word
      at = found
    }
  }
  if (!target) return { text: body, typo: false }
  const replacement = TYPES[target]
  if (body.includes(replacement)) {
    // 替换结果已经在文本里（如「已经」），换词没意义。
    return { text: body, typo: false }
  }
  const next = body.slice(0, at) + replacement + body.slice(at + target.length)
  return { text: next, typo: true, fix: target }
}

/** 打错后那条修正消息。 */
export function typoFix(typoResult) {
  if (!typoResult?.typo) return ''
  return `${typoResult.fix}*`
}

/** 按心情/精力给生成的长度指示；方差来自状态，不是随机数。 */
export function lengthHint({ mood = 0, energy = 60 } = {}) {
  if (energy < 25) return '你现在很累，话最少：一个字到半句话。'
  if (mood <= -1) return '你现在情绪低，话少且短，不想多解释。'
  if (mood >= 1 && energy >= 70) return '你现在状态不错，话可以多一点，两三句。'
  return '一到三句，短一点。'
}

/** 睡眠窗口内收到消息时的挂起策略。 */
export function sleepAck(clock) {
  const s = sleepState(clock)
  return s.asleep ? { hold: true, wakeAt: s.wakeAt } : { hold: false }
}

export const __internals = { TYPES, SLEEP_WINDOW, seedOf, rollOf, clamp }
