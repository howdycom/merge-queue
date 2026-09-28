import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQueueState, STATE_BRANCH, STATE_PATH } from './state.mjs'

function b64(obj) {
  return Buffer.from(`${JSON.stringify(obj, null, 2)}\n`).toString('base64')
}

function makeStore(overrides = {}) {
  const logs = []
  const puts = []
  const refs = { [STATE_BRANCH]: Boolean(overrides.file) }
  let file = overrides.file ?? null
  const store = createQueueState({
    repo: 'howdycom/astro-market',
    processingLabel: 'merge-queue: processing',
    dryRun: false,
    log: (message) => logs.push(`log:${message}`),
    logAction: (message) => logs.push(`action:${message}`),
    ghJson: (args) => {
      const path = args[args.length - 1]
      if (path === 'repos/howdycom/astro-market') return { default_branch: 'main' }
      if (path === 'repos/howdycom/astro-market/git/ref/heads/main') {
        return { object: { sha: 'default-sha' } }
      }
      if (path === `repos/howdycom/astro-market/git/ref/heads/${STATE_BRANCH}`) {
        if (!refs[STATE_BRANCH]) {
          const err = new Error('Not Found')
          err.stderr = 'HTTP 404: Not Found'
          throw err
        }
        return { object: { sha: 'state-sha' } }
      }
      if (String(path).startsWith(`repos/howdycom/astro-market/contents/${STATE_PATH}`)) {
        if (!file) {
          const err = new Error('Not Found')
          err.stderr = 'HTTP 404: Not Found'
          throw err
        }
        return file
      }
      if (args[0] === 'pr') {
        return { headRefOid: 'abc123' }
      }
      if (String(path).includes('/issues?')) {
        return overrides.issues ?? []
      }
      throw new Error(`unexpected ghJson ${args.join(' ')}`)
    },
    ghApiJson: (method, endpoint, body) => {
      if (method === 'POST' && endpoint.endsWith('/git/refs')) {
        refs[STATE_BRANCH] = true
        return JSON.stringify({ ref: body.ref })
      }
      if (method === 'PUT' && endpoint.endsWith(STATE_PATH)) {
        puts.push(body)
        file = {
          sha: `blob-${puts.length}`,
          content: body.content,
        }
        refs[STATE_BRANCH] = true
        return JSON.stringify({ content: { sha: file.sha } })
      }
      throw new Error(`unexpected ghApiJson ${method} ${endpoint}`)
    },
    ...overrides.deps,
  })
  return { store, logs, puts, refs, getFile: () => file }
}

test('getVar returns empty when no state file and no processing PR', () => {
  const { store } = makeStore()
  assert.equal(store.getVar('MERGE_QUEUE_PR'), '')
})

test('getVar migrates a single processing-label PR into JSON state', () => {
  const { store, puts } = makeStore({
    issues: [{ number: 42, pull_request: { url: 'https://example' } }],
  })
  assert.equal(store.getVar('MERGE_QUEUE_PR'), '42')
  assert.equal(store.getVar('MERGE_QUEUE_SHA'), 'abc123')
  assert.equal(puts.length, 1)
  const written = JSON.parse(Buffer.from(puts[0].content, 'base64').toString('utf8'))
  assert.equal(written.MERGE_QUEUE_PR, '42')
})

test('setVar writes JSON on the state branch', () => {
  const { store, puts } = makeStore()
  store.setVar('MERGE_QUEUE_PR', '99')
  store.setVar('MERGE_QUEUE_SHA', 'def')
  assert.equal(store.getVar('MERGE_QUEUE_PR'), '99')
  assert.ok(puts.length >= 2)
  const written = JSON.parse(Buffer.from(puts.at(-1).content, 'base64').toString('utf8'))
  assert.equal(written.MERGE_QUEUE_PR, '99')
  assert.equal(written.MERGE_QUEUE_SHA, 'def')
})

test('deleteVar and clearQueueState drop claim keys and keep other keys', () => {
  const { store } = makeStore({
    file: {
      sha: 'existing',
      content: b64({
        MERGE_QUEUE_PR: '7',
        MERGE_QUEUE_SHA: 'aaa',
        MERGE_QUEUE_CLAIMED_AT: '2026-01-01T00:00:00.000Z',
        MERGE_QUEUE_YIELD_COUNTS: '7:1',
      }),
    },
  })
  store.clearQueueState()
  assert.equal(store.getVar('MERGE_QUEUE_PR'), '')
  assert.equal(store.getVar('MERGE_QUEUE_YIELD_COUNTS'), '7:1')
})

test('dry-run setVar does not write', () => {
  const { store, puts } = makeStore({
    deps: { dryRun: true },
  })
  store.setVar('MERGE_QUEUE_PR', '1')
  assert.equal(puts.length, 0)
  assert.equal(store.getVar('MERGE_QUEUE_PR'), '1')
})
