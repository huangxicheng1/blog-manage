/**
 * github-client — a dependency-free GitHub REST client for `contents/` reads and
 * atomic commits.
 *
 * Design notes that matter for this plugin:
 *
 *   - No local `git` is involved. Everything goes through the REST API with the
 *     user's fine-grained PAT, so the plugin works on a machine that has never
 *     cloned the repository.
 *   - Reads are cheap and concurrent; every request has a hard timeout and a
 *     small retry budget, so a flaky network surfaces as a clear error instead of
 *     a hung panel.
 *   - A publish is one commit built with the Git Data API (blob -> tree ->
 *     commit -> ref), which is what makes a multi-file change atomic and gives us
 *     a real conflict signal: the ref update is non-forced, so a branch that
 *     moved underneath us fails instead of losing a commit.
 *   - The plugin never writes `entries.js`; `build.py` owns it and GitHub Actions
 *     regenerates it after the push.
 */

const DEFAULT_API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_ATTEMPTS = 3
const MAX_BACKOFF_MS = 4_000

/** A failure with a machine-readable `code` the UI can translate. */
export class GitHubError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'GitHubError'
    this.code = code
    /** Structured context (`errorsByPath`, the conflicting path, HTTP status). */
    this.details = details
  }
}

/** Split `owner/repo`, tolerating a full URL or a trailing slash. */
export function parseRepository(input) {
  const raw = String(input ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = raw.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null
  return { owner: parts[0], repo: parts[1] }
}

/** Encode a repository path for a URL without letting `/` become `%2F`. */
function encodePath(path) {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** Methods that change something, as opposed to fetching it. */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Map an HTTP failure onto a stable code plus a message that says what to do.
 *
 * `403` is the one status whose raw GitHub text is actively unhelpful —
 * "Resource not accessible by personal access token" never names the permission
 * to turn on, and a fine-grained token fails a write exactly the way it fails a
 * read. So the caller passes the request, and the message names the right fix.
 */
function classify(status, body, response, request = {}) {
  const apiMessage = typeof body?.message === 'string' ? body.message : ''
  const remaining = response?.headers?.get?.('x-ratelimit-remaining')
  const isWrite = WRITE_METHODS.has(String(request.method ?? 'GET').toUpperCase())
  // GitHub's opaque fine-grained phrase adds nothing once we name the fix.
  const opaque = /resource not accessible by personal access token/i.test(apiMessage)
  const detail = apiMessage === '' || opaque ? '' : `（GitHub: ${apiMessage}）`

  if (status === 401) {
    return new GitHubError('unauthorized', 'GitHub 拒绝了这个 Token（401）。请确认 Token 未过期、已复制完整。', { status })
  }
  if (status === 403 && (remaining === '0' || /rate limit/i.test(apiMessage))) {
    return new GitHubError('rate-limited', 'GitHub API 速率限制已用尽，请稍后重试。', { status })
  }
  if (status === 403) {
    if (isWrite) {
      // A classic token says "Must have push access"; a fine-grained one says the
      // opaque phrase above. They need different instructions.
      const classic = /push access/i.test(apiMessage)
      return new GitHubError(
        'token-missing-write',
        classic
          ? `Token 缺少写入权限（403）。这是 classic token，请确认它带了 repo 权限。${detail}`.trim()
          : 'Token 缺少写入权限（403）。发布需要 Contents: Read and write —— 请到 fine-grained Token 设置里把 Repository permissions → Contents 改成 Read and write。改权限不会更换 Token，改完直接重试即可。',
        { status, method: request.method, path: request.path },
      )
    }
    return new GitHubError(
      'forbidden',
      `Token 读不到这个资源（403）。请检查 Token 的 Repository access 是否包含该仓库，以及它是否过期或被撤销。${detail}`.trim(),
      { status, method: request.method, path: request.path },
    )
  }
  if (status === 404) {
    return new GitHubError('not-found', '找不到仓库或文件（404）。请检查仓库名、分支名，以及 Token 是否勾选了该仓库。', { status })
  }
  if (status === 409 || status === 422) {
    return new GitHubError('conflict', `GitHub 拒绝了这次写入（${status}）：远端可能已经变化。${apiMessage}`.trim(), { status })
  }
  if (status === 429) {
    return new GitHubError('rate-limited', 'GitHub API 速率限制已用尽，请稍后重试。', { status })
  }
  if (status >= 500) {
    return new GitHubError('server', `GitHub 服务暂时不可用（${status}）。`, { status })
  }
  return new GitHubError('http', `GitHub 请求失败（${status}）。${apiMessage}`.trim(), { status })
}

const RETRYABLE = new Set(['network', 'timeout', 'server', 'rate-limited'])

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitHubError('cancelled', '请求已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new GitHubError('cancelled', '请求已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Build a client bound to one repository/branch/token.
 *
 * `fetchImpl` and `apiBase` are injectable so the client can be exercised in a
 * plain Node test against a local stub instead of the live API.
 */
export function createGitHubClient(options) {
  const token = String(options?.token ?? '')
  const repository = parseRepository(options?.repository)
  const branch = String(options?.branch ?? 'main')
  const apiBase = String(options?.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const timeoutMs = Number(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const attempts = Math.max(1, Number(options?.attempts ?? DEFAULT_ATTEMPTS))
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const logger = options?.logger

  if (repository === null) throw new GitHubError('bad-repository', '仓库必须写成 owner/repo 形式')
  if (typeof fetchImpl !== 'function') throw new GitHubError('no-fetch', '当前运行时没有可用的 fetch')

  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`

  /** One request with timeout + retry; returns parsed JSON or `null` for 204. */
  async function request(method, path, { body, query, accept, signal } = {}) {
    const url = new URL(`${apiBase}${path}`)
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
    }
    const headers = {
      accept: accept ?? 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'dsh-gh-blog',
    }
    if (token !== '') headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // AbortSignal.any keeps the caller's cancellation and adds our timeout.
      const timeoutController = new AbortController()
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
      const composed =
        signal !== undefined && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal
      try {
        const response = await fetchImpl(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: composed,
        })
        if (response.status === 204) return null
        const text = await response.text()
        let parsed = null
        if (text !== '') {
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
        }
        if (!response.ok) throw classify(response.status, parsed, response, { method, path })
        return parsed
      } catch (error) {
        const normalized =
          error instanceof GitHubError
            ? error
            : error?.name === 'AbortError'
              ? new GitHubError('timeout', `GitHub 请求超时（${timeoutMs}ms）`)
              : new GitHubError('network', `无法连接 GitHub：${error?.message ?? String(error)}`)
        lastError = normalized
        if (!RETRYABLE.has(normalized.code) || attempt === attempts) throw normalized
        const backoff = Math.min(MAX_BACKOFF_MS, 350 * 2 ** (attempt - 1))
        logger?.warn?.(`gh-blog: ${method} ${path} 失败（${normalized.code}），${backoff}ms 后重试`)
        await sleep(backoff, signal)
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new GitHubError('network', '未知网络错误')
  }

  return {
    repository,
    branch,

    /** Identity behind the token — the cheapest way to prove a PAT is alive. */
    async getUser(signal) {
      const user = await request('GET', '/user', { signal })
      return { login: user?.login ?? '', name: user?.name ?? '' }
    },

    /** Repository metadata plus the permissions GitHub reports for this token. */
    async getRepository(signal) {
      const repo = await request('GET', repoPath, { signal })
      return {
        fullName: repo?.full_name ?? '',
        defaultBranch: repo?.default_branch ?? '',
        private: repo?.private === true,
        permissions: repo?.permissions ?? {},
      }
    },

    /** Head commit sha of the configured branch. */
    async getBranchHead(signal) {
      const ref = await request('GET', `${repoPath}/git/ref/heads/${encodePath(branch)}`, { signal })
      const sha = ref?.object?.sha
      if (typeof sha !== 'string') throw new GitHubError('malformed', 'GitHub 返回的分支引用缺少 sha')
      return sha
    },

    /** Full recursive file listing of a tree, filtered by the caller. */
    async listTree(treeSha, signal) {
      const tree = await request('GET', `${repoPath}/git/trees/${treeSha}`, { query: { recursive: '1' }, signal })
      return Array.isArray(tree?.tree) ? tree.tree : []
    },

    /** Tree sha of a commit. */
    async getCommitTree(commitSha, signal) {
      const commit = await request('GET', `${repoPath}/git/commits/${commitSha}`, { signal })
      const sha = commit?.tree?.sha
      if (typeof sha !== 'string') throw new GitHubError('malformed', 'GitHub 返回的 commit 缺少 tree')
      return sha
    },

    /** Decoded text of one blob (base64 in, UTF-8 out). */
    async getBlobText(blobSha, signal) {
      const blob = await request('GET', `${repoPath}/git/blobs/${blobSha}`, { signal })
      if (blob?.encoding !== 'base64' || typeof blob?.content !== 'string') {
        throw new GitHubError('malformed', 'GitHub 返回的 blob 不是 base64 编码')
      }
      return Buffer.from(blob.content, 'base64').toString('utf8')
    },

    /**
     * One file's blob sha and decoded text, or `null` when it does not exist.
     * The contents API returns the base64 payload inline, so a read costs a
     * single request.
     */
    async getFileEntry(path, signal) {
      try {
        const file = await request('GET', `${repoPath}/contents/${encodePath(path)}`, {
          query: { ref: branch },
          signal,
        })
        if (typeof file?.sha !== 'string') return null
        const encoded = typeof file?.content === 'string' ? file.content.replace(/\n/g, '') : ''
        const text = encoded === '' ? '' : Buffer.from(encoded, 'base64').toString('utf8')
        return { sha: file.sha, text, size: Number(file?.size ?? text.length) }
      } catch (error) {
        if (error instanceof GitHubError && error.code === 'not-found') return null
        throw error
      }
    },

    /** Current blob sha of a file, or `null` when it does not exist. */
    async getFileSha(path, signal) {
      const entry = await this.getFileEntry(path, signal)
      return entry === null ? null : entry.sha
    },

    /**
     * Create one commit containing every change and advance the branch.
     *
     * `changes` entries are `{ path, text }` for an upsert or `{ path, delete: true }`.
     * A non-forced ref update is the last line of defence: if the branch moved
     * after we read its head, the update is rejected as a conflict.
     */
    async commitChanges({ changes, message, signal }) {
      if (!Array.isArray(changes) || changes.length === 0) {
        throw new GitHubError('no-changes', '没有需要提交的变更')
      }
      const headSha = await this.getBranchHead(signal)
      const baseTreeSha = await this.getCommitTree(headSha, signal)

      const entries = []
      for (const change of changes) {
        if (change.delete === true) {
          entries.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
          continue
        }
        const blob = await request('POST', `${repoPath}/git/blobs`, {
          body: { content: change.text, encoding: 'utf-8' },
          signal,
        })
        if (typeof blob?.sha !== 'string') throw new GitHubError('malformed', 'GitHub 没有返回 blob sha')
        entries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
      }

      const tree = await request('POST', `${repoPath}/git/trees`, {
        body: { base_tree: baseTreeSha, tree: entries },
        signal,
      })
      if (typeof tree?.sha !== 'string') throw new GitHubError('malformed', 'GitHub 没有返回 tree sha')

      const commit = await request('POST', `${repoPath}/git/commits`, {
        body: { message, tree: tree.sha, parents: [headSha] },
        signal,
      })
      if (typeof commit?.sha !== 'string') throw new GitHubError('malformed', 'GitHub 没有返回 commit sha')

      try {
        await request('PATCH', `${repoPath}/git/refs/heads/${encodePath(branch)}`, {
          body: { sha: commit.sha, force: false },
          signal,
        })
      } catch (error) {
        if (error instanceof GitHubError && (error.code === 'conflict' || error.code === 'server')) {
          throw new GitHubError(
            'conflict',
            '分支在提交过程中被更新了，远端已存在新的提交。请刷新文章列表后重试，你的修改仍保留在编辑器里。',
            { status: error.status },
          )
        }
        throw error
      }

      return {
        sha: commit.sha,
        url: `https://github.com/${repository.owner}/${repository.repo}/commit/${commit.sha}`,
        files: entries.map((entry) => entry.path),
      }
    },

    /** Most recent Actions run for this branch (needs Actions: Read). */
    async getLatestWorkflowRun(signal) {
      try {
        const runs = await request('GET', `${repoPath}/actions/runs`, {
          query: { branch, per_page: '1' },
          signal,
        })
        const run = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs[0] : undefined
        if (run === undefined) return null
        return {
          id: run.id,
          name: run.name ?? '',
          status: run.status ?? '',
          conclusion: run.conclusion ?? null,
          url: run.html_url ?? '',
          createdAt: run.created_at ?? '',
          updatedAt: run.updated_at ?? '',
          headSha: run.head_sha ?? '',
        }
      } catch (error) {
        // Actions: Read is optional for the publishing loop; a 403 there must
        // not turn a successful push into an error.
        if (error instanceof GitHubError && (error.code === 'forbidden' || error.code === 'not-found')) return null
        throw error
      }
    },
  }
}
