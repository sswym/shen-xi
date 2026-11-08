/**
 * dsh-companion 的浏览器半边。
 *
 * 注册在 设置 → 陪伴：一个能看她的状态、记忆、生活，也能改人格和 QQ 配置的页面。
 * 只依赖运行时提供的 react；数据走同源的 /dsh-companion/api。
 */
window.__ModuleLoader__.load({
  id: 'dsh-companion',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-companion/api'

    async function api(path, options = {}) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        ...options,
      })
      let data = null
      try { data = await response.json() } catch { /* 非 JSON */ }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `请求失败（HTTP ${response.status}）`)
      }
      return data
    }

    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

    function formatTime(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      } catch { return '' }
    }

    function formatDateTime(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      } catch { return '' }
    }

    const KIND_LABEL = {
      fact: '关于他',
      preference: '偏好',
      promise: '约定',
      event: '事件',
      feeling: '感受',
      note: '备注',
    }

    const MEMORY_KINDS = [
      ['fact', '关于他'],
      ['preference', '他的偏好'],
      ['promise', '约定'],
      ['event', '发生过的事'],
      ['feeling', '感受'],
    ]

    /* ---------------------------------------------------------------- */
    /* 图标                                                              */
    /* ---------------------------------------------------------------- */

    const PATHS = {
      refresh: ['M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5', 'M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5'],
      send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
      heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z'],
      sparkles: ['M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z'],
      book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
      brain: ['M9.5 3A3.5 3.5 0 0 0 6 6.5v.3A3.5 3.5 0 0 0 4 10a3.5 3.5 0 0 0 1.2 6.4A3.5 3.5 0 0 0 9.5 21 3.5 3.5 0 0 0 12 19.8V4.7A3.5 3.5 0 0 0 9.5 3z', 'M14.5 3A3.5 3.5 0 0 1 18 6.5v.3A3.5 3.5 0 0 1 20 10a3.5 3.5 0 0 1-1.2 6.4A3.5 3.5 0 0 1 14.5 21 3.5 3.5 0 0 1 12 19.8'],
      settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.26.62.86 1 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z'],
      trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 15H6L5 6', 'M10 11v6', 'M14 11v6'],
      plus: ['M12 5v14', 'M5 12h14'],
      check: ['M20 6 9 17l-5-5'],
      chat: ['M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'],
      moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
      clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
      link: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1'],
      x: ['M18 6 6 18', 'M6 6l12 12'],
    }

    function Icon({ name, size = 16 }) {
      const paths = PATHS[name] ?? PATHS.sparkles
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block', flex: 'none' },
      }, paths.map((d, i) => h('path', { key: i, d })))
    }

    function Avatar({ size = 76 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 96 96', 'aria-hidden': true,
        style: { display: 'block', flex: 'none', filter: 'drop-shadow(0 8px 18px rgba(31,41,55,.16))' },
      },
      h('defs', null,
        h('linearGradient', { id: 'cmp-av-bg', x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0', stopColor: '#354064' }),
          h('stop', { offset: '1', stopColor: '#161b2c' })),
        h('linearGradient', { id: 'cmp-av-moon', x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0', stopColor: '#ffe9b3' }),
          h('stop', { offset: '1', stopColor: '#efb86a' }))),
      h('rect', { x: 2, y: 2, width: 92, height: 92, rx: 28, fill: 'url(#cmp-av-bg)' }),
      h('circle', { cx: 42, cy: 40, r: 22, fill: 'url(#cmp-av-moon)' }),
      h('circle', { cx: 51, cy: 32, r: 20.5, fill: 'url(#cmp-av-bg)' }),
      h('path', { d: 'M28 70c6 4 12 6 20 6s14-2 20-6', fill: 'none', stroke: '#93a7dc', strokeWidth: 3, strokeLinecap: 'round' }),
      h('path', { d: 'M65 20l3.2 6.8 7.4 1-5.5 5 1.4 7.2-6.5-3.7-6.5 3.7 1.4-7.2-5.5-5 7.4-1z', fill: '#93a7dc', opacity: '.95' }))
    }

    /* ---------------------------------------------------------------- */
    /* 基础控件                                                          */
    /* ---------------------------------------------------------------- */

    function Pill({ tone = 'neutral', children }) {
      return h('span', { className: `cmp-pill cmp-pill-${tone}` }, children)
    }

    function Bar({ value, tone = 'brand' }) {
      const width = Math.max(0, Math.min(100, Number(value) || 0))
      return h('div', { className: 'cmp-bar' },
        h('div', { className: `cmp-bar-fill cmp-bar-${tone}`, style: { width: `${width}%` } }))
    }

    function Stat({ icon, label, value, hint, bar, tone }) {
      return h('div', { className: 'cmp-stat' },
        h('div', { className: 'cmp-stat-top' },
          h('span', { className: 'cmp-stat-icon' }, h(Icon, { name: icon, size: 16 })),
          h('span', { className: 'cmp-stat-label' }, label)),
        h('div', { className: 'cmp-stat-value' }, value),
        bar === undefined ? null : h(Bar, { value: bar, tone }),
        hint ? h('div', { className: 'cmp-stat-hint' }, hint) : null)
    }

    function Section({ title, hint, action, children }) {
      return h('section', { className: 'cmp-section' },
        (title || action) ? h('div', { className: 'cmp-section-head' },
          h('div', null,
            h('h2', { className: 'cmp-section-title' }, title),
            hint ? h('p', { className: 'cmp-section-hint' }, hint) : null),
          action ?? null) : null,
        children)
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'cmp-field' },
        h('span', { className: 'cmp-field-label' }, label),
        children,
        hint ? h('span', { className: 'cmp-field-hint' }, hint) : null)
    }

    function TextInput({ value, onChange, placeholder, type = 'text', disabled }) {
      return h('input', {
        className: 'cmp-input', type, value: value ?? '', placeholder: placeholder ?? '',
        disabled: Boolean(disabled),
        onChange: (event) => onChange?.(event.target.value),
      })
    }

    function TextArea({ value, onChange, rows = 5, placeholder }) {
      return h('textarea', {
        className: 'cmp-input cmp-textarea', rows, value: value ?? '', placeholder: placeholder ?? '',
        onChange: (event) => onChange?.(event.target.value),
      })
    }

    function Toggle({ checked, onChange, disabled }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false',
        className: `cmp-toggle${checked ? ' is-on' : ''}`,
        disabled: Boolean(disabled),
        onClick: () => onChange?.(!checked),
      }, h('span', { className: 'cmp-toggle-knob' }))
    }

    function Button({ children, tone = 'default', icon, onClick, disabled, type = 'button' }) {
      return h('button', {
        type, className: `cmp-btn cmp-btn-${tone}`, disabled: Boolean(disabled), onClick,
      }, icon ? h(Icon, { name: icon, size: 15 }) : null, h('span', null, children))
    }

    function Empty({ icon = 'sparkles', title, hint, action }) {
      return h('div', { className: 'cmp-empty' },
        h('div', { className: 'cmp-empty-icon' }, h(Icon, { name: icon, size: 28 })),
        h('div', { className: 'cmp-empty-title' }, title),
        hint ? h('div', { className: 'cmp-empty-hint' }, hint) : null,
        action ?? null)
    }

    /* ---------------------------------------------------------------- */
    /* 页头                                                              */
    /* ---------------------------------------------------------------- */

    function Hero({ data }) {
      const state = data.state
      const official = data.qq.mode === 'official'
      const bound = data.qq.ownerBound !== false && Boolean(data.qq.ownerId)
      const qqOk = data.qq.enabled && data.qq.connected
      const qqLabel = !data.qq.enabled
        ? 'QQ 未启用'
        : official && !bound
          ? 'QQ 待绑定'
          : qqOk ? 'QQ 在线' : 'QQ 未连接'
      const qqTone = !data.qq.enabled ? 'neutral' : official && !bound ? 'warn' : qqOk ? 'success' : 'warn'
      return h('div', { className: 'cmp-hero' },
        h(Avatar, { size: 78 }),
        h('div', { className: 'cmp-hero-main' },
          h('div', { className: 'cmp-name-row' },
            h('h1', { className: 'cmp-name' }, data.persona.name),
            h(Pill, { tone: qqTone }, qqLabel),
            data.heartbeat.enabled ? h(Pill, { tone: 'brand' }, '心跳中') : h(Pill, { tone: 'neutral' }, '心跳关')),
          h('div', { className: 'cmp-hero-sub' },
            `${data.now.key} ${data.now.weekday} ${data.now.clock}`,
            h('span', { className: 'cmp-dot' }, '·'),
            state.activity || '在过自己的日子'),
          h('div', { className: 'cmp-chips' },
            h('span', { className: 'cmp-chip' }, `${state.moodEmoji} ${state.moodLabel}`),
            h('span', { className: 'cmp-chip' }, `好感度 ${state.affection} · ${state.affectionLevel}`),
            h('span', { className: 'cmp-chip' }, `今天说了 ${data.counts.her} 句`))),
        h('div', { className: 'cmp-hero-side' },
          h('div', { className: 'cmp-hero-side-label' }, '他对她'),
          h('div', { className: 'cmp-hero-affection', style: { color: state.affectionTone } }, state.affectionLevel),
          h(Bar, { value: state.affection, tone: 'affection' }),
          h('div', { className: 'cmp-hero-side-hint' }, state.affectionHint)))
    }

    /* ---------------------------------------------------------------- */
    /* 概览                                                              */
    /* ---------------------------------------------------------------- */

    function ChatBubble({ item }) {
      const mine = item.role === 'owner'
      return h('div', { className: `cmp-msg ${mine ? 'is-owner' : 'is-her'}` },
        h('div', { className: `cmp-bubble ${mine ? 'cmp-bubble-owner' : 'cmp-bubble-her'}` }, item.text),
        h('div', { className: 'cmp-msg-meta' },
          item.channel === 'proactive' ? h('span', { className: 'cmp-msg-tag' }, '她主动') : null,
          h('span', null, formatTime(item.at))))
    }

    function OverviewTab({ data, onChanged, notify }) {
      const [draft, setDraft] = useState('')
      const [sending, setSending] = useState(false)
      const [saying, setSaying] = useState(false)
      const listRef = useRef(null)

      useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
      }, [data.chat.length])

      const send = async () => {
        const text = draft.trim()
        if (!text || sending) return
        setSending(true)
        try {
          await post('/chat', { text })
          setDraft('')
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setSending(false)
        }
      }

      const sayNow = async () => {
        if (saying) return
        setSaying(true)
        try {
          const result = await post('/say', { force: true })
          if (result.skipped) notify('她这次没说话。')
          else notify(result.delivery?.simulated ? '她说了一句（模拟，未发到 QQ）。' : '她主动发了一条。')
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setSaying(false)
        }
      }

      return h('div', { className: 'cmp-tab-body' },
        h('div', { className: 'cmp-stats' },
          h(Stat, { icon: 'moon', label: '心情', value: data.state.moodLabel, hint: `数值 ${data.state.mood}`, bar: ((data.state.mood + 2) / 4) * 100, tone: 'mood' }),
          h(Stat, { icon: 'sparkles', label: '精力', value: `${data.state.energy}/100`, hint: data.state.energy > 70 ? '还挺有精神' : data.state.energy > 40 ? '有点累' : '快没电了', bar: data.state.energy, tone: 'energy' }),
          h(Stat, { icon: 'heart', label: '好感度', value: `${data.state.affection}`, hint: `${data.state.affectionLevel} · ${data.state.affectionHint}`, bar: data.state.affection, tone: 'affection' })),

        h(Section, {
          title: '最近',
          hint: '她记得你们说过的话；这里也能直接和她聊。',
          action: h(Button, { icon: 'sparkles', onClick: sayNow, disabled: saying }, saying ? '她在想…' : '让她主动说一句'),
        },
        h('div', { className: 'cmp-chat' },
          h('div', { className: 'cmp-chat-list', ref: listRef },
            data.chat.length === 0
              ? h(Empty, { icon: 'chat', title: '还没聊过', hint: '在下面说一句，或者让她主动来找你。' })
              : data.chat.map((item) => h(ChatBubble, { key: item.id, item }))),
          h('div', { className: 'cmp-composer' },
            h('input', {
              className: 'cmp-input cmp-composer-input',
              value: draft,
              placeholder: `跟${data.persona.name}说点什么…`,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } },
            }),
            h(Button, { tone: 'primary', icon: 'send', onClick: send, disabled: sending || !draft.trim() }, sending ? '发送中…' : '发送')))))
    }

    /* ---------------------------------------------------------------- */
    /* 记忆                                                              */
    /* ---------------------------------------------------------------- */

    function MemoryTab({ data, onChanged, notify }) {
      const [query, setQuery] = useState('')
      const [items, setItems] = useState(data.memories.recent)
      const [total, setTotal] = useState(data.memories.total)
      const [history, setHistory] = useState(data.memories.history || 0)
      const [loading, setLoading] = useState(false)
      const [adding, setAdding] = useState(false)
      const [form, setForm] = useState({ text: '', kind: 'fact', importance: 3 })

      const search = useCallback(async (q) => {
        setLoading(true)
        try {
          const result = await api(`/memories${q ? `?q=${encodeURIComponent(q)}` : ''}`)
          setItems(result.items)
          setTotal(result.total)
          setHistory(result.history || 0)
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setLoading(false)
        }
      }, [notify])

      const add = async () => {
        if (!form.text.trim()) return
        try {
          await post('/memories', form)
          setForm({ text: '', kind: 'fact', importance: 3 })
          setAdding(false)
          notify('记下了。')
          await search(query)
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        }
      }

      const remove = async (id) => {
        if (!window.confirm('删掉这条记忆？')) return
        try {
          await api(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
          await search(query)
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        }
      }

      return h('div', { className: 'cmp-tab-body' },
        h(Section, {
          title: `她记得的事 · ${total}${history > 0 ? `（旧版本 ${history}）` : ''}`,
          hint: '越重要的事她越容易想起来；也可以手动补一条。',
          action: h(Button, { icon: 'plus', onClick: () => setAdding(!adding) }, adding ? '收起' : '加一条'),
        },
        adding ? h('div', { className: 'cmp-add-card' },
          h(TextArea, { rows: 3, value: form.text, placeholder: '例如：他喝咖啡不加糖；他每周三晚上加班。', onChange: (v) => setForm({ ...form, text: v }) }),
          h('div', { className: 'cmp-add-row' },
            h('select', { className: 'cmp-input cmp-select', value: form.kind, onChange: (e) => setForm({ ...form, kind: e.target.value }) },
              MEMORY_KINDS.map(([value, label]) => h('option', { key: value, value }, label))),
            h('select', { className: 'cmp-input cmp-select', value: String(form.importance), onChange: (e) => setForm({ ...form, importance: Number(e.target.value) }) },
              [1, 2, 3, 4, 5].map((n) => h('option', { key: n, value: String(n) }, `重要度 ${n}`))),
            h(Button, { tone: 'primary', icon: 'check', onClick: add }, '记住'))) : null,
        h('div', { className: 'cmp-toolbar' },
          h('input', {
            className: 'cmp-input', value: query, placeholder: '搜一搜她记得什么…',
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void search(query) },
          }),
          h(Button, { icon: 'refresh', onClick: () => search(query), disabled: loading }, loading ? '找…' : '搜索')),
        items.length === 0
          ? h(Empty, { icon: 'brain', title: '还没有这条记忆', hint: '聊得多了，她会自己记住；也可以手动加。' })
          : h('div', { className: 'cmp-memory-grid' },
            items.map((item) => h('div', { key: item.id, className: 'cmp-memory' },
              h('div', { className: 'cmp-memory-top' },
                h('span', { className: 'cmp-memory-kind' }, KIND_LABEL[item.kind] ?? '关于他'),
                h('span', { className: 'cmp-memory-date' }, formatDateTime(item.lastConfirmedAt || item.at)),
                h('button', { className: 'cmp-icon-btn', title: '删除', onClick: () => remove(item.id) },
                  h(Icon, { name: 'trash', size: 14 }))),
              h('div', { className: 'cmp-memory-text' }, item.text),
              h('div', { className: 'cmp-memory-foot' },
                h('span', null, '重要度'),
                h('span', { className: 'cmp-dots' },
                  [1, 2, 3, 4, 5].map((n) => h('i', { key: n, className: n <= item.importance ? 'is-on' : '' }))),
                h('span', { className: 'cmp-memory-conf' }, `置信 ${Math.round((item.confidence ?? 0.7) * 100)}%`)),
            )),
          )))
    }

    /* ---------------------------------------------------------------- */
    /* 生活                                                              */
    /* ---------------------------------------------------------------- */

    function LifeTab({ data, onChanged, notify }) {
      const [writing, setWriting] = useState(false)
      const writeDiary = async () => {
        setWriting(true)
        try {
          const result = await post('/diary', { force: true })
          if (!result.ok) throw new Error(result.error || '写不出来')
          notify('日记写好了。')
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setWriting(false)
        }
      }

      return h('div', { className: 'cmp-tab-body' },
        h('div', { className: 'cmp-world' },
          h('div', { className: 'cmp-world-icon' }, h(Icon, { name: 'moon', size: 22 })),
          h('div', null,
            h('div', { className: 'cmp-world-title' }, `今天 · ${data.today.date}`),
            h('div', { className: 'cmp-world-text' }, data.today.world || data.today.weather)),
        ),

        (data.today.threads?.length > 0
          ? h(Section, { title: '手上进行中的', hint: '跨天的事，会慢慢推进。' },
              h('div', { className: 'cmp-timeline' },
                data.today.threads.map((t) => h('div', { key: t.id, className: 'cmp-timeline-item' },
                  h('div', { className: 'cmp-timeline-time' }, `第 ${t.daysIn} 天`),
                  h('div', { className: 'cmp-timeline-body' },
                    h('div', { className: 'cmp-timeline-title' }, t.title),
                    h('div', { className: 'cmp-timeline-desc' }, t.text),
                  ),
                ),
              ),
            ),
          )
          : null),
        h(Section, { title: '她今天经历的', hint: '这些事会出现在她主动找你时的话题里。' },
          data.today.events.length === 0
            ? h(Empty, { icon: 'book', title: '今天还没发生什么', hint: '明天再来看看。' })
            : h('div', { className: 'cmp-timeline' },
              data.today.events.map((event) => h('div', { key: event.id, className: 'cmp-timeline-item' },
                h('div', { className: 'cmp-timeline-dot', 'data-shared': event.shared ? 'true' : 'false' }),
                h('div', { className: 'cmp-timeline-time' }, event.at),
                h('div', { className: 'cmp-timeline-body' },
                  h('div', { className: 'cmp-timeline-title' },
                    event.title,
                    h('span', { className: 'cmp-timeline-type' }, event.type),
                    event.shared ? h('span', { className: 'cmp-timeline-shared' }, '已分享') : null),
                  h('div', { className: 'cmp-timeline-desc' }, event.desc),
                  event.impact ? h('div', { className: 'cmp-timeline-impact' }, `→ ${event.impact}`) : null),
              )),
            ),
        ),

        h(Section, {
          title: '日记',
          hint: data.diary ? '她今天写下的。' : '今天还没写。',
          action: h(Button, { icon: 'book', onClick: writeDiary, disabled: writing }, writing ? '她在写…' : data.diary ? '重写今天的' : '让她写今天的日记'),
        },
        data.diary
          ? h('pre', { className: 'cmp-diary' }, data.diary)
          : h(Empty, { icon: 'book', title: '今天还没有日记', hint: '点右上角，让她用今天的口吻写一篇。' }),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 设置                                                              */
    /* ---------------------------------------------------------------- */

    function toForm(data) {
      const cfg = data.config
      return {
        name: cfg.name,
        callYou: cfg.callYou,
        provider: cfg.provider,
        model: cfg.model,
        temperature: String(cfg.temperature),
        qqEnabled: cfg.qq.enabled,
        qqMode: cfg.qq.mode || 'official',
        appId: cfg.qq.appId || '',
        appSecret: '',
        bindCode: cfg.qq.bindCode || '',
        httpUrl: cfg.qq.httpUrl,
        wsUrl: cfg.qq.wsUrl,
        accessToken: '',
        ownerId: cfg.qq.ownerId,
        hbEnabled: cfg.heartbeat.enabled,
        times: cfg.heartbeat.times.join(', '),
        quietStart: cfg.heartbeat.quietStart,
        quietEnd: cfg.heartbeat.quietEnd,
        minGap: String(cfg.heartbeat.minGapMinutes),
        maxPerDay: String(cfg.heartbeat.maxPerDay),
        autoExtract: cfg.memory.autoExtract,
        maxInjected: String(cfg.memory.maxInjected),
        recentMessages: String(cfg.memory.recentMessages ?? 12),
        embedEnabled: cfg.memory.embedding?.enabled !== false,
        embedBaseUrl: cfg.memory.embedding?.baseUrl || 'http://127.0.0.1:11434',
        embedModel: cfg.memory.embedding?.model || 'nomic-embed-text:latest',
        eventsPerDay: String(cfg.life.eventsPerDay),
        startAffection: String(cfg.affection.start),
        dailyGainCap: String(cfg.affection.dailyGainCap),
        guestsEnabled: cfg.guests?.enabled === true,
        guestsMaxPerDay: String(cfg.guests?.maxPerDay ?? 40),
        guestsExtract: cfg.guests?.extract === true,
        humanizeEnabled: cfg.persona?.humanize !== false,
        webEnabled: cfg.persona?.web === true,
        webSearchEnabled: cfg.persona?.webSearch === true,
        soul: data.persona.soul,
      }
    }

    function SettingsTab({ data, onChanged, notify }) {
      const [form, setForm] = useState(() => toForm(data))
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const [advanced, setAdvanced] = useState(false)
      const [creating, setCreating] = useState(false)
      const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      const save = async () => {
        setSaving(true)
        setTestResult(null)
        try {
          await post('/config', {
            name: form.name,
            callYou: form.callYou,
            provider: form.provider,
            model: form.model,
            temperature: Number(form.temperature) || 0.85,
            qq: {
              mode: form.qqMode,
              enabled: form.qqEnabled,
              appId: form.appId,
              appSecret: form.appSecret,
              ...(form.qqMode === 'onebot11' ? { ownerId: form.ownerId } : {}),
              httpUrl: form.httpUrl,
              wsUrl: form.wsUrl,
              accessToken: form.accessToken,
            },
            heartbeat: {
              enabled: form.hbEnabled,
              times: form.times.split(',').map((x) => x.trim()).filter(Boolean),
              quietStart: form.quietStart,
              quietEnd: form.quietEnd,
              minGapMinutes: Number(form.minGap) || 0,
              maxPerDay: Number(form.maxPerDay) || 0,
            },
            memory: {
              autoExtract: form.autoExtract,
              maxInjected: Number(form.maxInjected) || 10,
              recentMessages: Number(form.recentMessages) || 12,
              embedding: {
                enabled: form.embedEnabled,
                provider: 'ollama',
                baseUrl: form.embedBaseUrl,
                model: form.embedModel,
              },
            },
            life: { eventsPerDay: Number(form.eventsPerDay) || 5 },
            persona: { humanize: form.humanizeEnabled, web: form.webEnabled, webSearch: form.webSearchEnabled },
            guests: {
              enabled: form.guestsEnabled,
              maxPerDay: Number(form.guestsMaxPerDay) || 40,
              extract: form.guestsExtract,
            },
            affection: {
              start: Number(form.startAffection) || 12,
              dailyGainCap: Number(form.dailyGainCap) || 4,
            },
          })
          if (form.soul !== data.persona.soul) await post('/persona', { soul: form.soul })
          notify('设置保存了。')
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setSaving(false)
        }
      }

      const test = async () => {
        setTesting(true)
        setTestResult(null)
        try {
          const result = await post('/test-qq', {})
          const who = result.info?.username || result.info?.nickname || result.info?.id
          setTestResult(result.ok
            ? { ok: true, text: `连接成功${who ? `：${who}` : ''}` }
            : { ok: false, text: result.error || '连接失败' })
        } catch (error) {
          setTestResult({ ok: false, text: String(error.message ?? error) })
        } finally {
          setTesting(false)
        }
      }

      const resetBind = async () => {
        if (!window.confirm('解除绑定后，机器人会忽略当前主人，直到用新的绑定码重新绑定。继续？')) return
        try {
          const result = await post('/bind/reset', {})
          setForm((current) => ({ ...current, ownerId: '', bindCode: result.config?.qq?.bindCode || '' }))
          notify('已解除绑定，新的绑定码已生成。')
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        }
      }

      const createSession = async () => {
        setCreating(true)
        try {
          const result = await post('/session/new', {})
          if (result.ok !== true) throw new Error(result.error || '新建会话失败')
          notify('新的陪伴会话已创建；旧会话仍留在 DSH 侧边栏。')
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setCreating(false)
        }
      }

      return h('div', { className: 'cmp-tab-body' },
        h(Section, { title: '人格', hint: '她是谁、怎么说话、怎么过日子，都在这里。保存后，下一次生成就会生效。' },
          h('div', { className: 'cmp-grid-2' },
            h(Field, { label: '名字' }, h(TextInput, { value: form.name, onChange: (v) => set('name', v) })),
            h(Field, { label: '她怎么称呼你' }, h(TextInput, { value: form.callYou, onChange: (v) => set('callYou', v) }))),
          h(Field, { label: '人格与说话方式', hint: '支持 {{call_you}} 占位符。' },
            h(TextArea, { rows: 14, value: form.soul, onChange: (v) => set('soul', v) }))),

        h(Section, { title: 'QQ', hint: '官方 API 推荐；也可以切到 OneBot / NapCat。没启用时进入模拟模式。' },
          h('div', { className: 'cmp-grid-2' },
            h(Field, { label: '接入方式', hint: '官方 API 需要 AppID / AppSecret；官方 ID 是 OpenID，不是 QQ 号。' },
              h('select', { className: 'cmp-input cmp-select', value: form.qqMode, onChange: (e) => set('qqMode', e.target.value) },
                h('option', { value: 'official' }, 'QQ 官方 API（推荐）'),
                h('option', { value: 'onebot11' }, 'OneBot 11 / NapCat')))),
          h('div', { className: 'cmp-row' },
            h('div', null,
              h('div', { className: 'cmp-row-title' }, '启用 QQ'),
              h('div', { className: 'cmp-row-hint' }, form.qqMode === 'official' ? '连官方 WebSocket 网关，接收和发送私聊。' : '需要本机运行 NapCat，并打开 HTTP 3000 / 正向 WS 3001。')),
            h(Toggle, { checked: form.qqEnabled, onChange: (v) => set('qqEnabled', v) })),
          form.qqMode === 'official'
            ? h('div', null,
              h('div', { className: 'cmp-grid-2' },
                h(Field, { label: 'AppID', hint: 'QQ 开放平台 → 机器人资料' },
                  h(TextInput, { value: form.appId, onChange: (v) => set('appId', v), placeholder: '例如 1904011248' })),
                h(Field, { label: 'AppSecret', hint: data.qq.hasAppSecret ? '已设置；留空则保持不变' : '开放平台的 AppSecret' },
                  h(TextInput, { type: 'password', value: form.appSecret, onChange: (v) => set('appSecret', v), placeholder: data.qq.hasAppSecret ? '••••••••' : '' }))),
              h('div', { className: 'cmp-bind-card' },
                h('div', { className: 'cmp-bind-head' },
                  h('div', { className: 'cmp-bind-title' }, data.qq.ownerBound ? '主人已绑定' : '等待绑定主人'),
                  h(Pill, { tone: data.qq.ownerBound ? 'success' : 'warn' }, data.qq.ownerBound ? '已绑定' : '未绑定')),
                data.qq.ownerBound
                  ? h('div', { className: 'cmp-bind-body' },
                    h('div', { className: 'cmp-bind-openid', title: data.qq.ownerId }, `OpenID：${data.qq.ownerId}`),
                    h('div', { className: 'cmp-field-hint' }, '只接受这个 OpenID 的私聊；主动消息也发给他。'),
                    h(Button, { tone: 'danger', icon: 'x', onClick: resetBind }, '解除绑定'))
                  : h('div', { className: 'cmp-bind-body' },
                    h('div', { className: 'cmp-field-hint' }, '用你的 QQ 私聊机器人，发送下面这一行：'),
                    h('code', { className: 'cmp-bind-code' }, `绑定 ${data.qq.bindCode || form.bindCode || '（保存后生成）'}`),
                    h('div', { className: 'cmp-field-hint' }, '绑定成功后绑定码立即作废，只认第一个发对码的 OpenID。'))))
            : h('div', null,
              h('div', { className: 'cmp-grid-2' },
                h(Field, { label: 'OneBot HTTP', hint: '发消息用的地址' }, h(TextInput, { value: form.httpUrl, onChange: (v) => set('httpUrl', v) })),
                h(Field, { label: 'OneBot WebSocket', hint: '收消息用的正向 WS 地址' }, h(TextInput, { value: form.wsUrl, onChange: (v) => set('wsUrl', v) }))),
              h('div', { className: 'cmp-grid-2' },
                h(Field, { label: '主人 QQ 号', hint: '只处理这个号的私聊' }, h(TextInput, { value: form.ownerId, onChange: (v) => set('ownerId', v), placeholder: '例如 123456789' })),
                h(Field, { label: 'Access Token', hint: data.qq.hasToken ? '已设置；留空保持不变' : 'NapCat 没设置就留空' },
                  h(TextInput, { type: 'password', value: form.accessToken, onChange: (v) => set('accessToken', v), placeholder: data.qq.hasToken ? '••••••••' : '' })))),
          h('div', { className: 'cmp-inline' },
            h(Button, { icon: 'link', onClick: test, disabled: testing }, testing ? '测试中…' : '测试连接'),
            testResult ? h('span', { className: `cmp-test ${testResult.ok ? 'is-ok' : 'is-bad'}` }, testResult.text) : null),
          h('div', { className: 'cmp-field-hint' }, '测试连接读取已保存的配置；改完 AppID/AppSecret 先保存再点测试。主动消息受开放平台频控；发送失败时先把心跳频率调低。')),

        h(Section, { title: '会话', hint: 'QQ 对话现在存在 DSH 会话里；左侧会话列表可以改名、删除、归档。' },
          data.session?.available === false
            ? h('div', { className: 'cmp-field-hint' }, '当前 profile 没有 sessionController，暂时无法使用 DSH 会话存储。')
            : h('div', null,
              h('div', { className: 'cmp-inline' },
                h(Pill, { tone: data.session?.live ? 'success' : 'warn' }, data.session?.live ? '已连接' : '未创建'),
                h('span', { className: 'cmp-session-title' }, data.session?.title || '尚未创建')),
              h('div', { className: 'cmp-session-id' }, data.session?.id || '绑定主人后自动创建'),
              h('div', { className: 'cmp-field-hint' }, `已 ${data.session?.turns ?? 0} 轮。建议 200–300 轮或 1–2 个月新建一次；新建前会先把旧会话压成几条情景记忆，人格、记忆、心情和好感度都跨会话保留。`),
              h('div', { className: 'cmp-field-hint' }, '删除/归档：在 DSH 左侧会话列表里操作。当前会话被删或归档后，下一条 QQ 消息会自动新建一个。'),
              h('div', { className: 'cmp-inline' },
                h(Button, { icon: 'plus', onClick: createSession, disabled: creating || !data.qq.ownerBound },
                  creating ? '创建中…' : '新建陪伴会话'),
                !data.qq.ownerBound ? h('span', { className: 'cmp-field-hint' }, '先绑定主人') : null))),

        h(Section, { title: '心跳', hint: '到了这些时间，她会自己判断要不要找你。不想说就不说。' },
          h('div', { className: 'cmp-row' },
            h('div', null,
              h('div', { className: 'cmp-row-title' }, '让她主动找你'),
              h('div', { className: 'cmp-row-hint' }, '关掉后只有你找她，她不会主动发消息。')),
            h(Toggle, { checked: form.hbEnabled, onChange: (v) => set('hbEnabled', v) })),
          h('div', { className: 'cmp-grid-2' },
            h(Field, { label: '心跳时间', hint: '逗号分隔，24 小时制' }, h(TextInput, { value: form.times, onChange: (v) => set('times', v) })),
            h(Field, { label: '静默时段' },
              h('div', { className: 'cmp-grid-2 cmp-grid-tight' },
                h(TextInput, { value: form.quietStart, onChange: (v) => set('quietStart', v) }),
                h(TextInput, { value: form.quietEnd, onChange: (v) => set('quietEnd', v) })))),
          h('div', { className: 'cmp-grid-2' },
            h(Field, { label: '最小间隔（分钟）' }, h(TextInput, { value: form.minGap, onChange: (v) => set('minGap', v) })),
            h(Field, { label: '每天最多几条' }, h(TextInput, { value: form.maxPerDay, onChange: (v) => set('maxPerDay', v) })))),

        h(Section, { title: '模型', hint: '留空就用 DSH 当前的默认模型。' },
          h('div', { className: 'cmp-grid-2' },
            h(Field, { label: 'Provider' }, h(TextInput, { value: form.provider, onChange: (v) => set('provider', v), placeholder: data.model?.resolved ? data.model.provider : '默认' })),
            h(Field, { label: 'Model' }, h(TextInput, { value: form.model, onChange: (v) => set('model', v), placeholder: data.model?.resolved ? data.model.model : '默认' }))),
          h(Field, { label: '温度', hint: '0 到 1.5；她平时是 0.85 左右' }, h(TextInput, { value: form.temperature, onChange: (v) => set('temperature', v) }))),

        h(Section, { title: '上下文', hint: '只影响模型每次看到多少历史；DSH 会话里仍然保存全部消息。' },
          h('div', { className: 'cmp-grid-2' },
            h(Field, { label: '最近聊天条数', hint: '默认 12，约等于最近 6 轮；范围 2–60' },
              h(TextInput, { value: form.recentMessages, onChange: (v) => set('recentMessages', v) })),
            h(Field, { label: '注入记忆条数', hint: '默认 10，范围 0–40' },
              h(TextInput, { value: form.maxInjected, onChange: (v) => set('maxInjected', v) }))),
          h('div', { className: 'cmp-field-hint' }, '调大能让她记住更多最近对话，但更费 token，也更容易被旧话题带偏。')),

        h('div', { className: 'cmp-advanced-head' },
          h('button', { className: 'cmp-link-btn', onClick: () => setAdvanced(!advanced) }, advanced ? '收起高级设置' : '展开高级设置')),
        advanced ? h('div', null,
          h(Section, { title: '记忆' },
            h('div', { className: 'cmp-row' },
              h('div', null,
                h('div', { className: 'cmp-row-title' }, '自动记住关于他的事'),
                h('div', { className: 'cmp-row-hint' }, '每次聊天后额外调用一次小模型提取；会增加一点用量。')),
              h(Toggle, { checked: form.autoExtract, onChange: (v) => set('autoExtract', v) }))),
          h(Section, { title: '语义索引', hint: '用本机 Ollama 给记忆建向量索引；不可用时自动退回关键词检索。' },
            h('div', { className: 'cmp-row' },
              h('div', null,
                h('div', { className: 'cmp-row-title' }, '启用 embedding 检索'),
                h('div', { className: 'cmp-row-hint' }, '默认 Ollama + nomic-embed-text；首次检索时自动建索引。')),
              h(Toggle, { checked: form.embedEnabled, onChange: (v) => set('embedEnabled', v) })),
            form.embedEnabled ? h('div', { className: 'cmp-grid-2' },
              h(Field, { label: 'Ollama 地址' }, h(TextInput, { value: form.embedBaseUrl, onChange: (v) => set('embedBaseUrl', v) })),
              h(Field, { label: 'Embedding 模型' }, h(TextInput, { value: form.embedModel, onChange: (v) => set('embedModel', v) }))) : null,
            data.memoryIndex ? h('div', { className: 'cmp-field-hint' },
              data.memoryIndex.indexed > 0
                ? `已索引 ${data.memoryIndex.indexed} 条 · ${data.memoryIndex.model} · ${data.memoryIndex.dimension} 维${data.memoryIndex.updatedAt ? ` · 更新于 ${formatDateTime(data.memoryIndex.updatedAt)}` : ''}${data.memoryIndex.lastError ? `（上次错误：${data.memoryIndex.lastError}）` : ''}`
                : `尚未建立索引${data.memoryIndex.lastError ? `：${data.memoryIndex.lastError}` : '；下一次记忆检索时建立。'}`) : null),
          h(Section, { title: '生活与关系' },
            h('div', { className: 'cmp-grid-2' },
              h(Field, { label: '每天几件事', hint: '0 到 5' }, h(TextInput, { value: form.eventsPerDay, onChange: (v) => set('eventsPerDay', v) })),
              h(Field, { label: '初始好感度' }, h(TextInput, { value: form.startAffection, onChange: (v) => set('startAffection', v) })),
              h(Field, { label: '每天好感度上限' }, h(TextInput, { value: form.dailyGainCap, onChange: (v) => set('dailyGainCap', v) }))),
            h('div', { className: 'cmp-row' },
              h('div', null,
                h('div', { className: 'cmp-row-title' }, '拟人节奏'),
                h('div', { className: 'cmp-row-hint' }, '回复延迟、气泡间隔、偶发错字、睡眠窗口；关掉就是秒回机器。')),
              h(Toggle, { checked: form.humanizeEnabled, onChange: (v) => set('humanizeEnabled', v) })),
            h('div', { className: 'cmp-row' },
              h('div', null,
                h('div', { className: 'cmp-row-title' }, '允许她联网查资料（实验）'),
                h('div', { className: 'cmp-row-hint' }, '只在你发链接或明确说“帮我查/搜一下”时触发；默认关闭。')),
              h(Toggle, { checked: form.webEnabled, onChange: (v) => set('webEnabled', v) })),
            form.webEnabled ? h('div', { className: 'cmp-row' },
              h('div', null,
                h('div', { className: 'cmp-row-title' }, '允许搜索（需要 provider 凭据）'),
                h('div', { className: 'cmp-row-hint' }, '明确说“帮我查/搜一下”时调用 DSH 的 web_search；没有配置 DEEPSEEK_API_KEY 时会说查不到。')),
              h(Toggle, { checked: form.webSearchEnabled, onChange: (v) => set('webSearchEnabled', v) })) : null),
          h(Section, { title: '访客', hint: '开启后主人之外的 QQ 用户也能和她说话（记忆/聊天独立，不动你们的关系）。' },
            h('div', { className: 'cmp-row' },
              h('div', null,
                h('div', { className: 'cmp-row-title' }, '允许访客私聊'),
                h('div', { className: 'cmp-row-hint' }, '用于盲测：第三方与她对话完全隔离，测完关掉即可。')),
              h(Toggle, { checked: form.guestsEnabled, onChange: (v) => set('guestsEnabled', v) })),
            form.guestsEnabled ? h('div', { className: 'cmp-grid-2' },
              h(Field, { label: '每人每天上限', hint: '默认 40' }, h(TextInput, { value: form.guestsMaxPerDay, onChange: (v) => set('guestsMaxPerDay', v) })),
              h(Field, { label: '记住访客', hint: '默认关' }, h(Toggle, { checked: form.guestsExtract, onChange: (v) => set('guestsExtract', v) }))) : null),
          ) : null,

        h('div', { className: 'cmp-save-bar' },
          h('span', { className: 'cmp-save-hint' }, '改动保存在 $DSH_HOME/companion/config.json 与 soul.md'),
          h(Button, { tone: 'primary', icon: 'check', onClick: save, disabled: saving }, saving ? '保存中…' : '保存设置')))
    }

    /* ---------------------------------------------------------------- */
    /* 主页面                                                            */
    /* ---------------------------------------------------------------- */

    function MaintRow({ item, children }) {
      const confidence = Math.round((item.confidence ?? 0.7) * 100)
      return h('div', { className: 'cmp-maint-row' },
        h('div', { className: 'cmp-maint-main' },
          h('div', { className: 'cmp-memory-kind' }, KIND_LABEL[item.kind] ?? '关于他'),
          h('div', { className: 'cmp-maint-text' }, item.text),
          h('div', { className: 'cmp-maint-meta' },
            `${formatDateTime(item.lastConfirmedAt || item.at)} · 重要度 ${item.importance} · 置信 ${confidence}%${item.weight !== undefined ? ` · 权重 ${item.weight}` : ''}`)),
        h('div', { className: 'cmp-maint-actions' }, children))
    }

    function DuplicateGroup({ group, busy, onMerge, onDelete }) {
      const [keep, setKeep] = useState(group[0].id)
      return h('div', { className: 'cmp-maint-group' },
        h('div', { className: 'cmp-maint-group-head' },
          h('span', { className: 'cmp-maint-group-title' }, `相似记忆 · ${group.length} 条`),
          h('select', { className: 'cmp-input cmp-select', value: keep, onChange: (e) => setKeep(e.target.value) },
            group.map((item) => h('option', { key: item.id, value: item.id }, item.text.slice(0, 30)))),
          h(Button, {
            tone: 'primary',
            icon: 'check',
            disabled: Boolean(busy),
            onClick: () => onMerge(keep, group.map((item) => item.id).filter((id) => id !== keep)),
          }, '合并其余')),
        group.map((item) => h(MaintRow, { key: item.id, item },
          h(Button, { tone: 'danger', icon: 'trash', disabled: Boolean(busy), onClick: () => onDelete(item.id) }, '删除'))))
    }

    function MemoryMaintenanceTab({ notify, onChanged }) {
      const [state, setState] = useState({ phase: 'loading', data: null, error: '' })
      const [busy, setBusy] = useState('')

      const load = useCallback(async () => {
        try {
          const data = await api('/memories/maintenance')
          setState({ phase: 'ready', data, error: '' })
        } catch (error) {
          setState({ phase: 'error', data: null, error: String(error.message ?? error) })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const run = async (key, task, message) => {
        if (busy) return
        setBusy(key)
        try {
          await task()
          notify(message)
          await load()
          await onChanged()
        } catch (error) {
          notify(String(error.message ?? error), 'error')
        } finally {
          setBusy('')
        }
      }

      const remove = (id) => {
        if (!window.confirm('永久删掉这条记忆？')) return
        void run(`del:${id}`, () => api(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }), '忘掉了。')
      }
      const confirm = (id, boost) => run(`ok:${id}`, () => post('/memories/confirm', { id, boost }), boost ? '保留并提升了重要度。' : '已确认。')
      const merge = (keepId, dropIds) => run(`merge:${keepId}`, () => post('/memories/merge', { keepId, dropIds }), '合并了。')
      const restore = (id) => run(`restore:${id}`, () => post('/memories/restore', { id }), '恢复了这个版本。')

      if (state.phase === 'loading') {
        return h('div', { className: 'cmp-loading' }, h('div', { className: 'cmp-spinner' }), '正在整理记忆…')
      }
      if (state.phase === 'error' || !state.data) {
        return h(Empty, { icon: 'brain', title: '读不到记忆维护数据', hint: state.error || '检查插件是否正常加载。', action: h(Button, { icon: 'refresh', onClick: load }, '重试') })
      }

      const data = state.data
      const low = data.lowValue || []
      const dup = data.duplicates || []
      const stale = data.stale || []
      const history = data.history || []
      const empty = low.length === 0 && dup.length === 0 && stale.length === 0 && history.length === 0

      return h('div', { className: 'cmp-tab-body' },
        h('div', { className: 'cmp-toolbar' },
          h('div', { className: 'cmp-field-hint' }, '只显示需要处理的记忆；正常记忆在「记忆」页。'),
          h(Button, { icon: 'refresh', onClick: load, disabled: Boolean(busy) }, '刷新')),
        empty ? h(Empty, { icon: 'check', title: '没有需要维护的记忆', hint: '低价值、重复、过时和旧版本会出现在这里。' }) : null,
        low.length > 0 ? h(Section, { title: `低价值自动记忆 · ${low.length}`, hint: '自动提取但重要度 < 3。默认不会注入；可以清掉，或保留并提升重要度。' },
          low.map((item) => h(MaintRow, { key: item.id, item },
            h(Button, { icon: 'check', disabled: Boolean(busy), onClick: () => confirm(item.id, true) }, '保留'),
            h(Button, { tone: 'danger', icon: 'trash', disabled: Boolean(busy), onClick: () => remove(item.id) }, '清掉')))) : null,
        dup.length > 0 ? h(Section, { title: `可能重复 · ${dup.length} 组`, hint: '选一条保留，其余标记为旧版本；旧版本可以在下面恢复。' },
          dup.map((group, index) => h(DuplicateGroup, {
            key: `dup-${index}`,
            group,
            busy,
            onMerge: merge,
            onDelete: remove,
          }))) : null,
        stale.length > 0 ? h(Section, { title: `可能过时 · ${stale.length}`, hint: '权重低于阈值或超过 120 天未确认；确认能刷新权重，也可以清掉。' },
          stale.map((item) => h(MaintRow, { key: item.id, item },
            h(Button, { icon: 'check', disabled: Boolean(busy), onClick: () => confirm(item.id, false) }, '确认'),
            h(Button, { tone: 'danger', icon: 'trash', disabled: Boolean(busy), onClick: () => remove(item.id) }, '清掉')))) : null,
        history.length > 0 ? h(Section, { title: `旧版本 · ${history.length}`, hint: '被新版本替代的记忆；恢复后当前版本会变成旧版本。' },
          history.map((item) => h(MaintRow, { key: item.id, item },
            h(Button, { icon: 'refresh', disabled: Boolean(busy), onClick: () => restore(item.id) }, '恢复'),
            h(Button, { tone: 'danger', icon: 'trash', disabled: Boolean(busy), onClick: () => remove(item.id) }, '删除')))) : null)
    }

    const TABS = [
      { id: 'overview', label: '概览', icon: 'sparkles' },
      { id: 'memory', label: '记忆', icon: 'brain' },
      { id: 'maintenance', label: '维护', icon: 'check' },
      { id: 'life', label: '生活', icon: 'book' },
      { id: 'settings', label: '设置', icon: 'settings' },
    ]

    function CompanionPage() {
      const [tab, setTab] = useState('overview')
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [toast, setToast] = useState(null)
      const toastTimer = useRef(null)

      const notify = useCallback((text, kind = 'info') => {
        setToast({ text, kind })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }, [])

      const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true)
        try {
          const result = await api('/overview')
          setData(result)
          setError('')
        } catch (err) {
          setError(String(err.message ?? err))
        } finally {
          if (!silent) setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
        // 页面不可见时暂停轮询：/overview 是重接口，别在后台空转。
        const tick = () => { if (!document.hidden) void load(true) }
        const timer = setInterval(tick, 20_000)
        document.addEventListener('visibilitychange', tick)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', tick)
        }
      }, [load])

      if (loading && !data) {
        return h('div', { className: 'cmp-root' },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          h('div', { className: 'cmp-loading' }, h('div', { className: 'cmp-spinner' }), '正在看看她过得怎么样…'))
      }

      if (!data) {
        return h('div', { className: 'cmp-root' },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          h(Empty, {
            icon: 'moon', title: '还没连上她的生活', hint: error || '检查插件是否正常加载。',
            action: h(Button, { icon: 'refresh', onClick: () => load() }, '重试'),
          }))
      }

      return h('div', { className: 'cmp-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(Hero, { data }),
        error ? h('div', { className: 'cmp-banner' }, error) : null,
        h('div', { className: 'cmp-tabs', role: 'tablist' },
          TABS.map((item) => h('button', {
            key: item.id, role: 'tab', 'aria-selected': tab === item.id ? 'true' : 'false',
            className: `cmp-tab${tab === item.id ? ' is-active' : ''}`,
            onClick: () => setTab(item.id),
          }, h(Icon, { name: item.icon, size: 16 }), item.label))),
        tab === 'overview' ? h(OverviewTab, { data, onChanged: () => load(true), notify }) : null,
        tab === 'memory' ? h(MemoryTab, { data, onChanged: () => load(true), notify }) : null,
        tab === 'maintenance' ? h(MemoryMaintenanceTab, { onChanged: () => load(true), notify }) : null,
        tab === 'life' ? h(LifeTab, { data, onChanged: () => load(true), notify }) : null,
        tab === 'settings' ? h(SettingsTab, { data, onChanged: () => load(true), notify }) : null,
        toast ? h('div', { className: `cmp-toast cmp-toast-${toast.kind}` }, toast.text) : null)
    }

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    const CSS = `
.cmp-root{--cmp-bg:var(--dsw-alias-bg-base,#fff);--cmp-card:var(--dsw-alias-bg-layer-1,#fff);--cmp-soft:var(--dsw-alias-bg-layer-2,#f5f6f8);--cmp-line:var(--dsw-alias-border-l3,#e3e5ea);--cmp-text:var(--dsw-alias-label-primary,#1f2328);--cmp-sub:var(--dsw-alias-label-secondary,#667085);--cmp-mute:var(--dsw-alias-label-tertiary,#98a2b3);--cmp-brand:var(--dsw-alias-brand-primary,#4f6ef7);--cmp-danger:var(--dsw-alias-state-error-primary,#dc2626);--cmp-ok:var(--dsw-alias-state-success-primary,#16a34a);--cmp-warn:var(--dsw-alias-state-warn-primary,#b45309);box-sizing:border-box;width:100%;max-width:1040px;margin:0 auto;padding:4px 4px 56px;color:var(--cmp-text);font-size:14px;line-height:1.6}
.cmp-root *{box-sizing:border-box}
.cmp-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:80px 20px;color:var(--cmp-sub);font-size:13px}
.cmp-spinner{width:16px;height:16px;border:2px solid var(--cmp-line);border-top-color:var(--cmp-brand);border-radius:50%;animation:cmp-spin .8s linear infinite}
@keyframes cmp-spin{to{transform:rotate(360deg)}}
.cmp-hero{display:flex;align-items:center;gap:20px;padding:22px;border:1px solid var(--cmp-line);border-radius:22px;background:linear-gradient(135deg,color-mix(in srgb,var(--cmp-brand) 7%,var(--cmp-card)),var(--cmp-card) 62%);margin-bottom:18px}
.cmp-hero-main{flex:1;min-width:0}
.cmp-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cmp-name{margin:0;font-size:24px;line-height:1.25;font-weight:650;letter-spacing:.01em}
.cmp-hero-sub{color:var(--cmp-sub);font-size:13px;margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cmp-dot{color:var(--cmp-mute)}
.cmp-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.cmp-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;background:var(--cmp-soft);color:var(--cmp-sub);font-size:12px;line-height:18px}
.cmp-hero-side{width:180px;flex:none;padding:12px 14px;border-radius:16px;background:color-mix(in srgb,var(--cmp-brand) 5%,var(--cmp-card));border:1px solid color-mix(in srgb,var(--cmp-brand) 12%,var(--cmp-line))}
.cmp-hero-side-label{font-size:11px;color:var(--cmp-mute);letter-spacing:.08em}
.cmp-hero-affection{font-size:18px;font-weight:650;margin:2px 0 8px}
.cmp-hero-side-hint{font-size:11px;color:var(--cmp-sub);margin-top:6px;line-height:1.5}
.cmp-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;line-height:19px;font-weight:600;white-space:nowrap}
.cmp-pill-neutral{background:var(--cmp-soft);color:var(--cmp-sub)}
.cmp-pill-brand{background:color-mix(in srgb,var(--cmp-brand) 10%,transparent);color:var(--cmp-brand)}
.cmp-pill-success{background:color-mix(in srgb,var(--cmp-ok) 12%,transparent);color:var(--cmp-ok)}
.cmp-pill-warn{background:color-mix(in srgb,var(--cmp-warn) 12%,transparent);color:var(--cmp-warn)}
.cmp-bar{height:6px;border-radius:999px;background:color-mix(in srgb,var(--cmp-line) 75%,transparent);overflow:hidden;margin:8px 0 0;width:100%}
.cmp-bar-fill{height:100%;border-radius:999px;transition:width .45s cubic-bezier(.2,.8,.2,1)}
.cmp-bar-brand{background:var(--cmp-brand)}
.cmp-bar-affection{background:linear-gradient(90deg,color-mix(in srgb,var(--cmp-brand) 55%,#ff9ab0),#ee7c98)}
.cmp-bar-mood{background:linear-gradient(90deg,#8fb4e8,#6fc39a)}
.cmp-bar-energy{background:linear-gradient(90deg,#e7b45f,#e8894f)}
.cmp-tabs{display:flex;align-items:center;gap:4px;padding:4px;background:var(--cmp-soft);border-radius:12px;margin-bottom:18px;width:fit-content;max-width:100%;overflow:auto}
.cmp-tab{appearance:none;border:0;background:transparent;color:var(--cmp-sub);font:inherit;font-size:13px;padding:6px 14px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.cmp-tab:hover{color:var(--cmp-text)}
.cmp-tab.is-active{background:var(--cmp-card);color:var(--cmp-text);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.08)}
.cmp-tab-body{display:flex;flex-direction:column;gap:18px}
.cmp-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.cmp-stat{background:var(--cmp-card);border:1px solid var(--cmp-line);border-radius:16px;padding:14px 16px}
.cmp-stat-top{display:flex;align-items:center;gap:7px;color:var(--cmp-sub);font-size:12px}
.cmp-stat-icon{display:inline-flex;color:var(--cmp-brand)}
.cmp-stat-label{font-weight:500}
.cmp-stat-value{font-size:20px;font-weight:650;margin-top:4px;line-height:1.3}
.cmp-stat-hint{font-size:11px;color:var(--cmp-mute);margin-top:6px;line-height:1.45}
.cmp-section{background:var(--cmp-card);border:1px solid var(--cmp-line);border-radius:18px;padding:16px 18px}
.cmp-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.cmp-section-title{margin:0;font-size:15px;font-weight:650}
.cmp-section-hint{margin:3px 0 0;font-size:12px;color:var(--cmp-mute);line-height:1.5}
.cmp-chat{border:1px solid var(--cmp-line);border-radius:18px;background:var(--cmp-card);overflow:hidden}
.cmp-chat-list{max-height:420px;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:linear-gradient(var(--cmp-card),color-mix(in srgb,var(--cmp-soft) 45%,var(--cmp-card)))}
.cmp-msg{display:flex;flex-direction:column;max-width:76%}
.cmp-msg.is-owner{align-self:flex-end;align-items:flex-end}
.cmp-msg.is-her{align-self:flex-start;align-items:flex-start}
.cmp-bubble{padding:9px 13px;border-radius:16px;font-size:13.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.cmp-bubble-owner{background:var(--cmp-brand);color:var(--dsw-alias-label-primary-foreground,#fff);border-bottom-right-radius:5px}
.cmp-bubble-her{background:var(--cmp-soft);color:var(--cmp-text);border-bottom-left-radius:5px}
.cmp-msg-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--cmp-mute);margin-top:4px;padding:0 3px}
.cmp-msg-tag{color:var(--cmp-brand);background:color-mix(in srgb,var(--cmp-brand) 9%,transparent);border-radius:4px;padding:0 4px}
.cmp-composer{display:flex;align-items:center;gap:8px;padding:12px;border-top:1px solid var(--cmp-line);background:var(--cmp-card)}
.cmp-composer-input{flex:1}
.cmp-input{width:100%;appearance:none;border:1px solid var(--cmp-line);background:var(--cmp-soft);color:var(--cmp-text);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;line-height:1.5;outline:none;transition:border-color .15s,box-shadow .15s}
.cmp-input:focus{border-color:var(--cmp-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--cmp-brand) 14%,transparent)}
.cmp-input::placeholder{color:var(--cmp-mute)}
.cmp-textarea{resize:vertical;min-height:72px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12.5px;line-height:1.7}
.cmp-select{cursor:pointer;min-width:120px}
.cmp-btn{appearance:none;border:1px solid var(--cmp-line);background:var(--cmp-card);color:var(--cmp-text);border-radius:9px;padding:7px 12px;font:inherit;font-size:12.5px;line-height:1.4;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s}
.cmp-btn:hover:not(:disabled){background:var(--cmp-soft)}
.cmp-btn:disabled{opacity:.5;cursor:default}
.cmp-btn-primary{background:var(--cmp-brand);border-color:var(--cmp-brand);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.cmp-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--cmp-brand) 88%,#000)}
.cmp-btn-danger{color:var(--cmp-danger);border-color:color-mix(in srgb,var(--cmp-danger) 25%,var(--cmp-line))}
.cmp-icon-btn{appearance:none;border:0;background:transparent;color:var(--cmp-mute);cursor:pointer;padding:3px;border-radius:6px;display:inline-flex}
.cmp-icon-btn:hover{color:var(--cmp-danger);background:var(--cmp-soft)}
.cmp-toolbar{display:flex;align-items:center;gap:8px}
.cmp-add-card{background:var(--cmp-card);border:1px dashed color-mix(in srgb,var(--cmp-brand) 35%,var(--cmp-line));border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px}
.cmp-add-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cmp-memory-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.cmp-memory{background:var(--cmp-card);border:1px solid var(--cmp-line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:7px}
.cmp-memory-top{display:flex;align-items:center;gap:7px}
.cmp-memory-kind{font-size:10.5px;color:var(--cmp-brand);background:color-mix(in srgb,var(--cmp-brand) 9%,transparent);padding:1px 6px;border-radius:5px;white-space:nowrap}
.cmp-memory-date{font-size:10.5px;color:var(--cmp-mute);margin-left:auto}
.cmp-memory-text{font-size:13px;line-height:1.6;word-break:break-word}
.cmp-memory-foot{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--cmp-mute)}
.cmp-memory-conf{margin-left:auto;color:var(--cmp-mute)}
.cmp-maint-row{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px dashed color-mix(in srgb,var(--cmp-line) 80%,transparent)}
.cmp-maint-row:first-of-type{border-top:0}
.cmp-maint-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.cmp-maint-main .cmp-memory-kind{align-self:flex-start;width:fit-content}
.cmp-maint-text{font-size:13px;line-height:1.6;word-break:break-word}
.cmp-maint-meta{font-size:10.5px;color:var(--cmp-mute);line-height:1.5}
.cmp-maint-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;flex:none;max-width:280px}
.cmp-maint-group{border:1px dashed color-mix(in srgb,var(--cmp-brand) 28%,var(--cmp-line));border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:color-mix(in srgb,var(--cmp-brand) 3%,var(--cmp-card))}
.cmp-maint-group-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:6px}
.cmp-maint-group-title{font-size:12px;font-weight:600;margin-right:auto}
.cmp-dots{display:inline-flex;gap:2px}
.cmp-dots i{width:4px;height:4px;border-radius:50%;background:var(--cmp-line);display:block}
.cmp-dots i.is-on{background:var(--cmp-brand)}
.cmp-world{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--cmp-brand) 6%,var(--cmp-card)),var(--cmp-card));border:1px solid var(--cmp-line);border-radius:16px;padding:14px 16px}
.cmp-world-icon{width:38px;height:38px;border-radius:12px;background:color-mix(in srgb,var(--cmp-brand) 10%,transparent);color:var(--cmp-brand);display:flex;align-items:center;justify-content:center;flex:none}
.cmp-world-title{font-size:12px;color:var(--cmp-mute)}
.cmp-world-text{font-size:13.5px;margin-top:2px}
.cmp-timeline{position:relative;display:flex;flex-direction:column;gap:14px;padding-left:16px}
.cmp-timeline:before{content:'';position:absolute;left:4px;top:6px;bottom:6px;width:1.5px;background:var(--cmp-line)}
.cmp-timeline-item{position:relative;padding-left:8px}
.cmp-timeline-dot{position:absolute;left:-16px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--cmp-line);border:2px solid var(--cmp-card)}
.cmp-timeline-dot[data-shared=true]{background:var(--cmp-brand)}
.cmp-timeline-time{font-size:11px;color:var(--cmp-mute);font-variant-numeric:tabular-nums}
.cmp-timeline-title{font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.cmp-timeline-type{font-size:10.5px;font-weight:400;color:var(--cmp-mute);background:var(--cmp-soft);padding:0 5px;border-radius:4px}
.cmp-timeline-shared{font-size:10.5px;font-weight:400;color:var(--cmp-brand);background:color-mix(in srgb,var(--cmp-brand) 9%,transparent);padding:0 5px;border-radius:4px}
.cmp-timeline-desc{font-size:12.5px;color:var(--cmp-sub);margin-top:2px;line-height:1.6}
.cmp-timeline-impact{font-size:11.5px;color:var(--cmp-mute);margin-top:2px}
.cmp-diary{margin:0;padding:14px 16px;background:var(--cmp-soft);border-radius:12px;white-space:pre-wrap;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12.5px;line-height:1.85;color:var(--cmp-text);max-height:420px;overflow:auto}
.cmp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:34px 20px;text-align:center;color:var(--cmp-mute)}
.cmp-empty-icon{color:color-mix(in srgb,var(--cmp-brand) 65%,var(--cmp-mute));margin-bottom:2px}
.cmp-empty-title{font-size:13px;color:var(--cmp-sub);font-weight:600}
.cmp-empty-hint{font-size:12px;max-width:420px;line-height:1.6}
.cmp-empty .cmp-btn{margin-top:8px}
.cmp-grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.cmp-grid-tight{gap:6px}
.cmp-field{display:flex;flex-direction:column;gap:5px}
.cmp-field-label{font-size:12px;color:var(--cmp-sub);font-weight:500}
.cmp-field-hint{font-size:11px;color:var(--cmp-mute);line-height:1.5}
.cmp-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:4px 0 10px}
.cmp-row-title{font-size:13px;font-weight:500}
.cmp-row-hint{font-size:11px;color:var(--cmp-mute);margin-top:2px;line-height:1.5}
.cmp-bind-card{margin-top:12px;border:1px dashed color-mix(in srgb,var(--cmp-brand) 30%,var(--cmp-line));border-radius:14px;padding:12px 14px;background:color-mix(in srgb,var(--cmp-brand) 4%,var(--cmp-card))}
.cmp-bind-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.cmp-bind-title{font-size:13px;font-weight:600}
.cmp-bind-body{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.cmp-bind-openid{font-size:12px;word-break:break-all;background:var(--cmp-soft);border-radius:8px;padding:6px 8px;width:100%;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace)}
.cmp-bind-code{font-size:15px;font-weight:650;letter-spacing:.06em;background:var(--cmp-soft);border:1px solid var(--cmp-line);border-radius:8px;padding:8px 12px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);color:var(--cmp-brand);user-select:all}
.cmp-session-title{font-size:13px;font-weight:600}
.cmp-session-id{font-size:11px;color:var(--cmp-mute);word-break:break-all;background:var(--cmp-soft);border-radius:8px;padding:6px 8px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);margin:6px 0 8px}
.cmp-toggle{appearance:none;border:0;width:40px;height:23px;border-radius:999px;background:var(--cmp-line);position:relative;cursor:pointer;flex:none;transition:background .18s}
.cmp-toggle.is-on{background:var(--cmp-brand)}
.cmp-toggle-knob{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .18s}
.cmp-toggle.is-on .cmp-toggle-knob{transform:translateX(17px)}
.cmp-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cmp-test{font-size:12px;padding:3px 8px;border-radius:6px}
.cmp-test.is-ok{color:var(--cmp-ok);background:color-mix(in srgb,var(--cmp-ok) 10%,transparent)}
.cmp-test.is-bad{color:var(--cmp-danger);background:color-mix(in srgb,var(--cmp-danger) 9%,transparent)}
.cmp-advanced-head{display:flex;justify-content:center;padding:2px 0}
.cmp-link-btn{appearance:none;border:0;background:transparent;color:var(--cmp-sub);font:inherit;font-size:12px;cursor:pointer;padding:4px 8px;border-radius:6px}
.cmp-link-btn:hover{color:var(--cmp-brand);background:var(--cmp-soft)}
.cmp-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0 0;border-top:1px solid var(--cmp-line);margin-top:2px}
.cmp-save-hint{font-size:11px;color:var(--cmp-mute)}
.cmp-banner{background:color-mix(in srgb,var(--cmp-danger) 8%,var(--cmp-card));border:1px solid color-mix(in srgb,var(--cmp-danger) 22%,var(--cmp-line));color:var(--cmp-danger);border-radius:10px;padding:9px 12px;font-size:12px;margin-bottom:12px;white-space:pre-wrap}
.cmp-toast{position:fixed;right:26px;bottom:26px;z-index:80;max-width:360px;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#1f2328);color:#fff;font-size:12.5px;line-height:1.5;box-shadow:0 12px 32px rgba(16,24,40,.24);animation:cmp-in .18s ease-out}
.cmp-toast-error{background:var(--cmp-danger)}
@keyframes cmp-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (max-width:720px){.cmp-hero{align-items:flex-start;flex-wrap:wrap}.cmp-hero-side{width:100%}.cmp-stats{grid-template-columns:1fr}.cmp-grid-2{grid-template-columns:1fr}.cmp-root{padding-left:0;padding-right:0}}
`

    /* ---------------------------------------------------------------- */
    /* 注册                                                              */
    /* ---------------------------------------------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'companion',
          order: 12,
          label: () => '陪伴',
        }, CompanionPage))
      },
    }
  },
})
