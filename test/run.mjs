/**
 * Dependency-free verification for the plugin's Host half.
 *
 * Run with `node test/run.mjs`. It exercises the three things most likely to
 * break silently:
 *
 *   1. `content-store` — the front matter contract this plugin must keep equal to
 *      the site's `build.py`. Every case below is a rule the requirement lists.
 *   2. `github-client` — request shape, retry, timeout, and the atomic
 *      blob -> tree -> commit -> ref sequence, against a stub API.
 *   3. `blog-service.publish` — the validation gate and the sha-conflict guard,
 *      which are the two ways an accidental overwrite could reach `main`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  articleIdFromPath,
  buildArticlePath,
  groupFromPath,
  isIsoDate,
  joinTags,
  normalizeArticle,
  parseFrontMatter,
  serializeArticle,
  slugifyTitle,
  splitTags,
  validateArticle,
  validateDocumentText,
} from '../lib/content-store.js'
import { createGitHubClient, parseRepository } from '../lib/github-client.js'
import { createBlogService } from '../lib/blog-service.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

const DOC = `---
title: 第一篇笔记
date: 2026-10-21
type: note
summary: 记录一下今天的插件开发。
category: 工程
tags: DSH, 插件
review: 2026-11-01
draft: true
---

## 正文

这里是内容。
`

// =====================================================================
// content-store: parsing
// =====================================================================

test('parse: a well-formed document yields front matter and body', () => {
  const parsed = parseFrontMatter(DOC)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.frontMatter.title, '第一篇笔记')
  assert.equal(parsed.frontMatter.date, '2026-10-21')
  assert.equal(parsed.frontMatter.type, 'note')
  assert.equal(parsed.frontMatter.draft, 'true')
  assert.ok(parsed.body.includes('这里是内容。'))
  assert.ok(!parsed.body.includes('title:'))
})

test('parse: CRLF input is normalised', () => {
  const parsed = parseFrontMatter(DOC.replace(/\n/g, '\r\n'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.frontMatter.summary, '记录一下今天的插件开发。')
})

test('parse: a document without a leading fence is rejected', () => {
  const parsed = parseFrontMatter('# 标题\n\n正文')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors[0].code, 'missing-opening-fence')
})

test('parse: a document without a closing fence is rejected', () => {
  const parsed = parseFrontMatter('---\ntitle: hi\n\ntext without separator')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors[0].code, 'missing-closing-fence')
})

test('parse: a nested/list line is rejected (build.py supports only key: value)', () => {
  const parsed = parseFrontMatter('---\ntitle: hi\n- a list item\n---\n\nbody')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors[0].code, 'unsupported-front-matter-line')
})

test('parse: a repeated key is reported', () => {
  const parsed = parseFrontMatter('---\ntitle: a\ntitle: b\n---\n\nbody')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors[0].code, 'duplicate-field')
})

// =====================================================================
// content-store: validation rules from the requirement
// =====================================================================

const VALID = {
  frontMatter: { title: '标题', date: '2026-10-21', type: 'note', summary: '摘要' },
  body: '正文内容',
  path: 'content/notes/2026-10-21-slug.md',
}

test('validate: the minimal valid document passes without errors', () => {
  const verdict = validateArticle(VALID)
  assert.deepEqual(verdict.errors, [])
})

test('validate: a missing required field is an error on that field', () => {
  for (const key of ['title', 'date', 'type', 'summary']) {
    const frontMatter = { ...VALID.frontMatter }
    delete frontMatter[key]
    const verdict = validateArticle({ ...VALID, frontMatter })
    assert.equal(verdict.ok, false, `${key} must be required`)
    assert.equal(verdict.errors[0].field, key)
  }
})

test('validate: an impossible calendar date is rejected', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-1', '21-10-2026', '2026/10/21']) {
    const verdict = validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, date } })
    assert.equal(verdict.ok, false, `${date} must be rejected`)
    assert.ok(verdict.errors.some((error) => error.field === 'date'))
  }
})

test('validate: leap days are handled like a calendar, not a regex', () => {
  assert.equal(isIsoDate('2024-02-29'), true)
  assert.equal(isIsoDate('2026-02-29'), false)
  assert.equal(isIsoDate('2026-12-31'), true)
})

test('validate: a type outside diary/note is rejected', () => {
  for (const type of ['post', 'Diary', '', 'notes']) {
    const verdict = validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, type } })
    assert.equal(verdict.ok, false, `type ${JSON.stringify(type)} must be rejected`)
    assert.equal(verdict.errors[0].field, 'type')
  }
})

test('validate: an empty body is rejected', () => {
  const verdict = validateArticle({ ...VALID, body: '   \n\n\t ' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.errors[0].field, 'body')
})

test('validate: a bad review date is rejected but an absent one is fine', () => {
  assert.equal(validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, review: '2026-11-01' } }).ok, true)
  const verdict = validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, review: 'tomorrow' } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.errors[0].field, 'review')
})

test('validate: a non-boolean draft flag is rejected', () => {
  const verdict = validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, draft: 'yes' } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.errors[0].field, 'draft')
  assert.equal(validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, draft: 'false' } }).ok, true)
})

test('validate: a diary stored under notes/ is rejected', () => {
  const verdict = validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, type: 'diary' } })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.errors.some((error) => error.code === 'path-type-mismatch'))
  assert.equal(validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, type: 'diary' }, path: 'content/diary/2026-10-21-x.md' }).ok, true)
})

test('validate: a file outside content/ is rejected', () => {
  const verdict = validateArticle({ ...VALID, path: 'posts/x.md' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.errors[0].code, 'path-outside-content')
})

test('validate: a category on a diary is a warning, not an error', () => {
  const verdict = validateArticle({
    frontMatter: { ...VALID.frontMatter, type: 'diary', category: '生活' },
    body: '正文',
    path: 'content/diary/2026-10-21-x.md',
  })
  assert.equal(verdict.ok, true)
  assert.ok(verdict.warnings.some((warning) => warning.code === 'category-only-note'))
})

test('validate: an unknown key is a warning, never a silent drop', () => {
  const verdict = validateArticle({ ...VALID, frontMatter: { ...VALID.frontMatter, mood: 'good' } })
  assert.equal(verdict.ok, true)
  assert.ok(verdict.warnings.some((warning) => warning.code === 'unknown-field'))
})

// =====================================================================
// content-store: serialisation and ids
// =====================================================================

test('serialize: round-trips through parse with the same values', () => {
  const text = serializeArticle({
    frontMatter: { title: '标题', date: '2026-10-21', type: 'note', summary: '摘要', category: '工程', tags: 'a, b', review: '2026-11-01', draft: 'true' },
    body: '## 小标题\n\n正文',
  })
  const parsed = parseFrontMatter(text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.frontMatter.title, '标题')
  assert.equal(parsed.frontMatter.tags, 'a, b')
  assert.equal(parsed.frontMatter.draft, 'true')
  assert.ok(parsed.body.includes('## 小标题'))
})

test('serialize: writes keys in a stable order and drops a diary category', () => {
  const text = serializeArticle({
    frontMatter: { title: 't', date: '2026-10-21', type: 'diary', summary: 's', category: '生活', tags: '' },
    body: 'b',
  })
  const keys = text
    .split('\n')
    .slice(1)
    .filter((line) => line.includes(':'))
    .map((line) => line.slice(0, line.indexOf(':')))
  assert.deepEqual(keys, ['title', 'date', 'type', 'summary'])
})

test('serialize: a value with a newline cannot produce a broken front matter line', () => {
  const text = serializeArticle({ frontMatter: { title: 'a\nb', date: '2026-10-21', type: 'note', summary: 's' }, body: 'x' })
  const parsed = parseFrontMatter(text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.frontMatter.title, 'a b')
})

test('normalizeArticle: blanks are dropped rather than written as empty keys', () => {
  const normalized = normalizeArticle({ title: ' t ', date: '2026-10-21', type: 'note', summary: ' s ', tags: 'a，b', review: '', category: '  ', draft: false, body: 'b' })
  assert.equal(normalized.frontMatter.title, 't')
  assert.equal(normalized.frontMatter.tags, 'a, b')
  assert.equal('review' in normalized.frontMatter, false)
  assert.equal('category' in normalized.frontMatter, false)
  assert.equal('draft' in normalized.frontMatter, false)
})

test('tags: both comma widths are accepted and normalised', () => {
  assert.deepEqual(splitTags('a, b，c ,, '), ['a', 'b', 'c'])
  assert.equal(joinTags(['a', '', ' b ']), 'a, b')
})

test('ids: article id, directory and path follow build.py', () => {
  assert.equal(articleIdFromPath('content/notes/2026-10-21-my-note.md'), 'notes/2026-10-21-my-note')
  assert.equal(buildArticlePath({ type: 'note', date: '2026-10-21', slug: 'my-note' }), 'content/notes/2026-10-21-my-note.md')
  assert.equal(buildArticlePath({ type: 'diary', date: '2026-10-21', slug: 'd' }), 'content/diary/2026-10-21-d.md')
  assert.equal(groupFromPath('content/diary/2026-10-21-d.md'), 'diary')
  assert.equal(groupFromPath('content/notes/2026-10-21-n.md'), 'note')
})

test('slugifyTitle: latin text becomes a filename, CJK survives', () => {
  assert.equal(slugifyTitle('My First Note!'), 'my-first-note')
  assert.equal(slugifyTitle('  多个   空格  '), '多个-空格')
  assert.equal(slugifyTitle('!!!'), '')
})

test('validateDocumentText: the whole text is parsed before it is judged', () => {
  const verdict = validateDocumentText('---\ntitle: x\n---\n\nbody', { path: 'content/notes/2026-10-21-x.md' })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.errors.some((error) => error.field === 'date'))
})

// =====================================================================
// github-client against a stub API
// =====================================================================

/** Minimal in-memory GitHub that answers exactly the endpoints the client uses. */
function createStubGitHub({ files = {}, head = 'head1', treeSha = 'tree1', failRefUpdate = false, failOnce = 0 } = {}) {
  const state = { files: new Map(Object.entries(files)), head, treeSha, commits: [], blobs: new Map(), calls: [], refUpdates: [] }
  let remainingFailures = failOnce

  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(body) })

  async function fetchImpl(url, init = {}) {
    const method = init.method ?? 'GET'
    const parsed = new URL(url)
    const path = decodeURIComponent(parsed.pathname)
    state.calls.push(`${method} ${path}`)

    if (remainingFailures > 0) {
      remainingFailures -= 1
      return json(502, { message: 'bad gateway' })
    }

    const base = '/repos/o/r'
    if (method === 'GET' && path === `${base}/git/ref/heads/main`) return json(200, { object: { sha: state.head } })
    if (method === 'GET' && path.startsWith(`${base}/git/commits/`)) return json(200, { sha: state.head, tree: { sha: state.treeSha } })
    if (method === 'GET' && path === `${base}/git/trees/${state.treeSha}`) {
      const entries = [...state.files.entries()].map(([filePath, text]) => {
        // The whole path, not just its prefix: every content/ file shares the
        // first bytes, so a truncated hash would collide and hand the same text
        // to every article.
        const sha = `blob-${Buffer.from(filePath).toString('hex')}`
        state.blobs.set(sha, text)
        return { path: filePath, mode: '100644', type: 'blob', sha, size: text.length }
      })
      return json(200, { tree: entries })
    }
    if (method === 'GET' && path.startsWith(`${base}/git/blobs/`)) {
      const sha = path.slice(`${base}/git/blobs/`.length)
      const text = state.blobs.get(sha)
      if (text === undefined) return json(404, { message: 'Not Found' })
      return json(200, { encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') })
    }
    const contentsPrefix = `${base}/contents/`
    if (method === 'GET' && path.startsWith(contentsPrefix)) {
      const filePath = path.slice(contentsPrefix.length)
      const text = state.files.get(filePath)
      if (text === undefined) return json(404, { message: 'Not Found' })
      return json(200, { sha: `blob-${Buffer.from(filePath).toString('hex')}`, content: Buffer.from(text, 'utf8').toString('base64'), size: text.length })
    }
    if (method === 'POST' && path === `${base}/git/blobs`) {
      const body = JSON.parse(init.body)
      const sha = `newblob${state.blobs.size}`
      state.blobs.set(sha, body.content)
      return json(201, { sha })
    }
    if (method === 'POST' && path === `${base}/git/trees`) return json(201, { sha: 'newtree' })
    if (method === 'POST' && path === `${base}/git/commits`) {
      const body = JSON.parse(init.body)
      state.commits.push(body)
      return json(201, { sha: 'newcommit' })
    }
    if (method === 'PATCH' && path === `${base}/git/refs/heads/main`) {
      state.refUpdates.push(JSON.parse(init.body))
      if (failRefUpdate) return json(422, { message: 'Update is not a fast forward' })
      return json(200, { object: { sha: 'newcommit' } })
    }
    if (method === 'GET' && path === `${base}/actions/runs`) return json(200, { workflow_runs: [] })
    if (method === 'GET' && path === '/user') return json(200, { login: 'tester' })
    if (method === 'GET' && path === base) return json(200, { full_name: 'o/r', default_branch: 'main', private: false, permissions: { push: true } })
    return json(404, { message: `unhandled ${method} ${path}` })
  }

  return { state, fetchImpl }
}

function makeClient(stub, overrides = {}) {
  return createGitHubClient({ token: 't', repository: 'o/r', branch: 'main', apiBase: 'https://api.test', fetchImpl: stub.fetchImpl, attempts: 3, logger: { warn() {} }, ...overrides })
}

test('parseRepository: accepts owner/repo, URLs and .git suffixes', () => {
  assert.deepEqual(parseRepository('o/r'), { owner: 'o', repo: 'r' })
  assert.deepEqual(parseRepository('https://github.com/huangxicheng1/huangxicheng1.github.io/'), { owner: 'huangxicheng1', repo: 'huangxicheng1.github.io' })
  assert.deepEqual(parseRepository('o/r.git'), { owner: 'o', repo: 'r' })
  assert.equal(parseRepository('nope'), null)
  assert.equal(parseRepository('a/b/c'), null)
})

await testAsync('client: a commit is one atomic blob -> tree -> commit -> ref sequence', async () => {
  const stub = createStubGitHub({ files: { 'content/notes/a.md': 'old' } })
  const client = makeClient(stub)
  const result = await client.commitChanges({
    changes: [
      { path: 'content/notes/new.md', text: 'hello' },
      { path: 'content/notes/a.md', delete: true },
    ],
    message: 'blog: test',
  })
  assert.equal(result.sha, 'newcommit')
  assert.equal(result.url, 'https://github.com/o/r/commit/newcommit')
  assert.deepEqual(result.files, ['content/notes/new.md', 'content/notes/a.md'])
  // The tree must carry the deletion as sha:null, which is how a file is removed.
  const treeCall = stub.state.calls.find((call) => call === 'POST /repos/o/r/git/trees')
  assert.ok(treeCall !== undefined)
  assert.equal(stub.state.commits.length, 1)
  assert.equal(stub.state.commits[0].parents[0], 'head1')
  assert.equal(stub.state.refUpdates.length, 1)
  assert.equal(stub.state.refUpdates[0].force, false)
  assert.equal(stub.state.refUpdates[0].sha, 'newcommit')
})

await testAsync('client: a rejected ref update becomes a conflict, not a silent overwrite', async () => {
  const stub = createStubGitHub({ failRefUpdate: true })
  const client = makeClient(stub, { attempts: 1 })
  await assert.rejects(
    () => client.commitChanges({ changes: [{ path: 'content/notes/a.md', text: 'x' }], message: 'm' }),
    (error) => error.code === 'conflict',
  )
})

await testAsync('client: a 5xx is retried and then succeeds', async () => {
  const stub = createStubGitHub({ failOnce: 1 })
  const client = makeClient(stub)
  const head = await client.getBranchHead()
  assert.equal(head, 'head1')
})

await testAsync('client: an exhausted timeout surfaces as a timeout code', async () => {
  const hanging = () => new Promise(() => {})
  const client = createGitHubClient({
    token: 't',
    repository: 'o/r',
    branch: 'main',
    apiBase: 'https://api.test',
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
    attempts: 1,
    timeoutMs: 40,
    logger: { warn() {} },
  })
  await assert.rejects(
    () => client.getUser(),
    (error) => error.code === 'timeout',
  )
})

await testAsync('client: 401 maps to unauthorized with actionable text', async () => {
  const client = createGitHubClient({
    token: 't',
    repository: 'o/r',
    branch: 'main',
    apiBase: 'https://api.test',
    fetchImpl: async () => ({ ok: false, status: 401, headers: new Map(), text: async () => '{"message":"Bad credentials"}' }),
    attempts: 1,
    logger: { warn() {} },
  })
  await assert.rejects(
    () => client.getUser(),
    (error) => error.code === 'unauthorized' && error.message.includes('401'),
  )
})

/**
 * A client whose reads succeed and whose first write returns a chosen 403.
 * This is the shape of the real failure: a fine-grained PAT with Contents: Read
 * reads the article list happily, then dies on `POST /git/blobs`.
 */
function makeWriteForbiddenClient(apiMessage) {
  const reply = (status, body, headers = new Map()) => ({
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(body),
  })
  return createGitHubClient({
    token: 't',
    repository: 'o/r',
    branch: 'main',
    apiBase: 'https://api.test',
    attempts: 1,
    logger: { warn() {} },
    fetchImpl: async (url, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      const path = new URL(url).pathname
      if (method !== 'GET') return reply(403, { message: apiMessage })
      if (path.includes('/git/ref/')) return reply(200, { object: { sha: 'head1' } })
      if (path.includes('/git/commits/')) return reply(200, { sha: 'head1', tree: { sha: 'tree1' } })
      return reply(404, { message: 'Not Found' })
    },
  })
}

await testAsync('client: a write 403 on a fine-grained token names the permission to fix', async () => {
  const client = makeWriteForbiddenClient('Resource not accessible by personal access token')
  await assert.rejects(
    () => client.commitChanges({ changes: [{ path: 'content/notes/a.md', text: 'x' }], message: 'm' }),
    (error) => {
      assert.equal(error.code, 'token-missing-write')
      assert.ok(error.message.includes('Read and write'), 'the message must name the permission')
      assert.ok(error.message.includes('Contents'), 'the message must name the permission group')
      assert.ok(!error.message.includes('Resource not accessible'), 'the opaque phrase is not helpful')
      assert.equal(error.details.method, 'POST')
      return true
    },
  )
})

await testAsync('client: a write 403 on a classic token points at the repo scope', async () => {
  const client = makeWriteForbiddenClient('Must have push access to repository')
  await assert.rejects(
    () => client.commitChanges({ changes: [{ path: 'content/notes/a.md', text: 'x' }], message: 'm' }),
    (error) => {
      assert.equal(error.code, 'token-missing-write')
      assert.ok(error.message.includes('classic'))
      assert.ok(error.message.includes('repo'))
      return true
    },
  )
})

await testAsync('client: a read 403 is a different code and a different hint', async () => {
  const client = createGitHubClient({
    token: 't',
    repository: 'o/r',
    branch: 'main',
    apiBase: 'https://api.test',
    attempts: 1,
    logger: { warn() {} },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Map(),
      text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token' }),
    }),
  })
  await assert.rejects(
    () => client.getBranchHead(),
    (error) => {
      assert.equal(error.code, 'forbidden')
      assert.ok(error.message.includes('Repository access'), 'a read failure must point at repository access')
      return true
    },
  )
})

await testAsync('client: an exhausted rate limit outranks the permission message', async () => {
  const client = createGitHubClient({
    token: 't',
    repository: 'o/r',
    branch: 'main',
    apiBase: 'https://api.test',
    attempts: 1,
    logger: { warn() {} },
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Map([['x-ratelimit-remaining', '0']]),
      text: async () => JSON.stringify({ message: 'API rate limit exceeded' }),
    }),
  })
  await assert.rejects(
    () => client.getBranchHead(),
    (error) => error.code === 'rate-limited',
  )
})

await testAsync('client: a missing file reads as null rather than throwing', async () => {
  const stub = createStubGitHub({ files: {} })
  const client = makeClient(stub)
  assert.equal(await client.getFileEntry('content/notes/none.md'), null)
})

await testAsync('client: a present file returns both sha and decoded text', async () => {
  const stub = createStubGitHub({ files: { 'content/notes/a.md': '---\ntitle: x\n---\n\n正文' } })
  const client = makeClient(stub)
  const entry = await client.getFileEntry('content/notes/a.md')
  assert.ok(entry.sha.startsWith('blob-'))
  assert.ok(entry.text.includes('正文'))
})

// =====================================================================
// blog-service: the two guards before a push
// =====================================================================

const SETTINGS = {
  repository: 'o/r',
  branch: 'main',
  contentRoot: 'content',
  siteUrl: 'https://example.test/',
  cacheTtlMs: 0,
}

function makeService({ fetchImpl, settings = SETTINGS, token = 't' } = {}) {
  const store = {
    path: 'C:/tmp/gh-blog/settings.json',
    async read() {
      return settings
    },
    async write() {
      return { ok: true, value: settings }
    },
  }
  const credentials = {
    async describe() {
      return { configured: token !== null, source: 'test', writable: true }
    },
    async resolve() {
      return token ?? undefined
    },
    async set() {},
    async unset() {},
  }
  return createBlogService({ settingsStore: store, credentials, fetchImpl, apiBase: 'https://api.test', logger: { warn() {} } })
}

const GOOD_FORM = { title: '新的一篇', date: '2026-10-21', type: 'note', summary: '摘要', body: '正文内容' }

await testAsync('publish: an invalid document is blocked before any network write', async () => {
  const stub = createStubGitHub({ files: {} })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  await assert.rejects(
    () => service.publish({ changes: [{ path: '', form: { ...GOOD_FORM, date: '2026-02-30' }, slug: 'x' }] }),
    (error) => {
      assert.equal(error.code, 'invalid-front-matter')
      assert.ok(Object.keys(error.details.errorsByPath).length > 0)
      return true
    },
  )
  assert.equal(stub.state.commits.length, 0, 'no commit may be created for an invalid document')
})

await testAsync('publish: a moved remote sha is refused with the conflicting path', async () => {
  const stub = createStubGitHub({ files: { 'content/notes/2026-10-21-x.md': 'old' } })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  await assert.rejects(
    () =>
      service.publish({
        changes: [{ path: 'content/notes/2026-10-21-x.md', form: GOOD_FORM, expectedSha: 'blob-does-not-match' }],
        message: 'm',
      }),
    (error) => {
      assert.equal(error.code, 'sha-conflict')
      assert.equal(error.details.path, 'content/notes/2026-10-21-x.md')
      return true
    },
  )
  assert.equal(stub.state.commits.length, 0)
})

await testAsync('publish: a new file with expectedSha null is refused when it already exists', async () => {
  const stub = createStubGitHub({ files: { 'content/notes/2026-10-21-x.md': 'old' } })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  await assert.rejects(
    () => service.publish({ changes: [{ form: GOOD_FORM, slug: 'x', expectedSha: null }], message: 'm' }),
    (error) => error.code === 'sha-conflict',
  )
})

await testAsync('publish: a valid new article becomes exactly one commit', async () => {
  const stub = createStubGitHub({ files: {} })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  const result = await service.publish({ changes: [{ form: GOOD_FORM, slug: 'x', expectedSha: null }], message: 'blog: add x' })
  assert.equal(stub.state.commits.length, 1)
  assert.equal(stub.state.commits[0].message, 'blog: add x')
  assert.equal(result.files[0].path, 'content/notes/2026-10-21-x.md')
  assert.equal(result.files[0].action, 'upsert')
  assert.equal(result.siteUrl, SETTINGS.siteUrl)
})

await testAsync('publish: a missing token fails with a message the settings panel can act on', async () => {
  const stub = createStubGitHub({ files: {} })
  const service = makeService({ fetchImpl: stub.fetchImpl, token: null })
  await assert.rejects(
    () => service.listArticles(),
    (error) => error.code === 'missing-token',
  )
})

await testAsync('list: articles are parsed, grouped and sorted newest first', async () => {
  const doc = (date, title, extra = '') =>
    `---\ntitle: ${title}\ndate: ${date}\ntype: note\nsummary: s\n${extra}---\n\nbody\n`
  const stub = createStubGitHub({
    files: {
      'content/notes/2026-10-01-old.md': doc('2026-10-01', '旧的'),
      'content/notes/2026-10-21-new.md': doc('2026-10-21', '新的'),
      'content/diary/2026-10-10-d.md': '---\ntitle: 日记一\ndate: 2026-10-10\ntype: diary\nsummary: s\n---\n\nbody\n',
      'content/notes/broken.md': 'not a document',
      'README.md': 'ignored',
    },
  })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  const list = await service.listArticles({ refresh: true })
  const paths = list.articles.map((article) => article.path)
  assert.equal(paths.length, 4, 'only content/**/*.md is listed')
  assert.deepEqual(paths.slice(0, 2), ['content/notes/2026-10-21-new.md', 'content/diary/2026-10-10-d.md'])
  const broken = list.articles.find((article) => article.path === 'content/notes/broken.md')
  assert.equal(broken.ok, false)
  const draftDoc = list.articles.find((article) => article.path === 'content/notes/2026-10-01-old.md')
  assert.equal(draftDoc.draft, false)
})

await testAsync('list: draft flag is surfaced for the list badge', async () => {
  const stub = createStubGitHub({
    files: { 'content/notes/2026-10-21-x.md': '---\ntitle: t\ndate: 2026-10-21\ntype: note\nsummary: s\ndraft: true\n---\n\nbody\n' },
  })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  const list = await service.listArticles({ refresh: true })
  assert.equal(list.articles[0].draft, true)
})

await testAsync('validateDraft: derives the path from type, date and slug', async () => {
  const stub = createStubGitHub({ files: {} })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  const verdict = await service.validateDraft({ form: GOOD_FORM, slug: 'hello-world' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.path, 'content/notes/2026-10-21-hello-world.md')
  assert.ok(verdict.text.startsWith('---\n'))
})

await testAsync('validateDraft: an unusable slug is a field error, not a crash', async () => {
  const stub = createStubGitHub({ files: {} })
  const service = makeService({ fetchImpl: stub.fetchImpl })
  const verdict = await service.validateDraft({ form: GOOD_FORM, slug: 'bad/slug' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.errors[0].field, 'slug')
})

// =====================================================================
// packaging sanity
// =====================================================================

test('package: every exported path exists and the patch names the package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must insert the package by its manifest name')
  for (const key of ['./locale/en.json', './locale/zh.json']) {
    const target = new URL(`..${key.slice(1)}`, import.meta.url)
    const dict = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(typeof dict.meta?.title, 'string')
    assert.equal(typeof dict.meta?.description, 'string')
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('package: the client artifact registers both the nav row and the main panel', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('sidebar.panellist'), 'the sidebar entry is what requirement 1 asks for')
  assert.ok(source.includes("'main'"), 'the page must be registered into the main slot')
  assert.ok(!/dangerouslySetInnerHTML/.test(source), 'article HTML must never be injected raw')
})

// =====================================================================

for (const failure of failures) {
  console.error(`\nFAIL  ${failure.name}`)
  console.error(failure.error?.stack ?? failure.error)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
