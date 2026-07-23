# workflows

Shared, stack-agnostic GitHub Actions and reusable workflows used across Howdy repos (`astro-market`, `ai-matching-platform`, and others).

This repo exists to centralize CI/CD mechanics that are duplicated across repos but carry no repo-specific business logic — Slack notifications, deploy-lock coordination, secret scanning, PR review scaffolding, etc. Anything tied to a specific stack (Terraform/GCP orchestration, Heroku/Docker app fan-out, Prisma/Alembic migrations) stays in its own repo.

## Usage

Reference actions and workflows by tag, not by branch:

```yaml
- uses: howdycom/workflows/actions/slack-notification@v1
  with:
    status: success
    environment: production
    workflow_name: ${{ github.workflow }}
    bot_token: ${{ secrets.SLACK_BOT_TOKEN }}
    channel_id: ${{ vars.SLACK_CHANNEL_ID }}
```

## Available actions

| Action | Purpose |
|---|---|
| [`actions/free-disk-space`](actions/free-disk-space) | Frees disk space on GitHub-hosted runners before large Docker builds. |
| [`actions/slack-notification`](actions/slack-notification) | Posts a status notification (deploy, scheduled job, CI result) to Slack via Block Kit. |
| [`actions/claude-remediation-prepare`](actions/claude-remediation-prepare) | Validates a `/claude-fix` trigger comment, checks commenter permission and branch/build-tooling safety, and gathers PR context (metadata, diff, comments) for a Claude remediation run. Runs on plain `node`, no repo toolchain needed. |
| [`actions/open-remediation-pr`](actions/open-remediation-pr) | Commits working-tree changes as `github-actions[bot]`, pushes a new branch, and opens a draft PR against a given base branch. |
| [`actions/merge-queue`](actions/merge-queue) | One state-machine step (`dequeue` / `check-completion` / `cleanup` / `watchdog`) of the merge-queue simulator — see below. |

## Available reusable workflows

| Workflow | Purpose |
|---|---|
| [`.github/workflows/merge-queue.yml`](.github/workflows/merge-queue.yml) | Serializes label-marked ("ready to merge") PRs into a target branch: priority-tiered queue, `update-branch` + native auto-merge for the happy path, event-driven failure detection (no polling except a rare watchdog). Call it from a thin caller workflow with the real triggers — see usage below. |

```yaml
# consumer-repo/.github/workflows/merge-queue.yml
on:
  push:
    branches: [develop]
  pull_request:
    types: [labeled, unlabeled, closed, synchronize]
  workflow_run:
    types: [completed]
  schedule:
    # Watchdog + idle/BEHIND self-heal. One ubuntu-slim job; keep this
    # relatively frequent so a stranded in-flight PR recovers without a
    # multi-hour wait. 30m is a good default; 3h is too slow when develop
    # advances outside the queue and the in-flight PR goes BEHIND.
    - cron: '*/30 * * * *'

jobs:
  process:
    uses: howdycom/workflows/.github/workflows/merge-queue.yml@v1
    with:
      target_branch: develop
      tier1_labels: bug
      tier1_title_regex: '^\[HOTFIX\]'
      tier2_title_regex: '^\[HCP-'
    secrets:
      merge_queue_pat: ${{ secrets.MERGE_QUEUE_GITHUB_TOKEN }}
```

### How the merge queue works

A PR gets the `ready to merge` label once it's approved and green. From there it's automatic — no one manually decides "who merges next":

- **Priority order** — not strict FIFO. Configurable via `tier1_labels`/`tier1_title_regex`/`tier2_title_regex`, defaulting to: PRs labeled `bug` or titled `[HOTFIX]...` go first, then PRs titled `[HCP-...]`, then everything else. Within a tier, whoever's been ready longest goes first (read from when `ready to merge` was actually applied, not PR number or creation date).
- **One PR at a time** — `MERGE_QUEUE_PR` is the single in-flight claim. New ready PRs wait; only the claimed PR is `update-branch`'d and watched.
- **The happy path is free** — on a push to `target_branch`, the next PR in line gets `update-branch`'d against the latest target and has auto-merge enabled (the workflow does this itself — see `queue.mjs`'s `enableAutoMerge`). `dequeue` polls in-job for up to ~60s to confirm the SHA actually changed post-`update-branch`, then GitHub's own auto-merge finishes the job once checks re-pass.
- **Re-sync when the base moves (critical)** — if a PR is already in flight and `target_branch` advances (manual merges, another path landing develop), branch protection with `required_status_checks.strict=true` makes native auto-merge **unable** to finish a `BEHIND` PR. On every subsequent `dequeue` trigger (including push to develop), the queue now **re-evaluates** the in-flight PR via `maintainInFlight`: re-`update-branch` when `mergeStateStatus=BEHIND`, clear and advance when closed/unlabeled, evict on real conflicts. Previously it logged "Already in flight. Nothing to do." and left healthy PRs stranded until the watchdog wrongly `requires action`'d them.
- **`check-completion` also re-syncs BEHIND** — not only when required checks fail. If checks finish on an old head that is now behind the base, it re-updates instead of "leaving it to native auto-merge" forever.
- **`synchronize` keeps the claim** — when the in-flight PR's head moves (our `update-branch` or an author push), cleanup refreshes `MERGE_QUEUE_SHA` and re-arms auto-merge. It does **not** clear the claim and re-dequeue (the old path double-claimed every successful update and raced check-completion).
- **Review state gates the queue** — native auto-merge silently waits forever on a PR whose review state blocks merging, so the queue never claims one: `dequeue` skips drafts and `REVIEW_REQUIRED` PRs (they stay queued, with a log line, and become eligible on approval/un-draft) and **evicts** `CHANGES_REQUESTED` PRs with a comment (only a human can resolve that state, and the author needs to know the ready label is doing nothing). The same guard runs on the *in-flight* PR (`maintainInFlight`/`check-completion`), because the state can change after the claim: changes requested mid-flight → evict; approval dismissed mid-flight (`REVIEW_REQUIRED`) → soft-requeue to the back of its tier, keeping `ready to merge`. Production incident this fixes: a `ready to merge`-labeled PR that had CHANGES_REQUESTED for a week was claimed and head-of-line blocked the astro-market queue for ~3.5 hours (2026-07-21) while every pass logged "still valid ... leaving it to native auto-merge".
- **Cancelled ≠ failed** — a required check that ends *cancelled* is not a verdict on the code: GitHub reports a job that blew its `timeout-minutes` as cancelled (even when the check's actual test/format step passed — this happened in production when a slow dependency install pushed the post-run cache save past a 10-minute job timeout), and concurrency supersession cancels too. Instead of evicting, the queue re-runs the cancelled workflow runs in place (`gh run rerun --failed`, same head SHA, so the watched `MERGE_QUEUE_SHA` stays valid), capped at `MAX_CHECK_RERUN_ATTEMPTS` (2) consecutive attempts per PR — past the cap it evicts with an accurate "keeps ending cancelled, check the job's timeout budget" message rather than a misleading "check failed".
- **Eviction** (removes `ready to merge`, adds `requires action`, comments why) happens on: a real merge conflict (`mergeable=CONFLICTING`), a **required** check *failing* after the update, `CHANGES_REQUESTED` review state, cancelled checks past the re-run cap, or a watchdog timeout where checks are green but merge still never completed (branch protection / review / deploy-lock investigation needed — the diagnostic message now includes `reviewDecision`). Optional/advisory check failures do not evict.
- **Watchdog is smarter than blind eviction** — every schedule run re-evaluates the in-flight PR first (`maintainInFlight`). Past `stale_after_minutes`: failing required checks → evict with names; cancelled required checks → bounded re-run (see above); still-pending required checks → **soft-requeue** (remove+re-add `ready to merge` so `readySince` moves to now and peers aren't starved, without `requires action`); otherwise evict with a diagnostic message. Successful re-syncs refresh `MERGE_QUEUE_CLAIMED_AT` so a PR that keeps getting legitimately rebased isn't false-evicted mid-CI.
- **Evict/requeue never re-picks its own PR in the same pass** — every chained `dequeue()` after an eviction, soft-requeue, or close excludes the PR it just released: `gh pr list` reads GitHub's search index, which lags label mutations by a few seconds, and in production an eviction's chained dequeue re-claimed the PR it had evicted two seconds earlier.
- **No stuck queue** — clearing the in-flight PR for any reason immediately tries the next one. Retryable non-conflict `update-branch` failures release the claim without failing the Actions run (exit 0) so the Actions tab stays readable.

> **Do not add your own top-level `concurrency:` block to the caller workflow.** This reusable workflow already declares `concurrency: group: merge-queue-${{ github.repository }}` internally, and that applies to `workflow_call` invocations of it. A caller that declares a *second* concurrency block using the same group name creates a self-referential wait -- the caller's own job would need to re-enter a group it's already occupying -- which GitHub rejects outright as an invalid workflow file (every trigger type fails with zero jobs created, no useful error surfaced anywhere in the API or UI). This is exactly what broke every run of the astro-market consumer for 4 days: its caller had its own `concurrency:` block "for local readability," using the identical group name.

**Trigger → job mapping.** The reusable workflow has 4 jobs, each with its own `if:` deciding whether it runs at all — this is the exact gating, not a paraphrase:

| Event | Job | Gate / behavior |
|---|---|---|
| `push` to `target_branch` | `dequeue` | Claims next ready PR **or** re-evaluates the current in-flight PR (re-sync if BEHIND) |
| `pull_request` `labeled` | `dequeue` | Only if the label added is `ready_label` — any other label does nothing |
| `pull_request` `synchronize` | `cleanup` | Only if PR matches `MERGE_QUEUE_PR` — refreshes watched SHA, **keeps claim** |
| `pull_request` `closed` | `cleanup` | Only if PR matches `MERGE_QUEUE_PR` — clears claim and dequeues next |
| `pull_request` `unlabeled` | `cleanup` | Same PR-number match, **and** the label removed must specifically be `ready_label` — clears claim and dequeues next |
| `workflow_run` `completed` | `check-completion` | Only if `workflow_run.head_sha == MERGE_QUEUE_SHA` — every other firing is skipped before a runner is allocated (free). On match: fail → evict; cancelled → bounded re-run; BEHIND → re-sync; review blocks merge → evict/soft-requeue; else ensure auto-merge |
| `schedule` | `watchdog` | Always evaluates: maintain in-flight / soft-requeue / evict / idle dequeue |

**Label lifecycle:**

| Label | Added by | Removed by |
|---|---|---|
| `ready_label` (default `ready to merge`) | A human — the only manual step in the whole system; also re-added by watchdog soft-requeue | `evict()` on failure paths; temporarily by soft-requeue |
| `processing_label` (default `merge-queue: processing`) | `dequeue`, immediately after picking a PR — before `update-branch` is even called | `evict()`, cleanup (closed/unlabeled), soft-requeue |
| `requires_action_label` (default `requires action`) | `evict()` only | Never automatically — a human clears it once the underlying problem is fixed |

**State**, for reference: `MERGE_QUEUE_PR` and `MERGE_QUEUE_CLAIMED_AT` are set the instant a PR is claimed (and `CLAIMED_AT` is refreshed on every successful re-sync and on every cancelled-check re-run); `MERGE_QUEUE_SHA` starts as the literal string `"pending"` and is updated to the real post-`update-branch` SHA once it's confirmed (`updateBranchAndWatch` polls for the head SHA to change, up to 12 times / 5s apart) — that's the exact value `check-completion`'s trigger condition compares against. All three are deleted together by whichever of `evict()` / cleanup (closed/unlabeled) / soft-requeue runs. `MERGE_QUEUE_RERUN_PR`/`MERGE_QUEUE_RERUN_COUNT` track consecutive cancelled-check re-runs per PR (deliberately not cleared while the same PR stays in flight — see the comment in `queue.mjs`), alongside the analogous `MERGE_QUEUE_UPDATE_FAIL_PR`/`MERGE_QUEUE_UPDATE_FAIL_COUNT` for update-branch retries.

### Prerequisites for a new consumer repo

Check/set these up before wiring in the caller workflow above:

1. **Two new labels must exist** in the consumer repo: `merge-queue: processing` and `requires action` (or whatever you pass via `processing_label`/`requires_action_label` — defaults shown). System-owned; humans shouldn't need to touch them. The "ready" label (default `ready to merge`) is expected to already exist as part of your existing PR workflow.
2. **`allow_auto_merge` must be enabled** at the repo level (Settings → General → Pull Requests).
3. **`target_branch` needs required status checks configured** in its branch protection — that's what auto-merge is actually waiting on. Check via `gh api repos/{owner}/{repo}/branches/{branch}/protection`.
   **Warning — do not combine this queue with "Dismiss stale pull request approvals when new commits are pushed."** The queue's own `update-branch` pushes a merge commit to every PR it claims; with dismiss-stale on, that push dismisses the very approval the merge needs, the review-state guard sees `REVIEW_REQUIRED`, soft-requeues the PR, and moves on to do the same to the next one — the queue would methodically un-approve your entire ready list (one wasted CI cycle and one bot comment per PR) and then idle. astro-market runs with `dismiss_stale_reviews: false`; verify yours before going live.
4. **A fine-grained PAT** scoped per the security note below, added as a repo secret and passed as `secrets.merge_queue_pat` (not `github_token` — that name is reserved by GitHub and will fail workflow validation entirely, silently breaking every trigger type).
5. **`Settings → Actions → General → Access`** on *this* repo (`howdycom/workflows`) must allow the consumer's org/repo to use its reusable workflows — otherwise every run fails with a generic "workflow file issue" and zero jobs, regardless of anything correct in the consumer's own file.

### Security notes for merge-queue consumers

`GITHUB_TOKEN` cannot write repository Actions variables (no grantable permission scope covers it) — this design tracks in-flight state that way specifically so the `workflow_run` completion listener can be gated by a job-level `if:`, which is what makes it free to run on every completed workflow in the repo (skipped jobs never reach a runner). That means every consumer needs its own fine-grained PAT (e.g. `MERGE_QUEUE_GITHUB_TOKEN`), scoped to exactly: **Contents** (write — required by the `update-branch` endpoint), **Pull requests** (write — labels, comments, update-branch), **Variables** (read/write). Don't broaden it further, and don't reuse a PAT provisioned for a different purpose (e.g. `CLAUDE_REMEDIATION_GITHUB_TOKEN`).

Verify **Contents** is actually granted *write* (not just read) before going live with `dry_run: false` — shadow mode never calls `update-branch` for real, so a missing or read-only Contents permission won't surface until the first live dequeue, and it fails in a way `dequeue()` used to misdiagnose as a merge conflict (see the code comment in `queue.mjs` for the incident this came from).

`check-completion` deliberately does **not** read required checks through the PAT. A fine-grained PAT can't read check-run results (as opposed to legacy commit statuses) created by other Apps via GraphQL, no matter what repository permission you grant it -- confirmed directly: every required check except the one plain commit status (`deploy-lock`) failed to resolve even after adding `Commit statuses: read`. Instead, the `check-completion` and `watchdog` jobs in this reusable workflow request `permissions: checks: read, statuses: read, actions: write, pull-requests: read, contents: read` for their own default `GITHUB_TOKEN`, which has that access out of the box, and `queue.mjs` uses that token for this read-only query plus the cancelled-check `gh run rerun --failed` call (the only reason `actions` is `write` rather than `read` — a job timeout reports its checks as *cancelled*, and re-running them beats evicting a healthy PR). All five are actually necessary -- before `gh pr checks --required` even queries the check rollup, it resolves the PR by number first (needs `pull-requests`), the rollup query itself starts from `commits(last: 1)` on the PR (needs `contents`) before it can reach `statusCheckRollup`, and that rollup reads both the `StatusContext` branch (needs `statuses`) and the `CheckRun -> checkSuite -> workflowRun -> workflow` branch (needs `actions`), not just `checks`. **Your caller's job-level `permissions:` block caps what the called workflow's jobs can be granted** — if you've set `permissions: {}` (as astro-market originally did, to force every mutation through the PAT), you must loosen it to at least those four reads plus `actions: write`; with only `actions: read` the re-run degrades to a logged warning (the failed attempt still counts toward the cap, and the claim clock is deliberately not refreshed when nothing restarted, so recovery stays bounded by `stale_after_minutes` windows until the cap evicts), and with less than the four reads the checks query itself keeps failing.

## Security notes for claude-remediation consumers

`claude-remediation-prepare` and `open-remediation-pr` only handle trigger validation and the git/PR mechanics — the LLM invocation itself (`anthropics/claude-code-action`) is wired up in each consuming repo's own workflow, including its `--allowedTools` Bash allowlist. That allowlist needs to be scoped to **non-executing commands only** (formatters and linters: `black`, `isort`, `prettier`, `eslint --fix`, `flake8`, `mypy`, plus read-only `git diff`/`git status`) — never test or build execution (`pytest`, `npm run test`, `npm run build`, `npm ci`, `uv run`, `make test`, etc.).

Why: confirmed via `anthropics/claude-code-action`'s source (`base-action/src/parse-sdk-options.ts`), the `anthropic_api_key` input is present in the full environment (`{ ...process.env }`) passed to the Claude session, and that environment is inherited by whatever the Bash tool executes. The action explicitly strips two OIDC token-minting variables from that environment but not the API key. A test/build command that reads its own environment (intentionally or via a compromised dependency/test file) can exfiltrate the key. Formatters/linters never execute the target code, so they don't have this exposure — verification that a fix actually works should happen via the normal CI that runs on the resulting draft PR, not inside the remediation job itself.

## Versioning

Changes are tagged with semver (`v1`, `v1.1`, ...). A major tag (`v1`) is kept moving to the latest compatible release so consumers can pin to it without manual bumps; breaking changes bump the major version and get their own tag. Don't reference `main` directly from a consumer workflow.

## Contributing

This repo is consumed by CI in multiple repos across different tech stacks — treat changes here like a library release, not a same-PR edit. Verify a change against both consumer repos (or at least a representative workflow) before tagging a new version.

Changes go through a PR, not direct pushes to `main` (the two composite actions in this repo run with write access and secrets in consuming repos, so review matters here more than usual).
