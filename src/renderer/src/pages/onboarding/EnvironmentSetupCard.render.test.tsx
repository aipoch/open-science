// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EnvironmentSetupCard } from './EnvironmentSetupCard'
import type { EnvironmentCheckResult } from '../../../../shared/settings'

// A not-ready, auto-installable environment so the "Install missing runtime" button renders.
const environment: EnvironmentCheckResult = {
  checkedAt: 1,
  platform: 'darwin',
  architecture: 'arm64',
  checks: [],
  ready: false,
  canAutoInstall: true,
  agentFrameworkId: 'claude-code',
  runtime: { found: false }
}

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

const installButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Install missing runtime')
  ) as HTMLButtonElement | undefined

describe('EnvironmentSetupCard install button lock', () => {
  it('disables the install button while ANOTHER runtime installs (installBusy), without showing this runtime as installing', () => {
    const onInstall = vi.fn()
    act(() => {
      root.render(
        <EnvironmentSetupCard
          environment={environment}
          isChecking={false}
          // This runtime is idle; a different runtime's install is in flight.
          isInstalling={false}
          installBusy={true}
          installLogs={[]}
          installProgress={null}
          onCheck={vi.fn()}
          onInstall={onInstall}
        />
      )
    })

    const button = installButton()
    // Locked (can't start a second install that would hit the store guard and surface a phantom failure)…
    expect(button?.disabled).toBe(true)
    // …but still shows the idle label, not this runtime's "Installing…" state.
    expect(button?.textContent).toContain('Install missing runtime')
    expect(button?.textContent).not.toContain('Installing…')
  })

  it('leaves the install button enabled when no runtime is installing', () => {
    act(() => {
      root.render(
        <EnvironmentSetupCard
          environment={environment}
          isChecking={false}
          isInstalling={false}
          installBusy={false}
          installLogs={[]}
          installProgress={null}
          onCheck={vi.fn()}
          onInstall={vi.fn()}
        />
      )
    })

    expect(installButton()?.disabled).toBe(false)
  })
})
