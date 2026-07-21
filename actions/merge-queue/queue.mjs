#!/usr/bin/env node
// Zero-dependency Node script implementing the merge-queue state machine.
// Commands: dequeue | check-completion | cleanup | watchdog (see action.yml).
//
// State lives in repo Actions variables (requires a PAT -- GITHUB_TOKEN
// cannot write repo variables, see the design proposal's cost-model section
// for why a file-based alternative was rejected):
//   MERGE_QUEUE_PR              - PR number currently in flight, or unset if idle
//   MERGE_QUEUE_SHA             - head SHA we're watching checks for ("pending"
//                                 between claiming a PR and update-branch settling)
//   MERGE_QUEUE_CLAIMED_AT      - ISO8601 timestamp of when the PR was claimed
//                                 (or last successfully re-synced), used by watchdog
//   MERGE_QUEUE_UPDATE_FAIL_PR/
//   MERGE_QUEUE_UPDATE_FAIL_COUNT - consecutive non-conflict update-branch
//                                 failures for a specific PR, used only to
//                                 evict after MAX_UPDATE_BRANCH_RETRIES
//                                 instead of retrying the same PR forever
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
// Short poll for GitHub's mergeable computation to settle out of UNKNOWN
// after a failed update-branch call, before trusting it to decide whether
// a failure was a real conflict. Much shorter than the SHA-settle poll
// above -- this is normally quick, and it's already inside a failure path.
const MERGEABLE_POLL_ATTEMPTS = 5
const MERGEABLE_POLL_INTERVAL_MS = 3000
// Backstop for the dequeue<->evict recursion below. Bounded in the normal
// case by how many PRs are actually ready (each eviction removes one from
// candidacy), but that assumption depends on removeLabel(READY_LABEL)
// actually succeeding -- if it silently fails for a real reason, the same
// PR could get reselected and re-evicted in a tight loop. This is a hard
// ceiling independent of that, not a realistic queue-depth estimate.
const MAX_DEQUEUE_RECURSION_DEPTH = 20
// How many consecutive non-conflict update-branch failures the *same* PR
// gets before it's evicted instead of released for another retry. Without
// this, a permanent-but-not-a-conflict failure (a fork PR this token can't
// update, a branch protection quirk, etc.) reselects the same PR forever --
// dequeue() always sorts to the same tier/readySince-oldest candidate, so
// nothing behind it in the queue is ever reached, even though a transient
// or system-wide failure (a token permission gap, say) deserves a retry
// rather than an immediate eviction. See MERGE_QUEUE_UPDATE_FAIL_PR /
// MERGE_QUEUE_UPDATE_FAIL_COUNT below.
const MAX_UPDATE_BRANCH_RETRIES = 3
// Regex matching the two phrasings GitHub returns when update-branch is a
// no-op because the head is already current with the base.
const ALREADY_UP_TO_DATE_RE = /up.to.date|not.*behind|no new commits on the base branch/i

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function sh(args, envOverride) {
  const env = envOverride ? { ...process.env, ...envOverride } : process.env
  return execFileSync(args[0], args.slice(1), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
}

function gh(args) {
  return sh(['gh', ...args])
}

function ghJson(args) {
  return JSON.parse(gh(args))
}

// Fine-grained PATs can't read check-run results (as opposed to legacy
// commit statuses) created by other Apps via GraphQL, no matter what
// repository permission is granted -- confirmed the hard way when
// check-completion's `gh pr checks --required` call failed on every
// required check except the one plain commit status (deploy-lock), even
// after adding Commit statuses: read. The default GITHUB_TOKEN has
// checks: read for its own repo/run out of the box, so this one read-only
// query uses that instead -- everything else (labels, variables,
// update-branch) still goes through the PAT, which is why MQ_GITHUB_TOKEN
// is a distinct, narrower credential rather than a blanket swap.
function ghAsDefaultToken(args) {
  if (!process.env.MQ_GITHUB_TOKEN) {
    throw new Error(
      'MQ_GITHUB_TOKEN is not set -- the calling job needs `permissions: checks: read` for this to work (see check-completion).',
    )
  }
  return sh(['gh', ...args], { GH_TOKEN: process.env.MQ_GITHUB_TOKEN })
}

function ghJsonAsDefaultToken(args) {
  return JSON.parse(ghAsDefaultToken(args))
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

function viewPr(prNumber) {
  return ghJson([
    'pr',
    'view',
    String(prNumber),
    '--json',
    'state,mergeable,mergeStateStatus,headRefOid,labels,autoMergeRequest,title',
  ])
}

async function resolveMergeable(prNumber, initialMergeable) {
  let mergeable = initialMergeable
  for (let attempt = 0; mergeable === 'UNKNOWN' && attempt < MERGEABLE_POLL_ATTEMPTS; attempt++) {
    await sleep(MERGEABLE_POLL_INTERVAL_MS)
    mergeable = ghJson(['pr', 'view', String(prNumber), '--json', 'mergeable']).mergeable
  }
  return mergeable
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

// ---- shared claim / update-branch path ----

/**
 * Call update-branch on an already-claimed PR, settle the head SHA, and
 * write MERGE_QUEUE_SHA. Returns:
 *   'watching'  - successfully tracking a head SHA (including already-up-to-date)
 *   'evicted'   - conflict or retry-cap eviction advanced the queue
 *   'released'  - non-conflict failure released the claim for a later retry
 */
async function updateBranchAndWatch(prNumber, depth = 0) {
  enableAutoMerge(prNumber)

  const before = DRY_RUN
    ? 'dry-run-placeholder-sha'
    : ghJson(['pr', 'view', String(prNumber), '--json', 'headRefOid']).headRefOid

  logAction(`call PUT /pulls/${prNumber}/update-branch`)
  if (DRY_RUN) {
    setVar('MERGE_QUEUE_SHA', before)
    return 'watching'
  }

  try {
    gh(['api', '-X', 'PUT', `repos/${REPO}/pulls/${prNumber}/update-branch`])
  } catch (err) {
    const message = String(err.stderr || err.message || err)
    log(`update-branch failed for PR #${prNumber}: ${message}`)
    if (ALREADY_UP_TO_DATE_RE.test(message)) {
      // Already current with the target branch -- not a failure, proceed
      // to watch the existing head SHA. "no new commits on the base
      // branch" is the exact phrasing `gh api -X PUT .../update-branch`
      // actually returns for this case (HTTP 422) -- confirmed in
      // production, where the original narrower regex missed it and
      // treated an already-current, perfectly healthy PR as a failure,
      // incrementing its retry counter toward eviction for no real reason.
      log(`PR #${prNumber} is already up to date with ${TARGET_BRANCH}.`)
      deleteVar('MERGE_QUEUE_UPDATE_FAIL_PR')
      deleteVar('MERGE_QUEUE_UPDATE_FAIL_COUNT')
      setVar('MERGE_QUEUE_SHA', before)
      return 'watching'
    }

    // Don't assume "merge conflict" from the error alone -- ask GitHub's
    // own mergeable state, which is authoritative. A prior version of this
    // code guessed "most likely a merge conflict" for *any* update-branch
    // error and evicted on that assumption; in production this mislabeled
    // several genuinely conflict-free, approved PRs (GitHub reported them
    // as MERGEABLE) as needing manual conflict resolution, when the real
    // cause was an unrelated token/permission problem on our side.
    // mergeable can be UNKNOWN right after a push while GitHub is still
    // computing it (see the mergeableState enum docs) -- poll briefly
    // rather than treat a not-yet-computed result as "not a conflict",
    // which would misdiagnose a real conflict that just hasn't resolved
    // yet with the misleading "not a merge conflict" retry message.
    let mergeable = ghJson(['pr', 'view', String(prNumber), '--json', 'mergeable']).mergeable
    mergeable = await resolveMergeable(prNumber, mergeable)
    if (mergeable === 'CONFLICTING') {
      await evict(
        prNumber,
        `Could not update with \`${TARGET_BRANCH}\`: real merge conflict (GitHub reports this PR as CONFLICTING). Resolve the conflict manually, then re-add \`${READY_LABEL}\`.`,
        depth,
      )
      return 'evicted'
    }

    // Not a real conflict -- most likely transient (or a merge-queue-token
    // permission problem), not something the PR author can fix. Don't evict
    // a healthy PR for an infra-side failure on the first attempt: release
    // the claim (instead of leaving MERGE_QUEUE_PR set and MERGE_QUEUE_SHA
    // stuck at 'pending') so the queue isn't blocked until the watchdog's
    // stale-timeout fires -- dequeue() no-ops whenever a PR is already
    // claimed, and check-completion can never match a 'pending' SHA against
    // a real workflow_run, so without this the *entire* queue would sit
    // frozen for up to stale_after_minutes even after the problem is fixed.
    //
    // But if the *same* PR keeps failing this way, it's not a one-off
    // transient blip -- dequeue() always re-sorts to the same tier/
    // readySince-oldest candidate, so an unlucky PR with a permanent,
    // PR-specific reason for failing (a fork branch this token can't
    // update, some other per-PR quirk) would get reselected and fail again
    // on every subsequent trigger forever, starving everything behind it in
    // the queue. Track consecutive failures per PR and evict once that
    // exceeds MAX_UPDATE_BRANCH_RETRIES, rather than retrying indefinitely.
    const lastFailedPr = getVar('MERGE_QUEUE_UPDATE_FAIL_PR')
    const priorAttempts = lastFailedPr === String(prNumber) ? Number(getVar('MERGE_QUEUE_UPDATE_FAIL_COUNT') || '0') : 0
    const attempts = priorAttempts + 1

    if (attempts >= MAX_UPDATE_BRANCH_RETRIES) {
      // Let evict() clear the queue state itself, rather than doing it here
      // first -- evict()'s own dequeue(depth + 1) chaining (which advances
      // the queue to the next ready PR, the same as every other eviction
      // path) is gated on MERGE_QUEUE_PR still matching this PR number.
      // Clearing it beforehand would make that guard false and silently
      // leave the queue idle until an unrelated trigger fired, exactly the
      // stuck-queue failure mode this whole fix exists to avoid.
      deleteVar('MERGE_QUEUE_UPDATE_FAIL_PR')
      deleteVar('MERGE_QUEUE_UPDATE_FAIL_COUNT')
      await evict(
        prNumber,
        `Could not update with \`${TARGET_BRANCH}\` after ${attempts} attempts, and GitHub does not report this as a merge conflict (mergeable=${mergeable}). This looks like a PR-specific or persistent problem rather than a one-off transient failure -- check the workflow run logs, fix the underlying issue, then re-add \`${READY_LABEL}\`.`,
        depth,
      )
      // Eviction (and the chained next dequeue) already ran -- do not fail
      // the Actions run. A red X here previously made successful queue
      // advances look like broken automation.
      log(
        `update-branch failed for PR #${prNumber} ${attempts} times in a row (not a merge conflict) -- evicted. Raw error: ${message.split('\n')[0]}`,
      )
      return 'evicted'
    }

    removeLabel(prNumber, PROCESSING_LABEL)
    clearQueueState()
    setVar('MERGE_QUEUE_UPDATE_FAIL_PR', String(prNumber))
    setVar('MERGE_QUEUE_UPDATE_FAIL_COUNT', String(attempts))
    // Soft-fail: claim released so a later trigger can retry. Exit 0 so the
    // Actions run is green -- the retry bookkeeping is the real signal, and
    // a red run here previously drowned out real failures in the Actions tab.
    log(
      `update-branch failed for PR #${prNumber} but GitHub reports mergeable=${mergeable} (not CONFLICTING) -- this is not a merge conflict. Attempt ${attempts}/${MAX_UPDATE_BRANCH_RETRIES} before eviction. Raw error: ${message.split('\n')[0]}`,
    )
    return 'released'
  }

  // The PUT call itself succeeded -- clear any consecutive-failure tracking
  // for this PR so a past transient blip doesn't count towards a future,
  // unrelated failure streak.
  deleteVar('MERGE_QUEUE_UPDATE_FAIL_PR')
  deleteVar('MERGE_QUEUE_UPDATE_FAIL_COUNT')

  // update-branch is asynchronous (202 accepted) -- poll briefly for the
  // head SHA to actually change before trusting it as the SHA to watch.
  let newSha = before
  for (let attempt = 0; attempt < UPDATE_BRANCH_POLL_ATTEMPTS; attempt++) {
    await sleep(UPDATE_BRANCH_POLL_INTERVAL_MS)
    const current = ghJson(['pr', 'view', String(prNumber), '--json', 'headRefOid']).headRefOid
    if (current !== before) {
      newSha = current
      break
    }
  }

  if (newSha === before) {
    log(
      `Warning: head SHA for PR #${prNumber} had not changed after ${(UPDATE_BRANCH_POLL_ATTEMPTS * UPDATE_BRANCH_POLL_INTERVAL_MS) / 1000}s. Leaving it tracked at the current SHA; the watchdog will re-check if it never settles.`,
    )
  }

  // Refresh the claim clock on every successful update/re-sync so a PR that
  // keeps getting rebased by external develop advances isn't falsely
  // watchdog-evicted mid-CI for "90 minutes stuck" when each rebase is
  // legitimate progress.
  setVar('MERGE_QUEUE_CLAIMED_AT', new Date().toISOString())
  setVar('MERGE_QUEUE_SHA', newSha)
  log(`Now watching PR #${prNumber} at ${newSha}.`)
  return 'watching'
}

/**
 * Re-evaluate the currently claimed PR instead of no-op'ing.
 *
 * Critical production failure this fixes: develop advanced (manual merges
 * outside the queue, or a second PR landing while this one waited on CI)
 * while PR #N was still claimed. Branch protection uses
 * required_status_checks.strict=true, so native auto-merge will never
 * finish a BEHIND PR -- but the previous dequeue() path logged
 * "Already in flight. Nothing to do." on every subsequent push and left
 * the PR stranded until the 90-minute watchdog *evicted* a healthy PR
 * with `requires action`.
 *
 * Also handles: PR closed/merged while claimed, ready label removed, real
 * conflicts, and MERGE_QUEUE_SHA drift after our own update-branch.
 */
async function maintainInFlight(prNumber, depth = 0) {
  let snap
  try {
    snap = viewPr(prNumber)
  } catch (err) {
    log(
      `Could not load in-flight PR #${prNumber} (${String(err.message || err).split('\n')[0]}). Clearing claim so the queue can advance.`,
    )
    clearQueueState()
    await dequeue(depth + 1)
    return
  }

  if (snap.state !== 'OPEN') {
    log(`In-flight PR #${prNumber} is ${snap.state}. Clearing claim and advancing the queue.`)
    removeLabel(prNumber, PROCESSING_LABEL)
    clearQueueState()
    await dequeue(depth + 1)
    return
  }

  const labelNames = (snap.labels || []).map((l) => l.name)
  if (!labelNames.includes(READY_LABEL)) {
    log(`In-flight PR #${prNumber} no longer has \`${READY_LABEL}\`. Clearing claim and advancing the queue.`)
    removeLabel(prNumber, PROCESSING_LABEL)
    clearQueueState()
    await dequeue(depth + 1)
    return
  }

  const mergeable = await resolveMergeable(prNumber, snap.mergeable)
  // Re-read mergeStateStatus after any UNKNOWN settle -- cheap and more
  // accurate if GitHub finished computing during the poll above.
  const status = ghJson(['pr', 'view', String(prNumber), '--json', 'mergeStateStatus,headRefOid,autoMergeRequest'])
  const mergeStateStatus = status.mergeStateStatus
  const headRefOid = status.headRefOid

  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    await evict(
      prNumber,
      `In-flight PR became CONFLICTING/DIRTY against \`${TARGET_BRANCH}\` (mergeable=${mergeable}, mergeStateStatus=${mergeStateStatus}). Resolve the conflict manually, then re-add \`${READY_LABEL}\`.`,
      depth,
    )
    return
  }

  // BEHIND is the common stuck-queue case under strict status checks: base
  // advanced, auto-merge is blocked, and we must update-branch again.
  if (mergeStateStatus === 'BEHIND') {
    log(
      `In-flight PR #${prNumber} is BEHIND \`${TARGET_BRANCH}\` (strict required checks block auto-merge until it's current). Re-running update-branch.`,
    )
    setVar('MERGE_QUEUE_SHA', 'pending')
    await updateBranchAndWatch(prNumber, depth)
    return
  }

  // Keep the watched SHA aligned with the actual head (author push, or a
  // prior update-branch whose synchronize event we only partially handled).
  const trackedSha = getVar('MERGE_QUEUE_SHA')
  if (!trackedSha || trackedSha === 'pending' || trackedSha !== headRefOid) {
    log(`Refreshing MERGE_QUEUE_SHA for PR #${prNumber}: ${trackedSha || '(unset)'} -> ${headRefOid}`)
    setVar('MERGE_QUEUE_SHA', headRefOid)
  }

  if (!status.autoMergeRequest) {
    log(`In-flight PR #${prNumber} has no active auto-merge request. Re-enabling.`)
    enableAutoMerge(prNumber)
  } else {
    log(
      `In-flight PR #${prNumber} is still valid (mergeStateStatus=${mergeStateStatus}, head=${headRefOid.slice(0, 7)}). Leaving it to native auto-merge.`,
    )
  }
}


// Required-check classification.
//
// `gh pr checks --required` buckets:
//   pass | fail | pending | skipping | cancel
//
// CRITICAL: do NOT treat `cancel` as a hard failure. A cancelled required
// check almost always means "superseded by a newer run" (update-branch,
// author push, concurrency on the PR's CI workflows) — not "this PR is
// broken." Treating cancel as fail previously caused healthy PRs to get
// `requires action` mid-queue whenever CI was cancelled-and-restarted
// while check-completion or the watchdog raced the new run. Cancel is
// wait-and-retry, same family as pending.
function isHardFailCheck(check) {
  return check.bucket === 'fail'
}

function isWaitCheck(check) {
  return check.bucket === 'pending' || check.bucket === 'cancel'
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
    // Previously this returned immediately ("Nothing to do"), which is what
    // stranded healthy BEHIND PRs whenever develop advanced while they were
    // claimed. Always re-evaluate the in-flight PR instead.
    log(`Already in flight: PR #${inFlight}. Re-evaluating instead of no-op'ing.`)
    await maintainInFlight(inFlight, depth)
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

  // A PR can end up with both `ready to merge` and `requires action` when a
  // human re-adds ready without first clearing the eviction label. Those
  // PRs are NOT ready candidates — they still need the underlying failure
  // fixed. Without this filter, dequeue re-claims the same previously
  // evicted PR (oldest readySince often wins) and re-blocks the queue.
  const eligible = prs.filter((pr) => {
    const names = (pr.labels || []).map((l) => l.name)
    return !names.includes(REQUIRES_ACTION_LABEL)
  })
  const skipped = prs.length - eligible.length
  if (skipped > 0) {
    log(
      `Skipping ${skipped} PR(s) that still have \`${REQUIRES_ACTION_LABEL}\` alongside \`${READY_LABEL}\`. Clear \`${REQUIRES_ACTION_LABEL}\` after fixing the issue, then re-add \`${READY_LABEL}\`.`,
    )
  }
  if (eligible.length === 0) {
    log(
      `Queue has ${prs.length} ready-labeled PR(s) but none are eligible (all still marked \`${REQUIRES_ACTION_LABEL}\`). Nothing to dequeue.`,
    )
    return
  }

  const withMeta = eligible.map((pr) => ({
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
  // Belt-and-suspenders: never carry a stale eviction label into a new claim
  // (should already be filtered out above).
  removeLabel(next.number, REQUIRES_ACTION_LABEL)

  await updateBranchAndWatch(next.number, depth)
}

async function checkCompletion() {
  const pr = getVar('MERGE_QUEUE_PR')
  const sha = getVar('MERGE_QUEUE_SHA')
  if (!pr || !sha || sha === 'pending') {
    log('Nothing resolvable in flight. Nothing to do.')
    return
  }

  // Before reading checks, make sure the claimed PR is still a live candidate
  // and not stranded BEHIND the base (auto-merge can't finish under strict
  // required status checks). This also recovers if the PR merged/closed via
  // a path that never fired our cleanup job.
  let snap
  try {
    snap = viewPr(pr)
  } catch (err) {
    log(`Could not load PR #${pr} for check-completion: ${String(err.message || err).split('\n')[0]}`)
    return
  }

  if (snap.state !== 'OPEN') {
    log(`PR #${pr} is ${snap.state}. Clearing claim and advancing the queue.`)
    removeLabel(pr, PROCESSING_LABEL)
    clearQueueState()
    await dequeue()
    return
  }

  if (snap.mergeStateStatus === 'BEHIND') {
    log(
      `PR #${pr} is BEHIND \`${TARGET_BRANCH}\` even though checks are finishing on the old head. Re-syncing instead of waiting on auto-merge that cannot succeed under strict status checks.`,
    )
    setVar('MERGE_QUEUE_SHA', 'pending')
    await updateBranchAndWatch(pr)
    return
  }

  if (snap.mergeable === 'CONFLICTING' || snap.mergeStateStatus === 'DIRTY') {
    await evict(
      pr,
      `Required path became CONFLICTING/DIRTY after updating with \`${TARGET_BRANCH}\` (mergeable=${snap.mergeable}, mergeStateStatus=${snap.mergeStateStatus}). Resolve the conflict manually, then re-add \`${READY_LABEL}\`.`,
    )
    return
  }

  // Keep SHA current if the head moved (shouldn't usually, but cheap).
  if (snap.headRefOid && snap.headRefOid !== sha) {
    log(`Head SHA for PR #${pr} moved ${sha.slice(0, 7)} -> ${snap.headRefOid.slice(0, 7)}; updating tracked SHA.`)
    setVar('MERGE_QUEUE_SHA', snap.headRefOid)
  }

  const checks = ghJsonAsDefaultToken(['pr', 'checks', pr, '--required', '--json', 'name,bucket'])
  const failing = checks.filter(isHardFailCheck)
  const waiting = checks.filter(isWaitCheck)
  if (failing.length === 0) {
    // Waiting (pending OR cancelled-and-likely-rerunning) is not green and
    // is not a reason to evict. Re-arm auto-merge and let the next
    // workflow_run / watchdog decide.
    if (waiting.length > 0) {
      const names = waiting.map((c) => `${c.name}(${c.bucket})`).join(', ')
      log(
        `PR #${pr} still has in-flight required check(s): ${names}. Not failing — leaving claim and waiting.`,
      )
      const autoMergeState = ghJson(['pr', 'view', pr, '--json', 'autoMergeRequest']).autoMergeRequest
      if (!autoMergeState) {
        log(`PR #${pr} has no active auto-merge request. Retrying enableAutoMerge while checks are still running.`)
        enableAutoMerge(pr)
      }
      return
    }

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

  // synchronize used to clear the claim and immediately re-dequeue the same
  // PR (update-branch → synchronize webhook → cleanup → dequeue → claim
  // again). That double-claimed every successful update, raced with
  // check-completion, and reset state unnecessarily. On synchronize we only
  // need to track the new head SHA and keep auto-merge armed.
  if (EVENT_ACTION === 'synchronize') {
    log(`Synchronize on in-flight PR #${EVENT_PR_NUMBER}; refreshing watched SHA (keeping claim).`)
    if (DRY_RUN) return
    const head = ghJson(['pr', 'view', EVENT_PR_NUMBER, '--json', 'headRefOid']).headRefOid
    setVar('MERGE_QUEUE_SHA', head)
    enableAutoMerge(EVENT_PR_NUMBER)
    log(`Now watching PR #${EVENT_PR_NUMBER} at ${head}.`)
    return
  }

  log(`Clearing in-flight state for PR #${EVENT_PR_NUMBER} (event: ${EVENT_ACTION}).`)
  removeLabel(EVENT_PR_NUMBER, PROCESSING_LABEL)
  clearQueueState()
  // Not an eviction -- no requires-action label, no comment. Being closed
  // or unlabeled isn't a failure, just no longer applicable to what the
  // queue was watching.

  // The queue is idle again now, but nothing else guarantees a fresh dequeue
  // gets triggered -- an unlabeled/close on the in-flight PR isn't a push
  // or a labeled event itself. Without this, a still-ready PR elsewhere in
  // the queue would sit stalled until some unrelated event happened to fire.
  // Pick up the next one immediately instead.
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

  // Always re-evaluate the in-flight PR first: a BEHIND / closed / unlabeled
  // PR should recover immediately, not wait out the stale timer just to get
  // wrongly evicted as "hung".
  await maintainInFlight(pr)

  // maintainInFlight may have advanced the queue (evict/closed) or re-synced
  // a BEHIND PR (which refreshes CLAIMED_AT). Re-read state before deciding
  // on a hung-PR eviction.
  const stillPr = getVar('MERGE_QUEUE_PR')
  const stillClaimedAt = getVar('MERGE_QUEUE_CLAIMED_AT')
  if (!stillPr || !stillClaimedAt) {
    log('Queue is idle after maintainInFlight. Done.')
    return
  }

  const elapsedMinutes = (Date.now() - new Date(stillClaimedAt).getTime()) / 60000
  if (elapsedMinutes <= STALE_AFTER_MINUTES) {
    log(
      `PR #${stillPr} has been in flight for ${Math.round(elapsedMinutes)}m, under the ${STALE_AFTER_MINUTES}m threshold (claim clock may have been refreshed by a re-sync).`,
    )
    return
  }

  // Past the stale window and still claimed after maintainInFlight. Prefer
  // diagnosing over blind eviction of a healthy PR:
  //  - failing required checks → evict with the check names
  //  - still BEHIND after maintain tried to re-sync → already handled above
  //  - all green + auto-merge active → something else is blocking merge
  //    (review, conversation, deploy-lock, permissions); comment+evict so
  //    a human can look rather than blocking the rest of the queue forever
  let snap
  try {
    snap = viewPr(stillPr)
  } catch (err) {
    log(`Could not load stale PR #${stillPr}: ${String(err.message || err).split('\n')[0]}. Evicting claim.`)
    clearQueueState()
    await dequeue()
    return
  }

  if (snap.state !== 'OPEN') {
    log(`Stale in-flight PR #${stillPr} is ${snap.state}. Clearing and advancing.`)
    removeLabel(stillPr, PROCESSING_LABEL)
    clearQueueState()
    await dequeue()
    return
  }

  try {
    const checks = ghJsonAsDefaultToken(['pr', 'checks', stillPr, '--required', '--json', 'name,bucket'])
    const failing = checks.filter(isHardFailCheck)
    if (failing.length > 0) {
      const names = failing.map((c) => c.name).join(', ')
      await evict(
        stillPr,
        `Stuck in the merge queue for over ${STALE_AFTER_MINUTES} minutes with failing required check(s): ${names}.`,
      )
      return
    }
    // pending OR cancel: still not a terminal outcome. Soft-requeue so a
    // slow/re-running required check can't starve the rest of the ready list.
    const pending = checks.filter(isWaitCheck)
    if (pending.length > 0) {
      // CI is still running past the budget. Don't mark requires-action for
      // a healthy PR whose only crime is slow E2E -- release the claim so
      // the rest of the queue can move, but leave ready-to-merge so it
      // re-enters naturally once a free slot opens (or the author re-labels).
      // Actually: if we only clear claim and leave ready, dequeue will
      // immediately re-pick the same oldest-ready PR and re-stuck. So we
      // must either evict or keep waiting. Prefer a soft requeue to the
      // *back* of the line by removing+re-adding ready... but label
      // timestamps drive priority, and re-adding would update readySince
      // to "now", demoting it behind older ready PRs. That's the right
      // fairness behavior for a slow PR starving the queue.
      log(
        `PR #${stillPr} still has pending/cancelled required checks after ${Math.round(elapsedMinutes)}m: ${pending
          .map((c) => `${c.name}(${c.bucket})`)
          .join(', ')}. Soft-requeueing (remove+re-add \`${READY_LABEL}\`) so older-ready peers aren't starved by a single slow PR.`,
      )
      // Clear claim BEFORE removing ready so the unlabeled webhook's cleanup
      // job sees no matching MERGE_QUEUE_PR and no-ops (avoids a double
      // dequeue race with the explicit dequeue() below).
      removeLabel(stillPr, PROCESSING_LABEL)
      clearQueueState()
      removeLabel(stillPr, READY_LABEL)
      // Re-add ready so it stays in the queue, but with a fresh readySince
      // (end of the line within its tier).
      addLabel(stillPr, READY_LABEL)
      comment(
        stillPr,
        `Soft-requeued by the merge-queue watchdog: still running (or cancelled-and-rerunning) required checks after ${Math.round(elapsedMinutes)} minutes (${pending
          .map((c) => `${c.name}(${c.bucket})`)
          .join(
            ', ',
          )}). Left in the queue (still has \`${READY_LABEL}\`) but moved to the back of its priority tier so other ready PRs can proceed. No action needed unless checks ultimately fail.`,
      )
      await dequeue()
      return
    }
  } catch (err) {
    log(`Could not read required checks for stale PR #${stillPr}: ${String(err.message || err).split('\n')[0]}`)
  }

  await evict(
    stillPr,
    `Stuck in the merge queue for over ${STALE_AFTER_MINUTES} minutes with no resolution (checks not failing, auto-merge did not complete, mergeStateStatus=${snap.mergeStateStatus}). Confirm branch protection / review requirements / deploy-lock, then re-add \`${READY_LABEL}\`.`,
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
