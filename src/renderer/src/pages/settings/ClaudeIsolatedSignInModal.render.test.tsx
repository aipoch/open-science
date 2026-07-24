// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// Testing Library wraps portal interactions and their async state updates in React's test lifecycle.
import { fireEvent, waitFor } from '@testing-library/react'
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
  browserSignInPending?: boolean
}): { onSubmit: SubmitSpy; onOpenChange: ReturnType<typeof vi.fn> } => {
  const onSubmit = (props.onSubmit ?? vi.fn(async () => undefined)) as SubmitSpy
  const onOpenChange = vi.fn()
  act(() => {
    root.render(
      <ClaudeIsolatedSignInModal
        open={props.open ?? true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit as never}
        browserSignInPending={props.browserSignInPending ?? false}
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
    renderModal({})

    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the Step 1 run-command block for a pure manual sign-in', () => {
    renderModal({ browserSignInPending: false })

    expect(document.body.textContent).toContain('Step 1 · Run')
    expect(findButton('Copy')).toBeDefined()
    // The paste field keeps its "Step 2" numbering when Step 1 is present.
    expect(document.body.textContent).toContain('Step 2 · Paste')
  })

  it('hides the run-command step during a browser sign-in (the app runs it) and shows the status banner', () => {
    renderModal({ browserSignInPending: true })

    // The app already runs `claude setup-token`, so the "Step 1 · Run this yourself" block is gone.
    expect(document.body.textContent).not.toContain('Step 1 · Run')
    expect(findButton('Copy')).toBeUndefined()
    // The paste field survives as a fallback, but without the now-orphaned "Step 2" numbering.
    expect(findInput('Claude setup token')).toBeDefined()
    expect(document.body.textContent).not.toContain('Step 2 · Paste')
    // The status banner explains the browser flow is in progress.
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'Opening your browser'
    )
  })

  it('does not call onSubmit when the user cancels', () => {
    const { onSubmit, onOpenChange } = renderModal({})

    const cancel = findButton('Cancel')
    if (!cancel) throw new Error('cancel button not found')
    act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes the dialog on a successful submit and calls onSubmit with the pasted token', async () => {
    const onSubmit = vi.fn(async (): Promise<ValidateProviderResult | undefined> => ({
      ok: true,
      category: 'ok'
    })) as SubmitSpy
    const { onOpenChange } = renderModal({ onSubmit })

    const input = findInput('Claude setup token')
    if (!input) throw new Error('token input not found')
    setInputValue(input, 'sk-ant-pasted')

    const signIn = findButton('Sign in')
    if (!signIn) throw new Error('sign in button not found')

    fireEvent.click(signIn)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('sk-ant-pasted')
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('surfaces the controller error inline and keeps the dialog open on a failed submit', async () => {
    const onSubmit = vi.fn(async (): Promise<ValidateProviderResult | undefined> => ({
      ok: false,
      category: 'unknown',
      message: 'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    })) as SubmitSpy
    const { onOpenChange } = renderModal({ onSubmit })

    const input = findInput('Claude setup token')
    if (!input) throw new Error('token input not found')
    setInputValue(input, 'sk-ant-pasted')

    const signIn = findButton('Sign in')
    if (!signIn) throw new Error('sign in button not found')

    fireEvent.click(signIn)

    await waitFor(() => {
      const alert = document.body.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain('Unlock the system keychain')
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
