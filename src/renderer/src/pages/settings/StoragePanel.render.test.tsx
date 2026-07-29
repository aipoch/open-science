// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StoragePanel } from './StoragePanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { EnvironmentCheckResult } from '../../../../shared/settings'

let container: HTMLDivElement
let root: Root

const environment = (checks: EnvironmentCheckResult['checks']): EnvironmentCheckResult => ({
  checkedAt: 1,
  platform: 'darwin',
  architecture: 'arm64',
  checks,
  ready: checks.every((check) => check.status !== 'failed'),
  canAutoInstall: false,
  agentFrameworkId: 'claude-code',
  runtime: { found: false }
})

// Richer usage sample matching the brief: two zero-byte categories, and a runtime category with
// expandable children (mirrors the mock's "Conda environments" breakdown).
const richInfo = {
  dataRoot: '/home/u/.open-science',
  isDefault: true,
  usage: {
    categories: [
      { key: 'artifacts', bytes: 22_700_000 },
      {
        key: 'runtime',
        bytes: 3_700_000_000,
        children: [
          { name: 'python', bytes: 58_400_000 },
          { name: 'r', bytes: 25_500_000 }
        ]
      },
      { key: 'uploads', bytes: 0 },
      { key: 'notebooks', bytes: 0 }
    ],
    totalBytes: 3_722_700_000
  },
  availableBytes: 530_600_000_000
}

const clickButton = (matcher: (button: HTMLButtonElement) => boolean): void => {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(matcher)
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// The move editor is collapsed behind the header "Change location" button + a warning-confirm step.
// Opening it: click the header button, then "Continue" in the warning dialog (rendered in a portal).
const openEditor = async (): Promise<void> => {
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Change location')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
  await act(async () => {
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Continue')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  useSettingsStore.setState(createInitialSettingsState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  ;(window as unknown as { api: unknown }).api = {
    storage: {
      getInfo: vi.fn().mockResolvedValue({
        dataRoot: '/home/u/.open-science',
        isDefault: true,
        usage: { categories: [], totalBytes: 35_600_000 },
        availableBytes: 500_000_000_000
      }),
      revealAppStorage: vi.fn().mockResolvedValue({ revealed: true }),
      pickDirectory: vi.fn().mockResolvedValue(null),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockResolvedValue({ ok: true }),
      detectActive: vi.fn().mockResolvedValue([]),
      migrate: vi.fn().mockResolvedValue({ ok: true }),
      cancelMigrate: vi.fn().mockResolvedValue(undefined),
      onProgress: vi.fn(() => () => {})
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('StoragePanel', () => {
  it('uses shared settings dialog chrome for data-location confirmations', async () => {
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/existing')
    ;(
      window as unknown as { api: { storage: { inspectDataRoot: ReturnType<typeof vi.fn> } } }
    ).api.storage.inspectDataRoot.mockResolvedValue({
      kind: 'adopt',
      dataRoot: '/mnt/existing/OpenScience'
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Change location')
      await Promise.resolve()
    })

    const warningOverlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find(
      (element) => element.className.includes('bg-black/50')
    )
    const warningDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')

    expect(warningOverlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(warningOverlay?.className).not.toContain('backdrop-blur')
    expect(warningDialog?.className).toContain('rounded-xl')
    expect(warningDialog?.className).toContain('border-border')
    expect(warningDialog?.className).toContain('bg-card')
    expect(warningDialog?.className).toContain('shadow-dialog')
    expect(warningDialog?.className).toContain('data-[state=open]:zoom-in-95')

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Continue')
        ?.click()
      await Promise.resolve()
    })
    await act(async () => {
      clickButton((button) => button.textContent?.includes('Browse') ?? false)
      await Promise.resolve()
    })
    clickButton((button) => button.textContent?.trim() === 'Use this folder')

    const adoptDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(adoptDialog?.className).toContain('rounded-xl')
    expect(adoptDialog?.className).toContain('border-border')
    expect(adoptDialog?.className).toContain('bg-card')
    expect(adoptDialog?.className).toContain('data-[state=open]:zoom-in-95')
  })

  it('shows the exact application-storage failure and reveals the trusted config root', async () => {
    const detail = '/home/u/.open-science — EACCES: permission denied'
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.',
          detail
        }
      ])
    })

    await act(async () => root.render(<StoragePanel />))

    expect(container.textContent).toContain('Application storage')
    expect(container.textContent).toContain(detail)
    const reveal = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Reveal')
    )
    await act(async () => reveal?.click())

    expect(window.api.storage.revealAppStorage).toHaveBeenCalledWith()
  })

  it('uses warning styling only while application storage remains unavailable', async () => {
    const repairedEnvironment = environment([
      {
        id: 'storage',
        label: 'App storage permission',
        status: 'passed',
        summary: 'Open Science can write to its private data folder.',
        detail: '/home/u/.open-science'
      }
    ])
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({ environmentCheck: repairedEnvironment })
      return repairedEnvironment
    })
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.',
          detail: '/home/u/.open-science — EACCES: permission denied'
        }
      ]),
      checkEnvironment
    } as never)

    await act(async () => root.render(<StoragePanel />))

    const repairNotice = container.querySelector<HTMLElement>(
      '[aria-label="Application storage"] .space-y-3'
    )
    expect(repairNotice?.className).toContain('border-amber-500/30')
    expect(repairNotice?.className).toContain('bg-amber-500/5')
    expect(repairNotice?.querySelector('.lucide-triangle-alert')).not.toBeNull()

    const recheck = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Check again'
    )
    await act(async () => recheck?.click())

    const repairedNotice = container.querySelector<HTMLElement>(
      '[aria-label="Application storage"] .space-y-3'
    )
    expect(repairedNotice?.className).not.toContain('border-amber-500/30')
    expect(repairedNotice?.className).not.toContain('bg-amber-500/5')
    expect(repairedNotice?.querySelector('.lucide-triangle-alert')).toBeNull()
    expect(repairedNotice?.querySelector('.text-emerald-600')).not.toBeNull()
  })

  it('waits for an explicit Continue action after storage passes but Agent still fails', async () => {
    const repairedEnvironment = environment([
      {
        id: 'storage',
        label: 'App storage permission',
        status: 'passed',
        summary: 'Open Science can write to its private data folder.',
        detail: '/home/u/.open-science'
      },
      {
        id: 'agent',
        label: 'Claude runtime',
        status: 'failed',
        summary: 'Claude is missing.'
      }
    ])
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({ environmentCheck: repairedEnvironment })
      return repairedEnvironment
    })
    const onContinueToAgent = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.',
          detail: '/home/u/.open-science — EACCES: permission denied'
        }
      ]),
      checkEnvironment
    } as never)

    await act(async () => root.render(<StoragePanel onContinueToAgent={onContinueToAgent} />))
    const recheck = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Check again'
    )
    await act(async () => recheck?.click())

    expect(onContinueToAgent).not.toHaveBeenCalled()
    const continueButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Continue to repair Agent'
    )
    expect(continueButton).toBeDefined()

    await act(async () => continueButton?.click())
    expect(onContinueToAgent).toHaveBeenCalledOnce()
  })

  it('keeps a full-check failure visible after Check again', async () => {
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({ environmentCheckError: 'Environment probe failed.' })
      return undefined
    })
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.',
          detail: '/home/u/.open-science — EACCES: permission denied'
        }
      ]),
      checkEnvironment
    })

    await act(async () => root.render(<StoragePanel />))
    const recheck = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Check again'
    )
    await act(async () => recheck?.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Environment probe failed.'
    )
  })

  it('follows later authoritative environment updates after a storage recheck', async () => {
    const repairedWithAgentFailure = environment([
      {
        id: 'storage',
        label: 'App storage permission',
        status: 'passed',
        summary: 'Open Science can write to its private data folder.'
      },
      {
        id: 'agent',
        label: 'Claude runtime',
        status: 'failed',
        summary: 'Claude is missing.'
      }
    ])
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({ environmentCheck: repairedWithAgentFailure })
      return repairedWithAgentFailure
    })
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.'
        }
      ]),
      checkEnvironment
    })

    await act(async () => root.render(<StoragePanel />))
    const recheck = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Check again'
    )
    await act(async () => recheck?.click())
    expect(container.textContent).toContain('Continue to repair Agent')

    await act(async () => {
      useSettingsStore.setState({
        environmentCheck: environment([
          {
            id: 'storage',
            label: 'App storage permission',
            status: 'passed',
            summary: 'Open Science can write to its private data folder.'
          }
        ])
      })
    })

    expect(container.textContent).not.toContain('Continue to repair Agent')
  })

  it('shows a rejected reveal call inline', async () => {
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.'
        }
      ])
    })
    window.api.storage.revealAppStorage = vi
      .fn()
      .mockRejectedValue(new Error('The folder could not be opened.'))

    await act(async () => root.render(<StoragePanel />))
    const reveal = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Reveal')
    )
    await act(async () => reveal?.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'The folder could not be opened.'
    )
  })

  it('disables Check again and shows progress while the full check is running', async () => {
    let finishCheck: (() => void) | undefined
    const checkEnvironment = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finishCheck = () => resolve(undefined)
        })
    )
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.'
        }
      ]),
      checkEnvironment
    })

    await act(async () => root.render(<StoragePanel />))
    const recheck = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Check again'
    )
    act(() => recheck?.click())

    const checking = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Checking…'
    )
    expect(checking?.disabled).toBe(true)

    await act(async () => finishCheck?.())
  })

  it('shows a loading state before the data location resolves', () => {
    act(() => {
      root.render(<StoragePanel />)
    })

    expect(container.textContent).toContain('Loading')
  })

  it('shows the hand-editing warning only after Change location is clicked', async () => {
    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The warning is gated behind the confirm step — not shown on the collapsed panel.
    expect(container.textContent).not.toContain('Open Science manages this folder')

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Change location')
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Open Science manages this folder')
    expect(document.body.textContent).toContain(
      "Don't move, rename, or delete files inside it — doing so can break your projects and history."
    )
  })

  it('loads and displays the current data location', async () => {
    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('/home/u/.open-science')
    expect(container.textContent).toMatch(/35\.6 MB/)
    expect(container.textContent).toContain('default location')
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Change location')
      )
    ).toBe(true)
  })

  it('renders the disk-usage breakdown with expandable runtime children', async () => {
    ;(
      window as unknown as { api: { storage: { getInfo: ReturnType<typeof vi.fn> } } }
    ).api.storage.getInfo.mockResolvedValue(richInfo)

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Artifacts')
    expect(container.textContent).toMatch(/22\.7 MB/)
    expect(container.textContent).toContain('Runtime')
    expect(container.textContent).toMatch(/3\.7 GB/)
    expect(container.textContent).toContain('Total')
    expect(container.textContent).toContain('Available on disk')
    expect(container.textContent).toMatch(/530\.6 GB/)

    // Children are collapsed until the runtime row is expanded.
    expect(container.textContent).not.toContain('python')

    clickButton((button) => button.textContent?.includes('Runtime') ?? false)

    expect(container.textContent).toContain('python')
    expect(container.textContent).toMatch(/58\.4 MB/)
    expect(container.textContent).toContain('r')
    expect(container.textContent).toMatch(/25\.5 MB/)
  })

  it('renders an empty disk-usage state without dividing by zero when totalBytes is 0', async () => {
    ;(
      window as unknown as { api: { storage: { getInfo: ReturnType<typeof vi.fn> } } }
    ).api.storage.getInfo.mockResolvedValue({
      dataRoot: '/home/u/.open-science',
      isDefault: true,
      usage: { categories: [], totalBytes: 0 },
      availableBytes: 500_000_000_000
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No data yet')
    expect(container.textContent).not.toContain('NaN')
    expect(container.textContent).not.toContain('Infinity')
  })

  it('collects the target path via Browse and opens the migration flow on Change', async () => {
    ;(
      window as unknown as {
        api: {
          storage: { getInfo: ReturnType<typeof vi.fn>; pickDirectory: ReturnType<typeof vi.fn> }
        }
      }
    ).api.storage.getInfo.mockResolvedValue(richInfo)
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/data')

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    await openEditor()

    // Editor open, nothing picked yet: the move action is disabled until a valid target is chosen.
    const changeButtonBefore = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Change location')
    expect(changeButtonBefore?.disabled).toBe(true)

    await act(async () => {
      clickButton((button) => button.textContent?.includes('Browse') ?? false)
      await Promise.resolve()
    })

    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input.value).toBe('/mnt/data')
    // The final `<parent>/OpenScience` path is shown so the user sees the appended folder before
    // acting, not just the raw parent they picked.
    expect(container.textContent).toContain('Data will be stored in')
    expect(container.textContent).toContain('/mnt/data/OpenScience')
    // Migration excludes runtime (3.7GB - artifacts 22.7MB), so the moved-size note shows only the
    // migrated categories' total, not the disk-usage total that includes runtime.
    expect(container.textContent).toContain('Your existing data (~22.7 MB) will be moved')
    expect(container.textContent).not.toContain('Your existing data (~3.7 GB)')
    expect(container.textContent).toContain(
      'Python/R environments are rebuilt at the new location on first use (not moved).'
    )

    const changeButtonAfter = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Change location')
    expect(changeButtonAfter?.disabled).toBe(false)

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Change location')
      await Promise.resolve()
    })

    // Change opens the migration flow, which detects running sessions before moving anything.
    expect(
      (window as unknown as { api: { storage: { detectActive: ReturnType<typeof vi.fn> } } }).api
        .storage.detectActive
    ).toHaveBeenCalled()
  })

  it('collapses the editor and clears the field on Cancel', async () => {
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/data')

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    await openEditor()
    await act(async () => {
      clickButton((button) => button.textContent?.includes('Browse') ?? false)
      await Promise.resolve()
    })

    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(
      '/mnt/data'
    )

    clickButton((button) => button.textContent?.trim() === 'Cancel')

    // Cancel collapses the editor entirely (input gone) and restores the header button.
    expect(container.querySelector('input[type="text"]')).toBeNull()
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Change location'
      )
    ).toBe(true)

    // Reopening starts from an empty field.
    await openEditor()
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('')
  })

  it('a path classified as move shows the migrate action, not the adopt one', async () => {
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/empty')
    ;(
      window as unknown as { api: { storage: { inspectDataRoot: ReturnType<typeof vi.fn> } } }
    ).api.storage.inspectDataRoot.mockResolvedValue({
      kind: 'move',
      dataRoot: '/mnt/empty/OpenScience'
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await openEditor()
    await act(async () => {
      clickButton((button) => button.textContent?.includes('Browse') ?? false)
      await Promise.resolve()
    })

    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Change location'
      )
    ).toBe(true)
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Use this folder'
      )
    ).toBe(false)
  })

  it('a path classified as adopt shows "Use this folder" and switches without moving', async () => {
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/existing')
    ;(
      window as unknown as { api: { storage: { inspectDataRoot: ReturnType<typeof vi.fn> } } }
    ).api.storage.inspectDataRoot.mockResolvedValue({
      kind: 'adopt',
      dataRoot: '/mnt/existing/OpenScience'
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await openEditor()
    await act(async () => {
      clickButton((button) => button.textContent?.includes('Browse') ?? false)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('already contains Open Science data')
    expect(container.textContent).toContain('Data will be stored in')
    expect(container.textContent).toContain('/mnt/existing/OpenScience')
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Change location'
      )
    ).toBe(false)

    clickButton((button) => button.textContent?.trim() === 'Use this folder')
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    // The confirm dialog shows the derived `<parent>/OpenScience` target, not the raw parent.
    expect(dialog?.textContent).toContain('/mnt/existing/OpenScience')

    // Search only within the dialog: the "Use this folder" trigger button (still in `container`,
    // which lives inside document.body) has identical text to the dialog's confirm action.
    const confirmButton = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) =>
      /^use this folder$/i.test(button.textContent ?? '')
    )
    await act(async () => {
      confirmButton?.click()
    })

    expect(
      (
        window as unknown as {
          api: { storage: { setDataRootAndRelaunch: ReturnType<typeof vi.fn> } }
        }
      ).api.storage.setDataRootAndRelaunch
    ).toHaveBeenCalledWith('/mnt/existing', false)
    // Adopt never touches the migration engine.
    expect(
      (window as unknown as { api: { storage: { migrate: ReturnType<typeof vi.fn> } } }).api.storage
        .migrate
    ).not.toHaveBeenCalled()
  })

  it('a path classified as invalid shows the inline error and disables both actions', async () => {
    ;(
      window as unknown as { api: { storage: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).api.storage.pickDirectory.mockResolvedValue('/mnt/bad')
    ;(
      window as unknown as { api: { storage: { inspectDataRoot: ReturnType<typeof vi.fn> } } }
    ).api.storage.inspectDataRoot.mockResolvedValue({
      kind: 'invalid',
      dataRoot: '/mnt/bad/OpenScience',
      error: 'The selected folder is not writable.'
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await openEditor()
    await act(async () => {
      clickButton((button) => button.textContent?.includes('Browse') ?? false)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('The selected folder is not writable.')
    const changeButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Change location'
    )
    expect(changeButton?.disabled).toBe(true)
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Use this folder'
      )
    ).toBe(false)
  })

  it('offers return-to-default inside the editor only when the current root is custom', async () => {
    ;(
      window as unknown as { api: { storage: { getInfo: ReturnType<typeof vi.fn> } } }
    ).api.storage.getInfo.mockResolvedValue({
      dataRoot: '/mnt/data/OpenScience',
      isDefault: false,
      defaultDataRoot: '/home/u/OpenScience',
      defaultParent: '/home/u',
      usage: { categories: [], totalBytes: 12_000_000 },
      availableBytes: 500_000_000_000
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Collapsed panel never shows it — it belongs to the relocation editor, behind Change location.
    expect(container.textContent).not.toContain('move it back to the default location')

    await openEditor()
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('move it back to the default location')
      )
    ).toBe(true)
    // The destination (default data root) is shown so the user sees where "back to default" goes.
    expect(container.textContent).toContain('/home/u/OpenScience')
  })

  it('does not offer return-to-default when the current root is already the default', async () => {
    // beforeEach's getInfo mock is isDefault:true.
    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    await openEditor()
    expect(container.textContent).not.toContain('move it back to the default location')
  })

  it('return-to-default inspects the default parent and opens the move-back flow', async () => {
    ;(
      window as unknown as { api: { storage: { getInfo: ReturnType<typeof vi.fn> } } }
    ).api.storage.getInfo.mockResolvedValue({
      dataRoot: '/mnt/data/OpenScience',
      isDefault: false,
      defaultDataRoot: '/home/u/OpenScience',
      defaultParent: '/home/u',
      usage: { categories: [], totalBytes: 12_000_000 },
      availableBytes: 500_000_000_000
    })
    // The default folder is empty (move), so the flow relocates the data back into it.
    ;(
      window as unknown as { api: { storage: { inspectDataRoot: ReturnType<typeof vi.fn> } } }
    ).api.storage.inspectDataRoot.mockResolvedValue({
      kind: 'move',
      dataRoot: '/home/u/OpenScience'
    })

    await act(async () => {
      root.render(<StoragePanel />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    await openEditor()
    await act(async () => {
      clickButton(
        (button) => button.textContent?.includes('move it back to the default location') ?? false
      )
      await Promise.resolve()
    })

    // It classified the default parent, not some browsed path.
    expect(
      (window as unknown as { api: { storage: { inspectDataRoot: ReturnType<typeof vi.fn> } } }).api
        .storage.inspectDataRoot
    ).toHaveBeenCalledWith('/home/u')
    // A 'move' opens the migration modal, which detects running sessions before moving anything.
    expect(
      (window as unknown as { api: { storage: { detectActive: ReturnType<typeof vi.fn> } } }).api
        .storage.detectActive
    ).toHaveBeenCalled()
  })
})
