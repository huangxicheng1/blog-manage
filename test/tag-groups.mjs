/**
 * Left-column behaviour: tag grouping, multi-tag membership, the untagged
 * bucket, remaining-tag text and the search fields.
 *
 * The rules live in `client.js` because the Client loader serves exactly one
 * browser artifact per plugin, so this harness evaluates that module with a stub
 * loader and a stub React in order to reach the documented `__test` helpers. It
 * never renders a component and never touches a DOM: it asserts data
 * transformations only.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

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

// ---------------------------------------------------------------------
// Evaluate client.js in a sandbox that only provides what module scope needs.
// ---------------------------------------------------------------------

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, 'dsh-hxc-blog')
        captured = definition
      },
    },
    localStorage: {
      getItem() {
        return null
      },
      setItem() {},
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout() {
      return 0
    },
    clearTimeout() {},
  },
  document: { addEventListener() {}, removeEventListener() {} },
  fetch: async () => {
    throw new Error('the test harness never performs a request')
  },
  console,
}
sandbox.globalThis = sandbox
createContext(sandbox)

// Only identifiers are read off React at factory time; no hook ever runs here.
const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: () => undefined,
  useCallback: () => () => {},
  useRef: () => ({ current: null }),
}
sandbox.require = (id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require(${id})`)
}

runInContext(source, sandbox)
assert.ok(captured !== null, 'client.js must register itself with the module loader')

const plugin = captured.factory(sandbox.require)
const { groupArticlesByTag, articleMatchesQuery, UNTAGGED } = plugin.__test

/**
 * The helpers run in the sandbox realm, so their arrays are not the test realm's
 * arrays. Copy across the boundary before comparing.
 */
const tagNames = (groups) => [...groups].map((group) => group.tag)
const othersOf = (group) => [...group.items[0].others]
const sortedNames = (groups) => tagNames(groups).sort()

// ---------------------------------------------------------------------

const ARTICLE = (path, tags, extra = {}) => ({
  path,
  id: path.replace(/^content\//, '').replace(/\.md$/, ''),
  title: extra.title ?? path,
  date: extra.date ?? '2026-10-20',
  tags,
  category: extra.category ?? '',
  summary: extra.summary ?? '',
  draft: false,
  ok: true,
})

test('shim: the module still exposes inject and apply for Cordis', () => {
  assert.equal([...plugin.inject].join(','), 'slots,locale')
  assert.equal(typeof plugin.apply, 'function')
})

test('groups: one group per tag, carrying its own article count', () => {
  const groups = groupArticlesByTag([
    ARTICLE('content/notes/a.md', ['DSH', '插件']),
    ARTICLE('content/notes/b.md', ['DSH']),
    ARTICLE('content/notes/c.md', ['复盘']),
  ])
  const named = Object.fromEntries(groups.map((group) => [group.tag, group.items.length]))
  assert.equal(named.DSH, 2)
  assert.equal(named['插件'], 1)
  assert.equal(named['复盘'], 1)
})

test('groups: an article with several tags appears in every one of its groups', () => {
  const groups = groupArticlesByTag([ARTICLE('content/notes/multi.md', ['DSH', '插件', '复盘'])])
  assert.equal(sortedNames(groups).join('|'), ['DSH', '复盘', '插件'].sort().join('|'))
  for (const group of groups) assert.equal(group.items.length, 1)
})

test('groups: each occurrence carries the remaining tags, not all of them', () => {
  const groups = groupArticlesByTag([ARTICLE('content/notes/multi.md', ['DSH', '插件'])])
  const dsh = groups.find((group) => group.tag === 'DSH')
  const plugin = groups.find((group) => group.tag === '插件')
  assert.deepEqual(othersOf(dsh), ['插件'])
  assert.deepEqual(othersOf(plugin), ['DSH'])
})

test('groups: an untagged article goes to the dedicated last group, not nowhere', () => {
  const groups = groupArticlesByTag([
    ARTICLE('content/notes/tagged.md', ['DSH']),
    ARTICLE('content/diary/untagged.md', []),
  ])
  const last = groups[groups.length - 1]
  assert.equal(last.tag, UNTAGGED)
  assert.equal(last.items.length, 1)
  assert.equal(last.items[0].article.path, 'content/diary/untagged.md')
  assert.deepEqual(othersOf(last), [])
})

test('groups: an empty or blank tag is treated as untagged', () => {
  const groups = groupArticlesByTag([
    ARTICLE('content/notes/x.md', []),
    ARTICLE('content/notes/y.md', ['', '   ']),
    ARTICLE('content/notes/z.md', undefined),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].tag, UNTAGGED)
  assert.equal(groups[0].items.length, 3)
})

test('groups: duplicate tags on one article do not double-file it', () => {
  const groups = groupArticlesByTag([ARTICLE('content/notes/dup.md', ['DSH', 'DSH ', 'DSH'])])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].tag, 'DSH')
  assert.equal(groups[0].items.length, 1)
})

test('groups: the busiest tag comes first and untagged stays last', () => {
  const groups = groupArticlesByTag([
    ARTICLE('content/notes/1.md', ['rare']),
    ARTICLE('content/notes/2.md', ['busy', 'rare']),
    ARTICLE('content/notes/3.md', ['busy']),
    ARTICLE('content/notes/4.md', ['busy']),
    ARTICLE('content/notes/5.md', []),
  ])
  assert.equal(groups[0].tag, 'busy')
  assert.equal(groups[0].items.length, 3)
  assert.equal(groups[1].tag, 'rare')
  assert.equal(groups[groups.length - 1].tag, UNTAGGED)
})

test('groups: equally sized tags keep first-seen order (deterministic everywhere)', () => {
  const groups = groupArticlesByTag([
    ARTICLE('content/notes/1.md', ['alpha', 'beta']),
    ARTICLE('content/notes/2.md', ['alpha', 'beta']),
  ])
  assert.equal(tagNames(groups).join('|'), 'alpha|beta')
})

test('groups: an empty list yields no groups (the panel shows its empty state)', () => {
  assert.equal([...groupArticlesByTag([])].length, 0)
  assert.equal([...groupArticlesByTag(undefined)].length, 0)
})

test('search: title, tag and file name all match', () => {
  const article = ARTICLE('content/notes/2026-10-20-order-timeout-auto-cancel.md', ['Java 八股文'], {
    title: '订单超时自动取消',
    summary: '从 15 分钟未支付到百亿级',
    category: '后端场景题',
  })
  assert.equal(articleMatchesQuery(article, '订单'), true, 'title')
  assert.equal(articleMatchesQuery(article, '八股文'), true, 'tag')
  assert.equal(articleMatchesQuery(article, 'order-timeout'), true, 'file name')
  assert.equal(articleMatchesQuery(article, '后端场景题'), true, 'category')
  assert.equal(articleMatchesQuery(article, 'dsH'.toLowerCase()), false, 'case-insensitive needle only')
  assert.equal(articleMatchesQuery(article, '不存在的词'), false)
})

test('search: an empty needle keeps everything', () => {
  assert.equal(articleMatchesQuery(ARTICLE('content/notes/a.md', []), ''), true)
})

test('search: grouping runs on the filtered set, so a query narrows the groups', () => {
  const articles = [
    ARTICLE('content/notes/a.md', ['DSH', '插件']),
    ARTICLE('content/notes/b.md', ['复盘']),
  ]
  const visible = articles.filter((article) => articleMatchesQuery(article, 'dsh'))
  const groups = groupArticlesByTag(visible)
  assert.equal(tagNames(groups).join('|'), 'DSH|插件')
})

// ---------------------------------------------------------------------
// Fold memory: the read side of "记忆折叠状态".
// ---------------------------------------------------------------------

const withStoredValue = (raw, fn) => {
  const previous = sandbox.window.localStorage
  sandbox.window.localStorage = {
    getItem: () => raw,
    setItem: () => {},
  }
  try {
    return fn(plugin.__test.readCollapsedGroups)
  } finally {
    sandbox.window.localStorage = previous
  }
}

test('fold memory: a stored list is read back as a set of folded tags', () => {
  const state = withStoredValue('["DSH","复盘"]', (read) => read())
  assert.deepEqual(Object.keys(state).sort(), ['DSH', '复盘'])
  assert.equal(state.DSH, true)
})

test('fold memory: nothing stored means everything is open', () => {
  assert.equal(Object.keys(withStoredValue(null, (read) => read())).length, 0)
})

test('fold memory: corrupt or foreign values degrade to "all open", never throw', () => {
  for (const raw of ['{not json', '{"a":1}', 'null', '["ok",3,null]']) {
    const state = withStoredValue(raw, (read) => read())
    assert.equal(typeof state, 'object')
    for (const value of Object.values(state)) assert.equal(value, true)
  }
  const mixed = withStoredValue('["ok",3,null]', (read) => read())
  assert.deepEqual(Object.keys(mixed), ['ok'])
})

test('fold memory: a storage that throws degrades to "all open"', () => {
  const previous = sandbox.window.localStorage
  sandbox.window.localStorage = {
    getItem() {
      throw new Error('SecurityError: storage disabled')
    },
    setItem() {},
  }
  try {
    assert.equal(Object.keys(plugin.__test.readCollapsedGroups()).length, 0)
  } finally {
    sandbox.window.localStorage = previous
  }
})

// ---------------------------------------------------------------------

for (const failure of failures) {
  console.error(`\nFAIL  ${failure.name}`)
  console.error(failure.error?.stack ?? failure.error)
}
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
