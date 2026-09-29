import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTier,
  compareQueueItems,
  dropYieldCount,
  incrementYieldCount,
  normalizeAuthor,
  parseLabelList,
  parseYieldCounts,
  pruneYieldCounts,
  serializeYieldCounts,
  type TieredPr,
} from './priority.ts'

const HOTFIX = /^\[HOTFIX\]/i
const HCP = /^\[HCP-/i
const ISSUE = /^\[(#\d+|HCP-)/i
const TECH = /^\[TECH\]/i
const BOTS = ['dependabot', 'dependabot[bot]', 'app/dependabot']
const DEFAULT_LABELS = parseLabelList('bug')
const FOCUS_LABELS = parseLabelList('bug, workspace')
const ONBOARDING_LABELS = parseLabelList('bug, workspace, app-onboarding, onboarding')

function pr(title: string, labels: string[], author?: string | { login: string }): TieredPr {
  const item: TieredPr = { title, labels: labels.map((name) => ({ name })) }
  if (author !== undefined) item.author = author
  return item
}

interface RankExtra {
  tier2TitleRegex?: RegExp
  deprioritizedTitleRegex?: RegExp | null
  deprioritizedAuthors?: string[] | null
}

function rank(item: TieredPr, labels: string[] = DEFAULT_LABELS, extra: RankExtra = {}): number {
  return classifyTier(item, {
    labels,
    tier1TitleRegex: HOTFIX,
    tier2TitleRegex: extra.tier2TitleRegex || HCP,
    deprioritizedTitleRegex: extra.deprioritizedTitleRegex,
    deprioritizedAuthors: extra.deprioritizedAuthors,
  })
}

function fullRank(item: TieredPr, labels: string[] = ONBOARDING_LABELS): number {
  return rank(item, labels, {
    tier2TitleRegex: ISSUE,
    deprioritizedTitleRegex: TECH,
    deprioritizedAuthors: BOTS,
  })
}

describe('parseLabelList', () => {
  it('splits a comma-separated list and trims tokens', () => {
    assert.deepEqual(parseLabelList(' bug, workspace , '), ['bug', 'workspace'])
  })

  it('splits a newline-separated list so callers can pass a YAML block', () => {
    assert.deepEqual(parseLabelList('bug\nworkspace\n'), ['bug', 'workspace'])
  })

  it('accepts mixed commas and newlines', () => {
    assert.deepEqual(parseLabelList('bug,\nworkspace,security'), ['bug', 'workspace', 'security'])
  })

  it('falls back when the raw value is blank', () => {
    assert.deepEqual(parseLabelList('', 'bug'), ['bug'])
    assert.deepEqual(parseLabelList('   ', 'bug'), ['bug'])
    assert.deepEqual(parseLabelList(null, 'bug'), ['bug'])
    assert.deepEqual(parseLabelList(undefined, 'bug'), ['bug'])
  })

  it('returns an empty list when both raw and fallback are blank', () => {
    assert.deepEqual(parseLabelList('', ''), [])
    assert.deepEqual(parseLabelList(undefined), [])
  })
})

describe('classifyTier — default single-label list stays backward compatible', () => {
  it('ranks a bug-labeled PR as tier 1', () => {
    assert.equal(rank(pr('[HCP-1] fix login', ['bug', 'ready to merge'])), 1)
  })

  it('ranks a HOTFIX title as tier 1 even without the bug label', () => {
    assert.equal(rank(pr('[HOTFIX] prod down', ['ready to merge'])), 1)
  })

  it('ranks an HCP title without a focus label as tier 2', () => {
    assert.equal(rank(pr('[HCP-99] add filter', ['ready to merge'])), 2)
  })

  it('ranks everything else as tier 3', () => {
    assert.equal(rank(pr('[TECH] chore', ['ready to merge'])), 3)
  })
})

describe('classifyTier — ordered focus labels', () => {
  it('ranks the first configured label above later ones', () => {
    assert.equal(rank(pr('[HCP-1] bugfix', ['bug']), FOCUS_LABELS), 1)
    assert.equal(rank(pr('[HCP-2] workspace work', ['workspace']), FOCUS_LABELS), 2)
  })

  it('uses the earliest matching label when a PR carries several', () => {
    assert.equal(rank(pr('[HCP-3] both', ['workspace', 'bug']), FOCUS_LABELS), 1)
  })

  it('keeps HOTFIX at rank 1 so it still beats later focus labels', () => {
    assert.equal(rank(pr('[HOTFIX] emergency', ['workspace']), FOCUS_LABELS), 1)
  })

  it('places HCP titles after every configured focus label', () => {
    assert.equal(rank(pr('[HCP-4] regular ticket', []), FOCUS_LABELS), 3)
  })

  it('places unlabeled / un-prefixed PRs last', () => {
    assert.equal(rank(pr('[TECH] docs', []), FOCUS_LABELS), 4)
  })

  it('accepts bare string labels as well as { name } objects', () => {
    assert.equal(
      classifyTier(
        { title: 'x', labels: ['workspace'] },
        { labels: FOCUS_LABELS, tier1TitleRegex: HOTFIX, tier2TitleRegex: HCP },
      ),
      2,
    )
  })

  it('treats a missing title as non-matching for the title regexes', () => {
    assert.equal(rank({ labels: [{ name: 'workspace' }] }, FOCUS_LABELS), 2)
  })

  it('treats a missing labels array as no label match', () => {
    assert.equal(rank({ title: '[TECH] none' }, FOCUS_LABELS), 4)
  })
})

describe('classifyTier — empty label list still ranks by title', () => {
  it('uses HOTFIX then HCP then everything else', () => {
    const none: string[] = []
    assert.equal(rank(pr('[HOTFIX] now', []), none), 1)
    assert.equal(rank(pr('[HCP-1] later', []), none), 2)
    assert.equal(rank(pr('[TECH] last', []), none), 3)
  })
})

describe('classifyTier — regex lastIndex is reset so /g flags stay safe', () => {
  it('does not skip a second match after a /g test', () => {
    const stickyHotfix = /\[HOTFIX\]/gi
    const stickyHcp = /\[HCP-/gi
    const options = { labels: DEFAULT_LABELS, tier1TitleRegex: stickyHotfix, tier2TitleRegex: stickyHcp }
    assert.equal(classifyTier(pr('[HOTFIX] one', []), options), 1)
    assert.equal(classifyTier(pr('[HOTFIX] two', []), options), 1)
  })
})

describe('normalizeAuthor', () => {
  it('collapses Dependabot login variants onto one token', () => {
    assert.equal(normalizeAuthor('app/dependabot'), 'dependabot')
    assert.equal(normalizeAuthor('dependabot[bot]'), 'dependabot')
    assert.equal(normalizeAuthor('Dependabot'), 'dependabot')
    assert.equal(normalizeAuthor({ login: 'app/dependabot' }), 'dependabot')
  })

  it('returns empty string for missing author', () => {
    assert.equal(normalizeAuthor(undefined), '')
    assert.equal(normalizeAuthor(null), '')
    assert.equal(normalizeAuthor({}), '')
  })
})

describe('classifyTier — issue titles beat TECH; Dependabot is last', () => {
  it('ranks onboarding labels immediately after workspace', () => {
    assert.equal(fullRank(pr('[#1] bugfix', ['bug'])), 1)
    assert.equal(fullRank(pr('[#2] workspace', ['workspace'])), 2)
    assert.equal(fullRank(pr('[#3] app onboarding', ['app-onboarding'])), 3)
    assert.equal(fullRank(pr('[#4] onboarding', ['onboarding'])), 4)
  })

  it('uses the earliest focus label when a PR carries several', () => {
    assert.equal(fullRank(pr('[#5] both', ['onboarding', 'workspace'])), 2)
  })

  it('ranks GitHub issue titles after every focus label and above other humans', () => {
    assert.equal(fullRank(pr('[#7122] api e2e', [])), 5)
    assert.equal(fullRank(pr('[#7418 #7422] two issues', [])), 5)
    assert.equal(fullRank(pr('[HCP-99] leftover jira', [])), 5)
    assert.equal(fullRank(pr('plain human PR', [])), 6)
  })

  it('ranks [TECH] titles below unlabeled humans and issue titles', () => {
    assert.equal(fullRank(pr('[TECH] chore', [])), 7)
    assert.equal(fullRank(pr('[TECH] - Automate bootstrap', ['ready to merge'])), 7)
  })

  it('keeps a [TECH] PR in its focus-label rank', () => {
    assert.equal(fullRank(pr('[TECH] workspace follow-up', ['workspace'])), 2)
  })

  it('puts Dependabot last even when it has a focus label or issue title', () => {
    assert.equal(fullRank(pr('Bump foo from 1 to 2', [], { login: 'app/dependabot' })), 8)
    assert.equal(fullRank(pr('[#1] bump', ['bug'], { login: 'dependabot[bot]' })), 8)
    assert.equal(fullRank(pr('[HOTFIX] bump', [], 'Dependabot')), 8)
  })

  it('does not deprioritize a human author whose login merely contains bot-like text', () => {
    assert.equal(fullRank(pr('[#9] work', [], { login: 'michael' })), 5)
  })
})

describe('classifyTier — omitting deprioritize options keeps leftover ranks', () => {
  it('still ranks [TECH] with other leftover PRs when no deprioritized regex is set', () => {
    assert.equal(rank(pr('[TECH] chore', ['ready to merge'])), 3)
    assert.equal(rank(pr('plain', ['ready to merge'])), 3)
  })
})

describe('compareQueueItems — oldest PR first within a tier', () => {
  it('keeps lower tier numbers ahead of older PRs in a later tier', () => {
    const hotfix = { tier: 1, createdAt: '2026-08-20T00:00:00Z', number: 300 }
    const oldHuman = { tier: 6, createdAt: '2026-01-01T00:00:00Z', number: 50 }
    const ordered = [oldHuman, hotfix].sort(compareQueueItems)
    assert.equal(ordered[0].number, 300)
  })

  it('orders same-tier PRs oldest createdAt first, even if a newer PR was labeled ready earlier', () => {
    const older = {
      tier: 5,
      createdAt: '2026-01-01T00:00:00Z',
      number: 100,
      readySince: '2026-08-25T00:00:00Z',
    }
    const newer = {
      tier: 5,
      createdAt: '2026-08-01T00:00:00Z',
      number: 200,
      readySince: '2026-08-01T00:00:00Z',
    }
    const ordered = [newer, older].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [100, 200],
    )
  })

  it('breaks a createdAt tie with the lower PR number', () => {
    const laterNumber = { tier: 2, createdAt: '2026-04-01T12:00:00Z', number: 80 }
    const earlierNumber = { tier: 2, createdAt: '2026-04-01T12:00:00Z', number: 40 }
    const ordered = [laterNumber, earlierNumber].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [40, 80],
    )
  })

  it('places a PR with a valid createdAt ahead of one missing the timestamp', () => {
    const dated = { tier: 4, createdAt: '2026-03-01T00:00:00Z', number: 90 }
    const undated = { tier: 4, number: 10 }
    const ordered = [undated, dated].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [90, 10],
    )
  })

  it('falls back to PR number when neither item has a parseable createdAt', () => {
    const later = { tier: 3, createdAt: 'not-a-date', number: 12 }
    const earlier = { tier: 3, number: 3 }
    const ordered = [later, earlier].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [3, 12],
    )
  })

  it('sorts a PR that has already yielded behind same-tier peers it blocked', () => {
    const oldestStuck = {
      tier: 5,
      createdAt: '2026-01-01T00:00:00Z',
      number: 100,
      yieldCount: 1,
    }
    const newerPeer = {
      tier: 5,
      createdAt: '2026-08-01T00:00:00Z',
      number: 200,
      yieldCount: 0,
    }
    const ordered = [oldestStuck, newerPeer].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [200, 100],
    )
  })

  it('does not let yieldCount jump a worse tier ahead of a better one', () => {
    const yieldedHotfix = { tier: 1, createdAt: '2026-08-20T00:00:00Z', number: 300, yieldCount: 4 }
    const unyieldedHuman = { tier: 6, createdAt: '2026-01-01T00:00:00Z', number: 50, yieldCount: 0 }
    const ordered = [unyieldedHuman, yieldedHotfix].sort(compareQueueItems)
    assert.equal(ordered[0].number, 300)
  })

  it('treats a missing yieldCount as 0 so unlabeled items stay oldest-first', () => {
    const older = { tier: 2, createdAt: '2026-01-01T00:00:00Z', number: 10 }
    const newerYielded = { tier: 2, createdAt: '2026-06-01T00:00:00Z', number: 20, yieldCount: 1 }
    const ordered = [newerYielded, older].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [10, 20],
    )
  })

  it('breaks an equal yieldCount tie with createdAt, then PR number', () => {
    const older = { tier: 4, yieldCount: 1, createdAt: '2026-02-01T00:00:00Z', number: 80 }
    const newer = { tier: 4, yieldCount: 1, createdAt: '2026-03-01T00:00:00Z', number: 40 }
    const ordered = [newer, older].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [80, 40],
    )
  })

  it('treats a non-finite yieldCount as 0 so corrupt counts never demote', () => {
    const corrupt = { tier: 2, createdAt: '2026-01-01T00:00:00Z', number: 10, yieldCount: Number.NaN }
    const yielded = { tier: 2, createdAt: '2026-06-01T00:00:00Z', number: 20, yieldCount: 1 }
    const ordered = [yielded, corrupt].sort(compareQueueItems)
    assert.deepEqual(
      ordered.map((item) => item.number),
      [10, 20],
    )
  })
})

describe('yield count persistence encoding', () => {
  it('parses prNumber:count pairs and ignores junk', () => {
    assert.deepEqual(parseYieldCounts('123:1,456:2'), { 123: 1, 456: 2 })
    assert.deepEqual(parseYieldCounts(' 123:1 , ,456:2,nope,7:,:3,9:-1,8:0 '), { 123: 1, 456: 2 })
    assert.deepEqual(parseYieldCounts(''), {})
    assert.deepEqual(parseYieldCounts(null), {})
  })

  it('serializes in PR-number order and drops non-positive counts', () => {
    assert.equal(serializeYieldCounts({ 456: 2, 123: 1, 9: 0, bad: Number.NaN }), '123:1,456:2')
    assert.equal(serializeYieldCounts({}), '')
  })

  it('increments an existing PR and starts a new one at 1', () => {
    assert.equal(incrementYieldCount('', 100), '100:1')
    assert.equal(incrementYieldCount('100:1,200:3', '100'), '100:2,200:3')
    assert.equal(incrementYieldCount('100:1', ''), '100:1')
  })

  it('drops a PR and prunes anything not in the keep set', () => {
    assert.equal(dropYieldCount('100:1,200:3', 100), '200:3')
    assert.equal(dropYieldCount('100:1', 100), '')
    assert.equal(pruneYieldCounts('100:1,200:3,300:1', [200, '300']), '200:3,300:1')
    assert.equal(pruneYieldCounts('100:1', []), '')
  })

  it('orders yield keys that share a number by their text', () => {
    assert.equal(serializeYieldCounts({ 10: 1, '02': 1, 2: 1 }), '02:1,2:1,10:1')
  })
})

describe('remaining classifier branches', () => {
  it('treats a null fallback and a null author list as empty', () => {
    assert.deepEqual(parseLabelList(null, null), [])
    assert.deepEqual(parseLabelList('   ', null), [])
    assert.equal(
      classifyTier(
        { title: 'plain', author: { login: 'dependabot' } },
        {
          labels: ['bug'],
          tier1TitleRegex: HOTFIX,
          tier2TitleRegex: HCP,
          deprioritizedTitleRegex: TECH,
          deprioritizedAuthors: null,
        },
      ),
      3,
    )
  })

  it('ignores blank deprioritized author tokens and still matches the rest', () => {
    assert.equal(
      classifyTier(
        { title: 'plain', author: 'dependabot', labels: [] },
        {
          labels: ['bug'],
          tier1TitleRegex: HOTFIX,
          tier2TitleRegex: HCP,
          deprioritizedTitleRegex: null,
          deprioritizedAuthors: ['', 'dependabot'],
        },
      ),
      5,
    )
  })

  it('treats a missing PR number as zero from either side', () => {
    const numbered = { tier: 1, createdAt: 'not-a-date', number: 4 }
    const blank = { tier: 1, createdAt: 'not-a-date' }
    assert.equal(compareQueueItems(numbered, blank), 4)
    assert.equal(compareQueueItems(blank, numbered), -4)
    assert.equal(compareQueueItems({ tier: 1, createdAt: 'not-a-date', number: 0 }, blank), 0)
  })

  it('sorts a missing timestamp behind a real one from either side', () => {
    const valid = { tier: 1, createdAt: '2026-01-01T00:00:00Z', number: 1 }
    const missing = { tier: 1, createdAt: 'not-a-date', number: 2 }
    assert.equal(compareQueueItems(valid, missing), -1)
    assert.equal(compareQueueItems(missing, valid), 1)
  })
})
