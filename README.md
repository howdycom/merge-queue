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

## Security notes for claude-remediation consumers

`claude-remediation-prepare` and `open-remediation-pr` only handle trigger validation and the git/PR mechanics — the LLM invocation itself (`anthropics/claude-code-action`) is wired up in each consuming repo's own workflow, including its `--allowedTools` Bash allowlist. That allowlist needs to be scoped to **non-executing commands only** (formatters and linters: `black`, `isort`, `prettier`, `eslint --fix`, `flake8`, `mypy`, plus read-only `git diff`/`git status`) — never test or build execution (`pytest`, `npm run test`, `npm run build`, `npm ci`, `uv run`, `make test`, etc.).

Why: confirmed via `anthropics/claude-code-action`'s source (`base-action/src/parse-sdk-options.ts`), the `anthropic_api_key` input is present in the full environment (`{ ...process.env }`) passed to the Claude session, and that environment is inherited by whatever the Bash tool executes. The action explicitly strips two OIDC token-minting variables from that environment but not the API key. A test/build command that reads its own environment (intentionally or via a compromised dependency/test file) can exfiltrate the key. Formatters/linters never execute the target code, so they don't have this exposure — verification that a fix actually works should happen via the normal CI that runs on the resulting draft PR, not inside the remediation job itself.

## Versioning

Changes are tagged with semver (`v1`, `v1.1`, ...). A major tag (`v1`) is kept moving to the latest compatible release so consumers can pin to it without manual bumps; breaking changes bump the major version and get their own tag. Don't reference `main` directly from a consumer workflow.

## Contributing

This repo is consumed by CI in multiple repos across different tech stacks — treat changes here like a library release, not a same-PR edit. Verify a change against both consumer repos (or at least a representative workflow) before tagging a new version.

Changes go through a PR, not direct pushes to `main` (the two composite actions in this repo run with write access and secrets in consuming repos, so review matters here more than usual).
