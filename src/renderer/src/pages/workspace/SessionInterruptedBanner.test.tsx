// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionInterruptedBanner } from './SessionInterruptedBanner'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
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
  vi.clearAllMocks()
})

const getResumeButton = (): HTMLButtonElement => {
  const button = container.querySelector('button')
  if (!button) throw new Error('resume button not found')
  return button as HTMLButtonElement
}

describe('SessionInterruptedBanner', () => {
  it('shows the message and resumes when the enabled button is clicked', () => {
    const onResume = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner
          message="Session was interrupted before the app closed."
          isResuming={false}
          onResume={onResume}
        />
      )
    })

    expect(container.textContent).toContain('Session was interrupted before the app closed.')
    const button = getResumeButton()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Resume')

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('disables the button and ignores clicks while a resume is in flight', () => {
    const onResume = vi.fn()
    act(() => {
      root.render(
        <SessionInterruptedBanner message="Interrupted." isResuming onResume={onResume} />
      )
    })

    const button = getResumeButton()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Resuming')

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onResume).not.toHaveBeenCalled()
  })
})
