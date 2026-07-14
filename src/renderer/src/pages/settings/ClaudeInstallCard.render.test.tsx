// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeInstallCard } from './ClaudeInstallCard'

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
  props: Partial<React.ComponentProps<typeof ClaudeInstallCard>> = {}
): (() => void) => {
  const onInstall = props.onInstall ?? vi.fn()

  act(() => {
    root.render(
      <ClaudeInstallCard
        isInstalling={false}
        installLogs={[]}
        npmAvailable
        onInstall={onInstall}
        {...props}
      />
    )
  })

  return onInstall as () => void
}

describe('ClaudeInstallCard install-source picker', () => {
  it('renders the install source as a styled combobox, never a native <select>', () => {
    // Regression guard: the picker used to be a native <select>, whose OS-level option popup lives
    // outside the React tree. Dismissing it inside the settings Radix Dialog registered as an
    // "interact outside" and closed the whole dialog. The Radix Select renders in a dismissable-layer
    // portal instead, so the trigger must be a styled button (role=combobox), not a native select.
    render()

    expect(container.querySelector('select[aria-label="Install source"]')).toBeNull()

    const trigger = container.querySelector('[aria-label="Install source"]')

    expect(trigger?.tagName).toBe('BUTTON')
    expect(trigger?.getAttribute('role')).toBe('combobox')
  })

  it('defaults to the app-managed download and shows its description, not a command', () => {
    render({ npmAvailable: true })

    const trigger = container.querySelector('[aria-label="Install source"]')

    expect(trigger?.textContent).toContain('App-managed download (recommended)')
    // The managed source is app-driven, so no copyable shell command is shown — just its description.
    expect(container.querySelector('[aria-label="Install command"]')).toBeNull()
    expect(container.textContent).toContain('no Node.js or npm required')
  })

  it('stays on the app-managed download even when npm is unavailable', () => {
    render({ npmAvailable: false })

    const trigger = container.querySelector('[aria-label="Install source"]')

    // The managed source needs neither npm nor Node, so it is the default regardless of npm presence,
    // and the npm-missing note (which only applies to the npm source) stays hidden.
    expect(trigger?.textContent).toContain('App-managed download (recommended)')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('installs the currently selected source when the button is clicked', () => {
    const onInstall = render({ npmAvailable: true })

    const button = Array.from(container.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('Install with one click')
    )

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onInstall).toHaveBeenCalledWith('managed')
  })
})
