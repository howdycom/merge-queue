import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTier, parseLabelList } from './priority.mjs'

const HOTFIX = /^\[HOTFIX\]/i
const HCP = /^\[HCP-/i
const DEFAULT_LABELS = parseLabelList('bug')
const FOCUS_LABELS = parseLabelList('bug, workspace')

function pr(title, labels) {
  return { title, labels: labels.map((name) => ({ name })) }
}

function rank(item, labels = DEFAULT_LABELS) {
  return classifyTier(item, {
    labels,
    tier1TitleRegex: HOTFIX,
    tier2TitleRegex: HCP,
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
    const none = []
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
