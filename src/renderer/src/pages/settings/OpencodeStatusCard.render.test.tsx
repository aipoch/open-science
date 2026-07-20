// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OpencodeStatusCard } from './OpencodeStatusCard'

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
  props: Partial<React.ComponentProps<typeof OpencodeStatusCard>> = {}
): (() => void) => {
  const onInstall = props.onInstall ?? vi.fn()

  act(() => {
    root.render(
      <OpencodeStatusCard
        opencode={{}}
        opencodeReady={false}
        isDetecting={false}
        onDetect={vi.fn()}
        isInstalling={false}
        installLogs={[]}
        installProgress={null}
        installError={undefined}
        npmAvailable
        onInstall={onInstall}
        {...props}
      />
    )
  })

  return onInstall as () => void
}

describe('OpencodeStatusCard', () => {
  it('shows the path and version when opencode is detected, and no install picker', () => {
    render({ opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' } })

    expect(container.textContent).toContain('OpenCode is installed')
    expect(container.textContent).toContain('/usr/local/bin/opencode')
    expect(container.textContent).toContain('1.18.3')
    expect(container.querySelector('[aria-label="Install source"]')).toBeNull()
  })

  it('shows the install-source picker (managed default) when opencode is not detected', () => {
    render({ opencode: {} })

    expect(container.textContent).toContain('OpenCode not detected')
    const trigger = container.querySelector('[aria-label="Install source"]')
    expect(trigger?.tagName).toBe('BUTTON')
    expect(trigger?.textContent).toContain('App-managed download (recommended)')
  })

  it('greys out uninstall (with a `?`) for a non-managed install and enables it for a managed one', () => {
    const onUninstall = vi.fn()
    const findUninstall = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Uninstall')
      )

    // A detected but non-managed (PATH) opencode shows the button greyed out (aria-disabled) with an
    // inline `?` explainer.
    render({
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      onUninstall: vi.fn()
    })
    expect(findUninstall()?.getAttribute('aria-disabled')).toBe('true')
    expect(findUninstall()?.querySelector('.lucide-circle-question-mark')).not.toBeNull()

    // The same install marked managed enables the action and fires onUninstall on click.
    render({
      opencode: { resolvedPath: '/data/opencode-managed/bin/opencode', version: '1.18.3' },
      managed: true,
      onUninstall
    })
    const button = findUninstall()
    expect(button?.disabled).toBe(false)
    expect(button?.getAttribute('aria-disabled')).toBeNull()

    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUninstall).toHaveBeenCalledTimes(1)
  })

  it('is selectable only when opencodeReady, not merely when a path is cached', () => {
    const installed = { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' }

    // A cached but not-ready binary (preflight failed --version) offers no radio.
    render({ opencode: installed, opencodeReady: false, onSelect: vi.fn() })
    expect(container.querySelector('[role="radio"]')).toBeNull()

    // Once ready, the radio appears.
    render({ opencode: installed, opencodeReady: true, onSelect: vi.fn() })
    expect(container.querySelector('[role="radio"]')).not.toBeNull()
  })
})
