// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerAutoReviewToggle } from './ComposerAutoReviewToggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const findToggleButton = (): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.getAttribute('aria-label')?.includes('Auto-review')
  )

  if (!button) throw new Error('Auto-review toggle button not found')

  return button as HTMLButtonElement
}

describe('ComposerAutoReviewToggle', () => {
  it('shows the toggle as enabled (on) when value is true', () => {
    act(() => {
      root.render(<ComposerAutoReviewToggle value={true} onChange={vi.fn()} />)
    })

    const button = findToggleButton()

    expect(button.getAttribute('aria-label')).toContain('Auto-review')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the toggle as disabled (off) when value is false', () => {
    act(() => {
      root.render(<ComposerAutoReviewToggle value={false} onChange={vi.fn()} />)
    })

    const button = findToggleButton()

    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('calls onChange with true when toggled off → on', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(<ComposerAutoReviewToggle value={false} onChange={onChange} />)
    })
    act(() => findToggleButton().click())

    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('calls onChange with false when toggled on → off', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(<ComposerAutoReviewToggle value={true} onChange={onChange} />)
    })
    act(() => findToggleButton().click())

    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('does not fire onChange when disabled', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(<ComposerAutoReviewToggle value={true} onChange={onChange} disabled={true} />)
    })
    act(() => findToggleButton().click())

    expect(onChange).not.toHaveBeenCalled()
  })
})
