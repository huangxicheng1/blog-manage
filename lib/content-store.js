/**
 * content-store — the single source of truth for the blog's article format.
 *
 * The site under `huangxicheng1/huangxicheng1.github.io` is not Jekyll/Hugo/Astro:
 * `build.py` scans `content/**\/*.md`, parses a deliberately tiny front matter and
 * emits `entries.js` (`window.SITE_ENTRIES`). `build.py` validates that front
 * matter and fails the build when it is wrong, so every rule in this file exists
 * to keep the plugin's output inside what `build.py` accepts:
 *
 *   - the document starts and ends with a `---` line;
 *   - between them there are only simple `key: value` lines (no nesting, no
 *     multi-line scalars, no lists);
 *   - `title`, `date`, `type` and `summary` are required;
 *   - `type` is exactly `diary` or `note`;
 *   - `date`, and the optional `review`, are `YYYY-MM-DD`;
 *   - `category` only means something on a note;
 *   - `tags` is a comma separated string;
 *   - `draft: true` keeps the article out of the published site;
 *   - the body is not empty;
 *   - an article's id is its path relative to `content/` without `.md`.
 *
 * Nothing here touches the network or the filesystem, so the same module is
 * cheap to exercise in a plain Node test.
 */

/** Directory (inside the repository) that holds the sources. */
export const DEFAULT_CONTENT_ROOT = 'content'

/** Front matter `type` values `build.py` accepts, in form order. */
export const ARTICLE_TYPES = ['diary', 'note']

/** Sub-directory each `type` is written to, relative to the content root. */
export const TYPE_DIRECTORIES = { diary: 'diary', note: 'notes' }

/** Required front matter keys, in the order the serializer writes them. */
export const REQUIRED_FIELDS = ['title', 'date', 'type', 'summary']

/** Optional front matter keys, in the order the serializer writes them. */
export const OPTIONAL_FIELDS = ['category', 'tags', 'review', 'draft']

/** Every key the serializer may emit. Anything else is reported as a warning. */
export const KNOWN_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

/** Form fields, in the order the editor renders them. */
export const FORM_FIELDS = ['title', 'date', 'type', 'summary', 'category', 'tags', 'review', 'draft']

/** `build.py` default for a note without a category. */
export const DEFAULT_CATEGORY = '未分类'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u
const FENCE = '---'

/** Normalize CRLF/CR to LF so every offset and split below is predictable. */
export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/** True when `value` is a real calendar date written as `YYYY-MM-DD`. */
export function isIsoDate(value) {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value.trim())
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  // Reject 2026-02-30 and friends: rebuild the date and compare the parts.
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** Local calendar day as `YYYY-MM-DD` (the editor's default for a new article). */
export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Strip one layer of matching quotes, the way a YAML reader would. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Parse a document into front matter and body.
 *
 * Returns `{ ok, frontMatter, body, errors }`. `errors` is never empty when
 * `ok` is false, and each entry is `{ field, code, message }` so the editor can
 * highlight the offending control.
 */
export function parseFrontMatter(text, options = {}) {
  const source = normalizeNewlines(text)
  const errors = []
  const fail = (field, code, message) => {
    errors.push({ field, code, message })
    return { ok: false, frontMatter: {}, body: '', errors }
  }

  const trimmedStart = source.replace(/^\uFEFF/, '')
  const lines = trimmedStart.split('\n')
  if (lines.length === 0 || lines[0].trim() !== FENCE) {
    return fail('document', 'missing-opening-fence', '文档必须以一行 --- 开头（front matter 起始标记）')
  }

  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FENCE) {
      closing = index
      break
    }
  }
  if (closing === -1) {
    return fail('document', 'missing-closing-fence', 'front matter 没有结束的 --- 行')
  }

  const frontMatter = Object.create(null)
  const seen = new Set()
  for (let index = 1; index < closing; index += 1) {
    const raw = lines[index]
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) {
      errors.push({
        field: 'document',
        code: 'unsupported-front-matter-line',
        message: `front matter 第 ${index + 1} 行不是 key: value 形式：「${line}」`,
      })
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1).trim())
    if (key === '') {
      errors.push({ field: 'document', code: 'empty-key', message: `front matter 第 ${index + 1} 行缺少字段名` })
      continue
    }
    if (seen.has(key)) {
      errors.push({ field: key, code: 'duplicate-field', message: `字段 ${key} 重复出现` })
      continue
    }
    seen.add(key)
    frontMatter[key] = value
  }

  const body = lines.slice(closing + 1).join('\n')
  if (errors.length > 0) return { ok: false, frontMatter, body, errors }
  return { ok: true, frontMatter, body, errors: [] }
}

/** `"a, b，c"` -> `['a','b','c']`; accepts both ASCII and full-width commas. */
export function splitTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter((tag) => tag !== '')
  }
  return String(value ?? '')
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

/** Canonical `tags` front matter value (empty string when there are none). */
export function joinTags(value) {
  return splitTags(value).join(', ')
}

/** `true` / `'true'` -> true, everything else false. */
export function isDraft(value) {
  if (value === true) return true
  return String(value ?? '').trim().toLowerCase() === 'true'
}

/**
 * Turn a title into a filename slug. Latin text is lowercased and space-joined;
 * CJK text is preserved because `build.py` derives the id from the raw path and
 * the site percent-encodes it in URLs.
 */
export function slugifyTitle(title) {
  const cleaned = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? '' : cleaned
}

/** Validate a slug typed by the user (or derived from the title). */
export function validateSlug(slug) {
  const value = String(slug ?? '').trim()
  if (value === '') return { field: 'slug', code: 'slug-empty', message: '文件名不能为空' }
  if (!SLUG.test(value)) {
    return {
      field: 'slug',
      code: 'slug-invalid',
      message: '文件名只能包含字母、数字、中文、点、下划线和连字符，且不能以符号开头',
    }
  }
  if (value.length > 120) return { field: 'slug', code: 'slug-too-long', message: '文件名过长（上限 120 个字符）' }
  return null
}

/** Repository path for an article, e.g. `content/notes/2026-10-21-my-note.md`. */
export function buildArticlePath({ type, date, slug, contentRoot = DEFAULT_CONTENT_ROOT }) {
  const directory = TYPE_DIRECTORIES[type] ?? TYPE_DIRECTORIES.note
  return `${contentRoot}/${directory}/${date}-${slug}.md`
}

/** Article id as `build.py` computes it: path under the content root, no extension. */
export function articleIdFromPath(path, contentRoot = DEFAULT_CONTENT_ROOT) {
  const normalized = String(path ?? '').replace(/\\/g, '/')
  const prefix = `${contentRoot}/`
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
  return relative.replace(/\.md$/i, '')
}

/** Repository directory an article lives in, used to group the file tree. */
export function groupFromPath(path, contentRoot = DEFAULT_CONTENT_ROOT) {
  const id = articleIdFromPath(path, contentRoot)
  const head = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
  if (head === TYPE_DIRECTORIES.diary) return 'diary'
  if (head === TYPE_DIRECTORIES.note || head === 'note') return 'note'
  return 'other'
}

/**
 * Validate a parsed document. Returns `{ ok, errors, warnings }`.
 *
 * `errors` blocks publishing; `warnings` is advisory (an unknown key, a filename
 * date that disagrees with `date`). The gate is intentionally the same one the
 * save path and the publish path use, so the editor cannot approve something the
 * push would reject.
 */
export function validateArticle({ frontMatter, body, path, contentRoot = DEFAULT_CONTENT_ROOT }) {
  const errors = []
  const warnings = []
  const field = (name) => String(frontMatter?.[name] ?? '').trim()

  const title = field('title')
  if (title === '') errors.push({ field: 'title', code: 'title-required', message: '标题不能为空' })
  else if (title.length > 200) errors.push({ field: 'title', code: 'title-too-long', message: '标题过长（上限 200 个字符）' })

  const date = field('date')
  if (date === '') errors.push({ field: 'date', code: 'date-required', message: '日期不能为空' })
  else if (!isIsoDate(date)) errors.push({ field: 'date', code: 'date-invalid', message: '日期必须是 YYYY-MM-DD 格式的真实日期' })

  const type = field('type')
  if (type === '') errors.push({ field: 'type', code: 'type-required', message: '类型不能为空' })
  else if (!ARTICLE_TYPES.includes(type)) {
    errors.push({ field: 'type', code: 'type-invalid', message: `类型只能是 ${ARTICLE_TYPES.join(' 或 ')}` })
  }

  const summary = field('summary')
  if (summary === '') errors.push({ field: 'summary', code: 'summary-required', message: '摘要不能为空' })
  else if (summary.length > 500) warnings.push({ field: 'summary', code: 'summary-long', message: '摘要偏长（超过 500 个字符）' })

  const review = field('review')
  if (review !== '' && !isIsoDate(review)) {
    errors.push({ field: 'review', code: 'review-invalid', message: '复习日期必须是 YYYY-MM-DD 格式的真实日期' })
  }

  const tags = splitTags(frontMatter?.tags)
  if (tags.length > 40) warnings.push({ field: 'tags', code: 'tags-many', message: '标签数量偏多' })

  const draftRaw = String(frontMatter?.draft ?? '').trim()
  if (draftRaw !== '' && !['true', 'false'].includes(draftRaw.toLowerCase())) {
    errors.push({ field: 'draft', code: 'draft-invalid', message: '草稿开关只能是 true 或 false' })
  }

  const category = field('category')
  if (category !== '' && type === 'diary') {
    warnings.push({ field: 'category', code: 'category-only-note', message: 'category 只对 note 有意义，diary 会被 build.py 忽略' })
  }

  if (normalizeNewlines(body).trim() === '') {
    errors.push({ field: 'body', code: 'body-required', message: '正文不能为空' })
  }

  for (const key of Object.keys(frontMatter ?? {})) {
    if (!KNOWN_FIELDS.includes(key)) {
      warnings.push({ field: key, code: 'unknown-field', message: `未知字段 ${key}，build.py 可能忽略它` })
    }
  }

  if (typeof path === 'string' && path !== '') {
    if (!/\.md$/i.test(path)) {
      errors.push({ field: 'slug', code: 'path-extension', message: '文章文件必须以 .md 结尾' })
    } else if (!path.startsWith(`${contentRoot}/`)) {
      errors.push({ field: 'slug', code: 'path-outside-content', message: `文章必须位于 ${contentRoot}/ 目录下` })
    } else {
      const group = groupFromPath(path, contentRoot)
      if (type === 'diary' && group !== 'diary') {
        errors.push({ field: 'slug', code: 'path-type-mismatch', message: 'diary 类型的文章必须放在 content/diary/' })
      }
      if (type === 'note' && group !== 'note') {
        errors.push({ field: 'slug', code: 'path-type-mismatch', message: 'note 类型的文章必须放在 content/notes/' })
      }
      if (errors.length === 0 && isIsoDate(date)) {
        const base = articleIdFromPath(path, contentRoot)
        const fileName = base.slice(base.lastIndexOf('/') + 1)
        if (fileName !== '' && !fileName.startsWith(date)) {
          warnings.push({
            field: 'slug',
            code: 'slug-date-mismatch',
            message: `文件名没有以日期 ${date} 开头，文章 id 会与日期不一致`,
          })
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Parse then validate one document; the shape every write path funnels through. */
export function validateDocumentText(text, { path, contentRoot = DEFAULT_CONTENT_ROOT } = {}) {
  const parsed = parseFrontMatter(text)
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [], frontMatter: parsed.frontMatter, body: parsed.body }
  const verdict = validateArticle({ frontMatter: parsed.frontMatter, body: parsed.body, path, contentRoot })
  return { ...verdict, frontMatter: parsed.frontMatter, body: parsed.body }
}

/**
 * Serialize front matter + body back into the exact text `build.py` reads.
 * Unknown keys are dropped (they are a warning, not a way to write YAML), and
 * the key order is stable so a re-save produces a minimal, reviewable diff.
 */
export function serializeArticle({ frontMatter, body }) {
  const source = frontMatter ?? {}
  const lines = [FENCE]

  const push = (key, value) => {
    const text = String(value ?? '').trim()
    if (text === '') return
    // A simple `key: value` line cannot carry a newline; collapse instead of
    // silently writing a document build.py would reject.
    lines.push(`${key}: ${text.replace(/\n+/g, ' ')}`)
  }

  push('title', source.title)
  push('date', source.date)
  push('type', source.type)
  push('summary', source.summary)
  if (String(source.type ?? '').trim() === 'note') push('category', source.category)
  push('tags', joinTags(source.tags))
  push('review', source.review)
  if (isDraft(source.draft) || String(source.draft ?? '').trim().toLowerCase() === 'false') {
    push('draft', isDraft(source.draft) ? 'true' : 'false')
  }

  lines.push(FENCE)
  const normalizedBody = normalizeNewlines(body).replace(/^\n+/, '').replace(/\s+$/, '')
  return `${lines.join('\n')}\n\n${normalizedBody}\n`
}

/**
 * Normalize a form submission into the canonical document object the editor and
 * serializer share. Blank optionals are dropped so they never reach the file.
 */
export function normalizeArticle(form) {
  const type = String(form?.type ?? 'note').trim()
  const frontMatter = {
    title: String(form?.title ?? '').trim(),
    date: String(form?.date ?? '').trim(),
    type,
    summary: String(form?.summary ?? '').trim(),
  }
  const category = String(form?.category ?? '').trim()
  if (type === 'note' && category !== '') frontMatter.category = category
  const tags = joinTags(form?.tags)
  if (tags !== '') frontMatter.tags = tags
  const review = String(form?.review ?? '').trim()
  if (review !== '') frontMatter.review = review
  if (isDraft(form?.draft)) frontMatter.draft = 'true'

  return { frontMatter, body: String(form?.body ?? '') }
}
