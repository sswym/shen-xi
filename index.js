/**
 * dsh-companion 的 Host 半边。
 *
 * 启动后：
 *   - 初始化 $DSH_HOME/companion 下的人格、生活、记忆文件；
 *   - 启动 QQ（官方 API 或 OneBot 11）收发；
 *   - 每 30 秒检查一次心跳时间；
 *   - 在 DSH Web 上挂 /dsh-companion/api 给管理界面用。
 *
 * 生成的模型调用走 DSH 的 llm 服务，不创建额外 Agent，也不依赖别的插件。
 */
import { ensureHome, homeRoot, loadConfig } from './lib/life.js'
import { Engine } from './lib/engine.js'
import { QqBridge } from './lib/qq.js'
import { registerApi } from './lib/api.js'
import { SessionStore } from './lib/session-store.js'

export const name = 'companion'
export const inject = ['llm']

export async function apply(ctx) {
  const root = homeRoot()
  const log = (line) => {
    try {
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(line)
      else console.log(line)
    } catch { /* 日志失败不影响主流程 */ }
  }
  const warn = (line) => {
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
      else console.warn(line)
    } catch { /* ignore */ }
  }

  await ensureHome(root)

  const qq = new QqBridge({
    loadConfig: () => loadConfig(root),
    log,
    onPrivateMessage: async ({ userId, text, eventId }) => {
      const cfg = await loadConfig(root)
      if (!cfg.qq.enabled) return
      if (!cfg.qq.ownerId) {
        const code = String(cfg.qq.bindCode ?? '')
        const normalize = (value) => String(value ?? '').replace(/\s+/g, '')
        if (code && normalize(text) === code) {
          const bound = await engine.bindOwner(userId)
          if (bound.ok) {
            const next = await loadConfig(root)
            await qq.send('绑定好了。以后我只和你说话。', next, { replyTo: eventId })
            log(`[companion] 已绑定主人 OpenID：${userId}`)
          }
          return
        }
        warn('[companion] 收到未绑定用户的私聊，已忽略；绑定码在「设置 → 陪伴 → 设置」里')
        return
      }
      // 主人之外的用户交给 engine：guests.enabled 时按访客分流，否则忽略。
      await engine.handleOwnerMessage({ text, channel: 'qq', userId, eventId })
    },
  })

  const store = new SessionStore({ ctx, root, log })
  const engine = new Engine({ ctx, root, qq, store, log })
  engine.root = root

  ctx.effect(() => store.watchDisposal(), 'companion.session-events')

  ctx.effect(() => {
    void qq.start().catch((error) => warn(`[companion] QQ 启动失败：${error?.message ?? error}`))
    return () => qq.stop()
  }, 'companion.qq')

  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const cfg = await loadConfig(root)
          qq.configure(cfg)
          await engine.tick()
        } catch (error) {
          warn(`[companion] 心跳检查失败：${error?.message ?? error}`)
        }
      })()
    }, 30_000)
    if (timer.unref) timer.unref()
    const warmup = setTimeout(() => { void engine.tick().catch(() => {}) }, 3_000)
    if (warmup.unref) warmup.unref()
    return () => {
      clearInterval(timer)
      clearTimeout(warmup)
    }
  }, 'companion.heartbeat')

  ctx.inject(['webServer'], (scoped) => {
    const api = registerApi({ ctx: scoped, engine, log })
    if (!api.ok) {
      warn(`[companion] 管理接口没有挂上：${api.error}`)
      return
    }
    scoped.effect(() => api.dispose, 'companion.api')
    log(`[companion] 管理接口已挂载 ${api.path}`)
  })

  log(`[companion] 已启动，数据目录 ${root}`)
}

export { homeRoot }
