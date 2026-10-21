/**
 * Host-half integration check.
 *
 * The `/api` surface is authenticated, so an outside HTTP probe cannot tell a
 * registered route from a missing one. This script instead drives the real
 * `apply()` with a stand-in Context that records route registrations, then calls
 * those routes exactly as the browser half does — including a full publish that
 * runs route -> service -> github-client -> (stubbed) api.github.com.
 *
 * `$DSH_HOME` is redirected to a throwaway directory first, so a settings write
 * here can never touch the developer's real profile.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandboxHome = mkdtempSync(join(tmpdir(), 'ghb-host-'))
process.env.DSH_HOME = sandboxHome

const { apply } = await import('../index.js')

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

// ---------------------------------------------------------------------
// A stand-in Context exposing only what the plugin reads.
// ---------------------------------------------------------------------

const TOKEN = 'stub-token'

function createContext({ token = TOKEN } = {}) {
  const routes = new Map()
  const disposers = []
  const logs = []
  const services = new Map()

  const credentials = {
    async describe() {
      return { configured: token !== null, source: token === null ? undefined : 'test', writable: true }
    },
    async resolve() {
      return token === null ? undefined : { value: token, source: 'test' }
    },
    async set(value) {
      services.set('token', value)
    },
    async unset() {
      services.delete('token')
    },
  }

  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  }

  function makeCtx() {
    return {
      logger: {
        info: (message) => logs.push(`info: ${message}`),
        warn: (message) => logs.push(`warn: ${message}`),
        debug: () => {},
      },
      get(name) {
        if (name === 'connection') return connection
        if (name === 'credentials') return credentials
        return undefined
      },
      effect(callback) {
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => {}
      },
      inject(_services, callback) {
        return callback(makeCtx())
      },
      provide() {},
      set(name, value) {
        services.set(name, value)
      },
    }
  }

  return { ctx: makeCtx(), routes, disposers, logs, services, credentials }
}

/** Call one registered route the way the web server does. */
async function callRoute(routes, path, payload, { raw } = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  assert.deepEqual(route.methods, ['POST'], `${path} must accept POST`)
  assert.equal(route.requestBody, 'buffered', `${path} must buffer its body`)
  const body = raw ?? (payload === undefined ? '' : JSON.stringify(payload))
  const request = new Request(`http://localhost${path}`, { method: 'POST', body })
  const response = await route.fetch(request)
  assert.equal(response.status, 200, `${path} answers domain failures inside a 200 envelope`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}

// ---------------------------------------------------------------------
// A stub api.github.com, used for the publish path.
// ---------------------------------------------------------------------

function installStubGitHub({ files = {} } = {}) {
  const state = { files: new Map(Object.entries(files)), commits: [], blobs: new Map(), calls: [] }
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(body) })
  const shaOf = (path) => `blob-${Buffer.from(path).toString('hex')}`

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const path = decodeURIComponent(new URL(url).pathname)
    state.calls.push(`${method} ${path}`)
    const base = '/repos/huangxicheng1/huangxicheng1.github.io'

    if (method === 'GET' && path === `${base}/git/ref/heads/main`) return json(200, { object: { sha: 'head1' } })
    if (method === 'GET' && path.startsWith(`${base}/git/commits/`)) return json(200, { sha: 'head1', tree: { sha: 'tree1' } })
    if (method === 'GET' && path === `${base}/git/trees/tree1`) {
      return json(200, {
        tree: [...state.files.entries()].map(([filePath, text]) => {
          state.blobs.set(shaOf(filePath), text)
          return { path: filePath, mode: '100644', type: 'blob', sha: shaOf(filePath), size: text.length }
        }),
      })
    }
    if (method === 'GET' && path.startsWith(`${base}/git/blobs/`)) {
      const text = state.blobs.get(path.slice(`${base}/git/blobs/`.length))
      return text === undefined ? json(404, { message: 'Not Found' }) : json(200, { encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') })
    }
    const contents = `${base}/contents/`
    if (method === 'GET' && path.startsWith(contents)) {
      const filePath = path.slice(contents.length)
      const text = state.files.get(filePath)
      if (text === undefined) return json(404, { message: 'Not Found' })
      return json(200, { sha: shaOf(filePath), content: Buffer.from(text, 'utf8').toString('base64'), size: text.length })
    }
    if (method === 'POST' && path === `${base}/git/blobs`) {
      const sha = `newblob${state.blobs.size}`
      state.blobs.set(sha, JSON.parse(init.body).content)
      return json(201, { sha })
    }
    if (method === 'POST' && path === `${base}/git/trees`) {
      state.trees = state.trees ?? []
      state.trees.push(JSON.parse(init.body))
      return json(201, { sha: 'newtree' })
    }
    if (method === 'POST' && path === `${base}/git/commits`) {
      state.commits.push(JSON.parse(init.body))
      return json(201, { sha: 'newcommit' })
    }
    if (method === 'PATCH' && path === `${base}/git/refs/heads/main`) {
      state.refUpdates = state.refUpdates ?? []
      state.refUpdates.push(JSON.parse(init.body))
      return json(200, { object: { sha: 'newcommit' } })
    }
    if (method === 'GET' && path === `${base}/actions/runs`) return json(200, { workflow_runs: [] })
    if (method === 'GET' && path === '/user') return json(200, { login: 'huangxicheng1' })
    if (method === 'GET' && path === base) return json(200, { full_name: 'huangxicheng1/huangxicheng1.github.io', default_branch: 'main', private: false, permissions: { push: true } })
    return json(404, { message: `unhandled ${method} ${path}` })
  }
  return state
}

const realFetch = globalThis.fetch

// ---------------------------------------------------------------------

const registered = createContext()
apply(registered.ctx, {})

const EXPECTED_ROUTES = [
  '/api/gh-blog/settings',
  '/api/gh-blog/settings/save',
  '/api/gh-blog/test-connection',
  '/api/gh-blog/articles',
  '/api/gh-blog/article',
  '/api/gh-blog/validate',
  '/api/gh-blog/publish',
  '/api/gh-blog/run',
  '/api/gh-blog/automation/contract',
  '/api/gh-blog/automation/create',
]

check('host: apply() registers every route as an owned effect', () => {
  for (const path of EXPECTED_ROUTES) {
    assert.ok(registered.routes.has(path), `missing route ${path}`)
  }
  assert.equal(registered.routes.size, EXPECTED_ROUTES.length)
  assert.equal(registered.disposers.length, EXPECTED_ROUTES.length, 'each route must have a disposer for plugin unload')
})

check('host: the service is published for in-process automation', () => {
  assert.ok(registered.services.has('ghBlog'), 'ghBlog must be set on the context')
  assert.equal(typeof registered.services.get('ghBlog').publish, 'function')
})

await checkAsync('route settings: defaults come back without ever exposing a token', async () => {
  const payload = await callRoute(registered.routes, '/api/gh-blog/settings', {})
  assert.equal(payload.ok, true)
  assert.equal(payload.value.repository, 'huangxicheng1/huangxicheng1.github.io')
  assert.equal(payload.value.branch, 'main')
  assert.equal(payload.value.contentRoot, 'content')
  assert.equal(payload.value.hasToken, true)
  assert.equal('token' in payload.value, false, 'the envelope must never carry the secret')
})

await checkAsync('route settings/save: preferences persist into $DSH_HOME', async () => {
  const saved = await callRoute(registered.routes, '/api/gh-blog/settings/save', { repository: 'me/site', branch: 'trunk' })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.repository, 'me/site')
  assert.equal(saved.value.branch, 'trunk')
  const reread = await callRoute(registered.routes, '/api/gh-blog/settings', {})
  assert.equal(reread.value.repository, 'me/site')
  // Restore for the remaining cases.
  await callRoute(registered.routes, '/api/gh-blog/settings/save', {
    repository: 'huangxicheng1/huangxicheng1.github.io',
    branch: 'main',
  })
})

await checkAsync('route settings/save: an invalid repository is a field error, not a 500', async () => {
  const saved = await callRoute(registered.routes, '/api/gh-blog/settings/save', { repository: 'not a repo' })
  assert.equal(saved.ok, false)
  assert.equal(saved.error.code, 'invalid-settings')
})

await checkAsync('route validate: an invalid draft answers with per-field errors', async () => {
  const payload = await callRoute(registered.routes, '/api/gh-blog/validate', {
    form: { title: '', date: '2026-02-30', type: 'post', summary: '', body: '' },
    slug: 'x',
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.value.ok, false)
  const fields = payload.value.errors.map((error) => error.field)
  for (const field of ['title', 'date', 'type', 'summary', 'body']) {
    assert.ok(fields.includes(field), `expected a ${field} error, got ${fields.join(',')}`)
  }
})

await checkAsync('route articles: without a token the panel gets a setup-shaped failure', async () => {
  const noTokenHome = createContext({ token: null })
  apply(noTokenHome.ctx, {})
  const payload = await callRoute(noTokenHome.routes, '/api/gh-blog/articles', {})
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'missing-token')
})

await checkAsync('route automation/contract: the documented hook is served', async () => {
  const payload = await callRoute(registered.routes, '/api/gh-blog/automation/contract', {})
  assert.equal(payload.ok, true)
  assert.equal(payload.value.version, 1)
  assert.equal(payload.value.routes.create.path, '/api/gh-blog/automation/create')
  assert.equal(payload.value.service.name, 'ghBlog')
  assert.equal(payload.value.browserEvent.name, 'dsh-gh-blog:draft')
})

await checkAsync('route automation/create: publishing without confirm is refused', async () => {
  const payload = await callRoute(registered.routes, '/api/gh-blog/automation/create', {
    title: 'x',
    body: 'y',
    publish: true,
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'confirmation-required')
})

await checkAsync('route: a body that is not JSON is reported, not thrown', async () => {
  const payload = await callRoute(registered.routes, '/api/gh-blog/settings', undefined, { raw: '{not json' })
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'bad-request')
})

await checkAsync('route article: a path outside content/ is refused', async () => {
  const payload = await callRoute(registered.routes, '/api/gh-blog/article', { path: 'README.md' })
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'bad-path')
})

await checkAsync('end to end: automation create with publish+confirm makes one commit', async () => {
  const github = installStubGitHub({ files: { 'content/notes/existing.md': 'old' } })
  try {
    const payload = await callRoute(registered.routes, '/api/gh-blog/automation/create', {
      title: '今天的复盘',
      date: '2026-10-21',
      type: 'note',
      summary: '摘要',
      tags: ['复盘'],
      body: '## 内容\n\n正文',
      slug: 'daily-review',
      publish: true,
      confirm: true,
      commitMessage: 'blog: 自动写入今日复盘',
    })
    assert.equal(payload.ok, true, JSON.stringify(payload.error ?? {}))
    assert.equal(payload.value.published, true)
    assert.equal(payload.value.path, 'content/notes/2026-10-21-daily-review.md')
    assert.equal(github.commits.length, 1)
    assert.equal(github.commits[0].message, 'blog: 自动写入今日复盘')
    assert.equal(github.refUpdates.length, 1)
    assert.equal(github.refUpdates[0].force, false)
    // The new file's front matter must satisfy the site's contract.
    assert.ok(github.blobs.size > 0)
    const written = [...github.blobs.values()].find((text) => text.includes('daily-review') || text.includes('今天的复盘'))
    assert.ok(written !== undefined, 'the article text must reach the blob API')
    assert.ok(written.startsWith('---\ntitle: 今天的复盘\ndate: 2026-10-21\ntype: note\nsummary: 摘要\n'))
    assert.ok(written.includes('tags: 复盘'))
  } finally {
    globalThis.fetch = realFetch
  }
})

await checkAsync('end to end: a publish of an invalid article writes nothing', async () => {
  const github = installStubGitHub({ files: {} })
  try {
    const payload = await callRoute(registered.routes, '/api/gh-blog/automation/create', {
      title: '坏文章',
      date: '2026-02-30',
      body: 'x',
      slug: 'bad',
      publish: true,
      confirm: true,
    })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'invalid-front-matter')
    assert.equal(github.commits.length, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

await checkAsync('end to end: publish:false stages instead of committing', async () => {
  const github = installStubGitHub({ files: {} })
  try {
    const payload = await callRoute(registered.routes, '/api/gh-blog/automation/create', {
      title: '只暂存',
      date: '2026-10-21',
      body: '正文',
      slug: 'staged-only',
      publish: false,
    })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.published, false)
    assert.ok(payload.value.text.startsWith('---\n'))
    assert.equal(github.commits.length, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------

rmSync(sandboxHome, { recursive: true, force: true })

for (const failure of failures) {
  console.error(`\nFAIL  ${failure.name}`)
  console.error(failure.error?.stack ?? failure.error)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
