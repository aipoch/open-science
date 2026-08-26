// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMediaQuery } from './useMediaQuery'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useMediaQuery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('synchronizes the current result when the query changes', () => {
    const matches = new Map([
      ['(max-width: 767px)', false],
      ['(orientation: portrait)', true]
    ])
    vi.stubGlobal(
      'matchMedia',
      vi.fn(
        (query) =>
          ({
            media: query,
            matches: matches.get(query) ?? false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
          }) as unknown as MediaQueryList
      )
    )
    const container = document.createElement('div')
    const root = createRoot(container)
    let current = false
    const Harness = ({ query }: { query: string }): null => {
      current = useMediaQuery(query)
      return null
    }

    act(() => root.render(<Harness query="(max-width: 767px)" />))
    expect(current).toBe(false)

    act(() => root.render(<Harness query="(orientation: portrait)" />))
    expect(current).toBe(true)

    act(() => root.unmount())
  })
})
