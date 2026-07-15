// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeInstallCard } from './ClaudeInstallCard'
import { describeInstallProgress } from './claude-install-progress'

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

const MB = 1024 * 1024

describe('describeInstallProgress', () => {
  it('reports a determinate fraction + byte label for a sized download', () => {
    const r = describeInstallProgress({
      kind: 'progress',
      installId: 'i',
      phase: 'downloading',
      receivedBytes: 5 * MB,
      totalBytes: 10 * MB
    })
    expect(r.fraction).toBeCloseTo(0.5)
    expect(r.label).toContain('5.0')
    expect(r.label).toContain('10.0')
  })

  it('is indeterminate (no fraction) for a phase without a total', () => {
    expect(
      describeInstallProgress({ kind: 'progress', installId: 'i', phase: 'installing' })
    ).toEqual({
      label: 'Installing…'
    })
    expect(
      describeInstallProgress({ kind: 'progress', installId: 'i', phase: 'resolving' }).fraction
    ).toBeUndefined()
  })
})

describe('ClaudeInstallCard progress + log', () => {
  it('renders a determinate progress bar from installProgress', () => {
    render({
      isInstalling: true,
      installProgress: {
        kind: 'progress',
        installId: 'i',
        phase: 'downloading',
        receivedBytes: 5 * MB,
        totalBytes: 10 * MB
      }
    })

    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-valuenow')).toBe('50')
    expect(container.textContent).toContain('Downloading')
  })

  it('renders an indeterminate progress bar for a phase without a total', () => {
    render({
      isInstalling: true,
      installProgress: { kind: 'progress', installId: 'i', phase: 'installing' }
    })

    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-valuenow')).toBeNull()
    expect(bar?.getAttribute('data-indeterminate')).toBe('true')
    expect(container.textContent).toContain('Installing')
  })

  it('hides the install log on success behind a toggle', () => {
    render({ installLogs: ['Installed Claude 2.1.209.\n'] })

    expect(container.querySelector('[aria-label="Install log"]')).toBeNull()
    const toggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Show log')
    )
    expect(toggle).toBeTruthy()
  })

  it('auto-shows the install log and error when the last install failed', () => {
    render({ installLogs: ['registry failed: boom\n'], installError: 'registry failed: boom' })

    expect(container.querySelector('[aria-label="Install log"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('boom')
  })
})
