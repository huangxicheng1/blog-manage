/**
 * blog-service — the Host-side operations behind both the UI routes and the
 * automation hook.
 *
 * One operation, one implementation: the Web routes in `index.js` and the
 * automation entry point both call these methods, so a fix or a guard applies to
 * both callers.
 *
 * The token is a secret and is resolved from the Host `credentials` service on
 * *every* operation (never cached), which is what lets a user rotate a PAT in the
 * settings panel and have the next click use it without a restart.
 */

import { GitHubError, createGitHubClient, parseRepository } from './github-client.js'
import {
  DEFAULT_CONTENT_ROOT,
  articleIdFromPath,
  buildArticlePath,
  groupFromPath,
  isDraft,
  normalizeArticle,
  parseFrontMatter,
  serializeArticle,
  splitTags,
  validateArticle,
  validateDocumentText,
  validateSlug,
} from './content-store.js'

/** Key the PAT is stored under; the same name works as an ambient env var. */
export const TOKEN_REF = 'GH_BLOG_GITHUB_TOKEN'

const BLOB_CONCURRENCY = 6

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapPool(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Wrap any thrown value in the coded error shape the routes serialize. */
export function toCodedError(error) {
  if (error instanceof GitHubError) {
    return { code: error.code, message: error.message, details: error.details ?? {} }
  }
  return { code: 'internal', message: error?.message ?? String(error), details: {} }
}

/**
 * Read a change's expected blob sha without collapsing `null` into `undefined`.
 *
 * The distinction is load-bearing: `undefined` means "the caller did not check",
 * while `null` means "this file must not exist yet". A `??` here would silently
 * turn a create into an unchecked write.
 */
function expectedShaOf(change) {
  const value = change?.expectedSha
  if (value === undefined) return undefined
  return value === null ? null : String(value)
}

/**
 * Create the service.
 *
 * `credentials` is the Host credentials service, narrowed to the four calls this
 * plugin needs so the service stays testable without a live Harness.
 */
export function createBlogService({ settingsStore, credentials, logger, fetchImpl, apiBase, now = () => Date.now() }) {
  /** sha -> decoded text, so re-listing does not re-download unchanged files. */
  const textCache = new Map()
  /** Single-flight article listing cache. */
  let listing = null

  async function readSettings() {
    return settingsStore.read()
  }

  /** Resolve the PAT for this operation only. */
  async function resolveToken() {
    const resolved = await credentials.resolve()
    if (typeof resolved === 'string' && resolved.trim() !== '') return resolved.trim()
    return null
  }

  async function buildClient(settings, token) {
    return createGitHubClient({
      token,
      repository: settings.repository,
      branch: settings.branch,
      fetchImpl,
      apiBase,
      logger,
    })
  }

  /** Settings + token, or a clear failure the settings panel can act on. */
  async function connect() {
    const settings = await readSettings()
    if (parseRepository(settings.repository) === null) {
      throw new GitHubError('bad-repository', '仓库设置不合法，请写成 owner/repo 形式')
    }
    const token = await resolveToken()
    if (token === null) {
      throw new GitHubError('missing-token', '还没有配置 GitHub Token。请先在设置面板里填入一个 fine-grained PAT。')
    }
    const client = await buildClient(settings, token)
    return { settings, token, client }
  }

  function cacheBlob(sha, text) {
    // Bounded so a long session cannot grow this without limit.
    if (textCache.size > 400) textCache.clear()
    textCache.set(sha, text)
    return text
  }

  /** Read every `content/**\/*.md` blob of the current branch. */
  async function collectArticles({ settings, client, signal, refresh }) {
    const head = await client.getBranchHead(signal)
    if (!refresh && listing !== null && listing.head === head && now() - listing.at < (settings.cacheTtlMs ?? 0)) {
      return listing.value
    }

    const treeSha = await client.getCommitTree(head, signal)
    const tree = await client.listTree(treeSha, signal)
    const prefix = `${settings.contentRoot}/`
    const blobs = tree
      .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
      .filter((entry) => entry.path.startsWith(prefix) && /\.md$/i.test(entry.path))

    const articles = await mapPool(blobs, BLOB_CONCURRENCY, async (entry) => {
      const path = entry.path
      const sha = String(entry.sha ?? '')
      const id = articleIdFromPath(path, settings.contentRoot)
      const base = {
        path,
        id,
        sha,
        size: Number(entry.size ?? 0),
        group: groupFromPath(path, settings.contentRoot),
      }
      let text = textCache.get(sha)
      if (text === undefined) {
        try {
          text = cacheBlob(sha, await client.getBlobText(sha, signal))
        } catch (error) {
          return { ...base, title: id, date: '', type: base.group === 'diary' ? 'diary' : 'note', ok: false, unreadable: toCodedError(error) }
        }
      }
      const parsed = parseFrontMatter(text)
      const verdict = parsed.ok
        ? validateArticle({ frontMatter: parsed.frontMatter, body: parsed.body, path, contentRoot: settings.contentRoot })
        : { ok: false, errors: parsed.errors, warnings: [] }
      const fm = parsed.frontMatter ?? {}
      return {
        ...base,
        title: String(fm.title ?? '').trim() || id,
        date: String(fm.date ?? '').trim(),
        type: String(fm.type ?? '').trim() || (base.group === 'diary' ? 'diary' : 'note'),
        summary: String(fm.summary ?? '').trim(),
        category: String(fm.category ?? '').trim(),
        tags: splitTags(fm.tags),
        review: String(fm.review ?? '').trim(),
        draft: isDraft(fm.draft),
        ok: verdict.ok,
        errors: verdict.errors,
        warnings: verdict.warnings,
      }
    })

    articles.sort((left, right) => {
      if (left.date !== right.date) return left.date < right.date ? 1 : -1
      return left.title.localeCompare(right.title, 'zh-Hans-CN')
    })

    const value = { repository: settings.repository, branch: settings.branch, contentRoot: settings.contentRoot, head, articles }
    listing = { head, at: now(), value }
    return value
  }

  return {
    /** Masked settings for the panel: never returns the PAT itself. */
    async settings() {
      const settings = await readSettings()
      const info = await credentials.describe()
      return {
        repository: settings.repository,
        branch: settings.branch,
        contentRoot: settings.contentRoot,
        siteUrl: settings.siteUrl,
        cacheTtlMs: settings.cacheTtlMs,
        hasToken: info.configured === true,
        tokenSource: info.source ?? null,
        tokenWritable: info.writable !== false,
        tokenRef: TOKEN_REF,
        settingsPath: settingsStore.path,
      }
    },

    /**
     * Save settings. A non-empty `token` replaces the stored PAT;
     * `clearToken: true` removes it. Everything else is ordinary preferences.
     */
    async saveSettings(patch) {
      const result = await settingsStore.write({
        repository: patch?.repository,
        branch: patch?.branch,
        contentRoot: patch?.contentRoot,
        siteUrl: patch?.siteUrl,
      })
      if (result.ok !== true) {
        throw new GitHubError('invalid-settings', '设置有字段不合法', { errors: result.errors })
      }
      const token = String(patch?.token ?? '').trim()
      if (patch?.clearToken === true) {
        await credentials.unset()
      } else if (token !== '') {
        await credentials.set(token)
      }
      listing = null
      return this.settings()
    },

    /** Prove the PAT + repository + branch combination actually works. */
    async testConnection({ signal } = {}) {
      const { settings, client } = await connect()
      const user = await client.getUser(signal)
      const repo = await client.getRepository(signal)
      let head = null
      let branchError = null
      try {
        head = await client.getBranchHead(signal)
      } catch (error) {
        branchError = toCodedError(error)
      }
      return {
        user,
        repository: { fullName: repo.fullName, defaultBranch: repo.defaultBranch, private: repo.private, permissions: repo.permissions },
        settings: { repository: settings.repository, branch: settings.branch, contentRoot: settings.contentRoot, siteUrl: settings.siteUrl },
        head,
        branchError,
      }
    },

    /** The article list the left column renders. */
    async listArticles({ signal, refresh = false } = {}) {
      const { settings, client } = await connect()
      return collectArticles({ settings, client, signal, refresh })
    },

    /** One article's raw text plus its parsed front matter and body. */
    async readArticle({ path, signal } = {}) {
      const { settings, client } = await connect()
      const safePath = String(path ?? '').trim()
      if (safePath === '' || !safePath.startsWith(`${settings.contentRoot}/`)) {
        throw new GitHubError('bad-path', '只能读取 content 目录下的文章')
      }
      const entry = await client.getFileEntry(safePath, signal)
      if (entry === null) throw new GitHubError('not-found', `仓库里找不到 ${safePath}，它可能已被删除或改名`)
      cacheBlob(entry.sha, entry.text)
      const parsed = parseFrontMatter(entry.text)
      const verdict = parsed.ok
        ? validateArticle({ frontMatter: parsed.frontMatter, body: parsed.body, path: safePath, contentRoot: settings.contentRoot })
        : { ok: false, errors: parsed.errors, warnings: [] }
      return {
        path: safePath,
        sha: entry.sha,
        text: entry.text,
        frontMatter: parsed.frontMatter,
        body: parsed.body,
        parseErrors: parsed.errors,
        ok: verdict.ok,
        errors: verdict.errors,
        warnings: verdict.warnings,
      }
    },

    /**
     * Validate a draft without touching GitHub. This is the gate the editor calls
     * before enabling 发布, and the same rules the publish path re-runs.
     */
    async validateDraft({ form, slug, path } = {}) {
      const settings = await readSettings()
      const contentRoot = settings.contentRoot ?? DEFAULT_CONTENT_ROOT
      const normalized = normalizeArticle(form)
      const resolvedPath = resolveArticlePath({ form, slug, path, contentRoot })
      if (resolvedPath.error !== undefined) {
        return { ok: false, path: '', text: '', errors: [resolvedPath.error], warnings: [] }
      }
      const text = serializeArticle(normalized)
      const verdict = validateDocumentText(text, { path: resolvedPath.path, contentRoot })
      return {
        ok: verdict.ok,
        path: resolvedPath.path,
        text,
        frontMatter: verdict.frontMatter,
        body: verdict.body,
        errors: verdict.errors,
        warnings: verdict.warnings,
      }
    },

    /**
     * Publish a batch of changes as one commit.
     *
     * `changes` entries: `{ path, form, slug, expectedSha }` for an upsert, or
     * `{ path, delete: true, expectedSha }` for a deletion. `expectedSha` is the
     * blob sha the client last saw; `null` asserts the file must not exist yet.
     * Omitting it skips the check (used by the automation hook for a blind append).
     */
    async publish({ changes, message, signal } = {}) {
      if (!Array.isArray(changes) || changes.length === 0) {
        throw new GitHubError('no-changes', '没有需要发布的变更')
      }
      const { settings, client } = await connect()
      const contentRoot = settings.contentRoot ?? DEFAULT_CONTENT_ROOT

      const prepared = []
      const errorsByPath = {}
      for (const change of changes) {
        const path = String(change?.path ?? '').trim()
        if (change?.delete === true) {
          if (path === '' || !path.startsWith(`${contentRoot}/`)) {
            errorsByPath[path || '(空路径)'] = [{ field: 'path', code: 'bad-path', message: '只能删除 content 目录下的文章' }]
            continue
          }
          prepared.push({ path, delete: true, expectedSha: expectedShaOf(change) })
          continue
        }
        const resolvedPath = resolveArticlePath({ form: change?.form, slug: change?.slug, path, contentRoot })
        if (resolvedPath.error !== undefined) {
          errorsByPath[path || '(新文章)'] = [resolvedPath.error]
          continue
        }
        const text = serializeArticle(normalizeArticle(change?.form))
        const verdict = validateDocumentText(text, { path: resolvedPath.path, contentRoot })
        if (!verdict.ok) {
          errorsByPath[resolvedPath.path] = verdict.errors
          continue
        }
        prepared.push({ path: resolvedPath.path, text, expectedSha: expectedShaOf(change) })
      }

      if (Object.keys(errorsByPath).length > 0) {
        throw new GitHubError('invalid-front-matter', '有文章没有通过 build.py 规则校验，已阻止发布。', { errorsByPath })
      }

      // Conflict pre-flight: refuse to overwrite a file whose sha moved.
      for (const change of prepared) {
        if (change.expectedSha === undefined) continue
        const current = await client.getFileEntry(change.path, signal)
        const currentSha = current === null ? null : current.sha
        const expected = change.expectedSha === null ? null : change.expectedSha
        if (currentSha !== expected) {
          throw new GitHubError(
            'sha-conflict',
            `《${change.path}》在远端已经变化（本地版本 ${String(expected ?? '不存在').slice(0, 7)}，远端 ${String(currentSha ?? '不存在').slice(0, 7)}）。请刷新后重试，你的修改仍保留在编辑器里。`,
            { path: change.path, expectedSha: expected, currentSha },
          )
        }
      }

      const commitMessage = String(message ?? '').trim() || defaultCommitMessage(prepared)
      const commit = await client.commitChanges({
        changes: prepared.map((change) =>
          change.delete === true ? { path: change.path, delete: true } : { path: change.path, text: change.text },
        ),
        message: commitMessage,
        signal,
      })

      listing = null
      textCache.clear()
      return {
        commit,
        message: commitMessage,
        files: prepared.map((change) => ({ path: change.path, action: change.delete === true ? 'delete' : 'upsert' })),
        siteUrl: settings.siteUrl,
      }
    },

    /** Latest Actions run for the branch, used for the build feedback strip. */
    async latestRun({ signal } = {}) {
      const { client } = await connect()
      return client.getLatestWorkflowRun(signal)
    },

    /** Drop cached listings so the next read hits GitHub. */
    invalidate() {
      listing = null
      textCache.clear()
    },
  }
}

/**
 * Work out the repository path for a draft.
 *
 * An existing article keeps its path (renames are a delete + create, which keeps
 * the UI honest about history). A new article derives its path from
 * `type` + `date` + `slug`, and a bad slug is a field error rather than a 500.
 */
export function resolveArticlePath({ form, slug, path, contentRoot = DEFAULT_CONTENT_ROOT }) {
  const existing = String(path ?? '').trim()
  if (existing !== '') return { path: existing }
  const type = String(form?.type ?? 'note').trim()
  const date = String(form?.date ?? '').trim()
  const rawSlug = String(slug ?? '').trim()
  const slugError = validateSlug(rawSlug)
  if (slugError !== null) return { path: '', error: slugError }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { path: '', error: { field: 'date', code: 'date-invalid', message: '请先填写合法的日期，文件名会以它开头' } }
  }
  return { path: buildArticlePath({ type, date, slug: rawSlug, contentRoot }) }
}

/** A commit message that reads well in `git log` and on GitHub. */
export function defaultCommitMessage(changes) {
  const upserts = changes.filter((change) => change.delete !== true)
  const deletes = changes.filter((change) => change.delete === true)
  if (upserts.length + deletes.length === 1) {
    const only = upserts[0] ?? deletes[0]
    const fileName = only.path.slice(only.path.lastIndexOf('/') + 1)
    if (deletes.length === 1) return `blog: 删除 ${fileName}`
    if (upserts.length === 1) return `blog: 更新 ${fileName}`
  }
  const parts = []
  if (upserts.length > 0) parts.push(`更新 ${upserts.length} 篇`)
  if (deletes.length > 0) parts.push(`删除 ${deletes.length} 篇`)
  return `blog: ${parts.join('，')}`
}
