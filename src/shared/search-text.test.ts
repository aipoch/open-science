import { describe, expect, it } from 'vitest'
import { findSearchMatches } from './search-text'

describe('search text matching', () => {
  it('matches Greek final sigma consistently across letter case', () => {
    expect(findSearchMatches('ΟΣ and ΣΟΣ', 'ος')).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 }
    ])
  })
  it('preserves original offsets for compatibility and composed text', () => {
    expect(findSearchMatches('ＡＩ and AI', 'ai')).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 9 }
    ])
    expect(findSearchMatches('x e\u0301 y', 'é')).toEqual([{ start: 2, end: 4 }])
    expect(findSearchMatches('a [x] .*', '[x]')).toEqual([{ start: 2, end: 5 }])
    expect(findSearchMatches('İ', 'i')).toEqual([])
    expect(findSearchMatches('text', '')).toEqual([])
  })
})
