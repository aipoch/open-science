import { describe, expect, it } from 'vitest'

import { fuzzyScore } from './fuzzy-match'

// Convenience: rank candidates best-first, dropping non-matches, like the popups do.
const rank = (query: string, candidates: string[]): string[] =>
  candidates
    .map((c) => ({ c, m: fuzzyScore(query, c) }))
    .filter((x): x is { c: string; m: NonNullable<ReturnType<typeof fuzzyScore>> } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.c)

describe('fuzzyScore', () => {
  it('matches an empty query against anything with a neutral score', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, positions: [] })
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('LIT', 'Literature Review')).not.toBeNull()
    expect(fuzzyScore('lit', 'Literature Review')?.positions).toEqual([0, 1, 2])
  })

  it('returns null when the query is not an ordered subsequence', () => {
    expect(fuzzyScore('zz', 'Literature Review')).toBeNull()
    // Right chars, wrong order.
    expect(fuzzyScore('tl', 'Literature')).toBeNull()
  })

  it('matches a non-contiguous subsequence and reports its positions', () => {
    // "cg" -> the two word-initial letters of "clinical-genomics".
    const m = fuzzyScore('cg', 'clinical-genomics')
    expect(m).not.toBeNull()
    expect(m?.positions).toEqual([0, 9])
  })

  it('ranks a prefix match above a later word-boundary match', () => {
    expect(rank('report', ['report.pdf', 'final-report.pdf'])).toEqual([
      'report.pdf',
      'final-report.pdf'
    ])
  })

  it('drops candidates that are only a partial subsequence', () => {
    // "pro" is not a subsequence of "Imported Helper": no "o" follows the "r".
    expect(fuzzyScore('pro', 'Imported Helper')).toBeNull()
    expect(fuzzyScore('pro', 'ProteinMPNN')).not.toBeNull()
  })

  it('ranks contiguous matches above scattered ones', () => {
    const contiguous = fuzzyScore('genom', 'genomics')!
    const scattered = fuzzyScore('genom', 'gene-normalized-omics-map')!
    expect(contiguous.score).toBeGreaterThan(scattered.score)
  })

  it('rewards camelCase word boundaries', () => {
    // "mpnn" aligns to the "MPNN" hump.
    const m = fuzzyScore('mpnn', 'ProteinMPNN')
    expect(m).not.toBeNull()
    expect(m?.positions).toEqual([7, 8, 9, 10])
  })
})
