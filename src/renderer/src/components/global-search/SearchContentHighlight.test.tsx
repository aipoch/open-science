// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { SearchContentHighlight } from './SearchContentHighlight'
import { searchContentRanges } from './search-content-ranges'

afterEach(cleanup)

describe('rendered search highlights', () => {
  it('preserves manual scroll on equivalent children and resets for a new result', () => {
    const view = (identity: string): React.JSX.Element => (
      <div className="search-detail-content">
        <SearchContentHighlight key={identity} query="">
          <p>Unchanged message</p>
        </SearchContentHighlight>
      </div>
    )
    const { container, rerender } = render(view('first'))
    const viewport = container.firstElementChild as HTMLElement
    viewport.scrollTop = 250
    rerender(view('first'))
    expect(viewport.scrollTop).toBe(250)
    rerender(view('second'))
    expect(viewport.scrollTop).toBe(0)
  })
  it('refreshes asynchronously rendered text without resetting manual scroll', async () => {
    const view = (content: string): React.JSX.Element => (
      <div className="search-detail-content">
        <SearchContentHighlight query="needle">
          <p>{content}</p>
        </SearchContentHighlight>
      </div>
    )
    const { container, rerender } = render(view('needle'))
    const viewport = container.firstElementChild as HTMLElement
    viewport.scrollTop = 250
    rerender(view('needle and another needle'))
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-search-match-count]')
          ?.getAttribute('data-search-match-count')
      ).toBe('2')
    )
    expect(viewport.scrollTop).toBe(250)
  })
  it('keeps retained preview matches when an ancestor detail panel is temporarily hidden', () => {
    const view = (hidden: boolean, query: string): React.JSX.Element => (
      <aside aria-hidden={hidden}>
        <SearchContentHighlight query={query}>
          <p>Verified file preview content.</p>
          <span aria-hidden="true">Verified file preview hidden decoration.</span>
        </SearchContentHighlight>
      </aside>
    )
    const { container, rerender } = render(view(false, 'search-notes'))
    rerender(view(true, 'Verified file preview'))
    rerender(view(false, 'Verified file preview'))
    expect(
      container.querySelector('[data-search-match-count]')?.getAttribute('data-search-match-count')
    ).toBe('1')
  })
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
