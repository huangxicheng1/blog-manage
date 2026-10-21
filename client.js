/**
 * Browser half of the GitHub Pages blog manager.
 *
 * Everything here runs inside the Harness Web page, so it obeys the page's rules:
 * it renders React into existing slots, styles itself with the host's theme
 * tokens, keeps its stylesheet inside the component tree (unmounting removes it),
 * routes visible text through `ctx.locale`, and never talks to api.github.com —
 * all GitHub traffic goes through the Host's `/api/gh-blog/*` routes so the PAT
 * stays on the Host.
 *
 * The file is one module because the Client loader loads exactly one artifact per
 * plugin, but it is organised in the same layers the Host half uses, separated by
 * the `--- module:` banners below:
 *
 *   api        transport + typed failures
 *   i18n       dictionary registration
 *   markdown   a small, sanitising Markdown renderer
 *   ui         primitives (button, field, badge, spinner, states)
 *   editor     the split editor + front matter form
 *   settings   the connection panel
 *   panel      the page that composes the two-column layout
 */

window.__ModuleLoader__.load({
  id: 'dsh-hxc-blog',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const PLUGIN_ID = 'gh-blog'
    const NS = 'dsh-gh-blog'
    const SETTINGS_DOC_URL = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'
    const TOKEN_SCOPE_URL = 'https://github.com/settings/tokens?type=beta'

    // =====================================================================
    // --- module: api ------------------------------------------------------
    // =====================================================================

    const ROUTE_ROOT = 'api/gh-blog'

    /** A transport or Host failure carrying the Host's machine-readable code. */
    class ApiError extends Error {
      constructor(code, message, details) {
        super(message)
        this.name = 'ApiError'
        this.code = code
        this.details = details ?? {}
      }
    }

    /**
     * POST a JSON payload to one Host route and unwrap `{ ok, value }`.
     * The Host answers domain failures with an envelope (not an HTTP error), so
     * the error text a user sees is the one the Host wrote.
     */
    async function callApi(name, body) {
      let response
      try {
        response = await fetch(`${ROUTE_ROOT}/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        throw new ApiError('network', `无法连接 DSH Host：${error?.message ?? String(error)}`)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new ApiError('bad-response', `Host 返回了无法解析的响应（HTTP ${response.status}）`)
      }
      if (payload?.ok !== true) {
        const error = payload?.error ?? {}
        throw new ApiError(error.code ?? 'unknown', error.message ?? '未知错误', error.details)
      }
      return payload.value
    }

    // =====================================================================
    // --- module: i18n -----------------------------------------------------
    // =====================================================================

    const ZH = {
      'nav.title': '博客管理',
      'page.title': '博客管理',
      'page.subtitle': '{repo} · {branch}',
      'page.refresh': '刷新',
      'page.settings': '设置',
      'page.new': '新建文章',
      'page.publish': '发布',
      'page.publishCount': '发布（{n}）',
      'page.dirty': '有 {n} 项未发布的更改',
      'page.search': '搜索标题、标签或文件名',
      'group.untagged': '无标签',
      'group.untaggedHint': '这些文章在 front matter 里没有填 tags',
      'group.foldHint': '点击收起或展开这个分组',
      'state.loading': '正在读取仓库…',
      'state.loadingHint': '首次加载需要逐个读取文章，稍等一下。',
      'state.empty': '仓库里还没有文章',
      'state.emptyHint': '点右上角「新建文章」写第一篇。',
      'state.noMatch': '没有匹配的文章',
      'state.select': '选择左侧的一篇文章',
      'state.selectHint': '可以预览渲染结果，也可以切到编辑分屏改写内容。',
      'state.needSettings': '还没有配置 GitHub 连接',
      'state.needSettingsHint': '填入一个 fine-grained PAT 后就能读取仓库了。',
      'state.openSettings': '打开设置',
      'badge.draft': '草稿',
      'badge.dirty': '未发布',
      'badge.invalid': '格式有误',
      'meta.type': '类型',
      'meta.category': '分类',
      'meta.tags': '标签',
      'meta.review': '复习',
      'meta.date': '日期',
      'meta.id': '文章 id',
      'meta.uncategorized': '未分类',
      'meta.none': '无',
      'view.preview': '预览',
      'view.source': '源码',
      'view.edit': '编辑',
      'view.delete': '删除',
      'view.stage': '保存更改',
      'view.discard': '放弃更改',
      'view.staged': '已加入待发布',
      'view.previewHint': '实时预览',
      'field.title': '标题',
      'field.date': '日期',
      'field.type': '类型',
      'field.summary': '摘要',
      'field.category': '分类',
      'field.tags': '标签',
      'field.review': '复习日期',
      'field.draft': '存为草稿',
      'field.slug': '文件名',
      'field.body': '正文',
      'field.title.placeholder': '一句话说清这篇写什么',
      'field.summary.placeholder': '列表里显示的一句话摘要',
      'field.tags.placeholder': '用逗号分隔，例如：DSH, 插件',
      'field.slug.hint': '会写成 {path}',
      'field.optional': '可选',
      'field.body.placeholder': '用 Markdown 写正文…',
      'type.diary': '日记 (diary)',
      'type.note': '笔记 (note)',
      'settings.title': 'GitHub 连接',
      'settings.subtitle': 'Token 只保存在本机的 DSH 凭据存储里，不会上传到任何第三方。',
      'settings.token': 'GitHub Personal Access Token',
      'settings.token.configured': '已配置（{source}）',
      'settings.token.missing': '未配置',
      'settings.token.placeholder': 'github_pat_… 或 ghp_…',
      'settings.token.hint': 'fine-grained PAT 需要 Contents: Read and write，以及 Actions: Read（用于显示构建状态）。',
      'settings.token.keep': '留空表示保持当前 Token 不变。',
      'settings.token.clear': '清除已保存的 Token',
      'settings.createToken': '去 GitHub 创建 Token',
      'settings.tokenDocs': 'Token 使用说明',
      'settings.repository': '仓库',
      'settings.branch': '分支',
      'settings.contentRoot': '内容目录',
      'settings.siteUrl': '站点地址',
      'settings.save': '保存设置',
      'settings.test': '测试连接',
      'settings.close': '关闭',
      'settings.testing': '正在验证…',
      'settings.testOk': '连接正常：{user} → {repo}（HEAD {sha}）',
      'settings.saved': '设置已保存',
      'settings.path': '设置文件',
      'dialog.publishTitle': '确认发布',
      'dialog.publishIntro': '这些更改会作为一次 commit 推到 {branch}，随后 GitHub Actions 会自动构建并发布。',
      'dialog.commitMessage': 'Commit message',
      'dialog.commitHint': '留空则自动生成。',
      'dialog.confirm': '推送到 GitHub',
      'dialog.cancel': '取消',
      'dialog.deleteTitle': '删除文章',
      'dialog.deleteIntro': '将从仓库删除 {path}，并生成一次 commit。删除后只能用 Git 历史找回。',
      'dialog.deleteStagedIntro': '《{path}》还没有发布过，删除只会把它从待发布区移除，不会产生 commit。',
      'dialog.deleteConfirm': '确认删除',
      'action.discardTitle': '放弃未保存的更改？',
      'notify.published': '已推送到 {branch}（{sha}）',
      'notify.buildRunning': 'Actions 构建中…',
      'notify.buildSuccess': '构建成功，站点已更新',
      'notify.buildFailure': 'Actions 构建失败',
      'notify.openSite': '打开站点',
      'notify.openRun': '查看构建日志',
      'error.title': '出错了',
      'error.retry': '重试',
      'error.unauthorized': 'Token 无效或已过期，请在设置里重新填写。',
      'error.missingToken': '还没有配置 GitHub Token。',
      'error.conflict': '远端已经变化，请刷新后重试。',
      'error.offline': '网络请求失败，请检查代理或网络。',
      'error.details': '字段错误',
      'common.close': '关闭',
      'common.yes': '是',
      'common.no': '否',
      'common.unknown': '未知',
      'common.refresh': '刷新',
    }

    const EN = {
      'nav.title': 'Blog',
      'page.title': 'Blog manager',
      'page.subtitle': '{repo} · {branch}',
      'page.refresh': 'Refresh',
      'page.settings': 'Settings',
      'page.new': 'New article',
      'page.publish': 'Publish',
      'page.publishCount': 'Publish ({n})',
      'page.dirty': '{n} unpublished change(s)',
      'page.search': 'Search title, tag or file name',
      'group.untagged': 'Untagged',
      'group.untaggedHint': 'These articles have no tags in their front matter',
      'group.foldHint': 'Click to fold or unfold this group',
      'state.loading': 'Reading the repository…',
      'state.loadingHint': 'The first load fetches every article once.',
      'state.empty': 'No articles yet',
      'state.emptyHint': 'Use “New article” in the top right to write the first one.',
      'state.noMatch': 'No matching article',
      'state.select': 'Pick an article on the left',
      'state.selectHint': 'Preview the rendered result, or switch to the split editor.',
      'state.needSettings': 'No GitHub connection yet',
      'state.needSettingsHint': 'Add a fine-grained PAT to read the repository.',
      'state.openSettings': 'Open settings',
      'badge.draft': 'Draft',
      'badge.dirty': 'Unpublished',
      'badge.invalid': 'Invalid',
      'meta.type': 'Type',
      'meta.category': 'Category',
      'meta.tags': 'Tags',
      'meta.review': 'Review',
      'meta.date': 'Date',
      'meta.id': 'Article id',
      'meta.uncategorized': 'Uncategorised',
      'meta.none': 'None',
      'view.preview': 'Preview',
      'view.source': 'Source',
      'view.edit': 'Edit',
      'view.delete': 'Delete',
      'view.stage': 'Save changes',
      'view.discard': 'Discard',
      'view.staged': 'Staged',
      'view.previewHint': 'Live preview',
      'field.title': 'Title',
      'field.date': 'Date',
      'field.type': 'Type',
      'field.summary': 'Summary',
      'field.category': 'Category',
      'field.tags': 'Tags',
      'field.review': 'Review date',
      'field.draft': 'Keep as draft',
      'field.slug': 'File name',
      'field.body': 'Body',
      'field.title.placeholder': 'What is this about, in one line',
      'field.summary.placeholder': 'One line shown in the list',
      'field.tags.placeholder': 'Comma separated, e.g. DSH, plugin',
      'field.slug.hint': 'Will be written to {path}',
      'field.optional': 'optional',
      'field.body.placeholder': 'Write the body in Markdown…',
      'type.diary': 'Diary (diary)',
      'type.note': 'Note (note)',
      'settings.title': 'GitHub connection',
      'settings.subtitle': 'The token stays in the local DSH credential store and is never sent anywhere else.',
      'settings.token': 'GitHub personal access token',
      'settings.token.configured': 'Configured ({source})',
      'settings.token.missing': 'Not configured',
      'settings.token.placeholder': 'github_pat_… or ghp_…',
      'settings.token.hint': 'A fine-grained PAT needs Contents: Read and write, plus Actions: Read for build status.',
      'settings.token.keep': 'Leave empty to keep the current token.',
      'settings.token.clear': 'Clear the saved token',
      'settings.createToken': 'Create a token on GitHub',
      'settings.tokenDocs': 'Token guide',
      'settings.repository': 'Repository',
      'settings.branch': 'Branch',
      'settings.contentRoot': 'Content directory',
      'settings.siteUrl': 'Site URL',
      'settings.save': 'Save settings',
      'settings.test': 'Test connection',
      'settings.close': 'Close',
      'settings.testing': 'Verifying…',
      'settings.testOk': 'Connected: {user} → {repo} (HEAD {sha})',
      'settings.saved': 'Settings saved',
      'settings.path': 'Settings file',
      'dialog.publishTitle': 'Confirm publish',
      'dialog.publishIntro': 'These changes become one commit on {branch}; GitHub Actions then builds and publishes the site.',
      'dialog.commitMessage': 'Commit message',
      'dialog.commitHint': 'Leave empty to generate one.',
      'dialog.confirm': 'Push to GitHub',
      'dialog.cancel': 'Cancel',
      'dialog.deleteTitle': 'Delete article',
      'dialog.deleteIntro': 'This deletes {path} from the repository in one commit. Only Git history can bring it back.',
      'dialog.deleteStagedIntro': '{path} has never been published, so deleting it only drops it from the staging area without a commit.',
      'dialog.deleteConfirm': 'Delete',
      'action.discardTitle': 'Discard unsaved changes?',
      'notify.published': 'Pushed to {branch} ({sha})',
      'notify.buildRunning': 'Actions build in progress…',
      'notify.buildSuccess': 'Build succeeded, the site is updated',
      'notify.buildFailure': 'Actions build failed',
      'notify.openSite': 'Open site',
      'notify.openRun': 'View build log',
      'error.title': 'Something went wrong',
      'error.retry': 'Retry',
      'error.unauthorized': 'The token is invalid or expired. Update it in settings.',
      'error.missingToken': 'No GitHub token configured yet.',
      'error.conflict': 'The remote moved. Refresh and try again.',
      'error.offline': 'The request failed. Check network or proxy.',
      'error.details': 'Field errors',
      'common.close': 'Close',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.unknown': 'Unknown',
      'common.refresh': 'Refresh',
    }

    // =====================================================================
    // --- module: markdown -------------------------------------------------
    // =====================================================================

    /**
     * Is `url` safe to place in an href/src? Only absolute http(s)/mailto and
     * same-origin relative targets survive, so a `javascript:` payload in an
     * article can never execute inside the Harness page.
     */
    function safeUrl(url) {
      const value = String(url ?? '').trim()
      if (value === '') return null
      if (/^(https?:\/\/|mailto:|\/|\.\/|\.\.\/|#)/i.test(value)) return value
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
      return value
    }

    const INLINE_SOURCE = [
      '(`+)([\\s\\S]*?)\\1', // 1,2 code
      '!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 3,4 image
      '\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 5,6 link
      '\\*\\*([\\s\\S]+?)\\*\\*', // 7 strong
      '~~([\\s\\S]+?)~~', // 8 strike
      '(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)', // 9 emphasis
    ].join('|')

    /** Render inline Markdown into React nodes (no HTML injection anywhere). */
    function renderInline(text, keyBase) {
      const nodes = []
      const source = String(text ?? '')
      let cursor = 0
      let index = 0
      // A fresh regex per call: the emphasis branch recurses, and a shared
      // lastIndex would make the outer scan restart forever.
      const pattern = new RegExp(INLINE_SOURCE, 'g')
      for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        if (match.index > cursor) nodes.push(source.slice(cursor, match.index))
        const key = `${keyBase}-i${index}`
        index += 1
        if (match[2] !== undefined) {
          nodes.push(h('code', { key, className: 'ghb-code-inline' }, match[2]))
        } else if (match[4] !== undefined) {
          const src = safeUrl(match[4])
          nodes.push(
            src === null
              ? h('span', { key }, match[3])
              : h('img', { key, className: 'ghb-md-img', src, alt: match[3] ?? '', loading: 'lazy' }),
          )
        } else if (match[6] !== undefined) {
          const href = safeUrl(match[6])
          nodes.push(
            href === null
              ? h('span', { key }, match[5])
              : h('a', { key, className: 'ghb-link', href, target: '_blank', rel: 'noreferrer noopener' }, match[5]),
          )
        } else if (match[7] !== undefined) {
          nodes.push(h('strong', { key }, renderInline(match[7], key)))
        } else if (match[8] !== undefined) {
          nodes.push(h('del', { key }, renderInline(match[8], key)))
        } else if (match[9] !== undefined) {
          nodes.push(h('em', { key }, renderInline(match[9], key)))
        }
        cursor = match.index + match[0].length
      }
      if (cursor < source.length) nodes.push(source.slice(cursor))
      return nodes
    }

    const BLOCK_START = /^(```|~~~|#{1,6}\s|\s*>|\s*([-*+]|\d+\.)\s+|\s*(---|\*\*\*|___)\s*$)/

    /** Split a pipe table row, tolerating escaped pipes. */
    function splitRow(line) {
      return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'))
    }

    /** Render a Markdown document into React nodes. */
    function renderMarkdown(source, keyBase = 'md') {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let counter = 0
      const nextKey = () => `${keyBase}-b${(counter += 1)}`

      while (index < lines.length) {
        const line = lines[index]

        if (line.trim() === '') {
          index += 1
          continue
        }

        const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line)
        if (fence !== null) {
          const marker = fence[1]
          const language = fence[2]
          const body = []
          index += 1
          while (index < lines.length && lines[index].trim().indexOf(marker) !== 0) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(
            h(
              'pre',
              { key: nextKey(), className: 'ghb-pre' },
              language === '' ? null : h('span', { className: 'ghb-pre-lang' }, language),
              h('code', null, body.join('\n')),
            ),
          )
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          blocks.push(h(`h${level}`, { key: nextKey(), className: `ghb-h ghb-h${level}` }, renderInline(heading[2], `${keyBase}-h${counter}`)))
          index += 1
          continue
        }

        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
          blocks.push(h('hr', { key: nextKey(), className: 'ghb-hr' }))
          index += 1
          continue
        }

        if (/^\s*>/.test(line)) {
          const body = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            body.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: nextKey(), className: 'ghb-quote' }, renderMarkdown(body.join('\n'), `${keyBase}-q${counter}`)))
          continue
        }

        // Pipe table: header row followed by a separator row.
        if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[index + 1]) && lines[index + 1].includes('-')) {
          const header = splitRow(line)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
            rows.push(splitRow(lines[index]))
            index += 1
          }
          blocks.push(
            h(
              'div',
              { key: nextKey(), className: 'ghb-table-wrap' },
              h(
                'table',
                { className: 'ghb-table' },
                h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell, `${keyBase}-th${cellIndex}`))))),
                h(
                  'tbody',
                  null,
                  rows.map((row, rowIndex) =>
                    h('tr', { key: rowIndex }, row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell, `${keyBase}-td${rowIndex}-${cellIndex}`)))),
                  ),
                ),
              ),
            ),
          )
          continue
        }

        const listMatch = /^\s*([-*+]|\d+\.)\s+/.exec(line)
        if (listMatch !== null) {
          const ordered = /\d+\./.test(listMatch[1])
          const items = []
          while (index < lines.length) {
            const itemMatch = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[index])
            if (itemMatch === null) break
            const parts = [itemMatch[2]]
            index += 1
            // Continuation lines belong to the same item until a blank/block line.
            while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !BLOCK_START.test(lines[index])) {
              parts.push(lines[index].trim())
              index += 1
            }
            items.push(parts.join(' '))
          }
          blocks.push(
            h(
              ordered ? 'ol' : 'ul',
              { key: nextKey(), className: ordered ? 'ghb-ol' : 'ghb-ul' },
              items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item, `${keyBase}-li${counter}-${itemIndex}`))),
            ),
          )
          continue
        }

        const paragraph = []
        while (index < lines.length && lines[index].trim() !== '' && !BLOCK_START.test(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length === 0) {
          // Defensive: never spin on a line the block rules did not claim.
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(h('p', { key: nextKey(), className: 'ghb-p' }, renderInline(paragraph.join(' '), `${keyBase}-p${counter}`)))
      }

      return blocks
    }

    // =====================================================================
    // --- module: ui primitives --------------------------------------------
    // =====================================================================

    const S = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
      topbar: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 600, letterSpacing: 0.1 },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      split: { display: 'flex', flex: 1, minHeight: 0 },
      list: { width: 320, flexShrink: 0, borderRight: '1px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--dsw-alias-bg-layer-1)' },
      listScroll: { flex: 1, overflowY: 'auto', padding: '6px 8px 16px' },
      detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
      detailScroll: { flex: 1, overflowY: 'auto', padding: '20px 26px 40px' },
      search: { margin: '10px 12px 6px', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 12.5, outline: 'none', width: 'calc(100% - 24px)' },
      row: { display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid transparent' },
      rowTitle: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      card: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)', padding: '16px 18px' },
      center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '48px 24px', textAlign: 'center', flex: 1, color: 'var(--dsw-alias-label-secondary)' },
      button: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 12.5, cursor: 'pointer', lineHeight: 1.5, fontFamily: 'inherit' },
      buttonPrimary: { border: '1px solid transparent', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-inverted, #1b1b1b)', fontWeight: 600 },
      buttonDanger: { border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
      input: { width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
      textarea: { width: '100%', padding: '9px 11px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6 },
      label: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 5 },
      hint: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4, lineHeight: 1.5 },
      badge: { display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 5, fontSize: 10.5, fontWeight: 600, lineHeight: 1.6, border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)' },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000, padding: 24 },
      modal: { width: 'min(560px, 100%)', maxHeight: '82vh', overflowY: 'auto', borderRadius: 14, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1))', padding: 20, boxShadow: '0 18px 50px rgba(0,0,0,0.45)' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, background: 'var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2))', padding: '1px 5px', borderRadius: 4 },
      err: { padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5, lineHeight: 1.6, background: 'transparent' },
      ok: { padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-state-success-primary)', fontSize: 12.5, lineHeight: 1.6 },
    }

    const CSS = `
.ghb-root *, .ghb-root *::before, .ghb-root *::after { box-sizing: border-box; }
.ghb-root ::-webkit-scrollbar { width: 9px; height: 9px; }
.ghb-root ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 5px; }
.ghb-root ::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
.ghb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghb-group:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghb-group:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ghb-row-active { background: var(--dsw-alias-interactive-bg-active); border-color: var(--dsw-alias-border-l2); }
.ghb-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ghb-primary:hover { filter: brightness(1.08); }
.ghb-input:focus, .ghb-area:focus { border-color: var(--dsw-alias-brand-primary); }
.ghb-invalid, .ghb-invalid:focus { border-color: var(--dsw-alias-state-error-primary) !important; }
.ghb-link { color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); text-decoration: underline; text-underline-offset: 2px; }
.ghb-md { font-size: 14px; line-height: 1.75; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.ghb-md p { margin: 0 0 12px; }
.ghb-md .ghb-h { margin: 22px 0 10px; line-height: 1.35; font-weight: 650; }
.ghb-md .ghb-h1 { font-size: 24px; }
.ghb-md .ghb-h2 { font-size: 20px; }
.ghb-md .ghb-h3 { font-size: 17px; }
.ghb-md .ghb-h4, .ghb-md .ghb-h5, .ghb-md .ghb-h6 { font-size: 15px; }
.ghb-md .ghb-hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 20px 0; }
.ghb-md .ghb-code-inline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2)); padding: 1px 5px; border-radius: 4px; }
.ghb-md .ghb-pre { position: relative; background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2)); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; overflow-x: auto; margin: 0 0 14px; }
.ghb-md .ghb-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.65; white-space: pre; }
.ghb-md .ghb-pre-lang { position: absolute; top: 6px; right: 10px; font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.ghb-md .ghb-quote { margin: 0 0 14px; padding: 4px 0 4px 14px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.ghb-md .ghb-ul, .ghb-md .ghb-ol { margin: 0 0 14px; padding-left: 22px; }
.ghb-md .ghb-ul li, .ghb-md .ghb-ol li { margin: 3px 0; }
.ghb-md .ghb-table-wrap { overflow-x: auto; margin: 0 0 14px; }
.ghb-md .ghb-table { border-collapse: collapse; font-size: 13px; }
.ghb-md .ghb-table th, .ghb-md .ghb-table td { border: 1px solid var(--dsw-alias-border-l1); padding: 6px 10px; text-align: left; }
.ghb-md .ghb-table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.ghb-md .ghb-md-img { max-width: 100%; border-radius: 8px; }
.ghb-md a { color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); }
@media (prefers-reduced-motion: no-preference) {
  .ghb-spin { animation: ghb-rotate 0.9s linear infinite; }
}
@keyframes ghb-rotate { to { transform: rotate(360deg); } }
`

    function StyleSheet() {
      return h('style', { 'data-ghb-style': '1' }, CSS)
    }

    function Button({ children, onClick, variant, disabled, title, style }) {
      const base = variant === 'primary' ? { ...S.button, ...S.buttonPrimary } : variant === 'danger' ? S.buttonDanger : S.button
      return h(
        'button',
        {
          type: 'button',
          className: variant === 'primary' ? 'ghb-btn ghb-primary' : 'ghb-btn',
          onClick,
          disabled,
          title,
          style: { ...base, opacity: disabled === true ? 0.5 : 1, cursor: disabled === true ? 'not-allowed' : 'pointer', ...style },
        },
        children,
      )
    }

    function Spinner({ size = 14 }) {
      return h(
        'span',
        {
          className: 'ghb-spin',
          style: {
            display: 'inline-block',
            width: size,
            height: size,
            borderRadius: '50%',
            border: '2px solid var(--dsw-alias-border-l2)',
            borderTopColor: 'var(--dsw-alias-brand-primary)',
            flexShrink: 0,
          },
          'aria-hidden': true,
        },
        null,
      )
    }

    function Badge({ children, tone }) {
      const extra =
        tone === 'accent'
          ? { color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' }
          : tone === 'error'
            ? { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' }
            : {}
      return h('span', { style: { ...S.badge, ...extra } }, children)
    }

    function CenterState({ title, hint, action }) {
      return h(
        'div',
        { style: S.center },
        h('div', { style: { fontSize: 13.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, title),
        hint === undefined ? null : h('div', { style: { fontSize: 12.5, maxWidth: 380, lineHeight: 1.6 } }, hint),
        action ?? null,
      )
    }

    function ErrorBox({ message, onRetry, t }) {
      return h(
        'div',
        { style: { ...S.err, display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', null, message),
        onRetry === undefined
          ? null
          : h('div', null, h(Button, { onClick: onRetry, style: { alignSelf: 'flex-start' } }, t('error.retry'))),
      )
    }

    function Field({ label, hint, error, children, requiredMark }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        h(
          'label',
          { style: S.label },
          label,
          requiredMark === true ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', marginLeft: 3 } }, '*') : null,
        ),
        children,
        error === undefined || error === null
          ? hint === undefined
            ? null
            : h('div', { style: S.hint }, hint)
          : h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, error),
      )
    }

    function Switch({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          onClick: () => onChange(checked !== true),
          className: 'ghb-btn',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 12.5,
            fontFamily: 'inherit',
            padding: 0,
          },
        },
        h(
          'span',
          {
            style: {
              width: 34,
              height: 20,
              borderRadius: 10,
              background: checked === true ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
              position: 'relative',
              transition: 'background 120ms ease',
              flexShrink: 0,
            },
          },
          h('span', {
            style: {
              position: 'absolute',
              top: 2,
              left: checked === true ? 16 : 2,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: 'var(--dsw-alias-switch-thumb, #fff)',
              transition: 'left 120ms ease',
            },
          }),
        ),
        label,
      )
    }

    function Modal({ title, onClose, children, footer }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        { style: S.overlay, role: 'dialog', 'aria-modal': 'true', onMouseDown: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { style: S.modal },
          h('div', { style: { fontSize: 14.5, fontWeight: 650, marginBottom: 12 } }, title),
          children,
          footer === undefined ? null : h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } }, footer),
        ),
      )
    }

    /** Group errors by field so the editor can mark the exact control. */
    function errorsByField(errors) {
      const map = {}
      for (const error of errors ?? []) {
        const field = error?.field ?? 'document'
        if (map[field] === undefined) map[field] = []
        map[field].push(error.message ?? error.code ?? '错误')
      }
      return map
    }

    // =====================================================================
    // --- module: editor ---------------------------------------------------
    // =====================================================================

    /** A blank draft in the shape the Host's validate endpoint expects. */
    function blankDraft(type, today) {
      return {
        title: '',
        date: today,
        type,
        summary: '',
        category: '',
        tags: '',
        review: '',
        draft: false,
        body: '',
        slug: '',
      }
    }

    /**
     * Split editor: front matter form on the left, live preview on the right,
     * with the Markdown body source editable underneath the form.
     */
    function ArticleEditor({ draft, setDraft, errors, warnings, onStage, onCancel, staged, path, t, slugPathHint }) {
      const byField = errorsByField(errors)
      const warningByField = errorsByField(warnings)
      const fieldError = (name) => (byField[name] === undefined ? undefined : byField[name].join('；'))
      const fieldWarning = (name) => (byField[name] === undefined ? undefined : byField[name].join('；'))
      const invalidClass = (name) => (byField[name] === undefined ? 'ghb-input' : 'ghb-input ghb-invalid')
      const update = (patch) => setDraft({ ...draft, ...patch })

      const bodyArea = useRef(null)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 26px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0 } },
          h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, path ?? t('page.new')),
          staged === true ? h(Badge, { tone: 'accent' }, t('view.staged')) : null,
          h('div', { style: { flex: 1 } }),
          byField.body === undefined ? null : h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, byField.body.join('；')),
          h(Button, { onClick: onCancel }, t('view.discard')),
          h(Button, { variant: 'primary', onClick: onStage }, t('view.stage')),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(320px, 1.1fr)', gap: 20, padding: '18px 26px 32px', overflowY: 'auto', flex: 1, minHeight: 0, alignItems: 'start' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 13 } },
            h(
              Field,
              { label: t('field.title'), requiredMark: true, error: fieldError('title') },
              h('input', {
                className: invalidClass('title'),
                style: S.input,
                value: draft.title,
                placeholder: t('field.title.placeholder'),
                onChange: (event) => update({ title: event.target.value }),
              }),
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
              h(
                Field,
                { label: t('field.date'), requiredMark: true, error: fieldError('date') },
                h('input', {
                  type: 'date',
                  className: invalidClass('date'),
                  style: S.input,
                  value: draft.date,
                  onChange: (event) => update({ date: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: t('field.type'), requiredMark: true, error: fieldError('type') },
                h(
                  'select',
                  {
                    className: invalidClass('type'),
                    style: { ...S.input, appearance: 'auto' },
                    value: draft.type,
                    onChange: (event) => update({ type: event.target.value }),
                  },
                  h('option', { value: 'diary' }, t('type.diary')),
                  h('option', { value: 'note' }, t('type.note')),
                ),
              ),
            ),
            h(
              Field,
              { label: t('field.summary'), requiredMark: true, error: fieldError('summary') },
              h('textarea', {
                className: 'ghb-area',
                style: { ...S.textarea, minHeight: 58, borderColor: byField.summary ? 'var(--dsw-alias-state-error-primary)' : undefined },
                value: draft.summary,
                placeholder: t('field.summary.placeholder'),
                onChange: (event) => update({ summary: event.target.value }),
              }),
            ),
            draft.type === 'note'
              ? h(
                  Field,
                  { label: t('field.category'), hint: t('field.optional'), error: fieldError('category') },
                  h('input', {
                    className: invalidClass('category'),
                    style: S.input,
                    value: draft.category,
                    onChange: (event) => update({ category: event.target.value }),
                  }),
                )
              : null,
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
              h(
                Field,
                { label: t('field.tags'), hint: t('field.optional'), error: fieldError('tags') },
                h('input', {
                  className: invalidClass('tags'),
                  style: S.input,
                  value: draft.tags,
                  placeholder: t('field.tags.placeholder'),
                  onChange: (event) => update({ tags: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: t('field.review'), hint: t('field.optional'), error: fieldError('review') },
                h('input', {
                  type: 'date',
                  className: invalidClass('review'),
                  style: S.input,
                  value: draft.review,
                  onChange: (event) => update({ review: event.target.value }),
                }),
              ),
            ),
            path === undefined
              ? h(
                  Field,
                  { label: t('field.slug'), error: fieldError('slug'), hint: (slugPathHint ?? '').replace('{path}', '') },
                  h('input', {
                    className: invalidClass('slug'),
                    style: S.input,
                    value: draft.slug,
                    onChange: (event) => update({ slug: event.target.value }),
                  }),
                )
              : null,
            h(Switch, { checked: draft.draft === true, onChange: (next) => update({ draft: next }), label: t('field.draft') }),
            Object.keys(warningByField).length === 0
              ? null
              : h(
                  'div',
                  { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
                  Object.values(warningByField).flat().join('；'),
                ),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, position: 'sticky', top: 0 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('field.body')),
              h('div', { style: { flex: 1 } }),
              h('span', { style: { ...S.hint, marginTop: 0 } }, t('view.previewHint')),
            ),
            h('textarea', {
              ref: bodyArea,
              className: 'ghb-area',
              style: {
                ...S.textarea,
                minHeight: 220,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12.5,
                borderColor: byField.body ? 'var(--dsw-alias-state-error-primary)' : undefined,
              },
              value: draft.body,
              placeholder: t('field.body.placeholder'),
              onChange: (event) => update({ body: event.target.value }),
            }),
            h(
              'div',
              { style: { ...S.card, padding: '14px 16px', maxHeight: '46vh', overflowY: 'auto' } },
              h('div', { className: 'ghb-md' }, renderMarkdown(draft.body === '' ? '—' : draft.body, 'editor-md')),
            ),
          ),
        ),
      )
    }

    // =====================================================================
    // --- module: settings -------------------------------------------------
    // =====================================================================

    function SettingsPanel({ open, onClose, settings, onSaved, t }) {
      const [form, setForm] = useState({ repository: '', branch: '', contentRoot: '', siteUrl: '', token: '', clearToken: false })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        if (open !== true) return
        setForm({
          repository: settings?.repository ?? '',
          branch: settings?.branch ?? '',
          contentRoot: settings?.contentRoot ?? '',
          siteUrl: settings?.siteUrl ?? '',
          token: '',
          clearToken: false,
        })
        setError(null)
        setNotice(null)
      }, [open, settings])

      if (open !== true) return null

      const save = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const next = await callApi('settings/save', {
            repository: form.repository,
            branch: form.branch,
            contentRoot: form.contentRoot,
            siteUrl: form.siteUrl,
            token: form.token,
            clearToken: form.clearToken,
          })
          setNotice(t('settings.saved'))
          await onSaved(next)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const test = async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const result = await callApi('test-connection', {})
          setNotice(
            t('settings.testOk')
              .replace('{user}', result.user.login || '?')
              .replace('{repo}', result.repository.fullName)
              .replace('{sha}', String(result.head ?? '—').slice(0, 7)),
          )
          if (result.branchError) setError(result.branchError.message)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: t('settings.title'),
        onClose,
        footer: [
          h(Button, { key: 'test', onClick: test, disabled: busy }, busy === true ? t('settings.testing') : t('settings.test')),
          h(Button, { key: 'save', variant: 'primary', onClick: save, disabled: busy }, t('settings.save')),
          h(Button, { key: 'close', onClick: onClose }, t('settings.close')),
        ],
        children: h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { style: { ...S.hint, marginTop: 0 } }, t('settings.subtitle')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, t('settings.token')),
              settings?.hasToken === true
                ? h(Badge, { tone: 'accent' }, t('settings.token.configured').replace('{source}', settings?.tokenSource ?? 'local'))
                : h(Badge, { tone: 'error' }, t('settings.token.missing')),
            ),
            h('input', {
              type: 'password',
              className: 'ghb-input',
              style: S.input,
              value: form.token,
              placeholder: settings?.hasToken === true ? t('settings.token.keep') : t('settings.token.placeholder'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => setForm({ ...form, token: event.target.value }),
            }),
            h('div', { style: S.hint }, t('settings.token.hint')),
            h(
              'div',
              { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' } },
              h('a', { className: 'ghb-link', href: TOKEN_SCOPE_URL, target: '_blank', rel: 'noreferrer noopener', style: { fontSize: 12 } }, t('settings.createToken')),
              h('a', { className: 'ghb-link', href: SETTINGS_DOC_URL, target: '_blank', rel: 'noreferrer noopener', style: { fontSize: 12 } }, t('settings.tokenDocs')),
              settings?.hasToken === true
                ? h(Switch, { checked: form.clearToken === true, onChange: (next) => setForm({ ...form, clearToken: next }), label: t('settings.token.clear') })
                : null,
            ),
          ),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 } },
            h(
              Field,
              { label: t('settings.repository') },
              h('input', {
                className: 'ghb-input',
                style: S.input,
                value: form.repository,
                onChange: (event) => setForm({ ...form, repository: event.target.value }),
              }),
            ),
            h(
              Field,
              { label: t('settings.branch') },
              h('input', {
                className: 'ghb-input',
                style: S.input,
                value: form.branch,
                onChange: (event) => setForm({ ...form, branch: event.target.value }),
              }),
            ),
          ),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 } },
            h(
              Field,
              { label: t('settings.contentRoot') },
              h('input', {
                className: 'ghb-input',
                style: S.input,
                value: form.contentRoot,
                onChange: (event) => setForm({ ...form, contentRoot: event.target.value }),
              }),
            ),
            h(
              Field,
              { label: t('settings.siteUrl') },
              h('input', {
                className: 'ghb-input',
                style: S.input,
                value: form.siteUrl,
                onChange: (event) => setForm({ ...form, siteUrl: event.target.value }),
              }),
            ),
          ),
          error === null ? null : h(ErrorBox, { message: error, t }),
          notice === null ? null : h('div', { style: S.ok }, notice),
          h('div', { style: { ...S.hint, marginTop: 0 } }, `${t('settings.path')}: ${settings?.settingsPath ?? '—'}`),
        ),
      })
    }

    // =====================================================================
    // --- module: panel ----------------------------------------------------
    // =====================================================================

    /** Bucket name for articles whose front matter has no tags. */
    const UNTAGGED = '\u0000untagged'

    /** Where the folded-group memory lives; page-scoped, so it survives reloads. */
    const COLLAPSE_KEY = 'dsh-gh-blog:collapsed-tag-groups'

    /** Read the remembered fold state. Any corrupt value degrades to "all open". */
    function readCollapsedGroups() {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return {}
        const state = {}
        for (const name of parsed) {
          if (typeof name === 'string' && name !== '') state[name] = true
        }
        return state
      } catch {
        return {}
      }
    }

    /** The fold affordance: a chevron that rotates instead of swapping glyphs. */
    function Chevron({ open }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          'aria-hidden': true,
          style: { flexShrink: 0, transform: open === true ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' },
        },
        h('path', { d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /**
     * Does this article match the search box? Title, tags and file name are the
     * documented fields; the id carries the path (so the file name matches too),
     * and summary/category stay searchable as a bonus.
     *
     * `needle` must already be trimmed and lower-cased.
     */
    function articleMatchesQuery(article, needle) {
      if (needle === '') return true
      const haystack = [article?.title, article?.id, article?.path, article?.category, article?.summary, ...(article?.tags ?? [])]
        .filter((value) => typeof value === 'string')
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    }

    /**
     * Group articles by tag — the left column's whole organising principle.
     *
     * Rules, straight from the requirement:
     *   - one group per tag, carrying 「标签名 + 文章数量」;
     *   - an article with several tags appears in *every* one of its tag groups;
     *   - an untagged article is not dropped: it goes to a dedicated last group;
     *   - each occurrence records the article's *remaining* tags, which is what
     *     the card shows as grey text (the group header already names the tag).
     *
     * Ordering puts the busiest tags first and keeps the untagged bucket last,
     * so the list reads the same way every time.
     */
    function groupArticlesByTag(articles) {
      const buckets = new Map()
      for (const article of articles ?? []) {
        const tags = [...new Set((Array.isArray(article?.tags) ? article.tags : []).map((tag) => String(tag).trim()).filter((tag) => tag !== ''))]
        if (tags.length === 0) {
          const items = buckets.get(UNTAGGED) ?? []
          items.push({ article, others: [] })
          buckets.set(UNTAGGED, items)
          continue
        }
        for (const tag of tags) {
          const items = buckets.get(tag) ?? []
          items.push({ article, others: tags.filter((other) => other !== tag) })
          buckets.set(tag, items)
        }
      }
      const entries = [...buckets.entries()].map(([tag, items]) => ({ tag, items }))
      // Busiest tag first; ties keep first-seen order, which follows the article
      // list (newest first) and is stable everywhere — `localeCompare` would make
      // the order depend on the runtime's ICU data.
      entries.sort((left, right) => {
        if (left.tag === UNTAGGED) return 1
        if (right.tag === UNTAGGED) return -1
        return right.items.length - left.items.length
      })
      return entries
    }

    /**
     * One article card. The list is grouped by tag, so the same article can
     * appear under several headers; `others` carries the article's *remaining*
     * tags (all of them minus the group's tag) so the card explains why it is
     * filed here without repeating the header.
     */
    function ArticleRow({ article, others, active, dirty, onSelect, t }) {
      // The requirement asks for title, date *and* file name: the name is what a
      // reader needs to find the file on GitHub, so it gets its own line.
      const fileName = String(article.path ?? '').slice(String(article.path ?? '').lastIndexOf('/') + 1)
      const rest = (others ?? []).filter((tag) => tag !== '')
      return h(
        'div',
        {
          className: active === true ? 'ghb-row ghb-row-active' : 'ghb-row',
          style: S.row,
          onClick: () => onSelect(article.path),
          role: 'button',
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(article.path)
            }
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('div', { style: S.rowTitle }, article.title),
          dirty === true ? h('span', { title: t('badge.dirty'), style: { width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-brand-primary)', flexShrink: 0 } }) : null,
        ),
        h(
          'div',
          { style: S.rowMeta },
          h('span', null, article.date === '' ? '—' : article.date),
          article.draft === true ? h(Badge, { tone: 'accent' }, t('badge.draft')) : null,
          article.ok !== true ? h(Badge, { tone: 'error' }, t('badge.invalid')) : null,
          rest.length === 0
            ? null
            : h(
                'span',
                {
                  style: {
                    fontSize: 10.5,
                    color: 'var(--dsw-alias-label-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  },
                  title: rest.map((tag) => `#${tag}`).join(' '),
                },
                rest.map((tag) => `#${tag}`).join(' '),
              ),
        ),
        h(
          'div',
          {
            style: {
              fontSize: 10.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: 'var(--dsw-alias-label-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: article.path,
          },
          fileName,
        ),
      )
    }

    function MetaChips({ article, t }) {
      const chip = (label, value) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 12 } },
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, `${label}:`),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, value),
        )
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px' } },
        chip(t('meta.type'), article.type),
        chip(t('meta.date'), article.date === '' ? '—' : article.date),
        chip(t('meta.category'), article.category === '' ? (article.type === 'note' ? t('meta.uncategorized') : t('meta.none')) : article.category),
        chip(t('meta.tags'), article.tags.length === 0 ? t('meta.none') : article.tags.join(' · ')),
        article.review === '' ? null : chip(t('meta.review'), article.review),
        article.draft === true ? h(Badge, { tone: 'accent' }, t('badge.draft')) : null,
      )
    }

    function BlogPanel(props) {
      const { t } = props

      const [phase, setPhase] = useState('loading') // loading | ready | error | setup
      const [settings, setSettings] = useState(null)
      const [listing, setListing] = useState({ articles: [], head: null, repository: '', branch: '' })
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      // Fold state is seeded from storage once and written back on every change,
      // so "collapse the tags I do not care about" survives a reload.
      const [collapsed, setCollapsed] = useState(readCollapsedGroups)
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState({ phase: 'idle', article: null, error: null })
      const [view, setView] = useState('preview') // preview | source | edit
      const [draft, setDraft] = useState(null)
      const [validation, setValidation] = useState({ errors: [], warnings: [], path: '' })
      const [staged, setStaged] = useState({})
      const [deletions, setDeletions] = useState({})
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [publishOpen, setPublishOpen] = useState(false)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [publishState, setPublishState] = useState({ phase: 'idle', error: null, commit: null, message: '' })
      const [build, setBuild] = useState(null)
      const today = useMemo(() => {
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      }, [])

      const dirtyPaths = useMemo(() => Object.keys(staged).filter((path) => deletions[path] !== true), [staged, deletions])
      const deletedPaths = useMemo(() => Object.keys(deletions), [deletions])
      const changeCount = dirtyPaths.length + deletedPaths.length

      /** Load settings, then the article list. */
      const bootstrap = useCallback(
        async (options = {}) => {
          setPhase('loading')
          setError(null)
          try {
            const nextSettings = await callApi('settings', {})
            setSettings(nextSettings)
            if (nextSettings.hasToken !== true) {
              setPhase('setup')
              return
            }
            const list = await callApi('articles', { refresh: options.refresh === true })
            setListing(list)
            setPhase('ready')
          } catch (failure) {
            if (failure.code === 'missing-token') {
              setPhase('setup')
              return
            }
            setError(failure)
            setPhase('error')
          }
        },
        [],
      )

      useEffect(() => {
        bootstrap()
      }, [bootstrap])

      /** Stage-3 hook: another surface (an AI turn, a script) can hand us a draft. */
      useEffect(() => {
        const onDraft = (event) => {
          const detail = event?.detail ?? {}
          if (typeof detail.body !== 'string') return
          setSelected(null)
          setDraft({
            ...blankDraft(detail.type === 'diary' ? 'diary' : 'note', detail.date ?? today),
            title: String(detail.title ?? '').trim(),
            summary: String(detail.summary ?? '').trim(),
            body: detail.body,
            tags: Array.isArray(detail.tags) ? detail.tags.join(', ') : String(detail.tags ?? ''),
            slug: '',
          })
          setValidation({ errors: [], warnings: [], path: '' })
          setView('edit')
        }
        window.addEventListener('dsh-gh-blog:draft', onDraft)
        return () => window.removeEventListener('dsh-gh-blog:draft', onDraft)
      }, [today])

      const selectArticle = useCallback(async (path) => {
        setSelected(path)
        const pending = staged[path]
        if (pending !== undefined && pending.form !== undefined) {
          setDraft({ ...pending.form, slug: pending.slug ?? '' })
          setValidation({ errors: [], warnings: [], path })
          setView('edit')
          return
        }
        setDetail({ phase: 'loading', article: null, error: null })
        setView('preview')
        try {
          const article = await callApi('article', { path })
          setDetail({ phase: 'ready', article, error: null })
        } catch (failure) {
          setDetail({ phase: 'error', article: null, error: failure })
        }
      }, [staged])

      const startNew = useCallback(() => {
        setSelected(null)
        setDraft(blankDraft('note', today))
        setValidation({ errors: [], warnings: [], path: '' })
        setDetail({ phase: 'idle', article: null, error: null })
        setView('edit')
      }, [today])

      /** Ask the Host to validate, then stage locally. Publishing stays explicit. */
      const stageDraft = useCallback(async () => {
        const path = selected ?? undefined
        try {
          const verdict = await callApi('validate', { form: draft, slug: draft.slug, path })
          setValidation({ errors: verdict.errors ?? [], warnings: verdict.warnings ?? [], path: verdict.path })
          if (verdict.ok !== true) return
          const expectedSha = path === undefined ? null : detail.article?.sha ?? staged[path]?.expectedSha ?? null
          setStaged((current) => ({
            ...current,
            [verdict.path]: { form: { ...draft }, slug: draft.slug, expectedSha, path: verdict.path },
          }))
          setSelected(verdict.path)
          setDeletions((current) => {
            if (current[verdict.path] === undefined) return current
            const next = { ...current }
            delete next[verdict.path]
            return next
          })
          // Refresh the reader for the newly staged path.
          setDetail({ phase: 'ready', article: { path: verdict.path, sha: expectedSha, frontMatter: verdict.frontMatter, body: verdict.body, text: verdict.text, errors: [], warnings: verdict.warnings }, error: null })
          setView('preview')
        } catch (failure) {
          setValidation({ errors: [{ field: 'document', message: failure.message }], warnings: [], path: '' })
        }
      }, [draft, selected, detail, staged])

      const stageDelete = useCallback(() => {
        const target = deleteTarget
        if (target === null) return
        if (target.sha === null || target.sha === undefined) {
          // Never published, so it only exists in the staging area: dropping it
          // from staging *is* the deletion. Sending a delete commit for a path
          // that is not on the branch would be a pointless commit.
          setStaged((current) => {
            const next = { ...current }
            delete next[target.path]
            return next
          })
        } else {
          setDeletions((current) => ({ ...current, [target.path]: target.sha }))
          setStaged((current) => {
            const next = { ...current }
            delete next[target.path]
            return next
          })
        }
        setDeleteTarget(null)
        setSelected(null)
        setDetail({ phase: 'idle', article: null, error: null })
        setView('preview')
      }, [deleteTarget])

      /** Build the change batch, send it, then watch the Actions run. */
      const doPublish = useCallback(
        async (message) => {
          const changes = []
          for (const path of deletedPaths) changes.push({ path, delete: true, expectedSha: deletions[path] })
          for (const path of dirtyPaths) {
            const entry = staged[path]
            changes.push({ path: entry.path ?? path, form: entry.form, slug: entry.slug, expectedSha: entry.expectedSha })
          }
          setPublishState({ phase: 'publishing', error: null, commit: null, message })
          try {
            const result = await callApi('publish', { changes, message })
            setPublishState({ phase: 'done', error: null, commit: result.commit, message: result.message })
            setStaged({})
            setDeletions({})
            setPublishOpen(false)
            setSelected(null)
            setDetail({ phase: 'idle', article: null, error: null })
            setView('preview')
            await bootstrap({ refresh: true })
            setBuild({ phase: 'watching', run: null, commit: result.commit, siteUrl: result.siteUrl })
          } catch (failure) {
            const byPath = failure?.details?.errorsByPath
            setPublishState({ phase: 'error', error: failure, commit: null, message })
            if (byPath !== undefined && byPath !== null) {
              const flat = Object.entries(byPath).flatMap(([path, errors]) => errors.map((error) => ({ ...error, path })))
              setValidation({ errors: flat, warnings: [], path: '' })
            }
          }
        },
        [deletedPaths, dirtyPaths, deletions, staged, bootstrap],
      )

      /** Poll the latest Actions run until it settles or we give up. */
      useEffect(() => {
        if (build?.phase !== 'watching') return undefined
        let cancelled = false
        let attempts = 0
        let timer = null
        const tick = async () => {
          if (cancelled) return
          attempts += 1
          try {
            const run = await callApi('run', {})
            if (cancelled) return
            if (run === null) {
              setBuild((current) => ({ ...current, phase: attempts > 20 ? 'unknown' : 'watching' }))
            } else if (run.status === 'completed') {
              setBuild((current) => ({ ...current, phase: run.conclusion === 'success' ? 'success' : 'failure', run }))
              return
            } else {
              setBuild((current) => ({ ...current, run }))
            }
          } catch {
            // A transient failure must not end the watch.
          }
          if (cancelled) return
          if (attempts < 40) timer = window.setTimeout(tick, 15_000)
          else setBuild((current) => ({ ...current, phase: 'unknown' }))
        }
        timer = window.setTimeout(tick, 6_000)
        return () => {
          cancelled = true
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [build?.phase, build?.commit?.sha])

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const articles = listing.articles ?? []
        if (needle === '') return articles
        return articles.filter((article) => articleMatchesQuery(article, needle))
      }, [listing, query])

      /** Tag groups for the left column; see `groupArticlesByTag` for the rules. */
      const groups = useMemo(() => groupArticlesByTag(filtered), [filtered])

      /** A search is an explicit request for results, so it overrides folding. */
      const expandedFor = useCallback((tag) => query.trim() !== '' || collapsed[tag] !== true, [query, collapsed])

      const toggleGroup = useCallback((tag) => {
        setCollapsed((current) => {
          const next = { ...current }
          if (next[tag] === true) delete next[tag]
          else next[tag] = true
          return next
        })
      }, [])

      // Fold state outlives the panel: reopening DSH keeps the tags you keep shut.
      useEffect(() => {
        try {
          const names = Object.keys(collapsed).filter((key) => collapsed[key] === true)
          window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(names))
        } catch {
          // Private mode / disabled storage: folding still works, it just is not remembered.
        }
      }, [collapsed])

      const isStagedView = selected !== null && staged[selected] !== undefined
      const currentArticle = detail.article

      // ---- top bar -------------------------------------------------------
      const topbar = h(
        'div',
        { style: S.topbar },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
          h('div', { style: S.title }, t('page.title')),
          h('div', { style: S.subtitle }, t('page.subtitle').replace('{repo}', settings?.repository ?? '—').replace('{branch}', settings?.branch ?? '—')),
        ),
        h('div', { style: { flex: 1 } }),
        changeCount > 0 ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, t('page.dirty').replace('{n}', String(changeCount))) : null,
        h(Button, { onClick: () => bootstrap({ refresh: true }), disabled: phase === 'loading' }, t('page.refresh')),
        h(Button, { onClick: () => setSettingsOpen(true) }, t('page.settings')),
        h(Button, { onClick: startNew }, t('page.new')),
        h(
          Button,
          { variant: 'primary', onClick: () => setPublishOpen(true), disabled: changeCount === 0 },
          changeCount === 0 ? t('page.publish') : t('page.publishCount').replace('{n}', String(changeCount)),
        ),
      )

      // ---- build strip ---------------------------------------------------
      const buildStrip = () => {
        if (build === null) return null
        const tone =
          build.phase === 'success' ? 'var(--dsw-alias-state-success-primary)' : build.phase === 'failure' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'
        const label =
          build.phase === 'watching'
            ? t('notify.buildRunning')
            : build.phase === 'success'
              ? t('notify.buildSuccess')
              : build.phase === 'failure'
                ? t('notify.buildFailure')
                : t('common.unknown')
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 12, color: tone, flexShrink: 0 } },
          build.phase === 'watching' ? h(Spinner, { size: 12 }) : null,
          h('span', null, label),
          build.run?.url ? h('a', { className: 'ghb-link', href: build.run.url, target: '_blank', rel: 'noreferrer noopener' }, t('notify.openRun')) : null,
          build.phase === 'success' && build.siteUrl ? h('a', { className: 'ghb-link', href: build.siteUrl, target: '_blank', rel: 'noreferrer noopener' }, t('notify.openSite')) : null,
          h('div', { style: { flex: 1 } }),
          h(Button, { onClick: () => setBuild(null), style: { padding: '2px 8px', fontSize: 11 } }, t('common.close')),
        )
      }

      // ---- left column ---------------------------------------------------
      const leftColumn = () =>
        h(
          'aside',
          { style: S.list },
          h('input', {
            className: 'ghb-input',
            style: S.search,
            value: query,
            placeholder: t('page.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'div',
            { style: S.listScroll },
            groups.length === 0
              ? h(CenterState, {
                  title: (listing.articles ?? []).length === 0 ? t('state.empty') : t('state.noMatch'),
                  hint: (listing.articles ?? []).length === 0 ? t('state.emptyHint') : undefined,
                })
              : groups.map((group) => {
                  const open = expandedFor(group.tag)
                  const untagged = group.tag === UNTAGGED
                  return h(
                    'div',
                    { key: group.tag },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ghb-group',
                        'aria-expanded': open,
                        title: untagged === true ? `${t('group.untaggedHint')} · ${t('group.foldHint')}` : `#${group.tag} · ${t('group.foldHint')}`,
                        onClick: () => toggleGroup(group.tag),
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          width: '100%',
                          padding: '10px 8px 6px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: 0.4,
                          textAlign: 'left',
                          color: 'var(--dsw-alias-label-tertiary)',
                          borderRadius: 6,
                        },
                      },
                      h(Chevron, { open }),
                      untagged === true ? null : h('span', { style: { color: 'var(--dsw-alias-brand-primary)', opacity: 0.85 } }, '#'),
                      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, untagged === true ? t('group.untagged') : group.tag),
                      // "标签名 + 文章数量": the count is per tag, not per article.
                      h('span', { style: { opacity: 0.6, marginLeft: 'auto' } }, group.items.length),
                    ),
                    open === false
                      ? null
                      : group.items.map(({ article, others }) =>
                          h(ArticleRow, {
                            key: `${group.tag}\u0000${article.path}`,
                            article,
                            others,
                            active: selected === article.path,
                            dirty: staged[article.path] !== undefined || deletions[article.path] !== undefined,
                            onSelect: selectArticle,
                            t,
                          }),
                        ),
                  )
                }),
          ),
        )

      // ---- right column --------------------------------------------------
      const rightColumn = () => {
        if (view === 'edit' && draft !== null) {
          return h(ArticleEditor, {
            draft,
            setDraft,
            errors: validation.errors,
            warnings: validation.warnings,
            onStage: stageDraft,
            onCancel: () => {
              if (selected !== null) {
                setView('preview')
                return
              }
              setDraft(null)
              setView('preview')
            },
            staged: isStagedView,
            path: selected ?? undefined,
            t,
            slugPathHint: '',
          })
        }

        if (selected === null) {
          return h(CenterState, { title: t('state.select'), hint: t('state.selectHint') })
        }

        if (detail.phase === 'loading') {
          return h('div', { style: S.center }, h(Spinner, { size: 18 }), h('div', null, t('state.loading')))
        }
        if (detail.phase === 'error') {
          return h('div', { style: { ...S.detailScroll } }, h(ErrorBox, { message: detail.error?.message ?? t('error.title'), onRetry: () => selectArticle(selected), t }))
        }
        if (currentArticle === null) return h(CenterState, { title: t('state.select') })

        const article = currentArticle
        const frontMatter = article.frontMatter ?? {}
        const display = {
          type: frontMatter.type ?? '',
          date: frontMatter.date ?? '',
          category: frontMatter.category ?? '',
          tags: String(frontMatter.tags ?? '')
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter((tag) => tag !== ''),
          review: frontMatter.review ?? '',
          draft: String(frontMatter.draft ?? '').toLowerCase() === 'true',
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 26px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, frontMatter.title ?? article.path),
            isStagedView ? h(Badge, { tone: 'accent' }, t('badge.dirty')) : null,
            display.draft === true ? h(Badge, { tone: 'accent' }, t('badge.draft')) : null,
            h('div', { style: { flex: 1 } }),
            h(Button, { onClick: () => setView(view === 'source' ? 'preview' : 'source') }, view === 'source' ? t('view.preview') : t('view.source')),
            h(
              Button,
              {
                onClick: () => {
                  setDraft({
                    title: String(frontMatter.title ?? ''),
                    date: String(frontMatter.date ?? today),
                    type: String(frontMatter.type ?? 'note'),
                    summary: String(frontMatter.summary ?? ''),
                    category: String(frontMatter.category ?? ''),
                    tags: display.tags.join(', '),
                    review: String(frontMatter.review ?? ''),
                    draft: display.draft,
                    body: String(article.body ?? ''),
                    slug: '',
                  })
                  setValidation({ errors: [], warnings: [], path: '' })
                  setView('edit')
                },
              },
              t('view.edit'),
            ),
            h(Button, { variant: 'danger', onClick: () => setDeleteTarget({ path: article.path, sha: article.sha }) }, t('view.delete')),
          ),
          h(
            'div',
            { style: S.detailScroll },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 } },
              h('h1', { style: { fontSize: 22, fontWeight: 680, margin: 0, lineHeight: 1.35 } }, frontMatter.title ?? article.path),
              h(MetaChips, { article: { ...display, tags: display.tags }, t }),
              h('div', { style: { ...S.hint, marginTop: 0 } }, `${t('meta.id')}: ${String(article.path ?? '').replace(/^content\//, '').replace(/\.md$/, '')}`),
            ),
            (article.errors ?? []).length === 0
              ? null
              : h('div', { style: { ...S.err, marginBottom: 16 } }, (article.errors ?? []).map((item) => item.message).join('；')),
            view === 'source'
              ? h('pre', { style: { ...S.code, display: 'block', padding: 14, whiteSpace: 'pre-wrap', lineHeight: 1.6, overflowX: 'auto' } }, article.text ?? '')
              : h('div', { className: 'ghb-md' }, renderMarkdown(article.body ?? '', `read-${article.path}`)),
          ),
        )
      }

      // ---- states --------------------------------------------------------
      if (phase === 'loading') {
        return h('div', { className: 'ghb-root', style: { ...S.page } }, h(StyleSheet), topbar, h('div', { style: S.center }, h(Spinner, { size: 18 }), h('div', { style: { fontWeight: 600 } }, t('state.loading')), h('div', { style: { fontSize: 12.5 } }, t('state.loadingHint'))))
      }
      if (phase === 'setup') {
        return h(
          'div',
          { className: 'ghb-root', style: S.page },
          h(StyleSheet),
          topbar,
          h(CenterState, {
            title: t('state.needSettings'),
            hint: t('state.needSettingsHint'),
            action: h(Button, { variant: 'primary', onClick: () => setSettingsOpen(true), style: { marginTop: 8 } }, t('state.openSettings')),
          }),
          h(SettingsPanel, { open: settingsOpen, onClose: () => setSettingsOpen(false), settings, onSaved: async (next) => { setSettings(next); setSettingsOpen(false); await bootstrap({ refresh: true }) }, t }),
        )
      }
      if (phase === 'error') {
        return h(
          'div',
          { className: 'ghb-root', style: S.page },
          h(StyleSheet),
          topbar,
          h('div', { style: { padding: 26 } }, h(ErrorBox, { message: error?.message ?? t('error.title'), onRetry: () => bootstrap({ refresh: true }), t })),
          h(SettingsPanel, { open: settingsOpen, onClose: () => setSettingsOpen(false), settings, onSaved: async (next) => { setSettings(next); setSettingsOpen(false); await bootstrap({ refresh: true }) }, t }),
        )
      }

      return h(
        'div',
        { className: 'ghb-root', style: S.page },
        h(StyleSheet),
        topbar,
        buildStrip(),
        h('div', { style: S.split }, leftColumn(), h('main', { style: S.detail }, rightColumn())),
        h(SettingsPanel, {
          open: settingsOpen,
          onClose: () => setSettingsOpen(false),
          settings,
          onSaved: async (next) => {
            setSettings(next)
            setSettingsOpen(false)
            await bootstrap({ refresh: true })
          },
          t,
        }),
        deleteTarget === null
          ? null
          : h(Modal, {
              title: t('dialog.deleteTitle'),
              onClose: () => setDeleteTarget(null),
              children: h(
                'div',
                { style: { fontSize: 13, lineHeight: 1.7 } },
                (deleteTarget.sha === null || deleteTarget.sha === undefined
                  ? t('dialog.deleteStagedIntro')
                  : t('dialog.deleteIntro')
                ).replace('{path}', deleteTarget.path),
              ),
              footer: [
                h(Button, { key: 'cancel', onClick: () => setDeleteTarget(null) }, t('dialog.cancel')),
                h(Button, { key: 'ok', variant: 'danger', onClick: stageDelete }, t('dialog.deleteConfirm')),
              ],
            }),
        publishOpen === true
          ? h(PublishDialog, {
              t,
              branch: settings?.branch ?? 'main',
              entries: [
                ...deletedPaths.map((path) => ({ path, action: 'delete' })),
                ...dirtyPaths.map((path) => ({ path: staged[path]?.path ?? path, action: 'upsert' })),
              ],
              state: publishState,
              onClose: () => {
                setPublishOpen(false)
                setPublishState({ phase: 'idle', error: null, commit: null, message: '' })
              },
              onConfirm: doPublish,
            })
          : null,
      )
    }

    /** The confirm-before-commit dialog: file list, commit message, result. */
    function PublishDialog({ t, branch, entries, state, onClose, onConfirm }) {
      const [message, setMessage] = useState('')
      const busy = state.phase === 'publishing'
      return h(Modal, {
        title: t('dialog.publishTitle'),
        onClose: () => (busy === true ? undefined : onClose()),
        children: h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', { style: { fontSize: 12.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' } }, t('dialog.publishIntro').replace('{branch}', branch)),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' } },
            entries.map((entry) =>
              h(
                'div',
                { key: `${entry.action}:${entry.path}`, style: { display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' } },
                h(Badge, { tone: entry.action === 'delete' ? 'error' : 'accent' }, entry.action === 'delete' ? 'D' : 'M'),
                h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.path),
              ),
            ),
          ),
          h(
            Field,
            { label: t('dialog.commitMessage'), hint: t('dialog.commitHint') },
            h('input', {
              className: 'ghb-input',
              style: S.input,
              value: message,
              onChange: (event) => setMessage(event.target.value),
              placeholder: 'blog: …',
            }),
          ),
          state.phase === 'error' ? h(ErrorBox, { message: state.error?.message ?? t('error.title'), t }) : null,
        ),
        footer: [
          h(Button, { key: 'cancel', onClick: onClose, disabled: busy }, t('dialog.cancel')),
          h(Button, { key: 'ok', variant: 'primary', onClick: () => onConfirm(message), disabled: busy }, busy === true ? t('notify.buildRunning') : t('dialog.confirm')),
        ],
      })
    }

    // =====================================================================
    // --- registration -----------------------------------------------------
    // =====================================================================

    /** The sidebar glyph: inherits the row's colour so it matches its siblings. */
    function BlogIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: edge, height: edge, fill: 'none', 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
        h('path', {
          d: 'M6.5 3.5h7l4.5 4.5v4',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M13.5 3.5V8H18', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M4 6.5h4M4 10h4.5M4 13.5h3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.55 }),
        h('path', { d: 'M6.5 17.5h7.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 17.5, cy: 18, r: 2.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M6.5 17.5v-1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Pure helpers exposed for the offline test harness. Cordis reads only
       * `inject` and `apply` from this object, so this field is inert at runtime;
       * it exists because the grouping rules are worth asserting without a DOM.
       */
      __test: { groupArticlesByTag, articleMatchesQuery, UNTAGGED, readCollapsedGroups },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'gh-blog: locale zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'gh-blog: locale en')
        const t = ctx.locale.bind(NS)

        // The page and the nav row are two registrations of one feature: the row
        // carries only the glyph, the label comes from list metadata so it
        // follows the active locale without re-registering.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PLUGIN_ID, locale: NS }, (props) => h(BlogPanel, { ...props, t })),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PLUGIN_ID, order: 31, label: () => t('nav.title'), locale: NS }, (props) =>
            h(BlogIcon, { size: props?.size }),
          ),
        )
      },
    }
  },
})
