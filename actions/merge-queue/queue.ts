#!/usr/bin/env node
// Zero-dependency Node script implementing the merge-queue state machine.
// Commands: dequeue | check-completion | cleanup | watchdog (see action.yml).
//
// State lives as JSON on branch `merge-queue-state` (contents: write on the
// default GITHUB_TOKEN). Actions variables were the original store so a
// caller `if:` could read `vars.MERGE_QUEUE_SHA` without a runner; that
// required a user PAT because GITHUB_TOKEN cannot write repository variables.
// Callers now gate pull_request cleanup on the processing label, and
// check-completion is watchdog-driven, so the JSON store is enough:
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
//   MERGE_QUEUE_RERUN_PR/
//   MERGE_QUEUE_RERUN_COUNT     - re-run attempts for cancelled (not failed)
//                                 required checks on a specific PR, capped at
//                                 MAX_CHECK_RERUN_ATTEMPTS before eviction.
//                                 Deliberately NOT cleared while the same PR
//                                 stays in flight (clearing on a green/pending
//                                 pass would let a chronically timing-out job
//                                 alternate cancel -> re-run forever without
//                                 ever hitting the cap); reset only when
//                                 dequeue makes a fresh claim, so a PR that
//                                 was evicted with spent budget and later
//                                 re-queued by a human starts over instead of
//                                 being insta-evicted on its first transient
//                                 cancellation.
//   MERGE_QUEUE_YIELD_COUNTS    - compact `prNumber:count` map of how many
//                                 times each ready PR has soft-requeued
//                                 (pending checks, missing approval, draft).
//                                 compareQueueItems uses this as a within-tier
//                                 tiebreak ahead of createdAt so a PR that
//                                 already yielded sorts behind peers it
//                                 blocked, restoring the old readySince-bump
//                                 demotion that createdAt-only ordering lost.
//                                 Dropped on evict / close / unlabeled so a
//                                 human re-queue starts at 0; pruned on
//                                 dequeue for PRs no longer in the ready list.
import { execFileSync } from 'node:child_process'
import { errorText } from './errors.ts'
import { paginate } from './pagination.ts'
import {
  classifyTier as rankPullRequest,
  compareQueueItems,
  dropYieldCount,
  incrementYieldCount,
  parseLabelList,
  parseYieldCounts,
  pruneYieldCounts,
  serializeYieldCounts,
  type TieredPr,
} from './priority.ts'
import { createQueueState } from './state.ts'

// `gh` JSON is untyped at the boundary: ghJson<T> asserts the shape each
// call site asked for (see state.ts's read<T> for the same pattern), so the
// interfaces below mirror the `--json` field lists, not validated schemas.
type PrNumber = string | number

interface GhLabel {
  name: string
}

interface GhPrListItem {
  number: number
  title: string
  labels: Array<{ name: string }>
  createdAt: string
  isDraft: boolean
  reviewDecision?: string
  author: { login: string }
}

interface PrSnapshot {
  state: string
  mergeable: string
  mergeStateStatus: string
  headRefOid: string
  labels?: GhLabel[]
  autoMergeRequest?: { enabledBy?: string } | null
  title: string
  reviewDecision?: string
  isDraft: boolean
}

interface PrStatus {
  mergeStateStatus: string
  headRefOid: string
  autoMergeRequest: { enabledBy?: string } | null
}

interface GhCheck {
  name: string
  bucket: string
  link?: string
}

interface TimelineEvent {
  event: string
  label?: { name?: string }
  created_at?: string
}

const REPO = requireEnv('GITHUB_REPOSITORY')
const COMMAND = requireEnv('MQ_COMMAND')
const TARGET_BRANCH = process.env.MQ_TARGET_BRANCH || ''
const MERGE_METHOD = process.env.MQ_MERGE_METHOD || 'squash'
const READY_LABEL = process.env.MQ_READY_LABEL || 'ready to merge'
const PROCESSING_LABEL = process.env.MQ_PROCESSING_LABEL || 'merge-queue: processing'
const REQUIRES_ACTION_LABEL = process.env.MQ_REQUIRES_ACTION_LABEL || 'requires action'
// Ordered focus labels from the consumer. First match wins. The default
// is the generic `bug` label; product-specific names (workspace, etc.)
// belong in the calling repo, not here.
const TIER1_LABELS = parseLabelList(process.env.MQ_TIER1_LABELS, 'bug')
const TIER1_TITLE_REGEX = new RegExp(process.env.MQ_TIER1_TITLE_REGEX || '^\\[HOTFIX\\]', 'i')
const TIER2_TITLE_REGEX = new RegExp(process.env.MQ_TIER2_TITLE_REGEX || '^\\[HCP-', 'i')
const DEPRIORITIZED_TITLE_REGEX = new RegExp(
  process.env.MQ_DEPRIORITIZED_TITLE_REGEX || '^\\[TECH\\]',
  'i',
)
const DEPRIORITIZED_AUTHORS = parseLabelList(
  process.env.MQ_DEPRIORITIZED_AUTHORS,
  'dependabot,dependabot[bot],app/dependabot',
)
const STALE_AFTER_MINUTES = Number(process.env.MQ_STALE_AFTER_MINUTES || '90')
const EVENT_PR_NUMBER = process.env.MQ_EVENT_PR_NUMBER || ''
const EVENT_ACTION = process.env.MQ_EVENT_ACTION || ''
const DRY_RUN = process.env.MQ_DRY_RUN === 'true'
const UPDATE_BRANCH_POLL_ATTEMPTS = Number(process.env.MQ_UPDATE_BRANCH_POLL_ATTEMPTS || '12')
const UPDATE_BRANCH_POLL_INTERVAL_MS = Number(process.env.MQ_UPDATE_BRANCH_POLL_INTERVAL_MS || '5000')
// Short poll for GitHub's mergeable computation to settle out of UNKNOWN
// after a failed update-branch call, before trusting it to decide whether
// a failure was a real conflict. Much shorter than the SHA-settle poll
// above -- this is normally quick, and it's already inside a failure path.
const MERGEABLE_POLL_ATTEMPTS = Number(process.env.MQ_MERGEABLE_POLL_ATTEMPTS || '5')
const MERGEABLE_POLL_INTERVAL_MS = Number(process.env.MQ_MERGEABLE_POLL_INTERVAL_MS || '3000')
// Backstop for the dequeue<->evict recursion below. Bounded in the normal
// case by how many PRs are actually ready (each eviction removes one from
// candidacy), but that assumption depends on removeLabel(READY_LABEL)
// actually succeeding -- if it silently fails for a real reason, the same
// PR could get reselected and re-evicted in a tight loop. This is a hard
// ceiling independent of that, not a realistic queue-depth estimate.
const MAX_DEQUEUE_RECURSION_DEPTH = Number(process.env.MQ_MAX_DEQUEUE_RECURSION_DEPTH || '20')
// How many consecutive non-conflict update-branch failures the *same* PR
// gets before it's evicted instead of released for another retry. Without
// this, a permanent-but-not-a-conflict failure (a fork PR this token can't
// update, a branch protection quirk, etc.) reselects the same PR forever --
// dequeue() always sorts to the same tier/createdAt-oldest candidate, so
// nothing behind it in the queue is ever reached, even though a transient
// or system-wide failure (a token permission gap, say) deserves a retry
// rather than an immediate eviction. See MERGE_QUEUE_UPDATE_FAIL_PR /
// MERGE_QUEUE_UPDATE_FAIL_COUNT below.
const MAX_UPDATE_BRANCH_RETRIES = 3
// How many times cancelled (NOT failed) required checks get re-run for the
// same in-flight PR before eviction. Cancelled is not a verdict on the code:
// GitHub reports a job that blew its `timeout-minutes` as cancelled, and
// concurrency-group supersession cancels too. Production evidence
// (howdycom/astro-market, 2026-07-21): two healthy PRs (#3875, #3789) were
// evicted for "Required check(s) failed: Prettier Format Check" when the
// check's own format step had PASSED -- the job's post-run cache-save step
// pushed a slow dependency install past a 10-minute job timeout, so the run
// ended cancelled and the old fail|cancel bucket filter called that a
// failure. The cap exists because a job that times out every single run
// (a genuinely broken/overloaded job) should surface to a human, not re-run
// forever.
const MAX_CHECK_RERUN_ATTEMPTS = 2
// Regex matching the two phrasings GitHub returns when update-branch is a
// no-op because the head is already current with the base.
const ALREADY_UP_TO_DATE_RE = /up.to.date|not.*behind|no new commits on the base branch/i

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function sh(args: string[], envOverride?: Record<string, string | undefined>): string {
  const env = envOverride ? { ...process.env, ...envOverride } : process.env
  return execFileSync(args[0], args.slice(1), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()
}

function gh(args: string[]): string {
  return sh(['gh', ...args])
}

function ghJson<T = unknown>(args: string[]): T {
  return JSON.parse(gh(args))
}

// POST/PATCH/etc. with a JSON body via `gh api --input -`. Prefer this over
// `gh pr edit` for mutations that only need REST (labels especially):
// `gh pr edit` still GraphQL-loads classic Projects `projectCards`, which
// GitHub now rejects and aborts the command on.
// Production evidence (howdycom/astro-market self-hosted merge-queue
// watchdog, 2026-08-08): dequeue claimed PR #6677 then died on
// `gh pr edit … --add-label merge-queue: processing` with
//   GraphQL: Projects (classic) is being deprecated … (projectCards)
// leaving MERGE_QUEUE_* variables set and the processing label never applied.
function ghApiJson(method: string, endpoint: string, body: unknown): string {
  return execFileSync(
    'gh',
    ['api', '-X', method, endpoint, '--input', '-'],
    {
      encoding: 'utf-8',
      input: JSON.stringify(body),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    },
  ).trim()
}

// Fine-grained PATs can't read check-run results (as opposed to legacy
// commit statuses) created by other Apps via GraphQL, no matter what
// repository permission is granted -- confirmed the hard way when
// check-completion's `gh pr checks --required` call failed on every
// required check except the one plain commit status (deploy-lock), even
// after adding Commit statuses: read. The default GITHUB_TOKEN has
// checks: read for its own repo/run out of the box, so this one read-only
// query uses that instead -- mutations (labels, state file, update-branch)
// go through GH_TOKEN, which callers now pass as github.token. MQ_GITHUB_TOKEN
// stays a distinct env var so check-run reads keep working if a caller still
// supplies a PAT that cannot read other Apps' checks.
function ghAsDefaultToken(args: string[]): string {
  if (!process.env.MQ_GITHUB_TOKEN) {
    throw new Error(
      'MQ_GITHUB_TOKEN is not set -- the calling job needs `permissions: checks: read` for this to work (see check-completion).',
    )
  }
  return sh(['gh', ...args], { GH_TOKEN: process.env.MQ_GITHUB_TOKEN })
}

function ghJsonAsDefaultToken<T = unknown>(args: string[]): T {
  return JSON.parse(ghAsDefaultToken(args))
}

// Fetch every page of a GitHub REST *list* endpoint as one flat array.
// Prefer `gh api --paginate --slurp` when available (gh CLI >= ~2.48, 2024-04).
// Self-hosted light runners may ship older `gh` that rejects `--slurp`
// ("unknown flag: --slurp"), which previously crashed every dequeue/watchdog
// call into getReadySince. Fall back to explicit page= iteration so the queue
// keeps working on those fleets without requiring a runner image upgrade.
let cachedGhApiSupportsSlurp: boolean | undefined
function ghApiSupportsSlurp(): boolean {
  if (cachedGhApiSupportsSlurp !== undefined) return cachedGhApiSupportsSlurp
  try {
    cachedGhApiSupportsSlurp = /\b--slurp\b/.test(sh(['gh', 'api', '--help']))
  } catch {
    cachedGhApiSupportsSlurp = false
  }
  return cachedGhApiSupportsSlurp
}

function ghPaginatedJson(endpoint: string): TimelineEvent[] {
  return paginate(endpoint, { ghJson, supportsSlurp: ghApiSupportsSlurp() }) as TimelineEvent[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(message: string): void {
  console.log(`[merge-queue:${COMMAND}] ${message}`)
}

function logAction(message: string): void {
  log(DRY_RUN ? `[dry-run] would ${message}` : message)
}

// ---- coordination state (JSON on merge-queue-state; GITHUB_TOKEN can write it) ----

const { getVar, setVar, deleteVar, clearQueueState } = createQueueState({
  repo: REPO,
  processingLabel: PROCESSING_LABEL,
  dryRun: DRY_RUN,
  log,
  logAction,
  ghJson,
  ghApiJson,
})

function readYieldCountsRaw(): string {
  return getVar('MERGE_QUEUE_YIELD_COUNTS')
}

function writeYieldCounts(serialized: string): void {
  if (serialized) setVar('MERGE_QUEUE_YIELD_COUNTS', serialized)
  else deleteVar('MERGE_QUEUE_YIELD_COUNTS')
}

function bumpYieldCount(prNumber: PrNumber): void {
  writeYieldCounts(incrementYieldCount(readYieldCountsRaw(), prNumber))
}

function clearYieldCount(prNumber: PrNumber): void {
  writeYieldCounts(dropYieldCount(readYieldCountsRaw(), prNumber))
}

function pruneStaleYieldCounts(prNumbers: Iterable<string | number>): void {
  const raw = readYieldCountsRaw()
  const next = pruneYieldCounts(raw, prNumbers)
  if (next !== serializeYieldCounts(parseYieldCounts(raw))) writeYieldCounts(next)
}

// ---- PR mutations ----

function addLabel(prNumber: PrNumber, label: string): void {
  logAction(`add label "${label}" to PR #${prNumber}`)
  if (DRY_RUN) return
  // Issues REST, not `gh pr edit --add-label` — see ghApiJson comment.
  // PR numbers are issue numbers for the labels endpoints.
  ghApiJson('POST', `repos/${REPO}/issues/${prNumber}/labels`, { labels: [label] })
}

function removeLabel(prNumber: PrNumber, label: string): void {
  logAction(`remove label "${label}" from PR #${prNumber}`)
  if (DRY_RUN) return
  try {
    // DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}
    // Label names with spaces/colons (e.g. "merge-queue: processing") must
    // be path-encoded. Same classic-Projects GraphQL pitfall as addLabel.
    gh([
      'api',
      '-X',
      'DELETE',
      `repos/${REPO}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
    ])
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
    const message = errorText(err)
    if (!/404/.test(message)) {
      log(`Warning: could not remove label "${label}" from PR #${prNumber}, treating as already absent: ${message.split('\n')[0]}`)
    }
  }
}

function comment(prNumber: PrNumber, body: string): void {
  logAction(`comment on PR #${prNumber}: ${body.split('\n')[0]}`)
  if (DRY_RUN) return
  gh(['pr', 'comment', String(prNumber), '--body', body])
}

function enableAutoMerge(prNumber: PrNumber): void {
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
    log(`Warning: could not enable auto-merge on PR #${prNumber}: ${errorText(err).split('\n')[0]}`)
  }
}

function viewPr(prNumber: PrNumber): PrSnapshot {
  return ghJson<PrSnapshot>([
    'pr',
    'view',
    String(prNumber),
    '--json',
    'state,mergeable,mergeStateStatus,headRefOid,labels,autoMergeRequest,title,reviewDecision,isDraft',
  ])
}

async function resolveMergeable(prNumber: PrNumber, initialMergeable: string): Promise<string> {
  let mergeable = initialMergeable
  for (let attempt = 0; mergeable === 'UNKNOWN' && attempt < MERGEABLE_POLL_ATTEMPTS; attempt++) {
    await sleep(MERGEABLE_POLL_INTERVAL_MS)
    mergeable = ghJson<{ mergeable: string }>(['pr', 'view', String(prNumber), '--json', 'mergeable']).mergeable
  }
  return mergeable
}

async function evict(prNumber: PrNumber, reason: string, depth = 0): Promise<void> {
  log(`Evicting PR #${prNumber}: ${reason}`)
  removeLabel(prNumber, READY_LABEL)
  removeLabel(prNumber, PROCESSING_LABEL)
  clearYieldCount(prNumber)
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
    // stalled until an unrelated event happened to fire. Pass the evicted
    // PR as the exclusion: `gh pr list` reads the search index, which lags
    // the label removal above by a few seconds -- in production (2026-07-21
    // 15:04Z) this chained dequeue re-selected and re-claimed the very PR
    // it had evicted two seconds earlier, wasting a full check cycle until
    // a second eviction advanced the queue for real.
    await dequeue(depth + 1, String(prNumber))
  }
}

/**
 * Release the claim so another ready PR can proceed this pass. Removing
 * and re-adding the ready label no longer demotes by itself (order is
 * createdAt, not readySince); bumpYieldCount is what sinks this PR behind
 * same-rank peers it already blocked. excludePr still skips it on the
 * chained dequeue in this pass (search-index lag). Used instead of
 * evict() when the PR is not at fault (slow checks, an approval that
 * disappeared) -- it keeps the ready label so no human has to re-queue it.
 */
async function softRequeueToBack(prNumber: PrNumber, body: string, depth = 0): Promise<void> {
  // Clear the claim BEFORE removing the ready label so the unlabeled
  // webhook's cleanup job sees no matching MERGE_QUEUE_PR and no-ops
  // (avoids a double-dequeue race with the explicit dequeue() below).
  removeLabel(prNumber, PROCESSING_LABEL)
  clearQueueState()
  removeLabel(prNumber, READY_LABEL)
  // Re-add ready so it stays in the queue. Guarded: if the re-add fails
  // after the remove succeeded, the PR would otherwise silently leave the
  // queue with no label, no comment, and only a red Actions run as evidence.
  try {
    addLabel(prNumber, READY_LABEL)
  } catch (err) {
    log(
      `Warning: could not re-add "${READY_LABEL}" to PR #${prNumber} during soft-requeue: ${errorText(err).split('\n')[0]}. The PR is OUT of the queue until a human re-adds the label.`,
    )
  }
  bumpYieldCount(prNumber)
  comment(prNumber, body)
  // Exclude the just-requeued PR from the immediate re-pick so a peer can
  // proceed this pass. The search index may not have caught up with the
  // label churn yet anyway.
  await dequeue(depth + 1, String(prNumber))
}

/**
 * Required check(s) ended "cancelled" -- usually a job that blew its
 * `timeout-minutes` budget (GitHub reports that as conclusion=cancelled) or
 * a concurrency-group supersession, NOT a verdict on the code. See
 * MAX_CHECK_RERUN_ATTEMPTS for the production incident this fixes. Re-run
 * the cancelled workflow runs in place (same head SHA, so MERGE_QUEUE_SHA
 * stays valid and their completion re-triggers check-completion), bounded
 * per PR so a chronically timing-out job still surfaces to a human.
 *
 * The re-run call uses the job's default GITHUB_TOKEN (ghAsDefaultToken),
 * not the PAT: fine-grained PATs would need an Actions write grant nobody
 * else needs, while the default token just needs the calling job to declare
 * `actions: write`. If that permission is missing the call fails safe --
 * logged warning, claim kept, attempt still counted -- and the cap
 * eventually evicts with an accurate reason instead of looping forever.
 */
async function rerunCancelledChecks(prNumber: PrNumber, cancelled: GhCheck[]): Promise<void> {
  const names = cancelled.map((c) => c.name).join(', ')

  // `gh pr checks --json link` returns the check's HTML URL, which embeds
  // the workflow run id (/actions/runs/<id>/...) for Actions-backed checks;
  // job-level links (/actions/runs/<id>/job/<jobId>) match the same prefix.
  // Plain commit statuses (e.g. deploy-lock) have non-Actions links and
  // filter out -- they also can never be CANCELLED (the status API has no
  // such state), so in practice this branch is defensive only. Several
  // checks can share one run; dedupe before re-running.
  const runIds = [...new Set(cancelled.map((c) => ((c.link || '').match(/\/actions\/runs\/(\d+)/) || [])[1]).filter(Boolean))]
  if (runIds.length === 0) {
    log(
      `Cancelled required check(s) on PR #${prNumber} (${names}), but no workflow run id could be resolved from their links (plain commit status?). Leaving the claim in place -- the watchdog will re-check and eventually evict.`,
    )
    return
  }

  // Only re-run runs that are actually completed. A run that is queued or
  // in_progress here almost always means a previous pass already requested
  // the re-run seconds ago and the check rollup hasn't flipped back to
  // pending yet -- several cancelled workflows firing their completion
  // events back-to-back serialize through the concurrency group, and
  // without this gate each trailing pass would burn one attempt on a
  // rerun-failed-jobs call GitHub is guaranteed to reject ("run in
  // progress"). Passes that start nothing do not count toward the cap.
  const completedRunIds: string[] = []
  for (const runId of runIds) {
    try {
      const status = ghJsonAsDefaultToken<{ status: string }>(['api', `repos/${REPO}/actions/runs/${runId}`]).status
      if (status === 'completed') {
        completedRunIds.push(runId)
      } else {
        log(`Run ${runId} is ${status} -- a re-run is already underway. Not counting an attempt; waiting for it to finish.`)
      }
    } catch (err) {
      log(`Warning: could not read status of run ${runId}: ${errorText(err).split('\n')[0]}. Skipping it this pass.`)
    }
  }
  if (completedRunIds.length === 0) return

  const lastRerunPr = getVar('MERGE_QUEUE_RERUN_PR')
  const priorRaw = Number(getVar('MERGE_QUEUE_RERUN_COUNT') || '0')
  // Number.isFinite guards a hand-edited/corrupted variable: NaN compares
  // false against the cap and would otherwise disable it entirely.
  const priorAttempts = lastRerunPr === String(prNumber) && Number.isFinite(priorRaw) ? priorRaw : 0
  const attempts = priorAttempts + 1

  if (attempts > MAX_CHECK_RERUN_ATTEMPTS) {
    await evict(
      prNumber,
      `Required check(s) keep ending cancelled -- not failed -- despite ${MAX_CHECK_RERUN_ATTEMPTS} re-run attempt(s): ${names}. A cancelled check usually means the job hit its \`timeout-minutes\` budget (GitHub reports timeouts as cancelled) or a concurrency group cancelled it. Check the job's timeout and the workflow's concurrency settings, then re-add \`${READY_LABEL}\`.`,
    )
    // Deleted after evict() so a failed eviction preserves the spent budget
    // (dequeue also resets these on every fresh claim).
    deleteVar('MERGE_QUEUE_RERUN_PR')
    deleteVar('MERGE_QUEUE_RERUN_COUNT')
    return
  }

  setVar('MERGE_QUEUE_RERUN_PR', String(prNumber))
  setVar('MERGE_QUEUE_RERUN_COUNT', String(attempts))

  let started = 0
  for (const runId of completedRunIds) {
    logAction(`re-run cancelled workflow run ${runId} for PR #${prNumber} (attempt ${attempts}/${MAX_CHECK_RERUN_ATTEMPTS}: ${names})`)
    if (DRY_RUN) continue
    try {
      // --failed re-runs failed and cancelled jobs only, keeping green jobs'
      // results -- cheaper and faster than re-running the whole run.
      ghAsDefaultToken(['run', 'rerun', runId, '--failed'])
      started++
    } catch (err) {
      log(
        `Warning: could not re-run workflow run ${runId}: ${errorText(err).split('\n')[0]}. If this is "Resource not accessible", the calling job needs \`actions: write\` for its default GITHUB_TOKEN (see the README). The attempt still counts toward the cap, so this cannot loop forever.`,
      )
    }
  }

  if (started > 0 || DRY_RUN) {
    // A re-run legitimately restarts the wait -- refresh the claim clock so
    // the watchdog's stale timer measures the re-run, not the original run.
    setVar('MERGE_QUEUE_CLAIMED_AT', new Date().toISOString())
  } else {
    // Nothing actually restarted (permissions, 30-day retention limit, ...).
    // Deliberately do NOT refresh the claim clock: with no new run there
    // will be no workflow_run event, so recovery is watchdog-driven -- a
    // refreshed clock would push each retry a full stale window apart and
    // stretch a dead queue to (cap+1) x stale_after_minutes.
    log(
      `No re-run could be started for PR #${prNumber} (attempt ${attempts}/${MAX_CHECK_RERUN_ATTEMPTS} still counts). Claim clock NOT refreshed; the watchdog's stale window governs recovery.`,
    )
  }
}

// ---- priority classification ----

function classifyTier(pr: TieredPr): number {
  return rankPullRequest(pr, {
    labels: TIER1_LABELS,
    tier1TitleRegex: TIER1_TITLE_REGEX,
    tier2TitleRegex: TIER2_TITLE_REGEX,
    deprioritizedTitleRegex: DEPRIORITIZED_TITLE_REGEX,
    deprioritizedAuthors: DEPRIORITIZED_AUTHORS,
  })
}

function getReadySince(prNumber: number, fallback: string): string | undefined {
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
async function updateBranchAndWatch(prNumber: PrNumber, depth = 0): Promise<'watching' | 'evicted' | 'released'> {
  enableAutoMerge(prNumber)

  const before = DRY_RUN
    ? 'dry-run-placeholder-sha'
    : ghJson<{ headRefOid: string }>(['pr', 'view', String(prNumber), '--json', 'headRefOid']).headRefOid

  logAction(`call PUT /pulls/${prNumber}/update-branch`)
  if (DRY_RUN) {
    setVar('MERGE_QUEUE_SHA', before)
    return 'watching'
  }

  try {
    gh(['api', '-X', 'PUT', `repos/${REPO}/pulls/${prNumber}/update-branch`])
  } catch (err) {
    const message = errorText(err)
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
    let mergeable = ghJson<{ mergeable: string }>(['pr', 'view', String(prNumber), '--json', 'mergeable']).mergeable
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
    // createdAt-oldest candidate, so an unlucky PR with a permanent,
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
    const current = ghJson<{ headRefOid: string }>(['pr', 'view', String(prNumber), '--json', 'headRefOid']).headRefOid
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
async function maintainInFlight(prNumber: PrNumber, depth = 0): Promise<void> {
  let snap: PrSnapshot
  try {
    snap = viewPr(prNumber)
  } catch (err) {
    log(
      `Could not load in-flight PR #${prNumber} (${errorText(err).split('\n')[0]}). Clearing claim so the queue can advance.`,
    )
    clearQueueState()
    await dequeue(depth + 1, String(prNumber))
    return
  }

  if (snap.state !== 'OPEN') {
    log(`In-flight PR #${prNumber} is ${snap.state}. Clearing claim and advancing the queue.`)
    removeLabel(prNumber, PROCESSING_LABEL)
    clearYieldCount(prNumber)
    clearQueueState()
    await dequeue(depth + 1, String(prNumber))
    return
  }

  const labelNames = (snap.labels || []).map((l) => l.name)
  if (!labelNames.includes(READY_LABEL)) {
    log(`In-flight PR #${prNumber} no longer has \`${READY_LABEL}\`. Clearing claim and advancing the queue.`)
    removeLabel(prNumber, PROCESSING_LABEL)
    clearYieldCount(prNumber)
    clearQueueState()
    await dequeue(depth + 1, String(prNumber))
    return
  }

  // Draft guard, same reasoning as the review-state guard below: dequeue
  // filters drafts at claim time, but an author can convert the in-flight
  // PR to draft afterwards, and native auto-merge can never complete a
  // draft. Soft-requeue rather than evict -- draft is a deliberate,
  // reversible "not yet" from the author, not a failure.
  if (snap.isDraft) {
    await softRequeueToBack(
      prNumber,
      `Soft-requeued by the merge queue: this PR was converted to draft while in flight, and native auto-merge cannot complete a draft PR. It keeps \`${READY_LABEL}\` and becomes eligible again when marked ready for review.`,
      depth,
    )
    return
  }

  // Review-state guard. dequeue() filters these out at claim time now, but
  // the state can also change *after* the claim: a reviewer can request
  // changes mid-flight, or an approval can be dismissed. mergeStateStatus
  // BLOCKED alone cannot distinguish "waiting for checks" (fine, native
  // auto-merge will finish) from "unmergeable review state" (auto-merge
  // waits forever) -- in production (howdycom/astro-market 2026-07-21) a
  // CHANGES_REQUESTED PR (#3614) was claimed at 15:08Z and every subsequent
  // pass logged "still valid ... Leaving it to native auto-merge" while the
  // whole queue sat head-of-line blocked behind it for hours.
  if (snap.reviewDecision === 'CHANGES_REQUESTED') {
    await evict(
      prNumber,
      `A reviewer has requested changes (reviewDecision=CHANGES_REQUESTED), so native auto-merge can never complete this PR. Address the review (or have it dismissed), then re-add \`${READY_LABEL}\`.`,
      depth,
    )
    return
  }
  if (snap.reviewDecision === 'REVIEW_REQUIRED') {
    await softRequeueToBack(
      prNumber,
      `Soft-requeued by the merge queue: this PR needs an approving review it does not currently have (reviewDecision=REVIEW_REQUIRED), so native auto-merge cannot complete it. It keeps \`${READY_LABEL}\` and yields this pass so another ready PR can proceed; it now sorts behind same-rank peers it has already yielded to and becomes eligible again once approved.`,
      depth,
    )
    return
  }

  const mergeable = await resolveMergeable(prNumber, snap.mergeable)
  // Re-read mergeStateStatus after any UNKNOWN settle -- cheap and more
  // accurate if GitHub finished computing during the poll above.
  const status = ghJson<PrStatus>(['pr', 'view', String(prNumber), '--json', 'mergeStateStatus,headRefOid,autoMergeRequest'])
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

// ---- commands ----

async function dequeue(depth = 0, excludePr = ''): Promise<void> {
  if (depth > MAX_DEQUEUE_RECURSION_DEPTH) {
    log(
      `Reached the max recursion depth (${MAX_DEQUEUE_RECURSION_DEPTH}) of dequeue<->evict calls in a single run -- stopping here rather than risking a runaway loop. Whatever's left in the queue will be picked up by the next real trigger (push, label, or the watchdog).`,
    )
    return
  }

  const inFlight = getVar('MERGE_QUEUE_PR')
  if (inFlight) {
    // In dry-run, evictions/requeues don't actually clear the claim, so a
    // chained re-entry would re-evaluate the identical state up to the
    // recursion cap, logging the same would-evict block ~20 times per run.
    // Depth 0 still evaluates normally, so shadow mode shows the decision
    // exactly once.
    if (DRY_RUN && depth > 0) {
      log(`[dry-run] claim on PR #${inFlight} would have been released by the previous step; stopping re-entry here.`)
      return
    }
    // Previously this returned immediately ("Nothing to do"), which is what
    // stranded healthy BEHIND PRs whenever develop advanced while they were
    // claimed. Always re-evaluate the in-flight PR instead.
    log(`Already in flight: PR #${inFlight}. Re-evaluating instead of no-op'ing.`)
    await maintainInFlight(inFlight, depth)
    return
  }

  const prs = ghJson<GhPrListItem[]>([
    'pr',
    'list',
    '--state',
    'open',
    '--base',
    TARGET_BRANCH,
    '--label',
    READY_LABEL,
    // Explicit: gh defaults to 30, which silently truncates the candidate
    // set -- the astro-market ready list has been observed at 21+ PRs, and
    // a truncated page could hide an older tier-1/HOTFIX PR entirely.
    '--limit',
    '100',
    '--json',
    'number,title,labels,createdAt,isDraft,reviewDecision,author',
  ])
  // excludePr is the PR a caller just evicted, requeued, or watched close.
  // `gh pr list` reads GitHub's search index, which lags label/state
  // mutations by a few seconds -- in production (2026-07-21 15:04Z) an
  // eviction's chained dequeue re-selected the very PR it had evicted two
  // seconds earlier because the index still returned it.
  const candidates = prs.filter((pr) => String(pr.number) !== String(excludePr))
  if (candidates.length === 0) {
    log(
      prs.length > 0
        ? `Queue is empty apart from just-released PR #${excludePr} (excluded this pass; the search index lags label changes).`
        : 'Queue is empty.',
    )
    return
  }

  const yieldCounts = parseYieldCounts(readYieldCountsRaw())
  const withMeta = candidates.map((pr) => ({
    ...pr,
    tier: classifyTier(pr),
    readySince: getReadySince(pr.number, pr.createdAt),
    yieldCount: yieldCounts[String(pr.number)] || 0,
  }))

  withMeta.sort(compareQueueItems)
  // Keep the just-released PR even if the search index has not returned it
  // yet -- that is the count we just incremented in softRequeueToBack.
  pruneStaleYieldCounts([...prs.map((pr) => pr.number), excludePr].filter(Boolean))

  if (depth === 0) {
    const focus = TIER1_LABELS.length > 0 ? TIER1_LABELS.join(' > ') : '(none)'
    log(`Priority labels (first match wins): ${focus}`)
    log(
      `Deprioritized after ticket titles: ${DEPRIORITIZED_TITLE_REGEX} then authors ${DEPRIORITIZED_AUTHORS.join(', ') || '(none)'}`,
    )
    log(
      `Queue order: ${withMeta
        .map((item) => `#${item.number}(t${item.tier}${item.yieldCount ? `,y${item.yieldCount}` : ''})`)
        .join(', ')}`,
    )
  }

  // Walk candidates in priority order and claim the first one native
  // auto-merge could actually complete. Drafts and PRs whose review state
  // blocks merging must not be claimed: auto-merge silently waits forever
  // on them, and claiming one head-of-line blocks the entire queue until
  // the watchdog's stale timer fires. Production evidence (2026-07-21):
  // dequeue claimed #3614 -- ready-labeled but CHANGES_REQUESTED since
  // 07-14 -- and the queue merged nothing for the next several hours.
  for (const next of withMeta) {
    if (next.isDraft) {
      log(
        `Skipping PR #${next.number} "${next.title}": still a draft. It stays queued and becomes eligible when marked ready for review.`,
      )
      continue
    }
    if (next.reviewDecision === 'CHANGES_REQUESTED') {
      // Unlike REVIEW_REQUIRED there is nothing pending about this state --
      // only a human can resolve it (address the review or dismiss it), so
      // evict with a comment rather than skipping silently: the author
      // needs to know the ready label is doing nothing.
      await evict(
        next.number,
        `A reviewer has requested changes (reviewDecision=CHANGES_REQUESTED), so native auto-merge can never complete this PR. Address the review (or have it dismissed), then re-add \`${READY_LABEL}\`.`,
        depth,
      )
      continue
    }
    if (next.reviewDecision === 'REVIEW_REQUIRED') {
      log(
        `Skipping PR #${next.number} "${next.title}": reviewDecision=REVIEW_REQUIRED (the base branch requires an approving review this PR does not have yet). It stays queued and becomes eligible once approved.`,
      )
      continue
    }

    log(
      `Dequeuing PR #${next.number} "${next.title}" (tier ${next.tier}, created ${next.createdAt}, yields ${next.yieldCount || 0}, ready since ${next.readySince})`,
    )

    // Claim BEFORE calling update-branch so a crash mid-call is visible as
    // "stuck in flight" (catchable by the watchdog) rather than invisible.
    setVar('MERGE_QUEUE_PR', String(next.number))
    setVar('MERGE_QUEUE_SHA', 'pending')
    setVar('MERGE_QUEUE_CLAIMED_AT', new Date().toISOString())
    // A fresh claim starts a fresh cancelled-check re-run budget -- the
    // counters deliberately survive everything within a flight (see header),
    // so this claim-time reset is the ONLY thing that stops an
    // evicted-then-requeued PR from inheriting spent budget and getting
    // insta-evicted on its first transient cancellation.
    deleteVar('MERGE_QUEUE_RERUN_PR')
    deleteVar('MERGE_QUEUE_RERUN_COUNT')
    addLabel(next.number, PROCESSING_LABEL)

    await updateBranchAndWatch(next.number, depth)
    return
  }

  log(
    `No eligible PRs: every ready-labeled PR targeting ${TARGET_BRANCH} is a draft or blocked on review. Queue stays idle until one becomes eligible (approval, un-draft) -- the schedule tick or the next push/label event will pick it up.`,
  )
}

async function checkCompletion(): Promise<void> {
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
  let snap: PrSnapshot
  try {
    snap = viewPr(pr)
  } catch (err) {
    log(`Could not load PR #${pr} for check-completion: ${errorText(err).split('\n')[0]}`)
    return
  }

  if (snap.state !== 'OPEN') {
    log(`PR #${pr} is ${snap.state}. Clearing claim and advancing the queue.`)
    removeLabel(pr, PROCESSING_LABEL)
    clearQueueState()
    await dequeue(0, String(pr))
    return
  }

  // Same draft guard as maintainInFlight: auto-merge cannot complete a
  // draft, and there is no point watching checks on one.
  if (snap.isDraft) {
    await softRequeueToBack(
      pr,
      `Soft-requeued by the merge queue: this PR was converted to draft while in flight, and native auto-merge cannot complete a draft PR. It keeps \`${READY_LABEL}\` and becomes eligible again when marked ready for review.`,
    )
    return
  }

  // Same review-state guard as maintainInFlight: BLOCKED cannot distinguish
  // "waiting for checks" from "unmergeable review state", and there is no
  // point re-syncing or watching checks on a PR auto-merge can never finish.
  if (snap.reviewDecision === 'CHANGES_REQUESTED') {
    await evict(
      pr,
      `A reviewer has requested changes (reviewDecision=CHANGES_REQUESTED), so native auto-merge can never complete this PR. Address the review (or have it dismissed), then re-add \`${READY_LABEL}\`.`,
    )
    return
  }
  if (snap.reviewDecision === 'REVIEW_REQUIRED') {
    await softRequeueToBack(
      pr,
      `Soft-requeued by the merge queue: this PR needs an approving review it does not currently have (reviewDecision=REVIEW_REQUIRED), so native auto-merge cannot complete it. It keeps \`${READY_LABEL}\` and yields this pass so another ready PR can proceed; it now sorts behind same-rank peers it has already yielded to and becomes eligible again once approved.`,
    )
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

  let checks: GhCheck[]
  try {
    checks = ghJsonAsDefaultToken<GhCheck[]>(['pr', 'checks', pr, '--required', '--json', 'name,bucket,link'])
  } catch (err) {
    // Transient API failure (or gh's "no checks reported" error, which
    // exits 1 even with --json). Keep the claim and stay green -- the next
    // completion event or watchdog tick re-reads; a red run here just
    // drowns out real failures in the Actions tab (same rationale as the
    // watchdog's identical guard).
    log(
      `Could not read required checks for PR #${pr}: ${errorText(err).split('\n')[0]}. Leaving the claim for a later pass.`,
    )
    return
  }
  // 'fail' only -- cancelled is handled separately below, because it is not
  // a verdict on the code (job timeouts and concurrency supersessions both
  // report as cancelled) and used to wrongly evict healthy PRs here. Note
  // gh buckets a TIMED_OUT conclusion as 'fail', not 'cancel' -- that case
  // (the check logic itself timing out, rather than the job wrapper being
  // cancelled) still evicts, which is the right call for a check that ran
  // and could not finish.
  const failing = checks.filter((c) => c.bucket === 'fail')
  const cancelled = checks.filter((c) => c.bucket === 'cancel')
  const stillPending = checks.filter((c) => c.bucket === 'pending')
  if (failing.length === 0 && cancelled.length > 0) {
    if (stillPending.length > 0) {
      // The check set has not settled: a sibling required check is still
      // executing, so its completion event is guaranteed to re-enter here.
      // Acting now would try to re-run a run GitHub may still consider in
      // progress and double-count the attempt budget for what is really
      // one cancellation episode.
      log(
        `Required check(s) ended cancelled on PR #${pr} (${cancelled.map((c) => c.name).join(', ')}) but ${stillPending.length} required check(s) are still pending. Waiting for the set to settle.`,
      )
      return
    }
    await rerunCancelledChecks(pr, cancelled)
    return
  }
  if (failing.length === 0) {
    // Enabling auto-merge at claim time (in dequeue) can silently fail if
    // GitHub requires branch-protection conditions to already be met at the
    // moment it's requested -- unconfirmed whether that applies to classic
    // per-PR auto-merge, but cheap to guard against regardless. Re-verify
    // and retry here, on every check-completion run, rather than trusting
    // the single claim-time attempt.
    const autoMergeState = ghJson<{ autoMergeRequest: { enabledBy?: string } | null }>(['pr', 'view', pr, '--json', 'autoMergeRequest']).autoMergeRequest
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

async function cleanup(): Promise<void> {
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
    const head = ghJson<{ headRefOid: string }>(['pr', 'view', EVENT_PR_NUMBER, '--json', 'headRefOid']).headRefOid
    setVar('MERGE_QUEUE_SHA', head)
    enableAutoMerge(EVENT_PR_NUMBER)
    log(`Now watching PR #${EVENT_PR_NUMBER} at ${head}.`)
    return
  }

  log(`Clearing in-flight state for PR #${EVENT_PR_NUMBER} (event: ${EVENT_ACTION}).`)
  removeLabel(EVENT_PR_NUMBER, PROCESSING_LABEL)
  clearYieldCount(EVENT_PR_NUMBER)
  clearQueueState()
  // Not an eviction -- no requires-action label, no comment. Being closed
  // or unlabeled isn't a failure, just no longer applicable to what the
  // queue was watching.

  // The queue is idle again now, but nothing else guarantees a fresh dequeue
  // gets triggered -- an unlabeled/close on the in-flight PR isn't a push
  // or a labeled event itself. Without this, a still-ready PR elsewhere in
  // the queue would sit stalled until some unrelated trigger fired.
  // Pick up the next one immediately instead (excluding the PR that just
  // closed/unlabeled -- the search index may still return it for a few
  // seconds).
  await dequeue(0, String(EVENT_PR_NUMBER))
}

async function watchdog(): Promise<void> {
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
  let snap: PrSnapshot
  try {
    snap = viewPr(stillPr)
  } catch (err) {
    log(`Could not load stale PR #${stillPr}: ${errorText(err).split('\n')[0]}. Evicting claim.`)
    clearQueueState()
    await dequeue(0, String(stillPr))
    return
  }

  if (snap.state !== 'OPEN') {
    log(`Stale in-flight PR #${stillPr} is ${snap.state}. Clearing and advancing.`)
    removeLabel(stillPr, PROCESSING_LABEL)
    clearQueueState()
    await dequeue(0, String(stillPr))
    return
  }

  try {
    const checks = ghJsonAsDefaultToken<GhCheck[]>(['pr', 'checks', stillPr, '--required', '--json', 'name,bucket,link'])
    // 'fail' only -- cancelled gets the bounded re-run treatment below, not
    // an eviction (job timeouts report as cancelled; see check-completion).
    const failing = checks.filter((c) => c.bucket === 'fail')
    if (failing.length > 0) {
      const names = failing.map((c) => c.name).join(', ')
      await evict(
        stillPr,
        `Stuck in the merge queue for over ${STALE_AFTER_MINUTES} minutes with failing required check(s): ${names}.`,
      )
      return
    }
    const pending = checks.filter((c) => c.bucket === 'pending')
    const cancelled = checks.filter((c) => c.bucket === 'cancel')
    // Only re-run once the set has settled (no pending) -- a cancel+pending
    // mix falls through to the pending soft-requeue below, same as any
    // still-running set; the next settle re-evaluates the cancellation.
    if (cancelled.length > 0 && pending.length === 0) {
      log(
        `PR #${stillPr} has cancelled (not failed) required check(s) after ${Math.round(elapsedMinutes)}m: ${cancelled
          .map((c) => c.name)
          .join(', ')}. Attempting a bounded re-run instead of evicting.`,
      )
      await rerunCancelledChecks(stillPr, cancelled)
      return
    }
    if (pending.length > 0) {
      // CI is still running past the budget. Don't mark requires-action for
      // a healthy PR whose only crime is slow E2E -- release the claim so
      // the rest of the queue can move, but leave ready-to-merge so it
      // re-enters naturally once a free slot opens (or the author re-labels).
      // Soft-requeue yields this pass (`excludePr`) and increments
      // MERGE_QUEUE_YIELD_COUNTS so the next dequeue sorts this PR behind
      // same-rank peers it has already blocked, instead of re-claiming the
      // oldest createdAt head every cycle.
      log(
        `PR #${stillPr} still has pending required checks after ${Math.round(elapsedMinutes)}m: ${pending
          .map((c) => c.name)
          .join(', ')}. Soft-requeueing so another ready PR can proceed this pass instead of staying stuck behind slow checks.`,
      )
      await softRequeueToBack(
        stillPr,
        `Soft-requeued by the merge-queue watchdog: still running required checks after ${Math.round(elapsedMinutes)} minutes (${pending
          .map((c) => c.name)
          .join(
            ', ',
          )}). Left in the queue (still has \`${READY_LABEL}\`) and skipped for this pass so other ready PRs can proceed. It now sorts behind same-rank peers it has already yielded to. No action needed unless checks ultimately fail.`,
      )
      return
    }
  } catch (err) {
    log(`Could not read required checks for stale PR #${stillPr}: ${errorText(err).split('\n')[0]}`)
  }

  await evict(
    stillPr,
    `Stuck in the merge queue for over ${STALE_AFTER_MINUTES} minutes with no resolution (checks not failing, auto-merge did not complete, mergeStateStatus=${snap.mergeStateStatus}, reviewDecision=${snap.reviewDecision || 'none'}). Confirm branch protection / review requirements / deploy-lock, then re-add \`${READY_LABEL}\`.`,
  )
}

const commands: Record<string, () => Promise<void>> = { dequeue, 'check-completion': checkCompletion, cleanup, watchdog }
const run = commands[COMMAND]
if (!run) {
  throw new Error(`Unknown command: ${COMMAND}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
