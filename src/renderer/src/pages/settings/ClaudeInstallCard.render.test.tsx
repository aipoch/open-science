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

  it('defaults to npm and shows its copyable command when npm is available', () => {
    render({ npmAvailable: true })

    const trigger = container.querySelector('[aria-label="Install source"]')

    expect(trigger?.textContent).toContain('npm (global install)')
    expect(container.querySelector('[aria-label="Install command"]')?.textContent).toContain(
      'npm i -g @anthropic-ai/claude-code'
    )
  })

  it('defaults to the official installer when npm is unavailable', () => {
    render({ npmAvailable: false })

    const trigger = container.querySelector('[aria-label="Install source"]')

    // Falls back to the script installer (no npm needed) and shows its command; the npm-missing note
    // only appears when npm itself is the selected source, so it stays hidden here.
    expect(trigger?.textContent).toContain('Official install.sh')
    expect(container.querySelector('[aria-label="Install command"]')?.textContent).toContain(
      'curl -fsSL https://claude.ai/install.sh'
    )
  })

  it('installs the currently selected source when the button is clicked', () => {
    const onInstall = render({ npmAvailable: true })

    const button = Array.from(container.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('Install with one click')
    )

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onInstall).toHaveBeenCalledWith('npm')
  })
})
