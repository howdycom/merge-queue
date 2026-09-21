// Queue coordination state stored as a JSON file on a dedicated branch.
// GITHUB_TOKEN can write repository contents (contents: write) but cannot
// write Actions variables, which is why this replaced the vars-based store.
export const STATE_BRANCH = 'merge-queue-state'
export const STATE_PATH = 'state.json'

const CLAIM_KEYS = ['MERGE_QUEUE_PR', 'MERGE_QUEUE_SHA', 'MERGE_QUEUE_CLAIMED_AT']

export function createQueueState({
  repo,
  processingLabel,
  dryRun,
  log,
  logAction,
  ghJson,
  ghApiJson,
}) {
  let cache = null
  let blobSha = null
  let loaded = false

  function emptyState() {
    return {}
  }

  function ensureBranch() {
    try {
      ghJson(['api', `repos/${repo}/git/ref/heads/${STATE_BRANCH}`])
      return
    } catch (err) {
      const message = String(err.stderr || err.message || err)
      if (!/404|Not Found/.test(message)) {
        throw err
      }
    }
    const defaultBranch = ghJson(['api', `repos/${repo}`]).default_branch
    const sha = ghJson(['api', `repos/${repo}/git/ref/heads/${defaultBranch}`]).object.sha
    logAction(`create branch ${STATE_BRANCH}`)
    if (dryRun) return
    ghApiJson('POST', `repos/${repo}/git/refs`, {
      ref: `refs/heads/${STATE_BRANCH}`,
      sha,
    })
  }

  function readFile() {
    try {
      return ghJson(['api', `repos/${repo}/contents/${STATE_PATH}?ref=${STATE_BRANCH}`])
    } catch (err) {
      const message = String(err.stderr || err.message || err)
      if (/404|Not Found/.test(message)) return null
      throw err
    }
  }

  function migrateFromProcessingLabel() {
    if (!processingLabel) return emptyState()
    try {
      const issues = ghJson([
        'api',
        `repos/${repo}/issues?labels=${encodeURIComponent(processingLabel)}&state=open&per_page=5`,
      ])
      const prs = (Array.isArray(issues) ? issues : []).filter((issue) => issue.pull_request)
      if (prs.length !== 1) return emptyState()
      const number = String(prs[0].number)
      const view = ghJson(['pr', 'view', number, '--repo', repo, '--json', 'headRefOid'])
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
        `Warning: could not migrate in-flight claim from ${processingLabel}: ${String(err.stderr || err.message || err).split('\n')[0]}`,
      )
      return emptyState()
    }
  }

  function load() {
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
      const message = String(err.stderr || err.message || err)
      if (!/404|Not Found/.test(message)) {
        log(`Warning: unexpected error reading ${STATE_PATH}: ${message.split('\n')[0]}`)
      }
    }
    cache = migrateFromProcessingLabel()
    blobSha = null
    if (Object.keys(cache).length > 0 && !dryRun) flush()
  }

  function flush() {
    if (dryRun) return
    ensureBranch()
    const body = {
      message: 'merge-queue: update coordination state',
      content: Buffer.from(`${JSON.stringify(cache, null, 2)}\n`).toString('base64'),
      branch: STATE_BRANCH,
    }
    if (blobSha) body.sha = blobSha
    try {
      const result = JSON.parse(ghApiJson('PUT', `repos/${repo}/contents/${STATE_PATH}`, body))
      blobSha = result.content?.sha || blobSha
    } catch (err) {
      const message = String(err.stderr || err.message || err)
      if (/409|sha/.test(message)) {
        const latest = readFile()
        blobSha = latest?.sha || null
        const retry = {
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

  function getVar(name) {
    load()
    return cache[name] || ''
  }

  function setVar(name, value) {
    load()
    logAction(`set ${name}=${value}`)
    cache[name] = value
    if (!dryRun) flush()
  }

  function deleteVar(name) {
    load()
    if (!(name in cache)) {
      logAction(`delete variable ${name}`)
      return
    }
    logAction(`delete variable ${name}`)
    delete cache[name]
    if (!dryRun) flush()
  }

  function clearQueueState() {
    for (const key of CLAIM_KEYS) deleteVar(key)
  }

  return { getVar, setVar, deleteVar, clearQueueState, STATE_BRANCH, STATE_PATH }
}
