import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

function pr(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    labels: [{ name: 'ready to merge' }],
    createdAt: `2026-01-0${number}T00:00:00Z`,
    isDraft: false,
    reviewDecision: 'APPROVED',
    author: { login: 'ada' },
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: `sha-${number}`,
    headAfterUpdate: `sha-${number}-next`,
    autoMergeRequest: { enabledBy: 'queue' },
    timeline: [
      { event: 'labeled', label: { name: 'ready to merge' }, created_at: '2026-01-02T00:00:00Z' },
    ],
    checks: [
      {
        name: 'unit',
        bucket: 'pass',
        link: 'https://github.com/howdycom/example/actions/runs/9',
      },
    ],
    runs: { 9: 'completed' },
    ...overrides,
  }
}

function run(command, scenario, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mq-'))
  const scenarioPath = join(dir, 'scenario.json')
  const logPath = join(dir, 'calls.json')
  const ghPath = join(dir, 'gh')
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  writeFileSync(logPath, '[]')
  writeFileSync(
    ghPath,
    `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(join(root, 'fake-gh.mjs'))} "$@"\n`,
  )
  chmodSync(ghPath, 0o755)
  const childEnv = {
    ...process.env,
    PATH: `${dir}:/usr/bin:/bin`,
    GITHUB_REPOSITORY: 'howdycom/example',
    GH_TOKEN: 'test-token',
    MQ_GITHUB_TOKEN: 'gha-token',
    MQ_TARGET_BRANCH: 'develop',
    MQ_COMMAND: command,
    MQ_UPDATE_BRANCH_POLL_ATTEMPTS: '1',
    MQ_UPDATE_BRANCH_POLL_INTERVAL_MS: '0',
    MQ_MERGEABLE_POLL_ATTEMPTS: '2',
    MQ_MERGEABLE_POLL_INTERVAL_MS: '0',
    GH_SCENARIO: scenarioPath,
    GH_CALL_LOG: logPath,
    ...env,
  }
  for (const [key, value] of Object.entries(childEnv)) {
    if (value == null) delete childEnv[key]
  }
  const result = spawnSync(process.execPath, [join(root, 'queue.mjs')], {
    encoding: 'utf8',
    env: childEnv,
  })
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    scenario: JSON.parse(readFileSync(scenarioPath, 'utf8')),
  }
}

function world(prs, extra = {}) {
  return { prs, ready: prs.map((item) => item.number), slurp: true, ...extra }
}

function claimed(number, json = {}) {
  return {
    stateBranch: true,
    stateFile: {
      sha: 'blob-0',
      json: {
        MERGE_QUEUE_PR: String(number),
        MERGE_QUEUE_SHA: `sha-${number}`,
        MERGE_QUEUE_CLAIMED_AT: '2020-01-01T00:00:00.000Z',
        ...json,
      },
    },
  }
}

function check(result, snippet) {
  assert.equal(
    result.status,
    0,
    `status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  if (snippet) assert.match(result.stdout, snippet)
}

test('missing repository env fails closed', () => {
  const result = run('dequeue', world([]), { GITHUB_REPOSITORY: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GITHUB_REPOSITORY/)
})

test('unknown command fails closed', () => {
  const result = run('nope', world([]))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown command: nope/)
})

test('dequeue reports an empty queue', () => {
  check(run('dequeue', world([])), /Queue is empty/)
})

test('omitted tuning env uses the production defaults', () => {
  check(
    run('dequeue', world([]), {
      MQ_TARGET_BRANCH: null,
      MQ_UPDATE_BRANCH_POLL_ATTEMPTS: null,
      MQ_UPDATE_BRANCH_POLL_INTERVAL_MS: null,
      MQ_MERGEABLE_POLL_ATTEMPTS: null,
      MQ_MERGEABLE_POLL_INTERVAL_MS: null,
      MQ_MAX_DEQUEUE_RECURSION_DEPTH: null,
    }),
    /Queue is empty/,
  )
})

test('stale yield counts for PRs no longer ready are pruned', () => {
  const result = run('dequeue', {
    ...world([pr(7)]),
    stateBranch: true,
    stateFile: { sha: 'blob-0', json: { MERGE_QUEUE_YIELD_COUNTS: '99:2' } },
  })
  check(result, /Now watching/)
  assert.equal(result.scenario.stateFile.json.MERGE_QUEUE_YIELD_COUNTS, undefined)
})

test('a yielded PR is shown in the queue order', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { isDraft: true })]),
      stateBranch: true,
      stateFile: { sha: 'blob-0', json: { MERGE_QUEUE_YIELD_COUNTS: '7:2' } },
    }),
    /#7\(t\d+,y2\)/,
  )
})

test('an in-flight PR with no labels is released', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { labels: undefined })]),
      ...claimed(7),
    }),
    /no longer has `ready to merge`/,
  )
})

test('an unset tracked SHA is logged as unset', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { headRefOid: 'sha-7' })]),
      ...claimed(7, { MERGE_QUEUE_SHA: '' }),
    }),
    /\(unset\)/,
  )
})

test('a matching failure PR with no stored count starts at one', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { updateBranch: 'fail', mergeable: 'MERGEABLE' })]),
      stateBranch: true,
      stateFile: { sha: 'blob-0', json: { MERGE_QUEUE_UPDATE_FAIL_PR: '7' } },
    }),
    /Attempt 1\/3/,
  )
})

test('update-branch failure for a different PR starts the retry count at one', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { updateBranch: 'fail', mergeable: 'MERGEABLE' })]),
      stateBranch: true,
      stateFile: {
        sha: 'blob-0',
        json: { MERGE_QUEUE_UPDATE_FAIL_PR: '99', MERGE_QUEUE_UPDATE_FAIL_COUNT: '2' },
      },
    }),
    /Attempt 1\/3/,
  )
})

test('cleanup with nothing in flight names the empty claim', () => {
  check(
    run('cleanup', world([]), { MQ_EVENT_PR_NUMBER: '4', MQ_EVENT_ACTION: 'closed' }),
    /tracked: none/,
  )
})

test('a cancelled check with no link does not invent a run id', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { checks: [{ name: 'unit', bucket: 'cancel' }] })]),
      ...claimed(7),
    }),
    /no workflow run id/,
  )
})

test('dequeue ignores the PR excluded on this pass', () => {
  const result = run('cleanup', {
    ...world([pr(4)]),
    ...claimed(4),
  }, { MQ_EVENT_PR_NUMBER: '4', MQ_EVENT_ACTION: 'closed' })
  check(result, /excluded this pass/)
})

test('dequeue claims an approved PR and watches the new head', () => {
  const result = run('dequeue', world([pr(7, { autoMergeRequest: null })]))
  check(result, /Now watching PR #7 at sha-7-next/)
  assert.equal(result.scenario.stateFile.json.MERGE_QUEUE_PR, '7')
  assert.equal(result.scenario.prs[0].autoMergeRequest.enabledBy, 'queue')
})

test('dequeue warns when update-branch does not move the head', () => {
  check(
    run('dequeue', world([pr(7, { updateBranch: 'same' })])),
    /head SHA for PR #7 had not changed/,
  )
})

test('dequeue treats an already-current branch as success', () => {
  check(
    run('dequeue', world([pr(7, { updateBranch: 'up-to-date' })])),
    /already up to date with develop/,
  )
})

test('dequeue releases the claim on the first non-conflict update failure', () => {
  const result = run('dequeue', world([pr(7, { updateBranch: 'fail', mergeableSequence: ['MERGEABLE'] })]))
  check(result, /Attempt 1\/3 before eviction/)
  assert.equal(result.scenario.stateFile.json.MERGE_QUEUE_UPDATE_FAIL_COUNT, '1')
  assert.equal(result.scenario.stateFile.json.MERGE_QUEUE_PR, undefined)
})

test('dequeue polls UNKNOWN mergeable before deciding it is not a conflict', () => {
  check(
    run('dequeue', world([pr(7, { updateBranch: 'fail', mergeableSequence: ['UNKNOWN', 'MERGEABLE'] })])),
    /not a merge conflict/,
  )
})

test('dequeue evicts a real update-branch conflict', () => {
  check(
    run('dequeue', world([pr(7, { updateBranch: 'fail', mergeableSequence: ['CONFLICTING'] })])),
    /real merge conflict/,
  )
})

test('dequeue evicts after repeated non-conflict update failures', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { updateBranch: 'fail', mergeable: 'MERGEABLE' })]),
      stateBranch: true,
      stateFile: {
        sha: 'blob-0',
        json: { MERGE_QUEUE_UPDATE_FAIL_PR: '7', MERGE_QUEUE_UPDATE_FAIL_COUNT: '2' },
      },
    }),
    /evicted/,
  )
})

test('dequeue skips a draft and claims the next approved PR', () => {
  check(
    run('dequeue', world([pr(1, { isDraft: true, createdAt: '2026-01-01T00:00:00Z' }), pr(2)])),
    /still a draft/,
  )
})

test('dequeue evicts a changes-requested PR and continues', () => {
  check(
    run('dequeue', world([
      pr(1, { reviewDecision: 'CHANGES_REQUESTED', createdAt: '2026-01-01T00:00:00Z' }),
      pr(2),
    ])),
    /reviewDecision=CHANGES_REQUESTED/,
  )
})

test('dequeue leaves the queue idle when every PR still needs review', () => {
  check(
    run('dequeue', world([pr(3, { reviewDecision: 'REVIEW_REQUIRED' })])),
    /No eligible PRs/,
  )
})

test('second timeline lookup reuses the slurp capability cache', () => {
  check(run('dequeue', world([pr(1, { isDraft: true }), pr(2, { isDraft: true })])), /still a draft/)
})

test('dequeue logs an empty focus list and empty deprioritized authors', () => {
  check(
    run('dequeue', world([pr(2)]), {
      MQ_TIER1_LABELS: ',',
      MQ_DEPRIORITIZED_AUTHORS: ',',
    }),
    /Priority labels \(first match wins\): \(none\)/,
  )
})

test('dry-run dequeue logs the actions it would take', () => {
  check(run('dequeue', world([pr(7)]), { MQ_DRY_RUN: 'true' }), /\[dry-run\] would add label/)
})

test('dry-run stops re-entry while the claim is still present', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { reviewDecision: 'CHANGES_REQUESTED' })]),
      ...claimed(7),
    }, { MQ_DRY_RUN: 'true' }),
    /stopping re-entry/,
  )
})

test('in-flight PR with no auto-merge gets it enabled again', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { autoMergeRequest: null, headRefOid: 'sha-7' })]),
      ...claimed(7),
    }),
    /no active auto-merge request/,
  )
})

test('in-flight PR refreshes a drifted SHA and stays on auto-merge', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { headRefOid: 'sha-7-live' })]),
      ...claimed(7, { MERGE_QUEUE_SHA: 'pending' }),
    }),
    /Refreshing MERGE_QUEUE_SHA/,
  )
})

test('in-flight BEHIND PR is updated again', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE' })]),
      ...claimed(7),
    }),
    /Re-running update-branch/,
  )
})

test('in-flight conflicting PR is evicted', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { mergeable: 'CONFLICTING' })]),
      ...claimed(7),
    }),
    /became CONFLICTING/,
  )
})

test('in-flight DIRTY PR is evicted', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' })]),
      ...claimed(7),
    }),
    /DIRTY/,
  )
})

test('in-flight draft is soft-requeued', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { isDraft: true })]),
      ...claimed(7),
    }),
    /converted to draft/,
  )
})

test('in-flight changes-requested PR is evicted', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { reviewDecision: 'CHANGES_REQUESTED' })]),
      ...claimed(7),
    }),
    /requested changes/,
  )
})

test('in-flight PR that lost its approval is soft-requeued', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { reviewDecision: 'REVIEW_REQUIRED' })]),
      ...claimed(7),
    }),
    /needs an approving review/,
  )
})

test('in-flight closed PR advances the queue', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { state: 'MERGED' }), pr(8)]),
      ...claimed(7),
    }),
    /is MERGED/,
  )
})

test('in-flight PR that cannot be loaded clears the claim', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { viewError: 'boom' })]),
      ...claimed(7),
    }),
    /Could not load in-flight PR #7/,
  )
})

test('in-flight PR that lost the ready label advances the queue', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { labels: [] })]),
      ...claimed(7),
    }),
    /no longer has `ready to merge`/,
  )
})

test('soft-requeue warns when the ready label cannot be put back', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { checks: [{ name: 'slow', bucket: 'pending', link: '' }] })]),
      ...claimed(7),
      labelAddFails: true,
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /OUT of the queue/,
  )
})

test('removing a label warns on a non-404 and stays quiet on 404', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { checks: [{ name: 'bad', bucket: 'fail', link: '' }] })]),
      ...claimed(7),
      removeLabelError: 'HTTP 500 nope',
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /could not remove label/,
  )
  check(
    run('watchdog', {
      ...world([pr(7, { checks: [{ name: 'bad', bucket: 'fail', link: '' }] })]),
      ...claimed(7),
      removeLabelError: 'HTTP 404 Not Found',
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /failing required check/,
  )
})

test('auto-merge failure is logged and the claim continues', () => {
  check(
    run('dequeue', world([pr(7, { autoMergeRequest: null }), ]), { }),
    /Now watching/,
  )
  check(
    run('dequeue', { ...world([pr(8, { autoMergeRequest: null })]), mergeError: 'auto-merge disabled' }),
    /could not enable auto-merge/,
  )
})

test('check-completion does nothing without a resolvable claim', () => {
  check(run('check-completion', world([])), /Nothing resolvable/)
  check(
    run('check-completion', { ...world([pr(7)]), ...claimed(7, { MERGE_QUEUE_SHA: 'pending' }) }),
    /Nothing resolvable/,
  )
})

test('check-completion advances a closed PR', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { state: 'CLOSED' })]),
      ...claimed(7),
    }),
    /is CLOSED/,
  )
})

test('check-completion cannot load the PR and leaves the claim', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { viewError: 'gone' })]),
      ...claimed(7),
    }),
    /Could not load PR #7/,
  )
})

test('check-completion soft-requeues a draft and a missing approval', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { isDraft: true })]),
      ...claimed(7),
    }),
    /converted to draft/,
  )
  check(
    run('check-completion', {
      ...world([pr(7, { reviewDecision: 'REVIEW_REQUIRED' })]),
      ...claimed(7),
    }),
    /needs an approving review/,
  )
})

test('check-completion evicts changes requested and re-syncs BEHIND', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { reviewDecision: 'CHANGES_REQUESTED' })]),
      ...claimed(7),
    }),
    /requested changes/,
  )
  check(
    run('check-completion', {
      ...world([pr(7, { mergeStateStatus: 'BEHIND' })]),
      ...claimed(7),
    }),
    /Re-syncing instead of waiting/,
  )
})

test('check-completion evicts a dirty head and follows a moved SHA', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { mergeStateStatus: 'DIRTY' })]),
      ...claimed(7),
    }),
    /CONFLICTING\/DIRTY/,
  )
  check(
    run('check-completion', {
      ...world([pr(7, { headRefOid: 'sha-7-live' })]),
      ...claimed(7, { MERGE_QUEUE_SHA: 'sha-7' }),
    }),
    /Head SHA for PR #7 moved/,
  )
})

test('check-completion waits when a cancelled check still has a sibling pending', () => {
  check(
    run('check-completion', {
      ...world([pr(7, {
        checks: [
          { name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' },
          { name: 'e2e', bucket: 'pending', link: 'https://github.com/howdycom/example/actions/runs/8' },
        ],
      })]),
      ...claimed(7),
    }),
    /still pending/,
  )
})

test('check-completion re-runs a completed cancelled workflow', () => {
  const result = run('check-completion', {
    ...world([pr(7, {
      checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9/job/3' }],
    })]),
    ...claimed(7),
  })
  check(result, /re-run cancelled workflow run 9/)
  assert.deepEqual(result.scenario.reruns, ['9'])
})

test('check-completion leaves the claim when a cancelled check has no run id', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { checks: [{ name: 'deploy-lock', bucket: 'cancel', link: 'https://example.test/status' }] })]),
      ...claimed(7),
    }),
    /no workflow run id/,
  )
})

test('check-completion ignores a cancelled run that is already restarting', () => {
  check(
    run('check-completion', {
      ...world([pr(7, {
        checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
        runs: { 9: 'in_progress' },
      })]),
      ...claimed(7),
    }),
    /already underway/,
  )
})

test('check-completion skips a run whose status cannot be read', () => {
  check(
    run('check-completion', {
      ...world([pr(7, {
        checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
        runs: { 9: 'error' },
      })]),
      ...claimed(7),
    }),
    /could not read status of run 9/,
  )
})

test('check-completion does not refresh the clock when the re-run itself fails', () => {
  const result = run('check-completion', {
    ...world([pr(7, {
      checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
    })]),
    ...claimed(7),
    rerunError: 'Resource not accessible',
  })
  check(result, /Claim clock NOT refreshed/)
  assert.equal(result.scenario.stateFile.json.MERGE_QUEUE_CLAIMED_AT, '2020-01-01T00:00:00.000Z')
})

test('check-completion evicts when cancelled re-runs are exhausted', () => {
  check(
    run('check-completion', {
      ...world([pr(7, {
        checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
      })]),
      ...claimed(7, { MERGE_QUEUE_RERUN_PR: '7', MERGE_QUEUE_RERUN_COUNT: '2' }),
    }),
    /keep ending cancelled/,
  )
})

test('a corrupted re-run counter does not disable the cap', () => {
  const result = run('check-completion', {
    ...world([pr(7, {
      checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
    })]),
    ...claimed(7, { MERGE_QUEUE_RERUN_PR: '7', MERGE_QUEUE_RERUN_COUNT: 'nope' }),
  })
  check(result, /attempt 1\/2/)
})

test('dry-run re-run still refreshes the claim clock', () => {
  check(
    run('check-completion', {
      ...world([pr(7, {
        checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
      })]),
      ...claimed(7),
    }, { MQ_DRY_RUN: 'true' }),
    /\[dry-run\] would re-run/,
  )
})

test('check-completion retries auto-merge when checks are green and records an active one', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { autoMergeRequest: null })]),
      ...claimed(7),
    }),
    /Retrying enableAutoMerge/,
  )
  check(
    run('check-completion', {
      ...world([pr(7)]),
      ...claimed(7),
    }),
    /auto-merge already active/,
  )
})

test('check-completion evicts failing checks and survives a checks API error', () => {
  check(
    run('check-completion', {
      ...world([pr(7, { checks: [{ name: 'lint', bucket: 'fail', link: '' }] })]),
      ...claimed(7),
    }),
    /Required check\(s\) failed/,
  )
  check(
    run('check-completion', {
      ...world([pr(7, { checksError: 'no checks reported' })]),
      ...claimed(7),
    }),
    /Could not read required checks/,
  )
})

test('check-completion without the default token reports the permission gap', () => {
  const result = run('check-completion', {
    ...world([pr(7)]),
    ...claimed(7),
  }, { MQ_GITHUB_TOKEN: '' })
  check(result, /Could not read required checks/)
})

test('cleanup ignores an event for a different PR and refreshes on synchronize', () => {
  check(
    run('cleanup', { ...world([pr(7)]), ...claimed(7) }, { MQ_EVENT_PR_NUMBER: '8', MQ_EVENT_ACTION: 'closed' }),
    /is not the tracked in-flight PR/,
  )
  check(
    run('cleanup', { ...world([pr(7, { headRefOid: 'sha-sync' })]), ...claimed(7) }, {
      MQ_EVENT_PR_NUMBER: '7',
      MQ_EVENT_ACTION: 'synchronize',
    }),
    /Now watching PR #7 at sha-sync/,
  )
  check(
    run('cleanup', { ...world([pr(7)]), ...claimed(7) }, {
      MQ_DRY_RUN: 'true',
      MQ_EVENT_PR_NUMBER: '7',
      MQ_EVENT_ACTION: 'synchronize',
    }),
    /refreshing watched SHA/,
  )
})

test('watchdog dequeues when idle and waits out a fresh claim', () => {
  check(run('watchdog', world([])), /Queue is idle/)
  check(
    run('watchdog', {
      ...world([pr(7)]),
      ...claimed(7, { MERGE_QUEUE_CLAIMED_AT: new Date().toISOString() }),
    }),
    /under the 90m threshold/,
  )
})

test('watchdog evicts a stale claim with failing checks', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { checks: [{ name: 'lint', bucket: 'fail', link: '' }] })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /failing required check/,
  )
})

test('watchdog soft-requeues stale pending checks and re-runs a settled cancel', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { checks: [{ name: 'e2e', bucket: 'pending', link: '' }] })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /Soft-requeueing/,
  )
  check(
    run('watchdog', {
      ...world([pr(7, {
        checks: [{ name: 'unit', bucket: 'cancel', link: 'https://github.com/howdycom/example/actions/runs/9' }],
      })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /bounded re-run/,
  )
})

test('watchdog clears a stale claim it cannot load or that is no longer open', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { viewErrorAfter: 2 })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /Evicting claim/,
  )
  check(
    run('watchdog', {
      ...world([pr(7, { state: 'MERGED' })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /is MERGED/,
  )
})

test('an unexpected label failure rejects the run', () => {
  const result = run('dequeue', { ...world([pr(7)]), labelAddFails: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /label add failed/)
})

test('watchdog advances a claim that closes after it was confirmed in flight', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { closeAfterViews: 3 })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /is CLOSED/,
  )
})

test('watchdog names a missing review decision when a stale claim has no checks', () => {
  check(
    run('watchdog', {
      ...world([pr(7, { reviewDecision: undefined, checks: [] })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /reviewDecision=none/,
  )
})

test('watchdog evicts a stale green claim and survives a checks read error', () => {
  check(
    run('watchdog', {
      ...world([pr(7)]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /no resolution/,
  )
  check(
    run('watchdog', {
      ...world([pr(7, { checksError: 'unavailable' })]),
      ...claimed(7),
    }, { MQ_STALE_AFTER_MINUTES: '0' }),
    /Could not read required checks for stale/,
  )
})

test('older gh without slurp still reads the ready-label timeline', () => {
  check(run('dequeue', { ...world([pr(7)]), slurp: false }), /Now watching/)
})

test('gh help failure falls back to explicit pagination', () => {
  check(run('dequeue', { ...world([pr(7)]), helpThrows: true, slurp: false }), /Now watching/)
})

test('dequeue stops at the recursion ceiling', () => {
  check(
    run('dequeue', {
      ...world([pr(7, { reviewDecision: 'CHANGES_REQUESTED' })]),
      ...claimed(7),
    }, { MQ_MAX_DEQUEUE_RECURSION_DEPTH: '0' }),
    /max recursion depth/,
  )
})

test('timeline with no ready label falls back to createdAt', () => {
  check(
    run('dequeue', world([pr(7, { timeline: [{ event: 'commented' }] })])),
    /ready since 2026-01-07/,
  )
})


