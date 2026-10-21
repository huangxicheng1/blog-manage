/**
 * Host half of the GitHub Pages blog manager.
 *
 * Responsibilities:
 *   - own the settings store and the GitHub token (through DSH's `credentials`
 *     service, never a file this plugin writes),
 *   - serve `/api/gh-blog/*` routes to the browser half,
 *   - provide the `ghBlog` service so other plugins and automatic tasks can drive
 *     the same operations in-process.
 *
 * The browser half never talks to api.github.com: it only talks to these routes,
 * so a token can never leak into page JavaScript or into a rendered component.
 */

import { AUTOMATION_CONTRACT, createArticleViaAutomation } from './lib/automation.js'
import { TOKEN_REF, createBlogService, toCodedError } from './lib/blog-service.js'
import { GitHubError } from './lib/github-client.js'
import { createSettingsStore } from './lib/settings-store.js'

export const name = 'gh-blog'

/** Routes need the browser carrier; the service itself works without it. */
export const inject = []

const ROUTE_PREFIX = '/api/gh-blog'

/**
 * Narrow the Host credentials service to the four calls this plugin needs.
 *
 * Every call reads through the service instead of a local cache, so rotating a
 * PAT in the panel takes effect on the very next operation. A missing service is
 * reported as a clear failure rather than a crash on activation.
 */
function createCredentialAdapter(ctx) {
  const lookup = () => {
    try {
      return ctx.get('credentials')
    } catch {
      return undefined
    }
  }

  const require_ = (method) => {
    const service = lookup()
    if (service === undefined || service === null || typeof service[method] !== 'function') {
      throw new GitHubError(
        'no-credentials',
        'DSH 的凭据服务不可用，无法安全保存 GitHub Token。请确认当前配置启用了凭据存储。',
      )
    }
    return service
  }

  return {
    async describe() {
      const service = lookup()
      if (service === undefined || service === null || typeof service.describe !== 'function') {
        return { configured: false, writable: false }
      }
      try {
        return await service.describe(TOKEN_REF)
      } catch {
        return { configured: false, writable: false }
      }
    },
    async resolve() {
      const service = lookup()
      if (service === undefined || service === null || typeof service.resolve !== 'function') return undefined
      try {
        const resolved = await service.resolve(TOKEN_REF)
        return typeof resolved?.value === 'string' ? resolved.value : undefined
      } catch {
        return undefined
      }
    },
    async set(value) {
      await require_('set').set(TOKEN_REF, value)
    },
    async unset() {
      const service = lookup()
      if (service === undefined || service === null || typeof service.unset !== 'function') return
      await service.unset(TOKEN_REF)
    },
  }
}

/** JSON response with the envelope both halves agree on. */
function respond(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
}

/** Wrap one operation so a throw becomes `{ ok: false, error }` for the client. */
function route(operation) {
  return async (request) => {
    let body = {}
    if (request.method === 'POST') {
      const text = await request.text()
      if (text.trim() !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          return respond({ ok: false, error: { code: 'bad-request', message: '请求体不是合法的 JSON', details: {} } })
        }
      }
    }
    try {
      const value = await operation(body, request)
      return respond({ ok: true, value: value === undefined ? null : value })
    } catch (error) {
      const coded = toCodedError(error)
      return respond({ ok: false, error: coded })
    }
  }
}

/** Register every route; each registration is an effect owned by this plugin. */
function registerRoutes(ctx, service, logger) {
  const connection = ctx.get('connection')
  const register = connection?.fetch?.register
  if (typeof register !== 'function') {
    logger?.warn?.('gh-blog: connection.fetch 不可用，浏览器面板无法连接 Host')
    return
  }

  const handlers = {
    [`${ROUTE_PREFIX}/settings`]: route(async () => service.settings()),
    [`${ROUTE_PREFIX}/settings/save`]: route(async (body) => service.saveSettings(body)),
    [`${ROUTE_PREFIX}/test-connection`]: route(async (_body, request) => service.testConnection({ signal: request.signal })),
    [`${ROUTE_PREFIX}/articles`]: route(async (body, request) =>
      service.listArticles({ refresh: body?.refresh === true, signal: request.signal }),
    ),
    [`${ROUTE_PREFIX}/article`]: route(async (body, request) => service.readArticle({ path: body?.path, signal: request.signal })),
    [`${ROUTE_PREFIX}/validate`]: route(async (body) => service.validateDraft(body)),
    [`${ROUTE_PREFIX}/publish`]: route(async (body, request) =>
      service.publish({ changes: body?.changes, message: body?.message, signal: request.signal }),
    ),
    [`${ROUTE_PREFIX}/run`]: route(async (_body, request) => service.latestRun({ signal: request.signal })),
    [`${ROUTE_PREFIX}/automation/contract`]: route(async () => AUTOMATION_CONTRACT),
    [`${ROUTE_PREFIX}/automation/create`]: route(async (body, request) => {
      if (body?.publish === true && body?.confirm !== true) {
        throw new GitHubError(
          'confirmation-required',
          '自动化发布需要在请求体里带上 confirm: true，避免脚本误发布。',
        )
      }
      return createArticleViaAutomation(service, body)
    }),
  }

  for (const [path, handler] of Object.entries(handlers)) {
    ctx.effect(
      () =>
        register.call(connection.fetch, {
          path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: handler,
        }),
      `gh-blog: ${path}`,
    )
  }
  logger?.info?.(`gh-blog: 已注册 ${Object.keys(handlers).length} 条 /api/gh-blog 路由`)
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const settingsStore = createSettingsStore({ config: config ?? {}, logger })
  const credentials = createCredentialAdapter(ctx)
  const service = createBlogService({ settingsStore, credentials, logger })

  // Publish the service for in-process automation. A profile without service
  // provisioning must still get the UI, so this is best-effort.
  try {
    ctx.provide?.('ghBlog')
    ctx.set?.('ghBlog', service)
  } catch (error) {
    logger?.warn?.(`gh-blog: 未能注册 ghBlog 服务（${error?.message ?? error}），HTTP 接口不受影响`)
  }

  // Routes wait for the browser carrier instead of blocking activation on it.
  // Cleanup lives in the route effects themselves, so the callback returns
  // nothing and stays compatible with the inject() contract.
  ctx.inject(['connection'], (inner) => {
    registerRoutes(inner, service, logger)
  })
}
