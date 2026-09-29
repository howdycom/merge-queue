import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function javascriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'coverage') continue
      files.push(...javascriptFiles(path))
      continue
    }
    if (path.endsWith('.mjs')) files.push(path)
  }
  return files
}

const files = javascriptFiles('actions').concat(javascriptFiles('scripts'))
let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}
if (failed) process.exit(1)
process.stdout.write(`Checked ${files.length} JavaScript files.\n`)
