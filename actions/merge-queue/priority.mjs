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
 * Lower number = higher priority.
 *
 * The label list is ordered: the first matching label wins. A PR that
 * carries several configured labels uses the earliest (highest-priority)
 * match. Title-based HOTFIX is treated as rank 1 so emergencies still
 * jump the queue without a focus label. After every configured label:
 * the tier-2 title regex, then everything else.
 *
 * @param {{ title?: string, labels?: Array<string | { name?: string }> }} pr
 * @param {{
 *   labels: string[],
 *   tier1TitleRegex: RegExp,
 *   tier2TitleRegex: RegExp,
 * }} options
 * @returns {number}
 */
export function classifyTier(pr, { labels, tier1TitleRegex, tier2TitleRegex }) {
  const labelNames = (pr.labels || []).map((entry) => (typeof entry === 'string' ? entry : entry.name))
  const labelIndex = labels.findIndex((name) => labelNames.includes(name))
  const title = pr.title || ''
  const isHotfix = matches(tier1TitleRegex, title)
  const isTier2Title = matches(tier2TitleRegex, title)

  if (labelIndex === 0 || isHotfix) return 1
  if (labelIndex > 0) return labelIndex + 1

  const afterLabels = Math.max(labels.length, 1) + 1
  if (isTier2Title) return afterLabels
  return afterLabels + 1
}

function matches(regex, text) {
  if (!regex) return false
  regex.lastIndex = 0
  return regex.test(text)
}
