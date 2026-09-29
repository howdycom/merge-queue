import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendQueryParam, getQueryParam, paginate } from './pagination.ts'

test('appendQueryParam replaces an existing key and preserves the rest', () => {
  assert.equal(appendQueryParam('repos/o/r/issues?per_page=100&page=2', 'page', '3'), 'repos/o/r/issues?per_page=100&page=3')
  assert.equal(appendQueryParam('repos/o/r/issues?page=2&per_page=5', 'page', '9'), 'repos/o/r/issues?per_page=5&page=9')
  assert.equal(appendQueryParam('repos/o/r/issues', 'per_page', '100'), 'repos/o/r/issues?per_page=100')
  assert.equal(getQueryParam('repos/o/r/issues', 'per_page'), null)
  assert.equal(getQueryParam('repos/o/r/issues?per_page=a%20b', 'per_page'), 'a b')
})

test('paginate walks pages when slurp is unavailable and stops on a short page', () => {
  const seen: string[] = []
  const items = paginate('repos/o/r/timeline', {
    supportsSlurp: false,
    ghJson: (args) => {
      seen.push(args[1])
      const page = new URL(`https://example/${args[1]}`).searchParams.get('page')
      return page === '1' ? Array.from({ length: 100 }, (_, index) => index) : [{ last: true }]
    },
  }) as unknown[]
  assert.equal(items.length, 101)
  assert.equal(seen[0], 'repos/o/r/timeline?per_page=100&page=1')
})

test('paginate keeps an endpoint that already declares per_page', () => {
  const seen: string[] = []
  const items = paginate('repos/o/r/timeline?per_page=2&page=8', {
    supportsSlurp: false,
    ghJson: (args) => {
      seen.push(args[1])
      return [{ ok: true }]
    },
  })
  assert.deepEqual(items, [{ ok: true }])
  assert.equal(seen[0], 'repos/o/r/timeline?per_page=2&page=1')
})

test('paginate returns a non-array page unchanged and flattens slurped pages', () => {
  assert.deepEqual(
    paginate('repos/o/r/timeline?per_page=100', {
      supportsSlurp: false,
      ghJson: () => ({ not: 'a list' }),
    }),
    { not: 'a list' },
  )
  assert.deepEqual(
    paginate('repos/o/r/timeline?per_page=100', {
      supportsSlurp: true,
      ghJson: () => [[{ a: 1 }], [{ b: 2 }]],
    }),
    [{ a: 1 }, { b: 2 }],
  )
  assert.deepEqual(
    paginate('repos/o/r/timeline?per_page=100', {
      supportsSlurp: true,
      ghJson: () => ({ slurped: false }),
    }),
    { slurped: false },
  )
})

test('paginate exhausts the page cap when every page is full', () => {
  let pages = 0
  const items = paginate('repos/o/r/timeline?per_page=1', {
    supportsSlurp: false,
    ghJson: () => {
      pages += 1
      return ['x']
    },
  }) as unknown[]
  assert.equal(pages, 100)
  assert.equal(items.length, 100)
})
