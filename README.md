# merge-queue

Shared GitHub Actions for a single-flight merge queue, plus a few companion actions that have no repo-specific business logic. The GitHub repository name is `howdycom/merge-queue`. The previous name was `howdycom/workflows`; GitHub redirects that slug after the rename, and the examples below use the new one.

Licensed under the [MIT License](LICENSE).

Howdy repos (`astro-market`, `ai-matching-platform`, and others) were the first callers. The actions are written so another repository can call them without Howdy-specific code.

This repo exists to centralize CI/CD mechanics that are duplicated across repos but carry no repo-specific business logic — Slack notifications, deploy-lock coordination, secret scanning, PR review scaffolding, etc. Anything tied to a specific stack (Terraform/GCP orchestration, Heroku/Docker app fan-out, Prisma/Alembic migrations) stays in its own repo.

## Usage

Reference actions and workflows by tag, not by branch:

```yaml
- uses: howdycom/merge-queue/actions/slack-notification@v1
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
| [`actions/project-sync`](actions/project-sync) | Reproduces a Jira-style PR/push → board status automation on a native GitHub Project (v2). Moves the Status field of the board issues linked to a PR (`Closes #N`) as it progresses; board owner/number and column names are inputs. |

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
    uses: howdycom/merge-queue/.github/workflows/merge-queue.yml@v1
    with:
      target_branch: develop
      # Ordered focus list — first label is highest priority. Keep
      # product-specific names here, not in howdycom/merge-queue.
      # Comma-separated or a YAML block both work:
      #   tier1_labels: |
      #     bug
      #     security
      tier1_labels: bug, security
      tier1_title_regex: '^\[HOTFIX\]'
      # Ticket titles after every focus label. Include `[#1234]` when the
      # consumer uses GitHub issues rather than leftover `[HCP-…]` Jira keys.
      tier2_title_regex: '^\[(#\d+|HCP-)'
      deprioritized_title_regex: '^\[TECH\]'
      deprioritized_authors: dependabot,dependabot[bot],app/dependabot
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: write
      checks: read
      statuses: read
```

### How the merge queue works

A PR gets the `ready to merge` label once it's approved and green. From there it's automatic — no one manually decides "who merges next":

- **Priority order** — not strict FIFO. Configurable via `tier1_labels`/`tier1_title_regex`/`tier2_title_regex`/`deprioritized_title_regex`/`deprioritized_authors`. `tier1_labels` is an **ordered** list (comma- or newline-separated): the first matching label wins, then the second, and so on. Title `[HOTFIX]...` stays at rank 1 with the first label so emergencies still jump the queue. After every configured focus label: titles matching `tier2_title_regex` (default leftover `[HCP-…]`; pass `^\[(#\d+|HCP-)` so GitHub `[#1234]` issue titles sit here too), then other human PRs, then `deprioritized_title_regex` (default `[TECH]`), then `deprioritized_authors` (default Dependabot, **always last** even with a focus label). A PR that carries several focus labels uses the earliest match. Within a rank, oldest PR first (`createdAt`, then number) so older PRs merge before newer ones added to the same rank — not when `ready to merge` was applied. A PR that has already **soft-requeued** (pending checks past the stale window, missing approval, draft) sorts behind same-rank peers it already blocked, via a per-PR yield count stored in `MERGE_QUEUE_YIELD_COUNTS`; equal yield counts still fall through to `createdAt`. That replaces the old `readySince` bump, which `createdAt` ordering made a no-op. Repeated re-claiming after every remaining same-rank peer has also yielded equally is accepted — that is a periodic retry, not a head-of-line block of peers. Default when a consumer omits the list: `bug`. Product-specific labels (`workspace`, `app-onboarding`, etc.) belong in the calling repo so this workflow stays reusable.
- **One PR at a time** — `MERGE_QUEUE_PR` is the single in-flight claim. New ready PRs wait; only the claimed PR is `update-branch`'d and watched.
- **The happy path is free** — on a push to `target_branch`, the next PR in line gets `update-branch`'d against the latest target and has auto-merge enabled (the workflow does this itself — see `queue.mjs`'s `enableAutoMerge`). `dequeue` polls in-job for up to ~60s to confirm the SHA actually changed post-`update-branch`, then GitHub's own auto-merge finishes the job once checks re-pass.
- **Re-sync when the base moves (critical)** — if a PR is already in flight and `target_branch` advances (manual merges, another path landing develop), branch protection with `required_status_checks.strict=true` makes native auto-merge **unable** to finish a `BEHIND` PR. On every subsequent `dequeue` trigger (including push to develop), the queue now **re-evaluates** the in-flight PR via `maintainInFlight`: re-`update-branch` when `mergeStateStatus=BEHIND`, clear and advance when closed/unlabeled, evict on real conflicts. Previously it logged "Already in flight. Nothing to do." and left healthy PRs stranded until the watchdog wrongly `requires action`'d them.
- **`check-completion` also re-syncs BEHIND** — not only when required checks fail. If checks finish on an old head that is now behind the base, it re-updates instead of "leaving it to native auto-merge" forever.
- **`synchronize` keeps the claim** — when the in-flight PR's head moves (our `update-branch` or an author push), cleanup refreshes `MERGE_QUEUE_SHA` and re-arms auto-merge. It does **not** clear the claim and re-dequeue (the old path double-claimed every successful update and raced check-completion).
- **Review state gates the queue** — native auto-merge silently waits forever on a PR whose review state blocks merging, so the queue never claims one: `dequeue` skips drafts and `REVIEW_REQUIRED` PRs (they stay queued, with a log line, and become eligible on approval/un-draft) and **evicts** `CHANGES_REQUESTED` PRs with a comment (only a human can resolve that state, and the author needs to know the ready label is doing nothing). The same guard runs on the *in-flight* PR (`maintainInFlight`/`check-completion`), because the state can change after the claim: changes requested mid-flight → evict; approval dismissed mid-flight (`REVIEW_REQUIRED`) → soft-requeue (yield this pass, keeping `ready to merge`). Production incident this fixes: a `ready to merge`-labeled PR that had CHANGES_REQUESTED for a week was claimed and head-of-line blocked the astro-market queue for ~3.5 hours (2026-07-21) while every pass logged "still valid ... leaving it to native auto-merge".
- **Cancelled ≠ failed** — a required check that ends *cancelled* is not a verdict on the code: GitHub reports a job that blew its `timeout-minutes` as cancelled (even when the check's actual test/format step passed — this happened in production when a slow dependency install pushed the post-run cache save past a 10-minute job timeout), and concurrency supersession cancels too. Instead of evicting, the queue re-runs the cancelled workflow runs in place (`gh run rerun --failed`, same head SHA, so the watched `MERGE_QUEUE_SHA` stays valid), capped at `MAX_CHECK_RERUN_ATTEMPTS` (2) consecutive attempts per PR — past the cap it evicts with an accurate "keeps ending cancelled, check the job's timeout budget" message rather than a misleading "check failed".
- **Eviction** (removes `ready to merge`, adds `requires action`, comments why) happens on: a real merge conflict (`mergeable=CONFLICTING`), a **required** check *failing* after the update, `CHANGES_REQUESTED` review state, cancelled checks past the re-run cap, or a watchdog timeout where checks are green but merge still never completed (branch protection / review / deploy-lock investigation needed — the diagnostic message now includes `reviewDecision`). Optional/advisory check failures do not evict.
- **Watchdog is smarter than blind eviction** — every schedule run re-evaluates the in-flight PR first (`maintainInFlight`). Past `stale_after_minutes`: failing required checks → evict with names; cancelled required checks → bounded re-run (see above); still-pending required checks → **soft-requeue** (keep `ready to merge`, skip that PR for this pass so a peer can proceed, without `requires action`, and increment its yield count so the next dequeue sorts it behind same-rank peers it already blocked); otherwise evict with a diagnostic message. Successful re-syncs refresh `MERGE_QUEUE_CLAIMED_AT` so a PR that keeps getting legitimately rebased isn't false-evicted mid-CI.
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

> **Caller-side event filters (cross-repo coupling).** Consumers may add a job-level `if:` on the *caller* workflow (before `uses: howdycom/merge-queue/...`) so non-queue-affecting events never enter the reusable workflow at all — e.g. astro-market skips draft `pull_request`s and only forwards `synchronize`/`closed` when the PR is the current `MERGE_QUEUE_PR` claim ([astro-market `.github/workflows/merge-queue.yml`](https://github.com/howdycom/astro-market/blob/develop/.github/workflows/merge-queue.yml)). That filter drops events *before this reusable workflow runs*, so the table above only sees what the caller lets through. If you change a job `if:` here **or** a consumer pre-filter, keep both sides aligned: a mismatch fails silently (queue stops reacting; no Actions error). Document any consumer pre-filter next to its `if:` with a pointer back to this section.

**Label lifecycle:**

| Label | Added by | Removed by |
|---|---|---|
| `ready_label` (default `ready to merge`) | A human — the only manual step in the whole system; also re-added by watchdog soft-requeue | `evict()` on failure paths; temporarily by soft-requeue |
| `processing_label` (default `merge-queue: processing`) | `dequeue`, immediately after picking a PR — before `update-branch` is even called | `evict()`, cleanup (closed/unlabeled), soft-requeue |
| `requires_action_label` (default `requires action`) | `evict()` only | Never automatically — a human clears it once the underlying problem is fixed |

**State**, for reference: claim fields live in `merge-queue-state`/`state.json` (contents: write on `GITHUB_TOKEN`). `MERGE_QUEUE_PR` and `MERGE_QUEUE_CLAIMED_AT` are set the instant a PR is claimed (and `CLAIMED_AT` is refreshed on every successful re-sync and on every cancelled-check re-run); `MERGE_QUEUE_SHA` starts as the literal string `"pending"` and is updated to the real post-`update-branch` SHA once it's confirmed (`updateBranchAndWatch` polls for the head SHA to change, up to 12 times / 5s apart). Cleanup on `synchronize`/`closed` is gated on the `merge-queue: processing` label, not on Actions variables. All three claim fields are deleted together by whichever of `evict()` / cleanup (closed/unlabeled) / soft-requeue runs. `MERGE_QUEUE_RERUN_PR`/`MERGE_QUEUE_RERUN_COUNT` track consecutive cancelled-check re-runs per PR (deliberately not cleared while the same PR stays in flight — see the comment in `queue.mjs`), alongside the analogous `MERGE_QUEUE_UPDATE_FAIL_PR`/`MERGE_QUEUE_UPDATE_FAIL_COUNT` for update-branch retries. `MERGE_QUEUE_YIELD_COUNTS` is a compact `prNumber:count` map of soft-requeues; it is the within-tier demotion key, dropped when a PR is evicted, closed, or unlabeled so a human re-queue starts at 0.

### Prerequisites for a new consumer repo

Check/set these up before wiring in the caller workflow above:

1. **Two new labels must exist** in the consumer repo: `merge-queue: processing` and `requires action` (or whatever you pass via `processing_label`/`requires_action_label` — defaults shown). System-owned; humans shouldn't need to touch them. The "ready" label (default `ready to merge`) is expected to already exist as part of your existing PR workflow.
2. **`allow_auto_merge` must be enabled** at the repo level (Settings → General → Pull Requests).
3. **`target_branch` needs required status checks configured** in its branch protection — that's what auto-merge is actually waiting on. Check via `gh api repos/{owner}/{repo}/branches/{branch}/protection`.
   **Warning — do not combine this queue with "Dismiss stale pull request approvals when new commits are pushed."** The queue's own `update-branch` pushes a merge commit to every PR it claims; with dismiss-stale on, that push dismisses the very approval the merge needs, the review-state guard sees `REVIEW_REQUIRED`, soft-requeues the PR, and moves on to do the same to the next one — the queue would methodically un-approve your entire ready list (one wasted CI cycle and one bot comment per PR) and then idle. astro-market runs with `dismiss_stale_reviews: false`; verify yours before going live.
4. **Caller `permissions:`** must grant `contents: write` (update-branch plus the `merge-queue-state` JSON file), `pull-requests: write`, `issues: write` (label mutations use Issues REST), `actions: write` (cancelled-check re-run), `checks: read`, and `statuses: read`. Do not pass a secret named `github_token` — that name is reserved by GitHub and fails workflow validation. `secrets.merge_queue_pat` is optional; omit it and jobs use `github.token`.
5. **While this repository is private**, `Settings → Actions → General → Access` on `howdycom/merge-queue` must allow the consumer's org or repo to use its reusable workflows. Otherwise every run fails with a generic "workflow file issue" and zero jobs. After the repository is public, outside callers can use the workflow without that allow-list.

### Security notes for merge-queue consumers

Queue state is a JSON file on branch `merge-queue-state`. `GITHUB_TOKEN` can write repository contents, so a user PAT is not required. Do not forward every `workflow_run` completion into this reusable workflow: the shared concurrency group will cancel real dequeue/cleanup work. Gate `synchronize`/`closed` on the processing label, and let the schedule watchdog cover check-completion.

Verify **Contents** is actually granted *write* (not just read) before going live with `dry_run: false` — shadow mode never calls `update-branch` for real, so a missing or read-only Contents permission won't surface until the first live dequeue, and it fails in a way `dequeue()` used to misdiagnose as a merge conflict (see the code comment in `queue.mjs` for the incident this came from).

Required-check reads and cancelled-check re-runs use the job's default `GITHUB_TOKEN` (`MQ_GITHUB_TOKEN`) because a fine-grained PAT cannot read other Apps' check runs via GraphQL. The caller `permissions:` block caps what the called jobs can be granted: they need `checks: read`, `statuses: read`, `actions: write`, `pull-requests: write`, `issues: write`, and `contents: write`. With only `actions: read` the re-run degrades to a logged warning (the failed attempt still counts toward the cap, and the claim clock is deliberately not refreshed when nothing restarted, so recovery stays bounded by `stale_after_minutes` windows until the cap evicts).

## Security notes for claude-remediation consumers

`claude-remediation-prepare` and `open-remediation-pr` only handle trigger validation and the git/PR mechanics — the LLM invocation itself (`anthropics/claude-code-action`) is wired up in each consuming repo's own workflow, including its `--allowedTools` Bash allowlist. That allowlist needs to be scoped to **non-executing commands only** (formatters and linters: `black`, `isort`, `prettier`, `eslint --fix`, `flake8`, `mypy`, plus read-only `git diff`/`git status`) — never test or build execution (`pytest`, `npm run test`, `npm run build`, `npm ci`, `uv run`, `make test`, etc.).

Why: confirmed via `anthropics/claude-code-action`'s source (`base-action/src/parse-sdk-options.ts`), the `anthropic_api_key` input is present in the full environment (`{ ...process.env }`) passed to the Claude session, and that environment is inherited by whatever the Bash tool executes. The action explicitly strips two OIDC token-minting variables from that environment but not the API key. A test/build command that reads its own environment (intentionally or via a compromised dependency/test file) can exfiltrate the key. Formatters/linters never execute the target code, so they don't have this exposure — verification that a fix actually works should happen via the normal CI that runs on the resulting draft PR, not inside the remediation job itself.

## Versioning

Changes are tagged with semver (`v1`, `v1.1`, ...). A major tag (`v1`) is kept moving to the latest compatible release so consumers can pin to it without manual bumps; breaking changes bump the major version and get their own tag. Don't reference `main` directly from a consumer workflow.

## Contributing

This repo is consumed by CI in multiple repos across different tech stacks — treat changes here like a library release, not a same-PR edit. Verify a change against both consumer repos (or at least a representative workflow) before tagging a new version.

Changes go through a PR, not direct pushes to `main` (the two composite actions in this repo run with write access and secrets in consuming repos, so review matters here more than usual).
