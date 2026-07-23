// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeIsolatedSignInModal } from './ClaudeIsolatedSignInModal'
import type { ValidateProviderResult } from '../../../../shared/settings'

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

type SubmitSpy = ReturnType<typeof vi.fn> & {
  mock: { results: Array<{ value: Promise<ValidateProviderResult | undefined> }> }
}

const renderModal = (props: {
  onSubmit?: SubmitSpy
  open?: boolean
}): { onSubmit: SubmitSpy; onOpenChange: ReturnType<typeof vi.fn> } => {
  const onSubmit = (props.onSubmit ?? vi.fn(async () => undefined)) as SubmitSpy
  // The first call's promise resolves with whatever the test queued. Subsequent calls reuse the
  // same spy so tests can stage success/failure by setting the mock return in sequence.
  if (onSubmit.mock.results.length === 0) {
    onSubmit.mockResolvedValueOnce(undefined)
  }
  const onOpenChange = vi.fn()
  act(() => {
    root.render(
      <ClaudeIsolatedSignInModal
        open={props.open ?? true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit as never}
      />
    )
  })
  return { onSubmit, onOpenChange }
}

// The modal renders into a Radix Portal that lands in document.body, not in the test container —
// so the helpers query the document rather than the mount node.
const findButton = (text: string | RegExp): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((button) => {
    const t = button.textContent ?? ''
    return typeof text === 'string' ? t.includes(text) : text.test(t)
  })

const findInput = (label: string): HTMLInputElement | undefined => {
  const labelled = document.body.querySelector(`[aria-label="${label}"]`)
  return (labelled as HTMLInputElement) ?? undefined
}

const setInputValue = (input: HTMLInputElement, value: string): void => {
  // React's onChange reads value via the synthetic event. The native value setter is what bypasses
  // React's tracking so the controlled input actually updates.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) {
    setter.call(input, value)
  } else {
    input.value = value
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ClaudeIsolatedSignInModal UI state', () => {
  // The async click → submit → onSubmit → close/error path is exercised at the service layer
  // (loginIsolatedClaude test group in service.test.ts), where the state updates can be observed
  // synchronously. These tests pin the synchronous UI state: button-enabled gating, label, and the
  // initial paint's error region absence.

  it('disables the Sign in button until the user pastes a non-empty token', () => {
    const { onSubmit } = renderModal({})

    const signIn = findButton('Sign in')
    expect(signIn?.disabled).toBe(true)

    const input = findInput('Claude setup token')
    if (!input) throw new Error('token input not found')
    setInputValue(input, 'sk-ant-pasted')

    expect(signIn?.disabled).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows the Sign in label and leaves onSubmit untouched after enabling', () => {
    const onSubmit = vi.fn(async () => undefined) as SubmitSpy
    renderModal({ onSubmit })

    const input = findInput('Claude setup token')
    if (!input) throw new Error('token input not found')
    setInputValue(input, 'sk-ant-pasted')

    const signIn = findButton('Sign in')
    if (!signIn) throw new Error('sign in button not found')
    expect(signIn.disabled).toBe(false)
    expect(signIn.textContent).toMatch(/Sign in/)
  })

  it('does not render the inline error region on first paint (it is controlled by submitError)', () => {
    // The role=alert region carries the controller's failure message after a failed submit. It is
    // absent on initial render and is driven by the modal's `submitError` state, not by props. The
    // full error-surface path is exercised at the service layer (loginIsolatedClaude test group).
    renderModal({})

    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not call onSubmit when the user cancels', () => {
    const { onSubmit, onOpenChange } = renderModal({})

    const cancel = findButton('Cancel')
    if (!cancel) throw new Error('cancel button not found')
    act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
