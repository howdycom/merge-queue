#!/usr/bin/env node
// Zero-dependency Node script — deliberately avoids anything beyond node builtins
// so it can run on a bare GitHub-hosted runner without a language-specific
// toolchain/install step in the calling repo.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const CONTEXT_DIR_NAME = 'claude-remediation'
const WRITABLE_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

const COMMAND_PREFIX = (process.env.CLAUDE_REMEDIATION_COMMAND_PREFIX || '/claude-fix')
  .trim()
  .toLowerCase()

const PROTECTED_BRANCHES = new Set(
  (process.env.CLAUDE_REMEDIATION_PROTECTED_BRANCHES || 'main,master')
    .split(',')
    .map((branch) => branch.trim())
    .filter(Boolean),
)

function ghText(args) {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function ghJson(args) {
  return JSON.parse(ghText(args))
}

function ghPaginatedJson(endpoint) {
  const pages = ghJson(['api', '--paginate', '--slurp', endpoint])
  return pages.flat()
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  fs.appendFileSync(outputPath, `${name}=${String(value).replace(/\n/g, ' ')}\n`)
}

function writeDisabled(reason, prNumber) {
  writeOutput('enabled', 'false')
  writeOutput('skip_reason', reason)
  if (prNumber) writeOutput('pr_number', prNumber)
  console.log(reason)
}

function ensureEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function getContextDir() {
  const root =
    process.env.CLAUDE_REMEDIATION_CONTEXT_DIR || process.env.RUNNER_TEMP || process.cwd()
  return path.join(root, CONTEXT_DIR_NAME)
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function getCollaboratorPermission(repository, actor) {
  try {
    return ghText(['api', `repos/${repository}/collaborators/${actor}/permission`, '--jq', '.permission'])
  } catch {
    return undefined
  }
}

function isWritablePermission(permission) {
  return Boolean(permission && WRITABLE_PERMISSIONS.has(permission))
}

function isProtectedHeadBranch(branchName) {
  return PROTECTED_BRANCHES.has(branchName)
}

function buildRemediationBranch(prNumber, runId, runAttempt) {
  return `claude/remediate-pr-${prNumber}-${runId}-${runAttempt}`
}

function parseRemediationCommand(body) {
  const firstLine = body
    ?.replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return null

  const normalized = firstLine.replace(/\s+/g, ' ').toLowerCase()

  if (normalized === COMMAND_PREFIX) {
    return { raw: firstLine, scope: 'single' }
  }

  if (normalized === `${COMMAND_PREFIX} all`) {
    return { raw: firstLine, scope: 'all' }
  }

  return null
}

function resolveTrigger(eventName, event) {
  const commentBody = event.comment?.body
  const command = parseRemediationCommand(commentBody)

  if (
    !command ||
    !commentBody ||
    !event.comment?.id ||
    !event.comment?.user?.login ||
    !event.comment.html_url
  ) {
    return null
  }

  if (eventName === 'issue_comment') {
    if (!event.issue?.pull_request || !event.issue.number) return null
    if (command.scope !== 'all') return null

    return {
      actor: event.comment.user.login,
      commentBody,
      commentId: event.comment.id,
      commentUrl: event.comment.html_url,
      eventName,
      prNumber: event.issue.number,
      scope: command.scope,
    }
  }

  if (eventName === 'pull_request_review_comment') {
    const prNumber = event.pull_request?.number
    if (!prNumber) return null

    return {
      actor: event.comment.user.login,
      commentBody,
      commentId: event.comment.id,
      commentUrl: event.comment.html_url,
      eventName,
      prNumber,
      reviewComment: {
        body: commentBody,
        diffHunk: event.comment.diff_hunk,
        line: event.comment.line,
        path: event.comment.path,
        replyToCommentId: event.comment.in_reply_to_id,
        startLine: event.comment.start_line,
        url: event.comment.html_url,
      },
      scope: command.scope,
    }
  }

  return null
}

function getReviewCommentId(comment) {
  if (!comment || typeof comment !== 'object' || !('id' in comment)) return undefined
  const id = comment.id
  return typeof id === 'number' ? id : undefined
}

function findTargetReviewComment(reviewComments, targetReviewCommentId) {
  if (targetReviewCommentId === undefined) return undefined
  return reviewComments.find((comment) => getReviewCommentId(comment) === targetReviewCommentId)
}

async function prepare() {
  const eventName = ensureEnv('GITHUB_EVENT_NAME')
  const eventPath = ensureEnv('GITHUB_EVENT_PATH')
  const repository = ensureEnv('GITHUB_REPOSITORY')
  const runId = ensureEnv('GITHUB_RUN_ID')
  const runAttempt = ensureEnv('GITHUB_RUN_ATTEMPT')
  const [repoOwner] = repository.split('/')
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'))
  const trigger = resolveTrigger(eventName, event)

  if (!trigger) {
    writeDisabled(`No supported ${COMMAND_PREFIX} command was found on a PR comment.`)
    return
  }

  const permission = getCollaboratorPermission(repository, trigger.actor)

  if (!isWritablePermission(permission)) {
    writeDisabled(
      `@${trigger.actor} does not have write, maintain, or admin permission on this repository.`,
      trigger.prNumber,
    )
    return
  }

  const pr = ghJson([
    'pr',
    'view',
    String(trigger.prNumber),
    '--json',
    [
      'author',
      'baseRefName',
      'headRefName',
      'headRefOid',
      'headRepository',
      'headRepositoryOwner',
      'isCrossRepository',
      'isDraft',
      'number',
      'title',
      'url',
    ].join(','),
  ])

  if (pr.isCrossRepository || pr.headRepositoryOwner?.login !== repoOwner) {
    writeDisabled(
      'Claude remediation only runs on same-repository PRs so it can open a nested PR back into the reviewed branch without exposing secrets to forked code.',
      trigger.prNumber,
    )
    return
  }

  if (isProtectedHeadBranch(pr.headRefName)) {
    writeDisabled(
      `Claude remediation will not target protected branch "${pr.headRefName}".`,
      trigger.prNumber,
    )
    return
  }

  const contextDir = getContextDir()
  fs.rmSync(contextDir, { force: true, recursive: true })
  fs.mkdirSync(contextDir, { recursive: true })

  const diff = ghText(['pr', 'diff', String(trigger.prNumber)])
  const reviewComments = ghPaginatedJson(
    `repos/${repository}/pulls/${trigger.prNumber}/comments?per_page=100`,
  )
  const issueComments = ghPaginatedJson(
    `repos/${repository}/issues/${trigger.prNumber}/comments?per_page=100`,
  )
  const targetReviewComment = findTargetReviewComment(
    reviewComments,
    trigger.reviewComment?.replyToCommentId,
  )

  if (trigger.scope === 'single' && !targetReviewComment) {
    writeDisabled(
      'Single-finding remediation must be requested as a reply to an existing inline Claude review comment.',
      trigger.prNumber,
    )
    return
  }

  writeJson(path.join(contextDir, 'request.json'), { ...trigger, targetReviewComment })
  writeJson(path.join(contextDir, 'pr.json'), pr)
  writeJson(path.join(contextDir, 'review-comments.json'), reviewComments)
  writeJson(path.join(contextDir, 'issue-comments.json'), issueComments)
  fs.writeFileSync(path.join(contextDir, 'pr.diff'), diff)

  writeOutput('enabled', 'true')
  writeOutput('command_scope', trigger.scope)
  writeOutput('context_dir', contextDir)
  writeOutput('head_ref', pr.headRefName)
  writeOutput('head_sha', pr.headRefOid)
  writeOutput('pr_number', pr.number)
  writeOutput('pr_title', pr.title)
  writeOutput('pr_url', pr.url)
  writeOutput('remediation_branch', buildRemediationBranch(pr.number, runId, runAttempt))
  writeOutput('trigger_url', trigger.commentUrl)
}

prepare().catch((error) => {
  console.error(error)
  process.exit(1)
})
