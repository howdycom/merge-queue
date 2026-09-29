// Ordered-label priority ranking for the merge queue.
// Consumer repos pass the label list; this module never hardcodes
// product-specific names beyond the documented defaults.

/**
 * Parse a comma- or newline-separated label list.
 * Empty tokens are dropped. `raw` falling back to `fallback` when blank
 * keeps callers that omit the input on the documented default.
 *
 * @param {string | undefined | null} raw
 * @param {string} [fallback]
 * @returns {string[]}
 */
export function parseLabelList(raw, fallback = '') {
  const source = raw == null || String(raw).trim() === '' ? String(fallback ?? '') : String(raw)
  return source
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Canonical author login for deprioritization matching.
 * `app/dependabot`, `dependabot[bot]`, and `Dependabot` all become `dependabot`.
 *
 * @param {string | { login?: string } | undefined | null} value
 * @returns {string}
 */
export function normalizeAuthor(value) {
  const login = typeof value === 'string' ? value : value?.login || ''
  let normalized = String(login).trim().toLowerCase()
  if (normalized.startsWith('app/')) normalized = normalized.slice(4)
  if (normalized.endsWith('[bot]')) normalized = normalized.slice(0, -'[bot]'.length)
  return normalized
}

/**
 * Lower number = higher priority.
 *
 * Rank order:
 *   1. HOTFIX title, or the first configured focus label
 *   2..N. remaining focus labels, in list order
 *   N+1. titles matching the ticket regex (issue `[#123]` / `[HCP-…]`)
 *   N+2. other human PRs
 *   N+3. titles matching the deprioritized regex (default `[TECH]`)
 *   N+4. deprioritized authors (default Dependabot) — always last, even
 *        when the PR also carries a focus label
 *
 * A PR that carries several configured labels uses the earliest
 * (highest-priority) match. Title-based HOTFIX stays at rank 1 so
 * emergencies still jump the queue without a focus label.
 *
 * @param {{
 *   title?: string,
 *   labels?: Array<string | { name?: string }>,
 *   author?: string | { login?: string },
 * }} pr
 * @param {{
 *   labels: string[],
 *   tier1TitleRegex: RegExp,
 *   tier2TitleRegex: RegExp,
 *   deprioritizedTitleRegex?: RegExp | null,
 *   deprioritizedAuthors?: string[],
 * }} options
 * @returns {number}
 */
export function classifyTier(
  pr,
  {
    labels,
    tier1TitleRegex,
    tier2TitleRegex,
    deprioritizedTitleRegex = null,
    deprioritizedAuthors = [],
  },
) {
  const focusCount = Math.max(labels.length, 1)
  const issueRank = focusCount + 1
  const otherRank = focusCount + 2
  const techRank = focusCount + 3
  const botRank = focusCount + 4

  const authorLogin = normalizeAuthor(pr.author)
  const deprioritizedLogins = new Set(
    (deprioritizedAuthors || []).map((entry) => normalizeAuthor(entry)).filter(Boolean),
  )
  if (authorLogin && deprioritizedLogins.has(authorLogin)) return botRank

  const labelNames = (pr.labels || []).map((entry) =>
    typeof entry === 'string' ? entry : entry.name,
  )
  const labelIndex = labels.findIndex((name) => labelNames.includes(name))
  const title = pr.title || ''
  const isHotfix = matches(tier1TitleRegex, title)
  const isTier2Title = matches(tier2TitleRegex, title)
  const isDeprioritizedTitle = matches(deprioritizedTitleRegex, title)

  if (labelIndex === 0 || isHotfix) return 1
  if (labelIndex > 0) return labelIndex + 1
  if (isTier2Title) return issueRank
  if (isDeprioritizedTitle) return techRank
  return otherRank
}

function matches(regex, text) {
  if (!regex) return false
  regex.lastIndex = 0
  return regex.test(text)
}

/**
 * How many times a PR has already yielded via soft-requeue. Missing,
 * non-finite, and negative values sort as 0 (never yielded).
 *
 * @param {{ yieldCount?: number }} item
 * @returns {number}
 */
function yieldCountOf(item) {
  const n = item.yieldCount
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Sort comparator for the ready queue.
 * Lower tier number first (higher priority). Within a tier, a PR that
 * has already soft-requeued sorts behind peers it has blocked, then
 * oldest PR first (`createdAt`, then number). Label-applied time is
 * not part of the order — yield count is what demotes a stuck PR.
 *
 * @param {{ tier: number, yieldCount?: number, createdAt?: string, number?: number }} a
 * @param {{ tier: number, yieldCount?: number, createdAt?: string, number?: number }} b
 * @returns {number}
 */
export function compareQueueItems(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier
  const aYield = yieldCountOf(a)
  const bYield = yieldCountOf(b)
  if (aYield !== bYield) return aYield - bYield
  const aCreated = Date.parse(a.createdAt || '')
  const bCreated = Date.parse(b.createdAt || '')
  const aValid = Number.isFinite(aCreated)
  const bValid = Number.isFinite(bCreated)
  if (aValid && bValid && aCreated !== bCreated) return aCreated - bCreated
  if (aValid !== bValid) return aValid ? -1 : 1
  return (a.number || 0) - (b.number || 0)
}

/**
 * Persist yield counts as `prNumber:count` pairs, comma-separated
 * (`123:1,456:2`). Stored in the MERGE_QUEUE_YIELD_COUNTS Actions
 * variable so a later dequeue can demote a PR that already yielded.
 *
 * @param {string | undefined | null} raw
 * @returns {Record<string, number>}
 */
export function parseYieldCounts(raw) {
  const counts = {}
  if (raw == null || String(raw).trim() === '') return counts
  for (const token of String(raw).split(',')) {
    const trimmed = token.trim()
    if (!trimmed) continue
    const sep = trimmed.lastIndexOf(':')
    if (sep <= 0) continue
    const pr = trimmed.slice(0, sep)
    const n = Number(trimmed.slice(sep + 1))
    if (!pr || !Number.isFinite(n) || n <= 0) continue
    counts[pr] = n
  }
  return counts
}

/**
 * @param {Record<string, number>} counts
 * @returns {string}
 */
export function serializeYieldCounts(counts) {
  return Object.entries(counts)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
    .map(([pr, n]) => `${pr}:${n}`)
    .join(',')
}

/**
 * @param {string | undefined | null} raw
 * @param {string | number} prNumber
 * @returns {string}
 */
export function incrementYieldCount(raw, prNumber) {
  if (prNumber == null || String(prNumber).trim() === '') {
    return serializeYieldCounts(parseYieldCounts(raw))
  }
  const counts = parseYieldCounts(raw)
  const key = String(prNumber)
  counts[key] = (counts[key] || 0) + 1
  return serializeYieldCounts(counts)
}

/**
 * @param {string | undefined | null} raw
 * @param {string | number} prNumber
 * @returns {string}
 */
export function dropYieldCount(raw, prNumber) {
  const counts = parseYieldCounts(raw)
  delete counts[String(prNumber)]
  return serializeYieldCounts(counts)
}

/**
 * Keep counts only for PRs still in `prNumbers` (plus any extra keys
 * the caller wants preserved, e.g. a just-requeued PR the search index
 * has not yet returned).
 *
 * @param {string | undefined | null} raw
 * @param {Iterable<string | number>} prNumbers
 * @returns {string}
 */
export function pruneYieldCounts(raw, prNumbers) {
  const counts = parseYieldCounts(raw)
  const keep = new Set([...prNumbers].map(String))
  for (const key of Object.keys(counts)) {
    if (!keep.has(key)) delete counts[key]
  }
  return serializeYieldCounts(counts)
}
