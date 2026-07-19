// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeUninstallControl } from './RuntimeUninstallControl'
import { uninstallDisabledHint } from './runtime-uninstall-hint'

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

const render = (
  props: Partial<React.ComponentProps<typeof RuntimeUninstallControl>> = {}
): (() => void) => {
  const onUninstall = props.onUninstall ?? vi.fn()

  act(() => {
    root.render(
      <RuntimeUninstallControl
        label="Claude"
        uninstallCommand="npm uninstall -g @anthropic-ai/claude-code"
        managed
        active={false}
        isUninstalling={false}
        isDetecting={false}
        onUninstall={onUninstall}
        {...props}
      />
    )
  })

  return onUninstall as () => void
}

const uninstallButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Uninstall')
  )

// The `?` explainer now lives inside the Uninstall button as a lucide CircleHelp icon (which lucide
// renders with the `lucide-circle-question-mark` class).
const hasHelpIcon = (): boolean =>
  uninstallButton()?.querySelector('.lucide-circle-question-mark') != null

describe('RuntimeUninstallControl', () => {
  it('enables uninstall and fires onUninstall for a non-active managed runtime, with no explainer', () => {
    const onUninstall = render()

    const button = uninstallButton()
    expect(button?.disabled).toBe(false)
    expect(button?.getAttribute('aria-disabled')).toBeNull()
    // A working uninstall needs no `?`.
    expect(hasHelpIcon()).toBe(false)

    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUninstall).toHaveBeenCalledTimes(1)
  })

  it('greys out uninstall (aria-disabled) with an inline `?` for a non-managed install', () => {
    const onUninstall = render({ managed: false, onUninstall: vi.fn() })

    const button = uninstallButton()
    // Greyed via aria-disabled (not the native attribute) so the tooltip stays hoverable.
    expect(button?.disabled).toBe(false)
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    expect(hasHelpIcon()).toBe(true)

    // The neutralized click does nothing.
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUninstall).not.toHaveBeenCalled()
  })

  it('greys out uninstall with an inline `?` when the runtime is active', () => {
    render({ managed: true, active: true })

    const button = uninstallButton()
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    expect(hasHelpIcon()).toBe(true)
  })

  it('natively disables uninstall without a `?` while a removal is in flight', () => {
    render({ managed: true, active: false, isUninstalling: true })

    const button = uninstallButton()
    // Transient busy states use the native disabled attribute and get no `?`.
    expect(button?.disabled).toBe(true)
    expect(hasHelpIcon()).toBe(false)
  })

  it('lets a busy state take priority over a standing reason (native disabled, no `?`)', () => {
    // A non-managed install has a standing reason, but a concurrent detect must still win: the button
    // is natively disabled with no stale explainer while the operation is in flight.
    render({ managed: false, isDetecting: true })

    const button = uninstallButton()
    expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('aria-disabled')).toBeNull()
    expect(hasHelpIcon()).toBe(false)
  })
})

// The tooltip content is portal-rendered by Radix only once open, which is unreliable to drive in jsdom,
// so the exact English copy and its branching are verified through the pure helper the control uses.
describe('uninstallDisabledHint', () => {
  const command = 'npm uninstall -g @anthropic-ai/claude-code'

  it('explains manual removal for a non-managed install, naming the command', () => {
    const hint = uninstallDisabledHint('Claude', command, { managed: false, active: false })

    expect(hint).toContain("Claude was found on your system but isn't managed by the app")
    expect(hint).toContain(command)
    expect(hint).toContain('then re-detect.')
  })

  it('tells the user to switch away from an active managed runtime', () => {
    const hint = uninstallDisabledHint('OpenCode', command, { managed: true, active: true })

    expect(hint).toBe(
      "OpenCode is the active agent framework and can't be uninstalled. Switch to another framework first, then uninstall."
    )
  })

  it('returns null for an actionable (non-active managed) runtime', () => {
    expect(uninstallDisabledHint('Claude', command, { managed: true, active: false })).toBeNull()
  })
})
