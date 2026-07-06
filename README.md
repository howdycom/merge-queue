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
| [`actions/claude-remediation-prepare`](actions/claude-remediation-prepare) | Validates a `/claude-fix` trigger comment, checks commenter permission and branch safety, and gathers PR context (metadata, diff, comments) for a Claude remediation run. Runs on plain `node`, no repo toolchain needed. |
| [`actions/open-remediation-pr`](actions/open-remediation-pr) | Commits working-tree changes as `github-actions[bot]`, pushes a new branch, and opens a draft PR against a given base branch. |

## Versioning

Changes are tagged with semver (`v1`, `v1.1`, ...). A major tag (`v1`) is kept moving to the latest compatible release so consumers can pin to it without manual bumps; breaking changes bump the major version and get their own tag. Don't reference `main` directly from a consumer workflow.

## Contributing

This repo is consumed by CI in multiple repos across different tech stacks — treat changes here like a library release, not a same-PR edit. Verify a change against both consumer repos (or at least a representative workflow) before tagging a new version.
