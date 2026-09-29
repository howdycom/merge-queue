import { errorText } from './errors.ts'

// Queue coordination state stored as a JSON file on a dedicated branch.
// GITHUB_TOKEN can write repository contents (contents: write) but cannot
// write Actions variables, which is why this replaced the vars-based store.
export const STATE_BRANCH = 'merge-queue-state'
export const STATE_PATH = 'state.json'

const CLAIM_KEYS = ['MERGE_QUEUE_PR', 'MERGE_QUEUE_SHA', 'MERGE_QUEUE_CLAIMED_AT']

export interface QueueStateDeps {
  repo: string
  processingLabel: string
  dryRun: boolean
  log: (message: string) => void
  logAction: (message: string) => void
  ghJson: (args: string[]) => unknown
  ghApiJson: (method: string, endpoint: string, body: unknown) => string
}

interface ContentFile {
  sha: string
  content: string
}

interface ProcessingIssue {
  number: number
  pull_request?: unknown
}

interface WriteFileBody {
  message: string
  content: string
  branch: string
  sha?: string
}

export function createQueueState({
  repo,
  processingLabel,
  dryRun,
  log,
  logAction,
  ghJson,
  ghApiJson,
}: QueueStateDeps) {
  // Starts empty but is never observed before load() sets it: every reader
  // and writer below goes through load() first.
  let cache: Record<string, string> = {}
  let blobSha: string | null = null
  let loaded = false

  // `gh` JSON is untyped at the boundary; each call site below asserts the
  // shape it asked for. The single cast lives here so the rest of the
  // module stays branch-identical to the logic it implements.
  function read<T = unknown>(args: string[]): T {
    return ghJson(args) as T
  }

  function emptyState(): Record<string, string> {
    return {}
  }

  function ensureBranch(): void {
    try {
      read(['api', `repos/${repo}/git/ref/heads/${STATE_BRANCH}`])
      return
    } catch (err) {
      const message = errorText(err)
      if (!/404|Not Found/.test(message)) {
        throw err
      }
    }
    const defaultBranch = read<{ default_branch: string }>(['api', `repos/${repo}`]).default_branch
    const sha = read<{ object: { sha: string } }>(['api', `repos/${repo}/git/ref/heads/${defaultBranch}`]).object.sha
    logAction(`create branch ${STATE_BRANCH}`)
    ghApiJson('POST', `repos/${repo}/git/refs`, {
      ref: `refs/heads/${STATE_BRANCH}`,
      sha,
    })
  }

  function readFile(): ContentFile | null {
    try {
      return read<ContentFile>(['api', `repos/${repo}/contents/${STATE_PATH}?ref=${STATE_BRANCH}`])
    } catch (err) {
      const message = errorText(err)
      if (/404|Not Found/.test(message)) return null
      throw err
    }
  }

  function migrateFromProcessingLabel(): Record<string, string> {
    if (!processingLabel) return emptyState()
    try {
      const issues = read<ProcessingIssue[]>([
        'api',
        `repos/${repo}/issues?labels=${encodeURIComponent(processingLabel)}&state=open&per_page=5`,
      ])
      const prs = (Array.isArray(issues) ? issues : []).filter((issue) => issue.pull_request)
      if (prs.length !== 1) return emptyState()
      const number = String(prs[0].number)
      const view = read<{ headRefOid?: string }>(['pr', 'view', number, '--repo', repo, '--json', 'headRefOid'])
      log(
        `Migrating merge-queue state from ${processingLabel} on PR #${number} (no ${STATE_PATH} on ${STATE_BRANCH} yet).`,
      )
      return {
        MERGE_QUEUE_PR: number,
        MERGE_QUEUE_SHA: view.headRefOid || '',
        MERGE_QUEUE_CLAIMED_AT: new Date().toISOString(),
      }
    } catch (err) {
      log(
        `Warning: could not migrate in-flight claim from ${processingLabel}: ${errorText(err).split('\n')[0]}`,
      )
      return emptyState()
    }
  }

  function load(): void {
    if (loaded) return
    loaded = true
    try {
      const file = readFile()
      if (file?.content) {
        cache = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
        if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = emptyState()
        blobSha = file.sha
        return
      }
    } catch (err) {
      const message = errorText(err)
      if (!/404|Not Found/.test(message)) {
        log(`Warning: unexpected error reading ${STATE_PATH}: ${message.split('\n')[0]}`)
      }
    }
    cache = migrateFromProcessingLabel()
    blobSha = null
    if (Object.keys(cache).length > 0 && !dryRun) flush()
  }

  function flush(): void {
    ensureBranch()
    const body: WriteFileBody = {
      message: 'merge-queue: update coordination state',
      content: Buffer.from(`${JSON.stringify(cache, null, 2)}\n`).toString('base64'),
      branch: STATE_BRANCH,
    }
    if (blobSha) body.sha = blobSha
    try {
      const result = JSON.parse(ghApiJson('PUT', `repos/${repo}/contents/${STATE_PATH}`, body))
      blobSha = result.content?.sha || blobSha
    } catch (err) {
      const message = errorText(err)
      if (/409|sha/.test(message)) {
        const latest = readFile()
        blobSha = latest?.sha || null
        const retry: WriteFileBody = {
          message: 'merge-queue: update coordination state',
          content: Buffer.from(`${JSON.stringify(cache, null, 2)}\n`).toString('base64'),
          branch: STATE_BRANCH,
        }
        if (blobSha) retry.sha = blobSha
        const result = JSON.parse(ghApiJson('PUT', `repos/${repo}/contents/${STATE_PATH}`, retry))
        blobSha = result.content?.sha || blobSha
        return
      }
      throw err
    }
  }

  function getVar(name: string): string {
    load()
    return cache[name] || ''
  }

  function setVar(name: string, value: string): void {
    load()
    logAction(`set ${name}=${value}`)
    cache[name] = value
    if (!dryRun) flush()
  }

  function deleteVar(name: string): void {
    load()
    if (!(name in cache)) {
      logAction(`delete variable ${name}`)
      return
    }
    logAction(`delete variable ${name}`)
    // Dry-run must not forget the claim. queue.ts relies on that so a
    // chained dequeue stops instead of replaying the same decision.
    if (dryRun) return
    delete cache[name]
    flush()
  }

  function clearQueueState(): void {
    for (const key of CLAIM_KEYS) deleteVar(key)
  }

  return { getVar, setVar, deleteVar, clearQueueState, STATE_BRANCH, STATE_PATH }
}
