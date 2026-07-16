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
    - cron: '0 */3 * * *'   # watchdog only

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
- **The happy path is free** — on a push to `target_branch`, the next PR in line gets `update-branch`'d against the latest target and has auto-merge enabled (the workflow does this itself now — see `queue.mjs`'s `enableAutoMerge`, don't rely on the PR author having turned it on already). `dequeue` polls in-job for up to ~60s to confirm the SHA actually changed post-`update-branch` (a bounded wait inside one run, not a recurring trigger), then GitHub's own auto-merge finishes the job once checks re-pass. No cross-run polling and no extra scheduled Action runs for the common case.
- **Eviction** (removes `ready to merge`, adds `requires action`, comments why) happens on: a merge conflict from `update-branch` (immediate, no checks to wait for), a **required** check failing after the update (optional/advisory check failures don't evict), or the watchdog timing out a PR that's been in flight past `stale_after_minutes` with no resolution. A PR closed, unlabeled, or freshly pushed to while in flight is cleaned up the same way state-wise, but isn't treated as a failure — no `requires action`, no comment.
- **No stuck queue** — clearing the in-flight PR for any reason (eviction or clean cleanup) immediately tries the next one, rather than waiting for an unrelated event to happen to notice. The only *scheduled, recurring* trigger in the whole system is the watchdog, purely as a last resort for CI that never completes at all — everything else (including the `update-branch` settle-check above) is either event-driven or a bounded wait inside a single run.

> **Do not add your own top-level `concurrency:` block to the caller workflow.** This reusable workflow already declares `concurrency: group: merge-queue-${{ github.repository }}` internally, and that applies to `workflow_call` invocations of it. A caller that declares a *second* concurrency block using the same group name creates a self-referential wait -- the caller's own job would need to re-enter a group it's already occupying -- which GitHub rejects outright as an invalid workflow file (every trigger type fails with zero jobs created, no useful error surfaced anywhere in the API or UI). This is exactly what broke every run of the astro-market consumer for 4 days: its caller had its own `concurrency:` block "for local readability," using the identical group name.

**Trigger → job mapping.** The reusable workflow has 4 jobs, each with its own `if:` deciding whether it runs at all — this is the exact gating, not a paraphrase:

| Event | Job | Gate |
|---|---|---|
| `push` to `target_branch` | `dequeue` | Always tries — the branch filter belongs on the caller's trigger, not this condition |
| `pull_request` `labeled` | `dequeue` | Only if the label added is `ready_label` — any other label does nothing |
| `pull_request` `closed` / `synchronize` | `cleanup` | Only if the PR number matches `MERGE_QUEUE_PR` — an unrelated PR does nothing |
| `pull_request` `unlabeled` | `cleanup` | Same PR-number match, **and** the label removed must specifically be `ready_label` — removing an unrelated label from the in-flight PR does nothing |
| `workflow_run` `completed` | `check-completion` | Only if `workflow_run.head_sha == MERGE_QUEUE_SHA` — every other firing (any other PR, any other SHA) is skipped before a runner is allocated, which is what keeps this free regardless of how often it fires |
| `schedule` | `watchdog` | Always evaluates; only acts if the in-flight PR has been claimed longer than `stale_after_minutes` |

**Label lifecycle:**

| Label | Added by | Removed by |
|---|---|---|
| `ready_label` (default `ready to merge`) | A human — the only manual step in the whole system | `evict()` on any failure path |
| `processing_label` (default `merge-queue: processing`) | `dequeue`, immediately after picking a PR — before `update-branch` is even called | `evict()`, or `cleanup` (closed/unlabeled/synchronize) |
| `requires_action_label` (default `requires action`) | `evict()` only | Never automatically — a human clears it once the underlying problem is fixed |

**State**, for reference: `MERGE_QUEUE_PR` and `MERGE_QUEUE_CLAIMED_AT` are set the instant a PR is claimed; `MERGE_QUEUE_SHA` starts as the literal string `"pending"` and is updated to the real post-`update-branch` SHA once it's confirmed (`dequeue` polls for the head SHA to change, up to 12 times / 5s apart) — that's the exact value `check-completion`'s trigger condition compares against. All three are deleted together by whichever of `evict()`/`cleanup()` runs.

### Prerequisites for a new consumer repo

Check/set these up before wiring in the caller workflow above:

1. **Two new labels must exist** in the consumer repo: `merge-queue: processing` and `requires action` (or whatever you pass via `processing_label`/`requires_action_label` — defaults shown). System-owned; humans shouldn't need to touch them. The "ready" label (default `ready to merge`) is expected to already exist as part of your existing PR workflow.
2. **`allow_auto_merge` must be enabled** at the repo level (Settings → General → Pull Requests).
3. **`target_branch` needs required status checks configured** in its branch protection — that's what auto-merge is actually waiting on. Check via `gh api repos/{owner}/{repo}/branches/{branch}/protection`.
4. **A fine-grained PAT** scoped per the security note below, added as a repo secret and passed as `secrets.merge_queue_pat` (not `github_token` — that name is reserved by GitHub and will fail workflow validation entirely, silently breaking every trigger type).
5. **`Settings → Actions → General → Access`** on *this* repo (`howdycom/workflows`) must allow the consumer's org/repo to use its reusable workflows — otherwise every run fails with a generic "workflow file issue" and zero jobs, regardless of anything correct in the consumer's own file.

### Security notes for merge-queue consumers

`GITHUB_TOKEN` cannot write repository Actions variables (no grantable permission scope covers it) — this design tracks in-flight state that way specifically so the `workflow_run` completion listener can be gated by a job-level `if:`, which is what makes it free to run on every completed workflow in the repo (skipped jobs never reach a runner). That means every consumer needs its own fine-grained PAT (e.g. `MERGE_QUEUE_GITHUB_TOKEN`), scoped to exactly: **Contents** (write — required by the `update-branch` endpoint), **Pull requests** (write — labels, comments, update-branch), **Variables** (read/write). Don't broaden it further, and don't reuse a PAT provisioned for a different purpose (e.g. `CLAUDE_REMEDIATION_GITHUB_TOKEN`).

Verify **Contents** is actually granted *write* (not just read) before going live with `dry_run: false` — shadow mode never calls `update-branch` for real, so a missing or read-only Contents permission won't surface until the first live dequeue, and it fails in a way `dequeue()` used to misdiagnose as a merge conflict (see the code comment in `queue.mjs` for the incident this came from).

`check-completion` deliberately does **not** read required checks through the PAT. A fine-grained PAT can't read check-run results (as opposed to legacy commit statuses) created by other Apps via GraphQL, no matter what repository permission you grant it -- confirmed directly: every required check except the one plain commit status (`deploy-lock`) failed to resolve even after adding `Commit statuses: read`. Instead, the `check-completion` job in this reusable workflow requests `permissions: checks: read, statuses: read, actions: read, pull-requests: read` for its own default `GITHUB_TOKEN`, which has that access out of the box, and `queue.mjs` uses that token for just this one read-only query. All four are actually necessary -- before `gh pr checks --required` even queries the check rollup, it resolves the PR by number first (needs `pull-requests`), and the rollup query itself reads both the `StatusContext` branch (needs `statuses`) and the `CheckRun -> checkSuite -> workflowRun -> workflow` branch (needs `actions`), not just `checks`. **Your caller's job-level `permissions:` block caps what the called workflow's jobs can be granted** — if you've set `permissions: {}` (as astro-market originally did, to force every mutation through the PAT), you must loosen it to at least those four read permissions or this query will keep failing.

## Security notes for claude-remediation consumers

`claude-remediation-prepare` and `open-remediation-pr` only handle trigger validation and the git/PR mechanics — the LLM invocation itself (`anthropics/claude-code-action`) is wired up in each consuming repo's own workflow, including its `--allowedTools` Bash allowlist. That allowlist needs to be scoped to **non-executing commands only** (formatters and linters: `black`, `isort`, `prettier`, `eslint --fix`, `flake8`, `mypy`, plus read-only `git diff`/`git status`) — never test or build execution (`pytest`, `npm run test`, `npm run build`, `npm ci`, `uv run`, `make test`, etc.).

Why: confirmed via `anthropics/claude-code-action`'s source (`base-action/src/parse-sdk-options.ts`), the `anthropic_api_key` input is present in the full environment (`{ ...process.env }`) passed to the Claude session, and that environment is inherited by whatever the Bash tool executes. The action explicitly strips two OIDC token-minting variables from that environment but not the API key. A test/build command that reads its own environment (intentionally or via a compromised dependency/test file) can exfiltrate the key. Formatters/linters never execute the target code, so they don't have this exposure — verification that a fix actually works should happen via the normal CI that runs on the resulting draft PR, not inside the remediation job itself.

## Versioning

Changes are tagged with semver (`v1`, `v1.1`, ...). A major tag (`v1`) is kept moving to the latest compatible release so consumers can pin to it without manual bumps; breaking changes bump the major version and get their own tag. Don't reference `main` directly from a consumer workflow.

## Contributing

This repo is consumed by CI in multiple repos across different tech stacks — treat changes here like a library release, not a same-PR edit. Verify a change against both consumer repos (or at least a representative workflow) before tagging a new version.

Changes go through a PR, not direct pushes to `main` (the two composite actions in this repo run with write access and secrets in consuming repos, so review matters here more than usual).
