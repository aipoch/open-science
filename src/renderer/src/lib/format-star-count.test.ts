import { describe, expect, it } from 'vitest'

import { formatStarCount } from './format-star-count'

describe('formatStarCount', () => {
  it('shows counts under 1000 verbatim', () => {
    expect(formatStarCount(0)).toBe('0')
    expect(formatStarCount(42)).toBe('42')
    expect(formatStarCount(999)).toBe('999')
  })

  it('formats thousands with a trimmed single decimal', () => {
    expect(formatStarCount(1000)).toBe('1k')
    expect(formatStarCount(1200)).toBe('1.2k')
    expect(formatStarCount(1234)).toBe('1.2k')
    expect(formatStarCount(12000)).toBe('12k')
    expect(formatStarCount(12345)).toBe('12.3k')
  })
})
