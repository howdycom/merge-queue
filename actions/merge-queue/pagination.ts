// Query-string helpers and REST list pagination for `gh api`.
// Split out of queue.ts so both "endpoint already has per_page" and
// "caller omitted per_page" are reachable in unit tests. queue.ts always
// passes a per_page, which would leave the other branch uncovered.

export function appendQueryParam(endpoint: string, key: string, value: string): string {
  // Drop any existing occurrence of the key so page= can be set cleanly.
  const withoutKey = endpoint
    .replace(new RegExp(`([?&])${key}=[^&]*&?`), '$1')
    .replace(/[?&]$/, '')
  const sep = withoutKey.includes('?') ? '&' : '?'
  return `${withoutKey}${sep}${key}=${encodeURIComponent(value)}`
}

export function getQueryParam(endpoint: string, key: string): string | null {
  const match = endpoint.match(new RegExp(`[?&]${key}=([^&]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

export interface PaginateDeps {
  ghJson: (args: string[]) => unknown
  supportsSlurp: boolean
}

/**
 * Fetch every page of a GitHub REST list endpoint as one flat array.
 * `supportsSlurp` selects `gh api --paginate --slurp` (gh >= ~2.48).
 * Otherwise page= is walked explicitly so older gh still works.
 *
 * A non-array page is returned unchanged (never wrapped), so the result is
 * `unknown` and each caller asserts the shape it asked `gh` for.
 */
export function paginate(endpoint: string, { ghJson, supportsSlurp }: PaginateDeps): unknown {
  if (supportsSlurp) {
    const pages: unknown = ghJson(['api', '--paginate', '--slurp', endpoint])
    return Array.isArray(pages) ? pages.flat() : pages
  }

  const perPage = Number(getQueryParam(endpoint, 'per_page')) || 100
  let base = getQueryParam(endpoint, 'per_page')
    ? endpoint
    : appendQueryParam(endpoint, 'per_page', String(perPage))
  // page= is owned by the loop below
  base = base
    .replace(new RegExp(`([?&])page=[^&]*&?`), '$1')
    .replace(/[?&]$/, '')

  const items: unknown[] = []
  const maxPages = 100
  for (let page = 1; page <= maxPages; page += 1) {
    const batch: unknown = ghJson(['api', appendQueryParam(base, 'page', String(page))])
    if (!Array.isArray(batch)) return batch
    items.push(...batch)
    if (batch.length < perPage) break
  }
  return items
}
