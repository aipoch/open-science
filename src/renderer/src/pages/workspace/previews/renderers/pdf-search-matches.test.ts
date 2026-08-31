import { describe, expect, it } from 'vitest'

import { countPdfSearchOccurrences, resolvePdfSearchMatch } from './pdf-search-matches'

describe('PDF search match summaries', () => {
  it('represents repeated matches with one bounded page summary', () => {
    expect(countPdfSearchOccurrences('a'.repeat(100_000), 'a')).toBe(100_000)
    expect(
      resolvePdfSearchMatch(
        [
          { pageNumber: 3, count: 100_000 },
          { pageNumber: 8, count: 2 }
        ],
        100_001
      )
    ).toEqual({ pageNumber: 8, occurrence: 1 })
  })
})
