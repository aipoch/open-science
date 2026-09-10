// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import type { WslPlatformInstallResult, WslSetupSnapshot } from '../../../../shared/wsl-setup'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { WslLocalShellSection } from './WslLocalShellSection'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

let container: HTMLDivElement
let root: Root
let probe: ReturnType<typeof vi.fn>
let select: ReturnType<typeof vi.fn>
let install: ReturnType<typeof vi.fn>
let installRecommended: ReturnType<typeof vi.fn>
let installMissingDependencies: ReturnType<typeof vi.fn>
let openTerminal: ReturnType<typeof vi.fn>
let createSupportHandoff: ReturnType<typeof vi.fn>
let switchToPowerShell: ReturnType<typeof vi.fn>
let useWsl2Bash: ReturnType<typeof vi.fn>
let getWslSetupStatus: ReturnType<typeof vi.fn>
let onWslSetupChanged: ReturnType<typeof vi.fn>

const project = (id: string, updatedAt: number): Project => ({
  id,
  name: id,
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt
})

const flush = async (): Promise<void> => {
  await act(async () => {})
}

const renderAndCheck = async (): Promise<void> => {
  await act(async () => root.render(<WslLocalShellSection />))
  await flush()
  expect(probe).not.toHaveBeenCalled()
  const check = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Check now')
  )
  expect(check).toBeDefined()
  await act(async () => check?.click())
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  probe = vi.fn().mockResolvedValue({
    state: 'distro-required',
    distros: [
      { name: 'Legacy', version: 1, isDefault: false },
      { name: 'Ubuntu-24.04', version: 2, isDefault: true }
    ],
    operationReference: 'deadbeef'
  })
  select = vi.fn().mockResolvedValue({
    state: 'ready',
    distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
    readiness: {
      wsl2: true,
      bash: true,
      bwrap: true,
      python3: true,
      namespaces: true,
      localWorkspace: true
    },
    operationReference: '1234abcd'
  })
  install = vi.fn().mockResolvedValue({
    outcome: 'uac-cancelled',
    operationReference: 'feedface',
    snapshot: {
      state: 'not-installed',
      distros: [],
      errorCode: 'wsl_install_uac_cancelled',
      operationReference: 'feedface'
    }
  })
  installRecommended = vi.fn().mockResolvedValue({
    state: 'distro-required',
    distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }],
    operationReference: 'feedface'
  })
  installMissingDependencies = vi.fn().mockResolvedValue({
    state: 'ready',
    distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
    readiness: { wsl2: true, home: true, bash: true, bwrap: true, python3: true },
    operationReference: 'cafebabe'
  })
  openTerminal = vi.fn().mockResolvedValue({
    state: 'first-launch-required',
    distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
    errorCode: 'wsl_first_launch_required',
    operationReference: 'feedface'
  })
  createSupportHandoff = vi.fn().mockResolvedValue({
    setupSessionToken: 'secret-setup-token',
    handoff: {
      schemaVersion: 1,
      guide: { id: 'wsl2-setup', version: '1', status: 'available' },
      capturedAt: '2026-09-08T00:00:00.000Z',
      revision: 7,
      errorCode: 'wsl_namespace_unavailable',
      supportReference: 'a1b2c3d4',
      operationReference: 'a1b2c3d4',
      windows: {
        version: '11',
        build: '26100',
        architecture: 'x64',
        previewAvailable: true,
        previewReason: 'available'
      },
      wsl: {
        softwareVersion: '2.5.9',
        linuxKernelVersion: '6.6.87',
        installState: 'dependency-required'
      },
      distros: [{ name: 'Private-Lab', version: 2, isDefault: true }],
      selectedTarget: { distro: 'Private-Lab', user: 'private-user' },
      currentBackend: 'powershell',
      checks: {
        wsl2: { state: 'pass' },
        home: { state: 'pass', path: '/home/private-user' },
        bash: { state: 'pass', path: '/bin/bash' },
        bwrap: { state: 'pass', path: '/usr/bin/bwrap' },
        python3: { state: 'fail' },
        mirroredNetworking: { state: 'pass' },
        namespaces: { state: 'fail' },
        localWorkspace: { state: 'pass' }
      },
      operation: { state: 'idle' },
      recovery: { restartRequired: false, resultUnknown: false, recheck: ['namespaces'] },
      capabilities: {
        wsl2: true,
        home: true,
        bash: true,
        bwrap: true,
        python3: false,
        namespaces: false
      },
      versions: { wsl: '2.5.9', distribution: '2' },
      target: 'restore-wsl2-bash'
    }
  })
  switchToPowerShell = vi.fn().mockResolvedValue({
    runtimeBinding: { kind: 'powershell', version: '5.1' },
    appliesTo: 'subsequent-executions',
    wslProfilePreserved: true
  })
  useWsl2Bash = vi.fn().mockResolvedValue({
    runtime: 'wsl2-bash',
    selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
    appliesTo: 'subsequent-executions'
  })
  getWslSetupStatus = vi.fn().mockResolvedValue({ revision: 0, operation: { state: 'idle' } })
  onWslSetupChanged = vi.fn(() => () => undefined)
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getWslSetupStatus,
      onWslSetupChanged,
      probeWslSetup: probe,
      selectWslProfile: select,
      installWslPlatform: install,
      installRecommendedWslDistro: installRecommended,
      installMissingWslDependencies: installMissingDependencies,
      openWslTerminal: openTerminal,
      createWslSupportHandoff: createSupportHandoff,
      switchLocalShellToPowerShell: switchToPowerShell,
      useWsl2Bash
    }
  }
  useProjectStore.setState({
    ...createInitialProjectState(),
    projects: [project('older', 1), project('newest', 2)],
    isLoaded: true
  })
  useNavigationStore.setState({
    view: 'home',
    activeProjectId: undefined,
    pendingCustomizePrefill: undefined,
    pendingWslSupportPrefill: undefined
  })
  useSettingsStore.setState({ isSettingsOpen: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('WslLocalShellSection', () => {
  const dependencySnapshot = (errorCode = 'wsl_bwrap_missing'): WslSetupSnapshot => ({
    state: 'dependency-required',
    distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
    readiness: { wsl2: true, home: true, bash: true, bwrap: false, python3: true },
    canInstallMissingDependencies: true,
    errorCode,
    operationReference: 'decafbad'
  })

  const withoutDependencyInstallCapability = (snapshot: WslSetupSnapshot): WslSetupSnapshot => {
    const copy = { ...snapshot }
    delete copy.canInstallMissingDependencies
    return copy
  }

  it('requires confirmation before installing missing dependencies as root', async () => {
    const snapshot = dependencySnapshot()
    getWslSetupStatus.mockResolvedValue({
      revision: 7,
      snapshot,
      operation: { state: 'idle' }
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    const installDependencies = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install missing dependencies')
    )
    expect(installDependencies).toBeDefined()
    expect(installMissingDependencies).not.toHaveBeenCalled()

    await act(async () => installDependencies?.click())
    await flush()

    expect(installMissingDependencies).not.toHaveBeenCalled()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Ubuntu-22.04')
    expect(dialog?.textContent).toContain('scientist')
    expect(dialog?.textContent).toContain('root')
    expect(dialog?.textContent).toContain('sudoers')
    expect(dialog?.textContent).toContain('future runs')
  })

  it('clearly labels the unpackaged development admission', async () => {
    await act(async () => root.render(<WslLocalShellSection developmentPreview />))
    await flush()

    expect(container.textContent).toContain('Local Shell · WSL2 Bash Development Preview')
  })

  it('waits for the user to refresh WSL2 status', async () => {
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(probe).not.toHaveBeenCalled()
    expect(container.textContent).toContain('WSL2 status has not been checked yet')
    expect(container.textContent).toContain('Check now')
  })

  it('offers only explicit PowerShell recovery when Preview admission is unavailable', async () => {
    await act(async () => root.render(<WslLocalShellSection previewAvailable={false} />))
    await flush()

    expect(probe).not.toHaveBeenCalled()
    expect(container.textContent).toContain('WSL2 Bash Preview is unavailable')
    expect(container.textContent).not.toContain('Check again')
    expect(container.textContent).not.toContain('Use WSL2 Bash')

    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Switch to PowerShell')
    )
    await act(async () => button?.click())
    await flush()

    expect(switchToPowerShell).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Future Shell commands will use PowerShell')
  })

  it('explicitly switches only future Shell commands to PowerShell and never retries failed work', async () => {
    probe.mockResolvedValue({
      state: 'failed',
      distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
      selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
      errorCode: 'wsl_namespace_unavailable',
      operationReference: 'a1b2c3d4'
    })
    await renderAndCheck()

    expect(switchToPowerShell).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Switch to PowerShell')
    )
    await act(async () => button?.click())
    await flush()

    expect(switchToPowerShell).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Future Shell commands will use PowerShell')
    expect(container.textContent).toContain('Running and failed commands were not rerun')
    expect(container.textContent).toContain('saved WSL2 profile is still available')
  })

  it('enables WSL2 Bash only through the explicit action on the latest ready profile', async () => {
    probe.mockResolvedValue({
      state: 'ready',
      distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }],
      selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
      readiness: {
        wsl2: true,
        home: true,
        bash: true,
        bwrap: true,
        namespaces: true,
        localWorkspace: true
      },
      operationReference: 'ready001'
    })
    await renderAndCheck()

    expect(useWsl2Bash).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This ready profile is only a candidate')
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Use WSL2 Bash')
    )
    await act(async () => button?.click())
    await flush()

    expect(useWsl2Bash).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Future Shell commands will use WSL2 Bash')
    expect(container.textContent).toContain('This ready profile is active')
    expect(container.textContent).toContain('Running and failed commands were not rerun')
  })

  it('treats a newly saved ready profile as a candidate and clears the old activation success', async () => {
    const ready = {
      state: 'ready' as const,
      distros: [
        { name: 'Ubuntu-22.04', version: 2 as const, isDefault: true },
        { name: 'Ubuntu-24.04', version: 2 as const, isDefault: false }
      ],
      selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
      readiness: {
        wsl2: true,
        home: true,
        bash: true,
        bwrap: true,
        namespaces: true,
        localWorkspace: true
      },
      operationReference: 'ready-a'
    }
    probe.mockResolvedValue(ready)
    select.mockResolvedValue({
      ...ready,
      selection: { distro: 'Ubuntu-22.04', user: 'candidate' },
      operationReference: 'ready-b'
    })
    await renderAndCheck()

    const useButton = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Use WSL2 Bash')
    )
    await act(async () => useButton?.click())
    await flush()
    expect(container.textContent).toContain('Future Shell commands will use WSL2 Bash')

    const userInput = container.querySelector('input')
    await act(async () => {
      if (userInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(userInput, 'candidate')
        userInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    const saveButton = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Save and check')
    )
    await act(async () => saveButton?.click())
    await flush()

    expect(select).toHaveBeenCalledWith({ distro: 'Ubuntu-22.04', user: 'candidate' })
    expect(container.textContent).not.toContain('Future Shell commands will use WSL2 Bash')
    expect(container.textContent).toContain('Use WSL2 Bash')
    expect(container.textContent).toContain('This ready profile is only a candidate')
  })

  it('offers an explicit PowerShell switch for a persisted active WSL2 profile', async () => {
    const selection = { distro: 'Ubuntu-24.04', user: 'scientist' }
    probe.mockResolvedValue({
      state: 'ready',
      distros: [{ name: selection.distro, version: 2, isDefault: true }],
      selection,
      activeRuntime: 'wsl2-bash',
      activatedSelection: selection,
      readiness: {
        wsl2: true,
        home: true,
        bash: true,
        bwrap: true,
        namespaces: true,
        localWorkspace: true
      },
      operationReference: 'active01'
    })

    await renderAndCheck()

    expect(container.textContent).toContain('This ready profile is active')
    expect(container.textContent).not.toContain('Use WSL2 Bash')
    expect(useWsl2Bash).not.toHaveBeenCalled()

    const switchButton = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Switch to PowerShell')
    )
    expect(switchButton).toBeDefined()
    await act(async () => switchButton?.click())
    await flush()

    expect(switchToPowerShell).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Future Shell commands will use PowerShell')
    expect(container.textContent).toContain('saved WSL2 profile is still available')
  })

  it('shows retry guidance without claiming a switch when persistence fails', async () => {
    probe.mockResolvedValue({
      state: 'failed',
      distros: [],
      errorCode: 'wsl_namespace_unavailable',
      operationReference: 'failed01'
    })
    switchToPowerShell.mockRejectedValueOnce(new Error('disk full'))
    await renderAndCheck()

    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Switch to PowerShell')
    )
    await act(async () => button?.click())
    await flush()

    expect(container.textContent).toContain('could not finish changing the Shell runtime')
    expect(container.textContent).toContain('Restart Open Science')
    expect(container.textContent).toContain('Try switching again')
    expect(container.textContent).not.toContain('Future Shell commands will use PowerShell')
    expect(probe).toHaveBeenCalledOnce()
  })

  it('requires a user click to install and never replays after UAC cancellation', async () => {
    probe.mockResolvedValue({
      state: 'not-installed',
      distros: [],
      errorCode: 'wsl_not_installed',
      operationReference: 'deadbeef'
    })
    await renderAndCheck()

    expect(install).not.toHaveBeenCalled()
    const installButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install WSL2')
    )
    await act(async () => installButton?.click())
    await flush()

    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('installation was cancelled')
    expect(container.textContent).toContain('wsl_install_uac_cancelled · feedface')
    expect(container.textContent).toContain('keep using PowerShell')
  })

  it('restores an in-progress installation when Settings is reopened without probing or starting it again', async () => {
    const installation = Promise.withResolvers<WslPlatformInstallResult>()
    let statusListener: ((status: unknown) => void) | undefined
    const runningStatus = {
      revision: 2,
      snapshot: {
        state: 'not-installed',
        distros: [],
        errorCode: 'wsl_not_installed',
        operationReference: 'before01'
      },
      operation: {
        state: 'running',
        kind: 'install-platform',
        phase: 'installing',
        operationReference: 'install4',
        startedAt: 1
      }
    }
    probe.mockResolvedValue(runningStatus.snapshot)
    install.mockReturnValue(installation.promise)
    onWslSetupChanged.mockImplementation((listener) => {
      statusListener = listener
      return () => undefined
    })

    await renderAndCheck()
    const installButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install WSL2')
    )
    act(() => installButton?.click())
    act(() => statusListener?.(runningStatus))
    expect(container.textContent).toContain('Installing the WSL2 platform in Windows')

    act(() => root.unmount())
    root = createRoot(container)
    getWslSetupStatus.mockResolvedValue(runningStatus)
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(probe).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Installing the WSL2 platform in Windows')
    expect(container.textContent).not.toContain('Install WSL2')

    act(() =>
      statusListener?.({
        revision: 3,
        snapshot: {
          state: 'not-installed',
          distros: [],
          errorCode: 'wsl_install_uac_cancelled',
          operationReference: 'install4'
        },
        operation: {
          state: 'finished',
          kind: 'install-platform',
          outcome: 'cancelled',
          operationReference: 'install4',
          startedAt: 1,
          finishedAt: 2
        }
      })
    )
    await flush()
    expect(container.textContent).toContain('installation was cancelled')
  })

  it('selects an existing WSL2 distro and exact user, then shows every readiness result', async () => {
    await renderAndCheck()

    const trigger = container.querySelector('[data-slot="select-trigger"]')
    expect(trigger?.className).toContain('h-8')
    expect(container.querySelector('select')).toBeNull()

    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'scientist'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Save and check')
    )
    await act(async () => save?.click())
    await flush()

    expect(select).toHaveBeenCalledWith({ distro: 'Ubuntu-24.04', user: 'scientist' })
    expect(container.textContent).toContain('ready for sandboxed WSL2 Bash')
    expect(container.textContent).toContain('Local Windows workspace')
    expect(container.textContent).not.toContain('1234abcd')
  })

  it('shows stable error code and operation reference without backend output', async () => {
    probe.mockResolvedValue({
      state: 'failed',
      distros: [],
      errorCode: 'wsl_workspace_not_ntfs',
      readiness: { wsl2: true, localWorkspace: false },
      operationReference: 'a1b2c3d4'
    })
    await renderAndCheck()

    expect(container.textContent).toContain('wsl_workspace_not_ntfs · a1b2c3d4')
    expect(container.textContent).toContain(
      'Move the Open Science data folder to a local NTFS drive'
    )
    expect(container.textContent).toContain('Not checked')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('offers the supported distros, recommends Ubuntu 24.04, and installs the selected distro', async () => {
    probe.mockResolvedValue({
      state: 'distro-required',
      distros: [],
      errorCode: 'wsl_distro_missing',
      operationReference: 'deadbeef'
    })
    installRecommended.mockResolvedValue({
      state: 'distro-required',
      distros: [{ name: 'FedoraLinux-44', version: 2, isDefault: true }],
      operationReference: 'feedface'
    })
    await renderAndCheck()

    const distroSelect = container.querySelector<HTMLButtonElement>(
      '[aria-label="WSL2 distribution"]'
    )
    expect(distroSelect?.textContent).toContain('Ubuntu 24.04 LTS (recommended)')
    act(() => {
      distroSelect?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      distroSelect?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map((option) =>
        option.textContent?.trim()
      )
    ).toEqual([
      'Ubuntu 24.04 LTS (recommended)',
      'Debian 13',
      'Ubuntu 22.04 LTS',
      'Kali Linux',
      'openSUSE',
      'Fedora'
    ])
    const fedora = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent?.trim() === 'Fedora'
    )
    act(() => {
      fedora?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      fedora?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const install = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install Fedora')
    )
    expect(install).toBeDefined()
    expect(installRecommended).not.toHaveBeenCalled()
    await act(async () => install?.click())
    await flush()

    expect(installRecommended).toHaveBeenCalledWith({ distro: 'FedoraLinux-44' })
    const launch = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open distribution terminal')
    )
    await act(async () => launch?.click())
    await flush()
    expect(openTerminal).toHaveBeenCalledWith({ distro: 'FedoraLinux-44' })
  })

  it('keeps first launch bound to the selected distro when Ubuntu is also installed', async () => {
    probe.mockResolvedValue({
      state: 'first-launch-required',
      distros: [
        { name: 'Debian', version: 2, isDefault: true },
        { name: 'Ubuntu-22.04', version: 2, isDefault: false }
      ],
      selection: { distro: 'Debian', user: 'scientist' },
      errorCode: 'wsl_first_launch_required',
      operationReference: 'decafbad'
    })
    await renderAndCheck()

    const launch = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open distribution terminal')
    )
    await act(async () => launch?.click())
    await flush()
    expect(openTerminal).toHaveBeenCalledWith({ distro: 'Debian' })
  })

  it('offers recommended first initialization without a selection only when Ubuntu is installed', async () => {
    probe.mockResolvedValue({
      state: 'distro-required',
      distros: [{ name: 'Debian', version: 2, isDefault: true }],
      operationReference: 'decafbad'
    })
    await renderAndCheck()

    expect(container.textContent).not.toContain('Open distribution terminal')
    expect(openTerminal).not.toHaveBeenCalled()
  })

  it('installs against the revision bound to the confirmed snapshot without activating WSL2 Bash', async () => {
    const snapshot = dependencySnapshot()
    getWslSetupStatus.mockResolvedValue({ revision: 7, snapshot, operation: { state: 'idle' } })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    const installDependencies = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install missing dependencies')
    )
    await act(async () => installDependencies?.click())
    await flush()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('Install missing dependencies')
    )
    await act(async () => confirm?.click())
    await flush()

    expect(installMissingDependencies).toHaveBeenCalledWith({ expectedRevision: 7 })
    expect(useWsl2Bash).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Use WSL2 Bash')
    expect(container.textContent).not.toContain('sudo apt-get')
    expect(container.textContent).not.toContain('Copy command')
  })

  it('refreshes a revision that is not yet bound to the manually checked snapshot', async () => {
    const snapshot = dependencySnapshot()
    probe.mockResolvedValue(snapshot)
    getWslSetupStatus
      .mockResolvedValueOnce({ revision: 0, operation: { state: 'idle' } })
      .mockResolvedValueOnce({ revision: 11, snapshot, operation: { state: 'idle' } })
    await renderAndCheck()

    const installDependencies = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install missing dependencies')
    )
    await act(async () => installDependencies?.click())
    await flush()
    const dialog = document.body.querySelector('[role="alertdialog"]')
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('Install missing dependencies')
    )
    await act(async () => confirm?.click())
    await flush()

    expect(installMissingDependencies).toHaveBeenCalledWith({ expectedRevision: 11 })
  })

  it.each(['wsl_bash_missing', 'wsl_bwrap_missing', 'wsl_python3_missing'])(
    'offers one-click installation for %s without a sudo command or user terminal action',
    async (errorCode) => {
      const snapshot = dependencySnapshot(errorCode)
      getWslSetupStatus.mockResolvedValue({ revision: 8, snapshot, operation: { state: 'idle' } })
      await act(async () => root.render(<WslLocalShellSection />))
      await flush()

      expect(container.textContent).toContain('Install missing dependencies')
      expect(container.textContent).not.toContain('sudo apt-get')
      expect(container.textContent).not.toContain('Copy command')
      expect(container.textContent).not.toContain('Open distribution terminal')
    }
  )

  it('explains the manual recovery path when automatic dependency installation is unavailable', async () => {
    const snapshot = withoutDependencyInstallCapability(dependencySnapshot())
    getWslSetupStatus.mockResolvedValue({ revision: 8, snapshot, operation: { state: 'idle' } })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(container.textContent).toContain(
      'Automatic installation is unavailable for this distribution. Use its package manager or set up in conversation.'
    )
    expect(container.textContent).not.toContain('Install missing dependencies')
  })

  it('shows dependency-specific progress while the root installation is running', async () => {
    const snapshot = dependencySnapshot()
    getWslSetupStatus.mockResolvedValue({
      revision: 9,
      snapshot,
      operation: {
        state: 'running',
        kind: 'install-runtime-dependencies',
        phase: 'installing',
        operationReference: 'cafebabe',
        startedAt: 1
      }
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(container.textContent).toContain('Installing Linux dependencies…')
  })

  it.each([
    [
      'wsl_dependency_install_failed',
      'Open Science could not install the missing Linux dependencies.'
    ],
    [
      'wsl_dependency_install_unconfirmed',
      'Open Science could not confirm that the missing Linux dependencies were installed.'
    ],
    [
      'wsl_dependency_install_not_allowed',
      'The selected WSL2 profile changed or is no longer eligible for dependency installation.'
    ],
    [
      'wsl_dependency_install_not_supported',
      'Automatic installation is unavailable for this distribution.'
    ],
    ['wsl_install_journal_unavailable', 'Open Science could not safely record the installation.']
  ])('explains dependency installation recovery for %s', async (errorCode, expectedCopy) => {
    const candidate: WslSetupSnapshot = {
      ...dependencySnapshot(errorCode),
      state:
        errorCode === 'wsl_dependency_install_failed' ||
        errorCode === 'wsl_dependency_install_unconfirmed'
          ? 'dependency-required'
          : 'failed'
    }
    const snapshot: WslSetupSnapshot =
      errorCode === 'wsl_dependency_install_not_supported'
        ? withoutDependencyInstallCapability(candidate)
        : candidate
    getWslSetupStatus.mockResolvedValue({ revision: 10, snapshot, operation: { state: 'idle' } })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(container.textContent).toContain(expectedCopy)
    if (snapshot.state === 'dependency-required') {
      const retry = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Try installation again')
      )
      await act(async () => retry?.click())
      await flush()
      expect(installMissingDependencies).not.toHaveBeenCalled()
      expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
    }
  })

  it('closes Settings and opens a normal project conversation with only safe WSL diagnostics', async () => {
    probe.mockResolvedValue({
      state: 'dependency-required',
      distros: [{ name: 'Private-Lab', version: 2, isDefault: true }],
      selection: { distro: 'Private-Lab', user: 'private-user' },
      readiness: { wsl2: true, bash: true, bwrap: true, namespaces: false },
      errorCode: 'wsl_namespace_unavailable',
      operationReference: 'a1b2c3d4'
    })
    await renderAndCheck()

    const support = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Set up in conversation')
    )
    await act(async () => support?.click())
    await flush()

    expect(createSupportHandoff).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().isSettingsOpen).toBe(false)
    expect(useNavigationStore.getState().activeProjectId).toBe('newest')
    const intent = useNavigationStore.getState().pendingWslSupportPrefill
    expect(intent?.doc.nodes).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('wsl_namespace_unavailable')
      })
    ])
    expect(JSON.stringify(intent?.doc)).toContain('Private-Lab')
    expect(JSON.stringify(intent?.doc)).toContain('private-user')
    expect(JSON.stringify(intent?.doc)).toContain('python3')
    expect(JSON.stringify(intent?.doc)).not.toContain('secret-setup-token')
    expect(intent?.setupSessionToken).toBe('secret-setup-token')
  })

  it('offers project creation and carries setup forward when no project is available', async () => {
    useProjectStore.setState({ ...createInitialProjectState(), projects: [], isLoaded: true })
    probe.mockResolvedValue({
      state: 'not-installed',
      distros: [],
      errorCode: 'wsl_not_installed',
      operationReference: 'a1b2c3d4'
    })
    await renderAndCheck()

    const support = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Set up in conversation')
    )
    expect(support?.disabled).toBe(true)
    const createProject = container.querySelector<HTMLButtonElement>(
      '[data-testid="wsl-setup-create-project"]'
    )
    expect(createProject).not.toBeNull()
    act(() => createProject?.click())
    expect(useSettingsStore.getState().isSettingsOpen).toBe(false)
    expect(useNavigationStore.getState().pendingProjectCreation).toBe(true)
    expect(useNavigationStore.getState().pendingWslSetupAfterProjectCreation).toBe(true)
  })

  it.each([
    'not-installed',
    'restart-required',
    'distro-required',
    'first-launch-required',
    'dependency-required',
    'failed'
  ] as const)('offers conversation support for the %s state', async (state) => {
    probe.mockResolvedValue({
      state,
      distros: [],
      errorCode: 'wsl_probe_failed',
      operationReference: 'a1b2c3d4'
    })
    await renderAndCheck()

    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Set up in conversation')
      )
    ).toBe(true)
  })
})
