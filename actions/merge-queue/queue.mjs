#!/usr/bin/env node
// Zero-dependency Node script implementing the merge-queue state machine.
// Commands: dequeue | check-completion | cleanup | watchdog (see action.yml).
//
// State lives in three repo Actions variables (requires a PAT -- GITHUB_TOKEN
// cannot write repo variables, see the design proposal's cost-model section
// for why a file-based alternative was rejected):
//   MERGE_QUEUE_PR         - PR number currently in flight, or unset if idle
//   MERGE_QUEUE_SHA        - head SHA we're watching checks for ("pending"
//                            between claiming a PR and update-branch settling)
//   MERGE_QUEUE_CLAIMED_AT - ISO8601 timestamp of when the PR was claimed,
//                            used only by the watchdog command
import { execFileSync } from 'node:child_process'

const REPO = requireEnv('GITHUB_REPOSITORY')
const COMMAND = requireEnv('MQ_COMMAND')
const TARGET_BRANCH = process.env.MQ_TARGET_BRANCH || ''
const MERGE_METHOD = process.env.MQ_MERGE_METHOD || 'squash'
const READY_LABEL = process.env.MQ_READY_LABEL || 'ready to merge'
const PROCESSING_LABEL = process.env.MQ_PROCESSING_LABEL || 'merge-queue: processing'
const REQUIRES_ACTION_LABEL = process.env.MQ_REQUIRES_ACTION_LABEL || 'requires action'
const TIER1_LABELS = (process.env.MQ_TIER1_LABELS || 'bug')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TIER1_TITLE_REGEX = new RegExp(process.env.MQ_TIER1_TITLE_REGEX || '^\\[HOTFIX\\]', 'i')
const TIER2_TITLE_REGEX = new RegExp(process.env.MQ_TIER2_TITLE_REGEX || '^\\[HCP-', 'i')
const STALE_AFTER_MINUTES = Number(process.env.MQ_STALE_AFTER_MINUTES || '90')
const EVENT_PR_NUMBER = process.env.MQ_EVENT_PR_NUMBER || ''
const EVENT_ACTION = process.env.MQ_EVENT_ACTION || ''
const DRY_RUN = process.env.MQ_DRY_RUN === 'true'
const UPDATE_BRANCH_POLL_ATTEMPTS = 12
const UPDATE_BRANCH_POLL_INTERVAL_MS = 5000
// Backstop for the dequeue<->evict recursion below. Bounded in the normal
// case by how many PRs are actually ready (each eviction removes one from
// candidacy), but that assumption depends on removeLabel(READY_LABEL)
// actually succeeding -- if it silently fails for a real reason, the same
// PR could get reselected and re-evicted in a tight loop. This is a hard
// ceiling independent of that, not a realistic queue-depth estimate.
const MAX_DEQUEUE_RECURSION_DEPTH = 20

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function sh(args) {
  return execFileSync(args[0], args.slice(1), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gh(args) {
  return sh(['gh', ...args])
}

function ghJson(args) {
  return JSON.parse(gh(args))
}

function ghPaginatedJson(endpoint) {
  const pages = ghJson(['api', '--paginate', '--slurp', endpoint])
  return pages.flat()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(message) {
  console.log(`[merge-queue:${COMMAND}] ${message}`)
}

function logAction(message) {
  log(DRY_RUN ? `[dry-run] would ${message}` : message)
}

// ---- state variables (require the PAT passed as GH_TOKEN) ----

function getVar(name) {
  try {
    return ghJson(['api', `repos/${REPO}/actions/variables/${name}`]).value || ''
  } catch (err) {
    const message = String(err.message || err)
    if (!/404/.test(message)) {
      // A genuinely-absent variable 404s -- that's the expected "idle" case.
      // Anything else (auth failure, rate limit, transient 5xx) getting
      // silently treated the same way as "idle" risks a double-claim if it
      // happens to coincide with another trigger. Surface it loudly instead
      // of masking it, even though we still fall back to treating it as
      // empty since there's no better recovery available here.
      log(`Warning: unexpected error reading variable ${name}, treating as unset: ${message.split('\n')[0]}`)
    }
    return ''
  }
}

function setVar(name, value) {
  logAction(`set ${name}=${value}`)
  if (DRY_RUN) return
  try {
    gh(['api', '-X', 'PATCH', `repos/${REPO}/actions/variables/${name}`, '-f', `value=${value}`])
  } catch {
    gh(['api', '-X', 'POST', `repos/${REPO}/actions/variables`, '-f', `name=${name}`, '-f', `value=${value}`])
  }
}

function deleteVar(name) {
  logAction(`delete variable ${name}`)
  if (DRY_RUN) return
  try {
    gh(['api', '-X', 'DELETE', `repos/${REPO}/actions/variables/${name}`])
  } catch {
    // already absent -- fine
  }
}

function clearQueueState() {
  deleteVar('MERGE_QUEUE_PR')
  deleteVar('MERGE_QUEUE_SHA')
  deleteVar('MERGE_QUEUE_CLAIMED_AT')
}

// ---- PR mutations ----

function addLabel(prNumber, label) {
  logAction(`add label "${label}" to PR #${prNumber}`)
  if (DRY_RUN) return
  gh(['pr', 'edit', String(prNumber), '--add-label', label])
}

function removeLabel(prNumber, label) {
  logAction(`remove label "${label}" from PR #${prNumber}`)
  if (DRY_RUN) return
  try {
    gh(['pr', 'edit', String(prNumber), '--remove-label', label])
  } catch (err) {
    // Mirrors getVar's 404-vs-other distinction. NOT independently verified
    // against a real "label already absent" case (couldn't safely force
    // this against a live PR to check the exact error text) -- best-effort
    // by analogy with the underlying REST endpoint's documented 404
    // behavior, not confirmed the way getVar's 404 handling was. The
    // recursion-depth guard in evict()/dequeue() below is the real backstop
    // regardless of whether this pattern-match is exactly right: if
    // removing READY_LABEL silently fails for a real reason, the same PR
    // could get reselected and re-evicted in a tight loop with nothing
    // bounding it otherwise.
    const message = String(err.message || err)
    if (!/404/.test(message)) {
      log(`Warning: could not remove label "${label}" from PR #${prNumber}, treating as already absent: ${message.split('\n')[0]}`)
    }
  }
}

function comment(prNumber, body) {
  logAction(`comment on PR #${prNumber}: ${body.split('\n')[0]}`)
  if (DRY_RUN) return
  gh(['pr', 'comment', String(prNumber), '--body', body])
}

function enableAutoMerge(prNumber) {
  // Enabled here rather than trusted as a precondition: a PR that's
  // ready-labeled but never actually had auto-merge turned on would sit
  // fully green and just never merge, jamming the queue until the watchdog
  // evicts an otherwise-healthy PR.
  logAction(`enable auto-merge (--${MERGE_METHOD}) on PR #${prNumber}`)
  if (DRY_RUN) return
  try {
    gh(['pr', 'merge', String(prNumber), '--auto', `--${MERGE_METHOD}`])
  } catch (err) {
    // Already enabled, or the repo/PR doesn't allow it -- log and continue;
    // check-completion/watchdog will still catch a PR that never merges.
    log(`Warning: could not enable auto-merge on PR #${prNumber}: ${String(err.message || err).split('\n')[0]}`)
  }
}

async function evict(prNumber, reason, depth = 0) {
  log(`Evicting PR #${prNumber}: ${reason}`)
  removeLabel(prNumber, READY_LABEL)
  removeLabel(prNumber, PROCESSING_LABEL)
  addLabel(prNumber, REQUIRES_ACTION_LABEL)
  comment(
    prNumber,
    `Removed from the merge queue: ${reason}\n\nFix the issue and re-add \`${READY_LABEL}\` to re-enter the queue.`,
  )
  if (getVar('MERGE_QUEUE_PR') === String(prNumber)) {
    clearQueueState()
    // Same reasoning as cleanup(): the queue is idle again, but nothing else
    // guarantees a fresh dequeue gets triggered by an eviction specifically
    // (a conflict, a failed check, or a watchdog timeout isn't a push or a
    // labeled event itself). Without this, any other ready PR would sit
    // stalled until an unrelated event happened to fire.
    await dequeue(depth + 1)
  }
}

// ---- priority classification ----

function classifyTier(pr) {
  const labelNames = (pr.labels || []).map((l) => l.name)
  if (TIER1_LABELS.some((l) => labelNames.includes(l)) || TIER1_TITLE_REGEX.test(pr.title)) return 1
  if (TIER2_TITLE_REGEX.test(pr.title)) return 2
  return 3
}

function getReadySince(prNumber, fallback) {
  const events = ghPaginatedJson(`repos/${REPO}/issues/${prNumber}/timeline?per_page=100`)
  const labelEvents = events.filter(
    (e) => e.event === 'labeled' && e.label && e.label.name === READY_LABEL,
  )
  if (labelEvents.length === 0) return fallback
  return labelEvents[labelEvents.length - 1].created_at
}

// ---- commands ----

async function dequeue(depth = 0) {
  if (depth > MAX_DEQUEUE_RECURSION_DEPTH) {
    log(
      `Reached the max recursion depth (${MAX_DEQUEUE_RECURSION_DEPTH}) of dequeue<->evict calls in a single run -- stopping here rather than risking a runaway loop. Whatever's left in the queue will be picked up by the next real trigger (push, label, or the watchdog).`,
    )
    return
  }

  const inFlight = getVar('MERGE_QUEUE_PR')
  if (inFlight) {
    log(`Already in flight: PR #${inFlight}. Nothing to do.`)
    return
  }

  const prs = ghJson([
    'pr',
    'list',
    '--state',
    'open',
    '--base',
    TARGET_BRANCH,
    '--label',
    READY_LABEL,
    '--json',
    'number,title,labels,createdAt',
  ])
  if (prs.length === 0) {
    log('Queue is empty.')
    return
  }

  const withMeta = prs.map((pr) => ({
    ...pr,
    tier: classifyTier(pr),
    readySince: getReadySince(pr.number, pr.createdAt),
  }))

  withMeta.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return new Date(a.readySince) - new Date(b.readySince)
  })

  const next = withMeta[0]
  log(`Dequeuing PR #${next.number} "${next.title}" (tier ${next.tier}, ready since ${next.readySince})`)

  // Claim BEFORE calling update-branch so a crash mid-call is visible as
  // "stuck in flight" (catchable by the watchdog) rather than invisible.
  setVar('MERGE_QUEUE_PR', String(next.number))
  setVar('MERGE_QUEUE_SHA', 'pending')
  setVar('MERGE_QUEUE_CLAIMED_AT', new Date().toISOString())
  addLabel(next.number, PROCESSING_LABEL)
  enableAutoMerge(next.number)

  const before = DRY_RUN
    ? 'dry-run-placeholder-sha'
    : ghJson(['pr', 'view', String(next.number), '--json', 'headRefOid']).headRefOid

  logAction(`call PUT /pulls/${next.number}/update-branch`)
  if (DRY_RUN) {
    setVar('MERGE_QUEUE_SHA', before)
    return
  }

  try {
    gh(['api', '-X', 'PUT', `repos/${REPO}/pulls/${next.number}/update-branch`])
  } catch (err) {
    const message = String(err.message || err)
    if (/up.to.date|not.*behind/i.test(message)) {
      // Already current with the target branch -- not a failure, proceed
      // to watch the existing head SHA.
      log(`PR #${next.number} is already up to date with ${TARGET_BRANCH}.`)
      setVar('MERGE_QUEUE_SHA', before)
      return
    }
    await evict(
      next.number,
      `Could not update with \`${TARGET_BRANCH}\`, most likely a merge conflict. Resolve the conflict manually, then re-add \`${READY_LABEL}\`.`,
      depth,
    )
    return
  }

  // update-branch is asynchronous (202 accepted) -- poll briefly for the
  // head SHA to actually change before trusting it as the SHA to watch.
  let newSha = before
  for (let attempt = 0; attempt < UPDATE_BRANCH_POLL_ATTEMPTS; attempt++) {
    await sleep(UPDATE_BRANCH_POLL_INTERVAL_MS)
    const current = ghJson(['pr', 'view', String(next.number), '--json', 'headRefOid']).headRefOid
    if (current !== before) {
      newSha = current
      break
    }
  }

  if (newSha === before) {
    log(
      `Warning: head SHA for PR #${next.number} had not changed after ${(UPDATE_BRANCH_POLL_ATTEMPTS * UPDATE_BRANCH_POLL_INTERVAL_MS) / 1000}s. Leaving it tracked at the current SHA; the watchdog will evict it if it never settles.`,
    )
  }

  setVar('MERGE_QUEUE_SHA', newSha)
  log(`Now watching PR #${next.number} at ${newSha}.`)
}

async function checkCompletion() {
  const pr = getVar('MERGE_QUEUE_PR')
  const sha = getVar('MERGE_QUEUE_SHA')
  if (!pr || !sha || sha === 'pending') {
    log('Nothing resolvable in flight. Nothing to do.')
    return
  }

  const checks = ghJson(['pr', 'checks', pr, '--required', '--json', 'name,bucket'])
  const failing = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
  if (failing.length === 0) {
    // Enabling auto-merge at claim time (in dequeue) can silently fail if
    // GitHub requires branch-protection conditions to already be met at the
    // moment it's requested -- unconfirmed whether that applies to classic
    // per-PR auto-merge, but cheap to guard against regardless. Re-verify
    // and retry here, on every check-completion run, rather than trusting
    // the single claim-time attempt.
    const autoMergeState = ghJson(['pr', 'view', pr, '--json', 'autoMergeRequest']).autoMergeRequest
    if (!autoMergeState) {
      log(`PR #${pr} has no active auto-merge request. Retrying enableAutoMerge (checks are otherwise green).`)
      enableAutoMerge(pr)
    } else {
      log(`No failing checks on PR #${pr} yet, auto-merge already active. Leaving it to native auto-merge.`)
    }
    return
  }

  const names = failing.map((c) => c.name).join(', ')
  await evict(
    pr,
    `Required check(s) failed after updating with \`${TARGET_BRANCH}\`: ${names}. This may mean the change needs adjusting for the latest \`${TARGET_BRANCH}\`, or it's an unrelated flake -- check the failing job(s) before re-adding the label.`,
  )
}

async function cleanup() {
  const pr = getVar('MERGE_QUEUE_PR')
  if (!pr || pr !== EVENT_PR_NUMBER) {
    log(`PR #${EVENT_PR_NUMBER} is not the tracked in-flight PR (tracked: ${pr || 'none'}). Nothing to do.`)
    return
  }

  log(`Clearing in-flight state for PR #${EVENT_PR_NUMBER} (event: ${EVENT_ACTION}).`)
  removeLabel(EVENT_PR_NUMBER, PROCESSING_LABEL)
  clearQueueState()
  // Not an eviction -- no requires-action label, no comment. Being closed,
  // unlabeled, or freshly pushed to isn't a failure, just no longer
  // applicable to what the queue was watching.

  // The queue is idle again now, but nothing else guarantees a fresh dequeue
  // gets triggered -- a synchronize/unlabeled/close on the in-flight PR
  // isn't a push or a labeled event itself. Without this, a still-ready PR
  // elsewhere in the queue would sit stalled until some unrelated event
  // happened to fire. Pick up the next one immediately instead.
  await dequeue()
}

async function watchdog() {
  const pr = getVar('MERGE_QUEUE_PR')
  const claimedAt = getVar('MERGE_QUEUE_CLAIMED_AT')
  if (!pr || !claimedAt) {
    // Also the self-heal path for the recursion-depth cutoff in dequeue():
    // if a pathological run evicted MAX_DEQUEUE_RECURSION_DEPTH PRs in a
    // single chain and stopped, the queue is left idle even though ready
    // PRs may still be waiting -- nothing else guarantees a push/label
    // event happens afterward. dequeue() itself is a safe no-op if the
    // queue is genuinely empty, so it's fine to just always try.
    log('Queue is idle. Trying a dequeue in case ready PRs are still waiting.')
    await dequeue()
    return
  }

  const elapsedMinutes = (Date.now() - new Date(claimedAt).getTime()) / 60000
  if (elapsedMinutes <= STALE_AFTER_MINUTES) {
    log(`PR #${pr} has been in flight for ${Math.round(elapsedMinutes)}m, under the ${STALE_AFTER_MINUTES}m threshold.`)
    return
  }

  await evict(
    pr,
    `Stuck in the merge queue for over ${STALE_AFTER_MINUTES} minutes with no resolution -- treating it as hung. If checks are just unusually slow, confirm the PR is actually healthy before re-adding \`${READY_LABEL}\`.`,
  )
}

const commands = { dequeue, 'check-completion': checkCompletion, cleanup, watchdog }
const run = commands[COMMAND]
if (!run) {
  throw new Error(`Unknown command: ${COMMAND}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
