/**
 * 语义记忆索引：用本机 Ollama 的 embedding 模型给 memories.json 建一个
 * 轻量向量索引（默认 nomic-embed-text）。
 *
 * - 索引单独存在 `$DSH_HOME/companion/embeddings.json`，不污染 memories.json。
 * - 只索引 active 记忆；文本 hash 变化会重新算；删除/旧的向量会被裁掉。
 * - Ollama 不可用时返回 null，让上层自动退回关键词检索；失败后冷却 60 秒，
 *   避免每一轮都等超时。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { memoryWeight } from './store.js'

const INDEX_VERSION = 1
const INDEX_FILE = 'embeddings.json'
const BATCH_SIZE = 16
const FAIL_COOLDOWN = 60_000
const MAX_TEXT = 2_000

function asText(value) {
  return String(value ?? '').trim()
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[\s，。！？、,.!?;；:：""''（）()《》【】[\]{}]/g, '')
  const out = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

function lexicalScore(item, query) {
  const text = String(item?.text ?? '').toLowerCase()
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return 0
  let score = 0
  if (text.includes(q)) score += 20
  for (const gram of bigrams(q)) if (text.includes(gram)) score += 2
  return score
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0
    const y = Number(b[i]) || 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export class MemoryIndex {
  constructor({ root, log, fetchImpl } = {}) {
    this.root = root
    this.log = typeof log === 'function' ? log : () => {}
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch?.bind(globalThis)
    this.file = join(root, INDEX_FILE)
    this.cache = null
    this.queue = Promise.resolve()
    this.failedUntil = 0
    this.lastError = ''
    this.queryCache = new Map()
  }

  hash(text) {
    return createHash('sha1').update(String(text ?? '')).digest('hex')
  }

  config(cfg) {
    const embedding = cfg?.memory?.embedding ?? {}
    return {
      enabled: embedding.enabled !== false,
      provider: String(embedding.provider ?? 'ollama'),
      baseUrl: String(embedding.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      model: String(embedding.model ?? 'nomic-embed-text:latest').trim() || 'nomic-embed-text:latest',
      timeoutMs: clamp(embedding.timeoutMs, 1000, 30000, 8000),
    }
  }

  modelKey(config) {
    return `${config.provider}:${config.model}`
  }

  serialize(task) {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  async load() {
    if (this.cache) return this.cache
    const raw = await readJson(this.file, null)
    this.cache = raw && raw.version === INDEX_VERSION && raw.items && typeof raw.items === 'object'
      ? raw
      : { version: INDEX_VERSION, modelKey: '', dimension: 0, updatedAt: 0, items: {} }
    return this.cache
  }

  async save(index) {
    await mkdir(dirname(this.file), { recursive: true })
    index.updatedAt = Date.now()
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(index) + '\n', 'utf8')
    await rename(tmp, this.file)
    this.cache = index
  }

  async fetchEmbeddings(texts, config) {
    if (typeof this.fetch !== 'function') throw new Error('当前环境没有 fetch')
    const input = texts.map((text) => String(text ?? '').slice(0, MAX_TEXT))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await this.fetch(`${config.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, input }),
        signal: controller.signal,
      })
      if (response.status === 404) return this.fetchEmbeddingsLegacy(input, config)
      if (!response.ok) throw new Error(`Ollama /api/embed HTTP ${response.status}`)
      const data = await response.json()
      const vectors = data?.embeddings
      if (!Array.isArray(vectors) || vectors.length !== input.length) {
        throw new Error('Ollama /api/embed 返回的 embeddings 数量不匹配')
      }
      return vectors.map((vector) => Array.from(vector, (x) => Number(x) || 0))
    } finally {
      clearTimeout(timer)
    }
  }

  /** 兼容旧版 Ollama：/api/embeddings 一次只接受一个 prompt。 */
  async fetchEmbeddingsLegacy(texts, config) {
    const out = []
    for (const text of texts) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const response = await this.fetch(`${config.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: config.model, prompt: text }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Ollama /api/embeddings HTTP ${response.status}`)
        const data = await response.json()
        if (!Array.isArray(data?.embedding)) throw new Error('Ollama /api/embeddings 缺少 embedding')
        out.push(Array.from(data.embedding, (x) => Number(x) || 0))
      } finally {
        clearTimeout(timer)
      }
    }
    return out
  }

  async embed(texts, config) {
    const out = []
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE)
      const vectors = await this.fetchEmbeddings(batch, config)
      out.push(...vectors)
    }
    return out
  }

  async ensure(list, cfg) {
    const config = this.config(cfg)
    if (!config.enabled || config.provider !== 'ollama') return null
    if (Date.now() < this.failedUntil) return null

    const active = (Array.isArray(list) ? list : []).filter((item) => item.status === 'active')
    const index = await this.load()
    const key = this.modelKey(config)
    if (index.modelKey !== key) {
      index.modelKey = key
      index.dimension = 0
      index.items = {}
      this.queryCache.clear()
    }

    const missing = active.filter((item) => {
      const cached = index.items[item.id]
      return !cached || cached.hash !== this.hash(item.text)
    })
    let changed = missing.length > 0 || !index.updatedAt
    if (missing.length > 0) {
      try {
        const vectors = await this.embed(missing.map((item) => item.text), config)
        for (let i = 0; i < missing.length; i += 1) {
          const vector = vectors[i]
          if (!Array.isArray(vector) || vector.length === 0) throw new Error('embedding 为空')
          if (index.dimension === 0) index.dimension = vector.length
          if (vector.length !== index.dimension) throw new Error('embedding 维度不一致')
          index.items[missing[i].id] = { hash: this.hash(missing[i].text), vector }
        }
        this.lastError = ''
      } catch (error) {
        this.failedUntil = Date.now() + FAIL_COOLDOWN
        this.lastError = String(error?.message ?? error)
        this.log(`[companion] embedding 索引不可用，暂时回退关键词检索：${this.lastError}`)
        return null
      }
    }

    const activeIds = new Set(active.map((item) => item.id))
    for (const id of Object.keys(index.items)) {
      if (!activeIds.has(id)) {
        delete index.items[id]
        changed = true
      }
    }
    if (changed) await this.save(index)
    else this.cache = index
    return index
  }

  async queryVector(text, config) {
    const key = String(text ?? '').slice(0, MAX_TEXT)
    if (this.queryCache.has(key)) return this.queryCache.get(key)
    const [vector] = await this.embed([key], config)
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('query embedding 为空')
    while (this.queryCache.size >= 100) this.queryCache.delete(this.queryCache.keys().next().value)
    this.queryCache.set(key, vector)
    return vector
  }

  /** 语义 + 关键词 + 重要度 + 衰减 + 使用频率。不可用时返回 null，由上层回退。 */
  async search(list, query, limit = 10, { cfg, now = Date.now() } = {}) {
    const q = asText(query)
    const request = Number(limit)
    const take = Number.isFinite(request) ? Math.max(0, Math.floor(request)) : 10
    if (!q || take === 0) return null
    return this.serialize(async () => {
      const config = this.config(cfg)
      const index = await this.ensure(list, cfg)
      if (!index) return null
      let qvec
      try {
        qvec = await this.queryVector(q, config)
      } catch (error) {
        this.failedUntil = Date.now() + FAIL_COOLDOWN
        this.lastError = String(error?.message ?? error)
        this.log(`[companion] query embedding 失败，暂时回退关键词检索：${this.lastError}`)
        return null
      }
      const scored = []
      for (const item of list) {
        if (item.status !== 'active') continue
        const cached = index.items[item.id]
        if (!cached) continue
        const lexical = lexicalScore(item, q)
        const semantic = Math.max(0, cosine(qvec, cached.vector))
        const importance = Number(item.importance) || 3
        if (item.source === 'chat' && importance < 3 && lexical === 0 && semantic < 0.5) continue
        const weight = memoryWeight(item, now)
        const confidence = clamp(item.confidence, 0, 1, 0.7)
        scored.push({
          item,
          score: lexical + semantic * 8 + importance * 1.5 + weight * 4 + confidence,
        })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, take).map((row) => row.item)
    })
  }

  async status(list, cfg) {
    const config = this.config(cfg)
    const index = await this.load()
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      dimension: index.modelKey === this.modelKey(config) ? index.dimension : 0,
      indexed: index.modelKey === this.modelKey(config) ? Object.keys(index.items).length : 0,
      updatedAt: index.modelKey === this.modelKey(config) ? (index.updatedAt || 0) : 0,
      lastError: this.lastError,
      cooldown: this.failedUntil > Date.now(),
    }
  }
}

export const __internals = { bigrams, lexicalScore, cosine, INDEX_FILE, INDEX_VERSION }
