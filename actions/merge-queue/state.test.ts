import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQueueState, STATE_BRANCH, STATE_PATH, type QueueStateDeps } from './state.ts'

function b64(obj: unknown): string {
  return Buffer.from(`${JSON.stringify(obj, null, 2)}\n`).toString('base64')
}

interface StoreOverrides {
  file?: { sha: string; content: string } | null
  issues?: unknown
  deps?: Partial<QueueStateDeps>
}

function makeStore(overrides: StoreOverrides = {}) {
  const logs: string[] = []
  const puts: Array<{ ref: string; content: string }> = []
  const refs: Record<string, boolean> = { [STATE_BRANCH]: Boolean(overrides.file) }
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
          const err = new Error('Not Found') as Error & { stderr: string }
          err.stderr = 'HTTP 404: Not Found'
          throw err
        }
        return { object: { sha: 'state-sha' } }
      }
      if (String(path).startsWith(`repos/howdycom/astro-market/contents/${STATE_PATH}`)) {
        if (!file) {
          const err = new Error('Not Found') as Error & { stderr: string }
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
      const payload = body as { ref: string; content: string }
      if (method === 'POST' && endpoint.endsWith('/git/refs')) {
        refs[STATE_BRANCH] = true
        return JSON.stringify({ ref: payload.ref })
      }
      if (method === 'PUT' && endpoint.endsWith(STATE_PATH)) {
        puts.push(payload)
        file = {
          sha: `blob-${puts.length}`,
          content: payload.content,
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
  const written = JSON.parse(Buffer.from(puts.at(-1)?.content ?? '', 'base64').toString('utf8'))
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

test('ensureBranch rethrows a non-404 ref error', () => {
  const broken = makeStore({
    deps: {
      ghJson: () => {
        const err = new Error('denied') as Error & { stderr: string }
        err.stderr = 'HTTP 500'
        throw err
      },
    },
  })
  assert.throws(() => broken.store.setVar('MERGE_QUEUE_PR', '1'), /denied/)
})

test('migration covers an empty label, several processing PRs, a missing sha, and a lookup failure', () => {
  const unlabeled = makeStore({ deps: { processingLabel: '' } })
  assert.equal(unlabeled.store.getVar('MERGE_QUEUE_PR'), '')

  const several = makeStore({
    issues: [
      { number: 1, pull_request: {} },
      { number: 2, pull_request: {} },
    ],
  })
  assert.equal(several.store.getVar('MERGE_QUEUE_PR'), '')

  const notArray = makeStore({ issues: { message: 'nope' } })
  assert.equal(notArray.store.getVar('MERGE_QUEUE_PR'), '')

  const noSha = makeStore({
    issues: [{ number: 5, pull_request: {} }],
    deps: {
      ghJson: (args) => {
        const path = String(args.at(-1))
        if (args[0] === 'pr') return {}
        if (path.includes('/issues?')) return [{ number: 5, pull_request: {} }]
        if (path === 'repos/howdycom/astro-market') return { default_branch: 'main' }
        if (path.endsWith('/git/ref/heads/main')) return { object: { sha: 'default-sha' } }
        const err = new Error('Not Found') as Error & { stderr: string }
        err.stderr = 'HTTP 404: Not Found'
        throw err
      },
      ghApiJson: (method) => {
        if (method === 'POST') return JSON.stringify({ ref: 'refs/heads/merge-queue-state' })
        if (method === 'PUT') return JSON.stringify({ content: { sha: 'migrated' } })
        throw new Error(method)
      },
    },
  })
  assert.equal(noSha.store.getVar('MERGE_QUEUE_SHA'), '')

  const failed = makeStore({
    deps: {
      ghJson: () => {
        throw new Error('timeline down')
      },
    },
  })
  assert.equal(failed.store.getVar('MERGE_QUEUE_PR'), '')
  assert.match(failed.logs.join('\n'), /could not migrate/)
})

test('load replaces invalid JSON, warns on unexpected read errors, and ignores a missing content body', () => {
  const arrayFile = makeStore({
    file: { sha: 's', content: Buffer.from('[]').toString('base64') },
  })
  assert.equal(arrayFile.store.getVar('MERGE_QUEUE_PR'), '')

  const warned = makeStore({
    deps: {
      ghJson: () => {
        throw new Error('HTTP 500 boom')
      },
    },
  })
  assert.equal(warned.store.getVar('MERGE_QUEUE_PR'), '')
  assert.match(warned.logs.join('\n'), /unexpected error reading/)

  const emptyBody = makeStore({
    file: { sha: 's', content: '' },
  })
  assert.equal(emptyBody.store.getVar('MERGE_QUEUE_PR'), '')
})

test('flush retries a 409, keeps a missing content sha, and rethrows other write errors', () => {
  let conflicted = false
  const retry = makeStore({
    file: { sha: 'existing', content: b64({ MERGE_QUEUE_PR: '1' }) },
    deps: {
      ghApiJson: (method, endpoint, body) => {
        if (method === 'PUT' && !conflicted) {
          conflicted = true
          const err = new Error('409 sha') as Error & { stderr: string }
          err.stderr = '409 sha mismatch'
          throw err
        }
        if (method === 'PUT') return JSON.stringify({ content: { sha: 'after-retry' } })
        throw new Error(`unexpected ${method} ${endpoint} ${JSON.stringify(body)}`)
      },
    },
  })
  retry.store.setVar('MERGE_QUEUE_SHA', 'next')
  assert.equal(retry.store.getVar('MERGE_QUEUE_SHA'), 'next')

  const noSha = makeStore({
    deps: {
      ghApiJson: (method) => {
        if (method === 'POST') return JSON.stringify({ ref: 'refs/heads/merge-queue-state' })
        if (method === 'PUT') return JSON.stringify({})
        throw new Error(method)
      },
    },
  })
  noSha.store.setVar('MERGE_QUEUE_PR', '3')
  assert.equal(noSha.store.getVar('MERGE_QUEUE_PR'), '3')

  const denied = makeStore({
    file: { sha: 'existing', content: b64({ MERGE_QUEUE_PR: '1' }) },
    deps: {
      ghApiJson: (method) => {
        if (method === 'POST') return JSON.stringify({ ref: 'ok' })
        const err = new Error('nope') as Error & { stderr: string }
        err.stderr = 'HTTP 500'
        throw err
      },
    },
  })
  assert.throws(() => denied.store.setVar('MERGE_QUEUE_SHA', '4'), /nope/)
})

test('deleteVar on a missing key and a falsy stored value stay quiet', () => {
  const { store, puts } = makeStore({
    file: { sha: 's', content: b64({ MERGE_QUEUE_PR: '' }) },
  })
  assert.equal(store.getVar('MERGE_QUEUE_PR'), '')
  store.deleteVar('MERGE_QUEUE_SHA')
  assert.equal(puts.length, 0)
})

test('missing files are recognized from message text and from a thrown string', () => {
  const fromMessage = makeStore({
    deps: {
      ghJson: (args) => {
        const path = String(args.at(-1))
        if (path.includes('/contents/')) throw new Error('HTTP 404: Not Found')
        if (path.includes('/issues?')) return []
        if (path.endsWith('/git/ref/heads/merge-queue-state')) throw new Error('Not Found')
        if (path === 'repos/howdycom/astro-market') return { default_branch: 'main' }
        if (path.endsWith('/heads/main')) return { object: { sha: 'default-sha' } }
        throw new Error(`unexpected ${path}`)
      },
      ghApiJson: (method) => {
        if (method === 'POST') return JSON.stringify({ ref: 'ok' })
        if (method === 'PUT') {
          const err = new Error('conflict') as Error & { stderr: string }
          err.stderr = 'sha mismatch'
          throw err
        }
        throw new Error(method)
      },
    },
  })
  assert.throws(() => fromMessage.store.setVar('MERGE_QUEUE_PR', '8'), /conflict/)

  const fromString = makeStore({
    deps: {
      ghJson: () => {
        throw 'Not Found'
      },
    },
  })
  assert.equal(fromString.store.getVar('MERGE_QUEUE_PR'), '')
  assert.match(fromString.logs.join('\n'), /could not migrate/)
})

test('a 409 retry with no latest file omits the blob sha', () => {
  let puts = 0
  const store = makeStore({
    file: { sha: 'existing', content: b64({ MERGE_QUEUE_PR: '1' }) },
    deps: {
      ghJson: (args) => {
        const path = String(args.at(-1))
        if (path.includes('/contents/')) {
          const err = new Error('Not Found') as Error & { stderr: string }
          err.stderr = 'HTTP 404: Not Found'
          throw err
        }
        if (path.endsWith('/git/ref/heads/merge-queue-state')) return { object: { sha: 'state' } }
        throw new Error(path)
      },
      ghApiJson: (method, _endpoint, body) => {
        if (method !== 'PUT') throw new Error(method)
        puts += 1
        if (puts === 1) {
          const err = new Error('conflict')
          err.message = '409 sha'
          throw err
        }
        const payload = body as { sha?: string }
        assert.equal(payload.sha, undefined)
        return JSON.stringify({})
      },
    },
  })
  store.store.setVar('MERGE_QUEUE_SHA', 'next')
  assert.equal(store.store.getVar('MERGE_QUEUE_SHA'), 'next')
})

test('state branch and path constants are the documented names', () => {
  assert.equal(STATE_BRANCH, 'merge-queue-state')
  assert.equal(STATE_PATH, 'state.json')
})
