/**
 * settings-store — durable, non-secret plugin settings.
 *
 * Only ordinary preferences live here (repository, branch, content root, site
 * URL, polling window). The GitHub token is a secret and never touches this
 * file: it goes through the Host `credentials` service, which keeps it in the
 * provider-managed writable store.
 *
 * Precedence, lowest to highest:
 *   1. the built-in defaults below,
 *   2. the `config` block of the bundle row in `cordis.patch.yml`,
 *   3. the panel's saved values (`$DSH_HOME/gh-blog/settings.json`).
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * half-written JSON file that would fail to load on the next start.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Defaults that mirror the confirmed repository layout. */
export const DEFAULT_SETTINGS = Object.freeze({
  repository: 'huangxicheng1/huangxicheng1.github.io',
  branch: 'main',
  contentRoot: 'content',
  siteUrl: 'https://huangxicheng1.github.io/',
  /** How long a fetched article list stays fresh before a refetch. */
  cacheTtlMs: 30_000,
})

const FIELD_LIMITS = {
  repository: 200,
  branch: 200,
  contentRoot: 200,
  siteUrl: 500,
}

/** `owner/repo`, the only repository shape the REST paths support. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** Git branch names reject spaces and a few control characters. */
const BRANCH = /^[^\s~^:?*[\\]+$/
/** A relative content root: no leading slash, no `..`, no backslashes. */
const CONTENT_ROOT = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/

/** Resolve `$DSH_HOME`, falling back to the conventional location. */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Validate one settings patch; returns `{ ok, errors, value }`. */
export function validateSettings(patch) {
  const errors = []
  const value = {}
  for (const [key, limit] of Object.entries(FIELD_LIMITS)) {
    // An explicit `undefined` means "not supplied", not the string "undefined".
    if (!(key in (patch ?? {})) || patch[key] === undefined) continue
    const text = String(patch[key] ?? '').trim()
    if (text.length > limit) {
      errors.push({ field: key, message: `${key} 过长` })
      continue
    }
    value[key] = text
  }
  if ('repository' in value && !REPOSITORY.test(value.repository)) {
    errors.push({ field: 'repository', message: '仓库必须写成 owner/repo，例如 huangxicheng1/huangxicheng1.github.io' })
  }
  if ('branch' in value && (value.branch === '' || !BRANCH.test(value.branch))) {
    errors.push({ field: 'branch', message: '分支名不能为空，也不能包含空格或 ~ ^ : ? * [ \\' })
  }
  if ('contentRoot' in value) {
    const root = value.contentRoot.replace(/^\.?\/+/, '').replace(/\/+$/, '')
    if (root === '' || !CONTENT_ROOT.test(root) || root.split('/').includes('..')) {
      errors.push({ field: 'contentRoot', message: '内容目录必须是仓库内的相对路径，例如 content' })
    } else {
      value.contentRoot = root
    }
  }
  if ('siteUrl' in value && value.siteUrl !== '' && !/^https?:\/\//i.test(value.siteUrl)) {
    errors.push({ field: 'siteUrl', message: '站点地址必须以 http:// 或 https:// 开头' })
  }
  return { ok: errors.length === 0, errors, value }
}

/** Coerce a stored/configured object into a complete settings object. */
function mergeSettings(base, overrides) {
  const next = { ...base }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (overrides?.[key] === undefined) continue
    if (key === 'cacheTtlMs') {
      const ttl = Number(overrides[key])
      if (Number.isFinite(ttl) && ttl >= 0) next.cacheTtlMs = ttl
      continue
    }
    const text = String(overrides[key] ?? '').trim()
    if (text !== '') next[key] = text
  }
  return next
}

/**
 * Create the store.
 *
 * `config` is the bundle row's `config` from `cordis.patch.yml`; it acts as a
 * machine-level default that the panel's saved file overrides.
 */
export function createSettingsStore({ config = {}, logger, homeDir } = {}) {
  const directory = join(homeDir ?? resolveDshHome(), 'gh-blog')
  const file = join(directory, 'settings.json')
  const fromConfig = mergeSettings(DEFAULT_SETTINGS, validateSettings(config).value)

  let cached = null

  async function loadFile() {
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      return validateSettings(parsed).value
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      logger?.warn?.(`gh-blog: 读取设置文件失败，改用默认值（${error?.message ?? error}）`)
      return {}
    }
  }

  async function persist(value) {
    await mkdir(directory, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  return {
    path: file,

    /** Current effective settings (file over config over defaults). */
    async read() {
      if (cached !== null) return cached
      cached = mergeSettings(fromConfig, await loadFile())
      return cached
    },

    /** Apply a validated patch and persist it. */
    async write(patch) {
      const verdict = validateSettings(patch)
      if (!verdict.ok) return { ok: false, errors: verdict.errors }
      const current = await this.read()
      const next = mergeSettings(current, verdict.value)
      await persist(next)
      cached = next
      return { ok: true, value: next }
    },

    /** Drop the in-memory copy so the next read re-reads the file. */
    invalidate() {
      cached = null
    },
  }
}
