// @vitest-environment jsdom
// Thin shell suite: step transitions (①→⑤ and Back), the recovery single-page view, and the
// shell-owned side effects (env-store hydration, full-screen relaunch state). Per-step content and
// gating live in the step suites (EnvironmentStep/AgentStep/ProviderStep/NotebookStep/LocationStep).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings-store'
import { OnboardingWizard } from './OnboardingWizard'
import {
  clickButton,
  DEFAULT_DATA_ROOT,
  findButton,
  storageInfo,
  fillRequiredProviderFields,
  readyClaudeState,
  resetOnboardingStores,
  stubWindowApi
} from './onboarding-test-utils'

let container: HTMLDivElement
let root: Root
let envInit: ReturnType<typeof vi.fn>
let envProvision: ReturnType<typeof vi.fn>

beforeEach(() => {
  ;({ envInit, envProvision } = resetOnboardingStores())
  stubWindowApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

const renderWizard = async (): Promise<void> => {
  await act(async () => {
    root.render(<OnboardingWizard />)
  })
}

const currentSection = (label: string): Element | null =>
  container.querySelector(`section[aria-label="${label}"]`)

// Reaches the early storage step from Environment.
const goToLocationStep = async (): Promise<void> => {
  await clickButton(/^continue$/i) // Environment → Location
}

describe('OnboardingWizard flow', () => {
  it('uses a single-column layout before the desktop breakpoint', async () => {
    readyClaudeState()

    await renderWizard()

    const layout = container.querySelector<HTMLElement>('[data-onboarding-layout="split"]')
    expect(layout?.className).toContain('grid-cols-1')
    expect(layout?.className).toContain('md:grid-cols-[240px_minmax(0,1fr)]')
  })

  it('walks all five steps forward in order, tracking progress', async () => {
    readyClaudeState()

    await renderWizard()

    // ① Environment — always the visible start, even when every check already passed.
    expect(currentSection('Prepare environment')).not.toBeNull()
    const progressItems = Array.from(
      container.querySelectorAll('ol[aria-label="Setup progress"] li')
    )
    expect(progressItems.map((item) => item.textContent)).toEqual([
      '1Environment',
      '2Data location',
      '3Agent runtime',
      '4Model provider',
      '5Notebook runtime'
    ])
    expect(progressItems[0].getAttribute('aria-current')).toBe('step')

    // ② Data location. Keeping the current default continues without a relaunch.
    await clickButton(/^continue$/i)
    expect(currentSection('Choose data location')).not.toBeNull()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    await clickButton(/^continue$/i)

    // ③ Agent runtime.
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
    expect(currentSection('Prepare environment')).toBeNull()

    // ④ Model provider.
    await clickButton(/^continue$/i)
    expect(currentSection('Configure model')).not.toBeNull()

    // A successful validation lands on ⑤ Notebook, which now owns final completion.
    await fillRequiredProviderFields(container)
    await clickButton(/test & continue/i)
    expect(currentSection('Notebook runtime (optional)')).not.toBeNull()
    expect(currentSection('Configure model')).toBeNull()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()

    await clickButton(/^finish$/i)
    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledOnce()
  })

  it('defaults Windows onboarding storage to the first usable non-system drive', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' },
      { path: 'E:\\', label: 'E:' }
    ])
    window.api.storage.inspectDataRoot = vi.fn().mockResolvedValueOnce({
      kind: 'move',
      dataRoot: 'D:\\OpenScience',
      targetWasAbsent: true
    })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(container.textContent).toContain('D:\\OpenScience')
    expect(window.api.storage.inspectDataRoot).toHaveBeenCalledWith('D:\\')
    expect(window.api.storage.inspectDataRoot).toHaveBeenCalledTimes(1)

    await clickButton(/continue/i)
    await clickButton(/^restart$/i)

    expect(window.api.storage.setDataRootAndRelaunch).toHaveBeenCalledWith('D:\\', false)
  })

  it('skips unusable or existing Windows data roots when choosing the default drive', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'F:\\', label: 'F:' },
      { path: 'C:\\', label: 'C:' },
      { path: 'E:\\', label: 'E:' },
      { path: 'D:\\', label: 'D:' }
    ])
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'invalid',
        dataRoot: 'D:\\OpenScience',
        error: 'The selected folder is not writable.'
      })
      .mockResolvedValueOnce({
        kind: 'adopt',
        dataRoot: 'E:\\OpenScience'
      })
      .mockResolvedValueOnce({
        kind: 'move',
        dataRoot: 'F:\\OpenScience',
        targetWasAbsent: true
      })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(container.textContent).toContain('F:\\OpenScience')
    expect(window.api.storage.inspectDataRoot).toHaveBeenNthCalledWith(1, 'D:\\')
    expect(window.api.storage.inspectDataRoot).toHaveBeenNthCalledWith(2, 'E:\\')
    expect(window.api.storage.inspectDataRoot).toHaveBeenNthCalledWith(3, 'F:\\')
  })

  it('skips an existing runtime-only target during automatic drive selection', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' },
      { path: 'E:\\', label: 'E:' }
    ])
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'move',
        dataRoot: 'D:\\OpenScience',
        targetWasAbsent: false
      })
      .mockResolvedValueOnce({
        kind: 'move',
        dataRoot: 'E:\\OpenScience',
        targetWasAbsent: true
      })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(container.textContent).toContain('E:\\OpenScience')
    expect(container.textContent).not.toContain('D:\\OpenScience')
    expect(window.api.storage.inspectDataRoot).toHaveBeenNthCalledWith(1, 'D:\\')
    expect(window.api.storage.inspectDataRoot).toHaveBeenNthCalledWith(2, 'E:\\')
  })

  it('keeps the existing default when Windows has no usable non-system drive', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' }
    ])
    window.api.storage.inspectDataRoot = vi.fn().mockResolvedValue({
      kind: 'invalid',
      dataRoot: 'D:\\OpenScience',
      error: 'The selected folder is not writable.'
    })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(container.textContent).toContain('C:\\Users\\researcher\\OpenScience')
    await clickButton(/continue/i)
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
  })

  it('resumes at Agent when a non-default data root was persisted before relaunch', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'E:\\Research\\OpenScience',
        isDefault: false,
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher'
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' },
      { path: 'E:\\', label: 'E:' }
    ])
    readyClaudeState()

    await renderWizard()

    expect(window.api.localFs.listDrives).not.toHaveBeenCalled()
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
    expect(currentSection('Choose data location')).toBeNull()
  })

  it('keeps a missing non-default data root in the recoverable onboarding flow', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'E:\\Research\\OpenScience',
        dataRootMissing: true,
        isDefault: false,
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher'
      })
    )
    readyClaudeState()

    await renderWizard()

    expect(currentSection('Prepare environment')).not.toBeNull()
    await goToLocationStep()
    expect(currentSection('Choose data location')).not.toBeNull()
    expect(container.textContent).toContain('E:\\Research\\OpenScience')
    expect(findButton(/browse/i)).not.toBeNull()
  })

  it('does not probe alternate drives for legacy data after its move prompt was dismissed', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\.open-science',
        isDefault: true,
        defaultDataRoot: 'C:\\Users\\researcher\\.open-science',
        defaultParent: 'C:\\Users\\researcher',
        legacyDataMovePrompt: false,
        canAutoSelectDataDrive: false
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' }
    ])
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(window.api.localFs.listDrives).not.toHaveBeenCalled()
    expect(container.textContent).toContain('C:\\Users\\researcher\\.open-science')
  })

  it('does not overwrite a location browsed while the Windows default probe is pending', async () => {
    let releaseDefaultProbe: (() => void) | undefined
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' }
    ])
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('F:\\Research')
    window.api.storage.inspectDataRoot = vi.fn().mockImplementation((parent: string) => {
      if (parent === 'D:\\') {
        return new Promise((resolve) => {
          releaseDefaultProbe = () =>
            resolve({ kind: 'move', dataRoot: 'D:\\OpenScience', targetWasAbsent: true })
        })
      }
      return Promise.resolve({ kind: 'move', dataRoot: 'F:\\Research\\OpenScience' })
    })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    await clickButton(/browse/i)

    expect(container.textContent).toContain('F:\\Research\\OpenScience')
    await act(async () => {
      releaseDefaultProbe?.()
    })
    expect(container.textContent).toContain('F:\\Research\\OpenScience')
    expect(container.textContent).not.toContain('D:\\OpenScience')
  })

  it('keeps Continue available while the Windows default recommendation is pending', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockReturnValue(new Promise(() => undefined))
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(container.textContent).toContain('C:\\Users\\researcher\\OpenScience')
    expect(findButton(/^continue$/i)?.disabled).toBe(false)

    await clickButton(/^continue$/i)
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
  })

  it('stops a pending Windows recommendation when the user leaves Location', async () => {
    let resolveDrives: ((drives: Array<{ path: string; label: string }>) => void) | undefined
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDrives = resolve
        })
    )
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    expect(window.api.localFs.listDrives).toHaveBeenCalledOnce()

    await clickButton(/back/i)
    await act(async () => {
      resolveDrives?.([
        { path: 'C:\\', label: 'C:' },
        { path: 'D:\\', label: 'D:' }
      ])
    })
    expect(window.api.storage.inspectDataRoot).not.toHaveBeenCalled()

    await goToLocationStep()
    expect(window.api.localFs.listDrives).toHaveBeenCalledOnce()
    expect(currentSection('Choose data location')?.getAttribute('aria-busy')).toBe('false')
  })

  it('ends a pending Windows recommendation and keeps the default after its deadline', async () => {
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' }
    ])
    window.api.storage.inspectDataRoot = vi.fn().mockReturnValue(new Promise(() => undefined))
    readyClaudeState()

    await renderWizard()
    vi.useFakeTimers()
    try {
      await goToLocationStep()
      expect(currentSection('Choose data location')?.getAttribute('aria-busy')).toBe('true')
      expect(window.api.storage.inspectDataRoot).toHaveBeenCalledWith('D:\\')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })

      expect(currentSection('Choose data location')?.getAttribute('aria-busy')).toBe('false')
      expect(container.textContent).toContain('C:\\Users\\researcher\\OpenScience')
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the Windows default recommendation when the user waits for the probe', async () => {
    let releaseDefaultProbe: (() => void) | undefined
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockResolvedValue(
      storageInfo({
        dataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
        defaultParent: 'C:\\Users\\researcher',
        canAutoSelectDataDrive: true
      })
    )
    window.api.localFs.listDrives = vi.fn().mockResolvedValue([
      { path: 'C:\\', label: 'C:' },
      { path: 'D:\\', label: 'D:' }
    ])
    window.api.storage.inspectDataRoot = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDefaultProbe = () =>
            resolve({ kind: 'move', dataRoot: 'D:\\OpenScience', targetWasAbsent: true })
        })
    )
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    expect(container.textContent).toContain('C:\\Users\\researcher\\OpenScience')
    expect(findButton(/^continue$/i)?.disabled).toBe(false)

    await act(async () => releaseDefaultProbe?.())

    expect(container.textContent).toContain('D:\\OpenScience')
    expect(container.textContent).not.toContain('C:\\Users\\researcher\\OpenScience')
    expect(findButton(/^continue$/i)?.disabled).toBe(false)
  })

  it('waits for Windows storage info before allowing Continue', async () => {
    let resolveStorageInfo: ((info: ReturnType<typeof storageInfo>) => void) | undefined
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStorageInfo = resolve
        })
    )
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    expect(findButton(/^continue$/i)?.disabled).toBe(true)

    await act(async () => {
      resolveStorageInfo?.(storageInfo({ canAutoSelectDataDrive: false }))
    })
    expect(findButton(/^continue$/i)?.disabled).toBe(false)
  })

  it('allows non-Windows onboarding to continue while storage info is pending', async () => {
    window.api.platform = 'darwin'
    window.api.storage.getInfo = vi.fn().mockReturnValue(new Promise(() => undefined))
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(findButton(/^continue$/i)?.disabled).toBe(false)
    await clickButton(/^continue$/i)
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
  })

  it('does not let a late storage resume override a Browse interaction in flight', async () => {
    let resolveStorageInfo: ((info: ReturnType<typeof storageInfo>) => void) | undefined
    let resolvePickedDirectory: ((path: string) => void) | undefined
    window.api.platform = 'win32'
    window.api.storage.getInfo = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStorageInfo = resolve
        })
    )
    window.api.storage.pickDirectory = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePickedDirectory = resolve
        })
    )
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: 'F:\\Research\\OpenScience' })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    await clickButton(/browse/i)

    await act(async () => {
      resolveStorageInfo?.(
        storageInfo({
          dataRoot: 'D:\\OpenScience',
          defaultDataRoot: 'C:\\Users\\researcher\\OpenScience',
          isDefault: false
        })
      )
    })

    expect(currentSection('Choose data location')).not.toBeNull()

    await act(async () => {
      resolvePickedDirectory?.('F:\\Research')
    })
    expect(container.textContent).toContain('F:\\Research\\OpenScience')
    expect(container.textContent).not.toContain('Set up the agent runtime')
  })

  it('does not probe alternate drives outside Windows', async () => {
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(window.api.localFs.listDrives).not.toHaveBeenCalled()
    expect(container.textContent).toContain(DEFAULT_DATA_ROOT)
  })

  it('Back walks the steps in reverse without losing the provider draft', async () => {
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    // Location → Environment, then walk forward to Notebook.
    await clickButton(/^back$/i)
    expect(currentSection('Prepare environment')).not.toBeNull()

    await clickButton(/^continue$/i)
    await clickButton(/^continue$/i)
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
    await clickButton(/^continue$/i)
    expect(currentSection('Configure model')).not.toBeNull()
    await fillRequiredProviderFields(container)
    await clickButton(/test & continue/i)
    expect(currentSection('Notebook runtime (optional)')).not.toBeNull()

    // Notebook → Provider → Agent → Location → Environment.
    await clickButton(/^back$/i)
    expect(currentSection('Configure model')).not.toBeNull()
    await clickButton(/^back$/i)
    expect(currentSection('Set up the agent runtime')).not.toBeNull()
    await clickButton(/^back$/i)
    expect(currentSection('Choose data location')).not.toBeNull()
    await clickButton(/^back$/i)
    expect(currentSection('Prepare environment')).not.toBeNull()

    await clickButton(/^continue$/i)
    await clickButton(/^continue$/i)
    await clickButton(/^continue$/i)
    expect(container.querySelector<HTMLInputElement>('#provider-base-url')?.value).toBe(
      'https://gateway.example'
    )
  })

  it('keeps a chosen data location after going Back and returning to Location', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    await clickButton(/browse/i)
    expect(container.textContent).toContain('/mnt/data/OpenScience')

    await clickButton(/^back$/i)
    expect(currentSection('Prepare environment')).not.toBeNull()
    await clickButton(/^continue$/i)

    expect(currentSection('Choose data location')).not.toBeNull()
    expect(container.textContent).toContain('/mnt/data/OpenScience')
    expect(container.textContent).toContain('Open Science will restart to set this up')
  })

  it('initializes (detects) the env store on mount without auto-provisioning python', async () => {
    readyClaudeState()

    await renderWizard()

    // Detect-only: hydrate the env store so the Notebook step reflects the real managed-python
    // state, but never eagerly provision — a fresh env is built lazily on first notebook use.
    expect(envInit).toHaveBeenCalledOnce()
    expect(envProvision).not.toHaveBeenCalled()
  })

  it('shows a full-screen "Setting up" state while the relaunch call is in flight', async () => {
    let releaseRelaunch: (() => void) | undefined
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    window.api.storage.setDataRootAndRelaunch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRelaunch = () => resolve({ ok: true })
        })
    )
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)
    await clickButton(/^restart$/i)

    expect(document.body.textContent).toContain('Setting up your workspace')

    // Clean up the still-pending promise so it doesn't leak into later tests.
    await act(async () => {
      releaseRelaunch?.()
    })
  })

  it('returns to Location with the failure reason when relaunching a custom path fails', async () => {
    window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
    window.api.storage.inspectDataRoot = vi
      .fn()
      .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
    window.api.storage.setDataRootAndRelaunch = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Disk is full.' })
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()
    await clickButton(/browse/i)
    await clickButton(/continue/i)
    await clickButton(/^restart$/i)

    expect(currentSection('Choose data location')).not.toBeNull()
    expect(container.textContent).toContain('Disk is full.')
    expect(container.textContent).toContain('/mnt/data/OpenScience')
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
  })

  it('keeps onboarding recoverable when loading storage information rejects', async () => {
    window.api.storage.getInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage is unavailable.'))
      .mockResolvedValueOnce(storageInfo())
    readyClaudeState()

    await renderWizard()
    await goToLocationStep()

    expect(currentSection('Choose data location')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain('Storage is unavailable.')

    await clickButton(/^retry$/i)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain(DEFAULT_DATA_ROOT)
    expect(window.api.storage.getInfo).toHaveBeenCalledTimes(2)
  })

  it('uses the startup storage loader supplied by App', async () => {
    const loadStorageInfo = vi.fn().mockResolvedValue(storageInfo())
    readyClaudeState()

    await act(async () => {
      root.render(<OnboardingWizard loadStorageInfo={loadStorageInfo} />)
    })

    expect(loadStorageInfo).toHaveBeenCalledOnce()
    expect(window.api.storage.getInfo).not.toHaveBeenCalled()
  })
})

it('regression: step changes move focus to the new heading', async () => {
  readyClaudeState()
  await renderWizard()
  act(() => {
    findButton(/^continue$/i)!.focus()
  })
  await clickButton(/^continue$/i)
  expect(currentSection('Choose data location')).not.toBeNull()
  expect(document.activeElement?.textContent).toBe('Where should Open Science store your data?')
  expect(document.activeElement?.tagName).toBe('H2')
  act(() => {
    findButton(/^back$/i)!.focus()
  })
  await clickButton(/^back$/i)
  expect(document.activeElement?.textContent).toBe('Prepare environment')
  expect(document.activeElement?.tagName).toBe('H2')
})

it('regression: every setup step exposes and focuses its own level-two heading', async () => {
  readyClaudeState()
  await renderWizard()
  const expectHeading = (title: string): void => {
    expect(document.activeElement?.tagName).toBe('H2')
    expect(document.activeElement?.textContent).toBe(title)
  }
  await clickButton(/^continue$/i)
  expectHeading('Where should Open Science store your data?')
  await clickButton(/^continue$/i)
  expectHeading('Set up the agent runtime')
  await clickButton(/^continue$/i)
  expectHeading('Connect a model')
  await fillRequiredProviderFields(container)
  await clickButton(/test & continue/i)
  expectHeading('Notebook runtime (optional)')
  for (const title of [
    'Connect a model',
    'Set up the agent runtime',
    'Where should Open Science store your data?',
    'Prepare environment'
  ]) {
    await clickButton(/^back$/i)
    expectHeading(title)
  }
})
