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
 * Sort comparator for the ready queue.
 * Lower tier number first (higher priority). Within a tier, oldest PR
 * first (`createdAt`, then number) so older PRs merge before newer ones
 * added to the same rank. Label-applied time is not part of the order.
 *
 * @param {{ tier: number, createdAt?: string, number?: number }} a
 * @param {{ tier: number, createdAt?: string, number?: number }} b
 * @returns {number}
 */
export function compareQueueItems(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier
  const aCreated = Date.parse(a.createdAt || '')
  const bCreated = Date.parse(b.createdAt || '')
  const aValid = Number.isFinite(aCreated)
  const bValid = Number.isFinite(bCreated)
  if (aValid && bValid && aCreated !== bCreated) return aCreated - bCreated
  if (aValid !== bValid) return aValid ? -1 : 1
  return (a.number || 0) - (b.number || 0)
}
