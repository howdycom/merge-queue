#!/usr/bin/env node
// Stateful stand-in for the gh CLI. queue.ts shells out once per call, so
// the scenario file is the shared memory between those processes.
import { readFileSync, writeFileSync } from 'node:fs'

// Shared with queue.test.ts (type-only import): the scenario JSON contract
// between the tests that build a world and this fake that answers `gh`.
export interface FakePr {
  number: number
  title?: string
  labels?: Array<{ name: string }>
  createdAt?: string
  isDraft?: boolean
  reviewDecision?: string
  author?: { login: string }
  state?: string
  mergeable?: string
  mergeStateStatus?: string
  headRefOid?: string
  headAfterUpdate?: string
  autoMergeRequest?: { enabledBy: string } | null
  timeline?: Array<{ event: string; label?: { name: string }; created_at?: string }>
  timelineMode?: string
  checks?: Array<{ name: string; bucket: string; link?: string }>
  checksError?: string
  runs?: Record<string, string>
  updateBranch?: string
  updateError?: string
  mergeableSequence?: string[]
  views?: number
  viewError?: string
  viewErrorAfter?: number
  closeAfterViews?: number
  // `pick` below projects arbitrary `--json` field lists out of a PR, so
  // the fake stays dynamically indexable by design.
  [key: string]: unknown
}

export interface FakeScenario {
  prs?: FakePr[]
  ready?: number[]
  slurp?: boolean
  slurpResult?: unknown
  helpThrows?: boolean
  stateConflict?: boolean
  stateFile?: { sha: string; json: Record<string, string> }
  stateWrites?: number
  stateBranch?: boolean
  stateReadError?: string
  omitContentSha?: boolean
  labelAddFails?: boolean
  removeLabelError?: string
  mergeError?: string
  rerunError?: string
  reruns?: string[]
  processingIssues?: unknown[]
}

const scenarioPath = process.env.GH_SCENARIO
const logPath = process.env.GH_CALL_LOG
if (!scenarioPath || !logPath) {
  process.stderr.write('GH_SCENARIO and GH_CALL_LOG must be set\n')
  process.exit(1)
}
// Rebind after the guard: narrowing does not cross into the closures below.
const scenarioFile: string = scenarioPath
const callLog: string = logPath
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8')) as FakeScenario
const args = process.argv.slice(2)
const calls: string[][] = JSON.parse(readFileSync(callLog, 'utf8'))
calls.push(args)
writeFileSync(callLog, JSON.stringify(calls))

function save(): void {
  writeFileSync(scenarioFile, JSON.stringify(scenario))
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  save()
  process.exit(code)
}

function ok(value?: unknown): never {
  if (value !== undefined) process.stdout.write(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
  save()
  process.exit(0)
}

function repo(): string {
  return process.env.GITHUB_REPOSITORY || 'howdycom/example'
}

function pr(number: string | number): FakePr {
  const found = (scenario.prs || []).find((item) => String(item.number) === String(number))
  if (!found) fail(`missing pr ${number}`)
  return found
}

function pick(source: FakePr, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) out[field] = source[field]
  return out
}

function jsonFields(): string[] | null {
  const index = args.indexOf('--json')
  if (index === -1) return null
  return args[index + 1].split(',')
}

function endpoint(): string {
  return args.find((arg) => arg.startsWith('repos/')) || ''
}

function readStdin(): string {
  return readFileSync(0, 'utf8')
}

function pathNumber(path: string, pattern: RegExp): string {
  const match = path.match(pattern)
  if (!match) fail(`could not parse a PR number out of ${path}`)
  return match[1]
}

if (args[0] === 'api' && args[1] === '--help') {
  if (scenario.helpThrows) fail('help exploded')
  ok(scenario.slurp === false ? 'usage\n' : 'usage --slurp --paginate\n')
}

if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
  if (scenario.slurpResult !== undefined) ok(scenario.slurpResult)
  const path = endpoint()
  const number = path.match(/\/issues\/(\d+)\/timeline/)?.[1]
  const item: Pick<FakePr, 'timeline' | 'timelineMode'> = number ? pr(number) : { timeline: [] }
  if (item.timelineMode === 'object') ok({ unexpected: true })
  ok([item.timeline || []])
}

if (args[0] === 'api' && args.includes('-X')) {
  const method = args[args.indexOf('-X') + 1]
  const path = endpoint()
  if (method === 'PUT' && path.includes('/contents/state.json')) {
    if (scenario.stateConflict) {
      scenario.stateConflict = false
      fail('409 sha mismatch')
    }
    const body = JSON.parse(readStdin()) as { content: string }
    const json = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) as Record<string, string>
    scenario.stateFile = { sha: `blob-${(scenario.stateWrites || 0) + 1}`, json }
    scenario.stateWrites = (scenario.stateWrites || 0) + 1
    scenario.stateBranch = true
    ok({ content: scenario.omitContentSha ? {} : { sha: scenario.stateFile.sha } })
  }
  if (method === 'POST' && path.endsWith('/git/refs')) {
    scenario.stateBranch = true
    ok({ ref: (JSON.parse(readStdin()) as { ref: string }).ref })
  }
  if (method === 'POST' && /\/issues\/\d+\/labels$/.test(path)) {
    const number = pathNumber(path, /\/issues\/(\d+)\/labels/)
    const label = (JSON.parse(readStdin()) as { labels: string[] }).labels[0]
    if (scenario.labelAddFails) fail('label add failed')
    const item = pr(number)
    item.labels = [...(item.labels || []), { name: label }]
    ok([])
  }
  if (method === 'DELETE' && path.includes('/labels/')) {
    if (scenario.removeLabelError) fail(scenario.removeLabelError)
    const number = pathNumber(path, /\/issues\/(\d+)\/labels/)
    const name = decodeURIComponent(path.split('/labels/')[1])
    const item = pr(number)
    item.labels = (item.labels || []).filter((label) => label.name !== name)
    ok('')
  }
  if (method === 'PUT' && path.includes('/update-branch')) {
    const number = pathNumber(path, /\/pulls\/(\d+)\/update-branch/)
    const item = pr(number)
    const mode = item.updateBranch || 'ok'
    if (mode === 'up-to-date') fail('no new commits on the base branch')
    if (mode === 'fail') fail(item.updateError || 'update failed')
    if (mode !== 'same') item.headRefOid = item.headAfterUpdate || `${item.headRefOid}-next`
    ok({ sha: item.headRefOid })
  }
  fail(`unhandled api ${method} ${path}`)
}

if (args[0] === 'api') {
  const path = endpoint()
  if (path === `repos/${repo()}`) ok({ default_branch: 'main' })
  if (path === `repos/${repo()}/git/ref/heads/main`) ok({ object: { sha: 'base-sha' } })
  if (path === `repos/${repo()}/git/ref/heads/merge-queue-state`) {
    if (!scenario.stateBranch) fail('HTTP 404: Not Found')
    ok({ object: { sha: 'state-sha' } })
  }
  if (path.startsWith(`repos/${repo()}/contents/state.json`)) {
    if (scenario.stateReadError) fail(scenario.stateReadError)
    if (!scenario.stateFile) fail('HTTP 404: Not Found')
    ok({
      sha: scenario.stateFile.sha,
      content: Buffer.from(`${JSON.stringify(scenario.stateFile.json, null, 2)}\n`).toString('base64'),
    })
  }
  if (path.includes('/issues?')) {
    ok(scenario.processingIssues === undefined ? [] : scenario.processingIssues)
  }
  if (path.includes('/timeline')) {
    const number = pathNumber(path, /\/issues\/(\d+)\/timeline/)
    const item = pr(number)
    if (item.timelineMode === 'object') ok({ unexpected: true })
    if (item.timelineMode === 'full-pages') {
      const page = Number(new URL(`https://example/${path}`).searchParams.get('page') || '1')
      ok(Array.from({ length: 100 }, (_, index) => ({ event: 'labeled', label: { name: 'ready to merge' }, created_at: `2026-01-01T00:${String(index).padStart(2, '0')}:00Z`, page })))
    }
    ok(item.timeline || [])
  }
  if (path.includes('/actions/runs/')) {
    const runId = pathNumber(path, /\/runs\/(\d+)/)
    const item = (scenario.prs || []).find((candidate) => candidate.runs && candidate.runs[runId])
    if (!item) fail(`unknown run ${runId}`)
    if (item.runs?.[runId] === 'error') fail('run lookup failed')
    ok({ status: item.runs?.[runId] })
  }
  fail(`unhandled api ${path}`)
}

if (args[0] === 'pr' && args[1] === 'list') {
  const fields = jsonFields()
  if (!fields) fail('pr list without --json')
  const numbers = scenario.ready || []
  ok(numbers.map((number) => pick(pr(number), fields)))
}

if (args[0] === 'pr' && args[1] === 'view') {
  const number = args[2]
  const item = pr(number)
  item.views = (item.views || 0) + 1
  if (item.closeAfterViews != null && item.views >= item.closeAfterViews) item.state = 'CLOSED'
  if (item.viewErrorAfter != null && item.views > item.viewErrorAfter) fail(item.viewError || 'later view failed')
  if (item.viewError) fail(item.viewError)
  const fields = jsonFields()
  if (!fields) fail('pr view without --json')
  if (fields.length === 1 && fields[0] === 'mergeable' && item.mergeableSequence?.length) {
    ok({ mergeable: item.mergeableSequence.shift() })
  }
  ok(pick(item, fields))
}

if (args[0] === 'pr' && args[1] === 'comment') ok('')

if (args[0] === 'pr' && args[1] === 'merge') {
  if (scenario.mergeError) fail(scenario.mergeError)
  const item = pr(args[2])
  item.autoMergeRequest = { enabledBy: 'queue' }
  ok('')
}

if (args[0] === 'pr' && args[1] === 'checks') {
  const item = pr(args[2])
  if (item.checksError) fail(item.checksError)
  ok(item.checks || [])
}

if (args[0] === 'run' && args[1] === 'rerun') {
  if (scenario.rerunError) fail(scenario.rerunError)
  scenario.reruns = [...(scenario.reruns || []), args[2]]
  ok('')
}

fail(`unhandled gh ${args.join(' ')}`)
