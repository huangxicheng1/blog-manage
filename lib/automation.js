/**
 * automation — the stage-3 extension contract, kept deliberately small.
 *
 * Three ways to drive the plugin without touching its UI, in increasing
 * coupling:
 *
 *   1. `POST /api/gh-blog/automation/create` (HTTP)
 *      The scheduled-task / webhook surface. Any DSH automation that can send an
 *      HTTP request inside the Host can create and publish an article.
 *
 *   2. the `ghBlog` Host service (`ctx.get('ghBlog')`)
 *      In-process surface for other plugins and, later, an agent tool. It is the
 *      same object the HTTP route calls, so there is one implementation.
 *
 *   3. `dsh-gh-blog:draft` window event (browser)
 *      For "an AI turn produced a draft, put it in the editor". It stages the
 *      draft locally so the human still reviews and confirms the commit — the
 *      plugin never publishes without an explicit confirmation from someone
 *      looking at the change list.
 *
 * Nothing here publishes behind the user's back: the HTTP and service surfaces
 * create an explicit commit, and the browser surface only stages.
 */

import { GitHubError } from './github-client.js'
import { ARTICLE_TYPES, DEFAULT_CATEGORY, isDraft, joinTags, todayIso } from './content-store.js'

/** Machine-readable description of the hook, served by the routes and the README. */
export const AUTOMATION_CONTRACT = Object.freeze({
  version: 1,
  routes: {
    create: { method: 'POST', path: '/api/gh-blog/automation/create' },
    contract: { method: 'POST', path: '/api/gh-blog/automation/contract' },
  },
  service: { name: 'ghBlog', methods: ['settings', 'listArticles', 'readArticle', 'validateDraft', 'publish', 'latestRun', 'createArticle'] },
  browserEvent: {
    name: 'dsh-gh-blog:draft',
    detail: { title: 'string', date: 'YYYY-MM-DD?', type: 'diary|note?', summary: 'string?', body: 'string', tags: 'string[]?' },
  },
  example: {
    title: '今天的复盘',
    date: '2026-10-21',
    type: 'note',
    summary: '把今天踩过的坑记下来，方便以后复习。',
    category: '工程',
    tags: ['复盘', 'DSH'],
    body: '## 今天做了什么\n\n- 写了插件\n',
    publish: true,
    commitMessage: 'blog: 自动写入今日复盘',
  },
})

/**
 * Normalize an automation payload into the same `{ form, slug }` shape the editor
 * submits, so the automation path reuses the editor's validation verbatim.
 */
export function normalizeAutomationRequest(input) {
  const payload = input ?? {}
  const title = String(payload.title ?? '').trim()
  if (title === '') throw new GitHubError('bad-request', '自动化请求缺少 title')

  const type = String(payload.type ?? 'note').trim()
  if (!ARTICLE_TYPES.includes(type)) {
    throw new GitHubError('bad-request', `type 只能是 ${ARTICLE_TYPES.join(' 或 ')}`)
  }

  const body = String(payload.body ?? '')
  if (body.trim() === '') throw new GitHubError('bad-request', '自动化请求缺少正文 body')

  const date = String(payload.date ?? '').trim() || todayIso()
  const summary = String(payload.summary ?? '').trim() || firstParagraph(body)
  const tags = Array.isArray(payload.tags) ? joinTags(payload.tags) : joinTags(payload.tags)

  const form = {
    title,
    date,
    type,
    summary,
    body,
    tags,
    category: type === 'note' ? String(payload.category ?? '').trim() : '',
    review: String(payload.review ?? '').trim(),
    draft: payload.draft === undefined ? false : isDraft(payload.draft),
  }
  if (type === 'note' && form.category === '') form.category = DEFAULT_CATEGORY

  return {
    form,
    slug: payload.slug === undefined ? '' : String(payload.slug).trim(),
    publish: payload.publish !== false,
    commitMessage: String(payload.commitMessage ?? '').trim(),
  }
}

/** First non-empty paragraph of the body, used as a default summary. */
function firstParagraph(body) {
  const line = String(body ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^#+\s*/gm, '').trim())
    .find((block) => block !== '')
  if (line === undefined) return ''
  return line.replace(/\s+/g, ' ').slice(0, 160)
}

/**
 * Create an article through the automation surface.
 *
 * Returns `{ slug, path, publish, commit?, draft? }`. When `publish` is false the
 * caller gets the serialized document back instead of a commit, which is the
 * "stage it and let a human confirm" behaviour.
 */
export async function createArticleViaAutomation(service, input) {
  const request = normalizeAutomationRequest(input)
  if (request.slug === '') {
    const { slugifyTitle } = await import('./content-store.js')
    request.slug = slugifyTitle(request.form.title)
  }
  const verdict = await service.validateDraft({ form: request.form, slug: request.slug })
  if (!verdict.ok) {
    throw new GitHubError('invalid-front-matter', '自动化写入的文章没有通过 build.py 规则校验。', { errorsByPath: { [verdict.path || '(新文章)']: verdict.errors } })
  }
  if (!request.publish) {
    return { path: verdict.path, text: verdict.text, published: false, form: request.form }
  }
  const result = await service.publish({
    changes: [{ path: verdict.path, form: request.form, slug: request.slug, expectedSha: null }],
    message: request.commitMessage,
  })
  return { ...result, path: verdict.path, published: true, form: request.form }
}
