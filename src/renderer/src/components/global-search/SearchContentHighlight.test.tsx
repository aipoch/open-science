// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { searchContentRanges } from './search-content-ranges'

describe('rendered search highlights', () => {
  it('matches across Markdown inline formatting while preserving selectable DOM', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Historical <strong>needle</strong> in a message.</p>'
    const html = root.innerHTML
    const ranges = searchContentRanges(root, 'historical needle')
    expect(ranges.map((range) => range.toString())).toEqual(['Historical needle'])
    expect(root.innerHTML).toBe(html)
  })
  it('uses normalized Unicode offsets and excludes preview controls', () => {
    const root = document.createElement('div')
    root.innerHTML = '<button>café</button><p>ＣＡＦÉ and cafe\u0301</p>'
    expect(searchContentRanges(root, 'café').map((range) => range.toString())).toEqual([
      'ＣＡＦÉ',
      'cafe\u0301'
    ])
  })
})
