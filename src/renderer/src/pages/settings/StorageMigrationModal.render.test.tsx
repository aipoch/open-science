// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MigrationOutcome, MigrationProgress } from '../../../../shared/storage'
import { StorageMigrationModal } from './StorageMigrationModal'

let container: HTMLDivElement
let root: Root

type MockStorageApi = {
  detectActive: ReturnType<typeof vi.fn>
  migrate: ReturnType<typeof vi.fn>
  cancelMigrate: ReturnType<typeof vi.fn>
  commitAndRelaunch: ReturnType<typeof vi.fn>
  discardMigratedCopy: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

const installApi = (overrides: Partial<MockStorageApi> = {}): MockStorageApi => {
  const api: MockStorageApi = {
    detectActive: vi.fn().mockResolvedValue([]),
    migrate: vi.fn().mockResolvedValue({ ok: true }),
    cancelMigrate: vi.fn().mockResolvedValue(undefined),
    commitAndRelaunch: vi.fn().mockResolvedValue({ ok: true }),
    discardMigratedCopy: vi.fn().mockResolvedValue({ ok: true }),
    onProgress: vi.fn(() => () => {}),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = { storage: api }
  return api
}

const clickButton = (matcher: (button: HTMLButtonElement) => boolean): void => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    matcher
  )
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('StorageMigrationModal', () => {
  it('continues a covered migration while suppressing its presentation', async () => {
    const api = installApi()

    await act(async () => {
      root.render(<StorageMigrationModal active={false} targetPath="/mnt/data" onClose={vi.fn()} />)
      await Promise.resolve()
    })

    expect(api.migrate).toHaveBeenCalledWith('/mnt/data')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      root.render(<StorageMigrationModal active targetPath="/mnt/data" onClose={vi.fn()} />)
    })

    expect(document.body.textContent).toMatch(/data copied/i)
  })

  it('advances past "Checking…" under StrictMode instead of stranding on detect (mountedRef reset)', async () => {
    // Regression: StrictMode's dev mount→unmount→mount left mountedRef false for the real mount, so
    // every async guard bailed and the modal stuck on the detecting copy. Rendering under StrictMode
    // must still reach the migrating stage and call migrate.
    const api = installApi({ detectActive: vi.fn().mockResolvedValue([]) })

    await act(async () => {
      root.render(
        <StrictMode>
          <StorageMigrationModal targetPath="/mnt/data" onClose={vi.fn()} />
        </StrictMode>
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toMatch(/Checking for running sessions/i)
    expect(api.migrate).toHaveBeenCalledWith('/mnt/data')
  })

  it('migrates immediately with no active sessions, reflects progress, and shows restarting on success', async () => {
    let progressListener: ((update: MigrationProgress) => void) | undefined
    let resolveMigrate: ((outcome: MigrationOutcome) => void) | undefined
    const api = installApi({
      onProgress: vi.fn((listener) => {
        progressListener = listener
        return () => {}
      }),
      migrate: vi.fn(
        () =>
          new Promise<MigrationOutcome>((resolve) => {
            resolveMigrate = resolve
          })
      )
    })

    await act(async () => {
      root.render(
        <StorageMigrationModal
          targetPath="/mnt/data"
          targetAvailableBytes={600}
          onClose={vi.fn()}
        />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.detectActive).toHaveBeenCalled()
    expect(api.migrate).toHaveBeenCalledWith('/mnt/data')

    act(() => {
      progressListener?.({
        phase: 'scan',
        copiedBytes: 0,
        totalBytes: 1000
      })
    })

    expect(document.body.textContent).toContain('Copy phase requires 1.0 KB')
    expect(document.body.textContent).toContain('Available on target disk: 600 B')
    const capacityWarning = Array.from(document.body.querySelectorAll('p')).find((element) =>
      element.textContent?.includes('may not have enough space for the copy')
    )
    expect(capacityWarning?.className).toContain('text-status-warning-foreground')

    act(() => {
      progressListener?.({
        phase: 'copy',
        copiedBytes: 500,
        totalBytes: 1000,
        currentPath: '/home/u/.open-science/artifacts/report.pdf'
      })
    })

    expect(document.body.textContent).toContain('/home/u/.open-science/artifacts/report.pdf')
    expect(document.body.textContent).toMatch(/50%/)
    const progressBar = document.body.querySelector<HTMLElement>('[style*="scaleX"]')
    expect(progressBar?.className).toContain('transition-transform')
    expect(progressBar?.className).toContain('motion-reduce:transition-none')
    expect(progressBar?.className).not.toContain('transition-all')

    // The migrating stage shows a running elapsed clock and a don't-quit warning (design follow-up).
    expect(document.body.textContent).toMatch(/Elapsed 0:00/)
    expect(document.body.textContent).toMatch(/turn off your computer until this finishes/i)

    act(() => {
      progressListener?.({
        phase: 'delete',
        copiedBytes: 0,
        totalBytes: 0
      })
    })

    expect(document.body.textContent).toMatch(/100%/)
    expect(document.body.textContent).toMatch(/cleaning up/i)

    await act(async () => {
      resolveMigrate?.({ ok: true })
      await Promise.resolve()
    })

    // Done stage: copy is complete but nothing is committed. "Restart now" commits + relaunches.
    expect(document.body.textContent).toMatch(/data copied/i)
    expect(document.body.querySelector('.bg-status-success-accent\\/10')).not.toBeNull()
    expect(document.body.querySelector('.text-emerald-600')).toBeNull()
    expect(api.commitAndRelaunch).not.toHaveBeenCalled()
    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Restart now')
      await Promise.resolve()
    })
    expect(api.commitAndRelaunch).toHaveBeenCalledWith('/mnt/data')
  })

  it('Keep current location discards the copy and closes without committing', async () => {
    const onClose = vi.fn()
    const api = installApi({
      migrate: vi.fn().mockResolvedValue({ ok: true })
    })

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toMatch(/data copied/i)
    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Keep current location')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.discardMigratedCopy).toHaveBeenCalledWith('/mnt/data')
    expect(api.commitAndRelaunch).not.toHaveBeenCalled()
    // Close happens only after the discard resolves (awaited, with a loading state).
    expect(onClose).toHaveBeenCalled()
  })

  it('resumes a verified copy without copying again and can finish the move', async () => {
    const api = installApi()

    await act(async () => {
      root.render(
        <StorageMigrationModal targetPath="/mnt/data" recoveryStatus="verified" onClose={vi.fn()} />
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Verified data copy found')
    expect(api.migrate).not.toHaveBeenCalled()

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Finish move')
      await Promise.resolve()
    })

    expect(api.commitAndRelaunch).toHaveBeenCalledWith('/mnt/data')
  })

  it('offers discard only for an incomplete recovered copy', async () => {
    const onClose = vi.fn()
    const api = installApi()

    await act(async () => {
      root.render(
        <StorageMigrationModal targetPath="/mnt/data" recoveryStatus="copying" onClose={onClose} />
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Incomplete data copy found')
    expect(document.body.textContent).not.toContain('Finish move')
    expect(api.detectActive).not.toHaveBeenCalled()
    expect(api.migrate).not.toHaveBeenCalled()

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Discard incomplete copy')
      await Promise.resolve()
    })

    expect(api.discardMigratedCopy).toHaveBeenCalledWith('/mnt/data')
    expect(api.commitAndRelaunch).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('confirms active-session interruption before finishing a recovered copy', async () => {
    const api = installApi({
      detectActive: vi
        .fn()
        .mockResolvedValue([{ projectId: 'proj-a', sessionId: 'sess-1', kind: 'agent' }])
    })

    await act(async () => {
      root.render(
        <StorageMigrationModal targetPath="/mnt/data" recoveryStatus="verified" onClose={vi.fn()} />
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Finishing this recovered move will interrupt')
    expect(document.body.textContent).not.toContain('Verified data copy found')

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Continue to recovery')
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Verified data copy found')
    expect(api.migrate).not.toHaveBeenCalled()
  })

  it('keeps the current location usable and warns when copied-data cleanup fails', async () => {
    const onClose = vi.fn()
    installApi({
      discardMigratedCopy: vi.fn().mockResolvedValue({
        ok: true,
        cleanupWarning: 'The unused data copy could not be removed.'
      })
    })

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
      await Promise.resolve()
    })
    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Keep current location')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Current location kept')
    expect(document.body.textContent).toContain('Normal work has resumed')
    expect(document.body.textContent).toContain('You can delete the copy later')

    clickButton((button) => button.textContent?.trim() === 'Close')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the modal open and retries when discard remains unresolved', async () => {
    const onClose = vi.fn()
    const discardMigratedCopy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'A migration is already being resolved.'
      })
      .mockResolvedValueOnce({ ok: true })
    installApi({ discardMigratedCopy })

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
      await Promise.resolve()
    })
    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Keep current location')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('A migration is already being resolved.')
    expect(document.body.textContent).toContain('Try again')

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Try again')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(discardMigratedCopy).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a confirm dialog listing active sessions; Cancel aborts without migrating', async () => {
    const api = installApi({
      detectActive: vi.fn().mockResolvedValue([
        { projectId: 'proj-a', sessionId: 'sess-1', kind: 'agent' },
        { projectId: 'proj-b', sessionId: 'sess-2', kind: 'notebook' }
      ])
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('proj-a')
    expect(document.body.textContent).toContain('sess-1')
    expect(document.body.textContent).toContain('proj-b')
    expect(document.body.textContent).toContain('sess-2')
    expect(document.body.textContent).toMatch(/interrupt/i)
    expect(document.body.textContent).toMatch(/restart/i)
    expect(api.migrate).not.toHaveBeenCalled()

    clickButton((button) => button.textContent?.trim() === 'Cancel')

    expect(api.migrate).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('proceeds to migrate when the user confirms "Interrupt and move"', async () => {
    const api = installApi({
      detectActive: vi
        .fn()
        .mockResolvedValue([{ projectId: 'proj-a', sessionId: 'sess-1', kind: 'agent' }])
    })

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.migrate).not.toHaveBeenCalled()

    await act(async () => {
      clickButton((button) => button.textContent?.trim() === 'Interrupt and move')
      await Promise.resolve()
    })

    expect(api.migrate).toHaveBeenCalledWith('/mnt/data')
  })

  it('blocks migration for delegated work and only lets the user return to stop it manually', async () => {
    const api = installApi({
      detectActive: vi
        .fn()
        .mockResolvedValue([{ projectId: 'proj-a', sessionId: 'delegated-1', kind: 'delegated' }])
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
      await Promise.resolve()
    })

    expect(document.body.textContent).toMatch(/subagents are still running/i)
    expect(document.body.textContent).toMatch(/stop its subagents/i)
    expect(document.body.textContent).not.toContain('Interrupt and move')
    expect(api.migrate).not.toHaveBeenCalled()
    expect(api.cancelMigrate).not.toHaveBeenCalled()

    clickButton((button) => button.textContent?.trim() === 'Return to tasks')

    expect(onClose).toHaveBeenCalledOnce()
    expect(api.migrate).not.toHaveBeenCalled()
    expect(api.cancelMigrate).not.toHaveBeenCalled()
  })

  it('cancels an in-flight migration and closes without showing an error', async () => {
    let resolveMigrate: ((outcome: MigrationOutcome) => void) | undefined
    const api = installApi({
      migrate: vi.fn(
        () =>
          new Promise<MigrationOutcome>((resolve) => {
            resolveMigrate = resolve
          })
      )
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    clickButton((button) => button.textContent?.trim() === 'Cancel')
    expect(api.cancelMigrate).toHaveBeenCalled()

    await act(async () => {
      resolveMigrate?.({ ok: false, error: 'Migration cancelled', cancelled: true })
      await Promise.resolve()
    })

    expect(onClose).toHaveBeenCalled()
    expect(document.body.textContent ?? '').not.toMatch(/failed/i)
  })

  it('shows a prominent error and keeps the modal open on switchoverFailed', async () => {
    const api = installApi({
      migrate: vi.fn().mockResolvedValue({
        ok: false,
        error: 'Data moved but the app could not restart automatically.',
        switchoverFailed: true
      })
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain(
      'Data moved but the app could not restart automatically.'
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(api.cancelMigrate).not.toHaveBeenCalled()
  })

  it('shows the error and allows closing when migration fails outright', async () => {
    installApi({
      migrate: vi.fn().mockResolvedValue({ ok: false, error: 'Disk full' })
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Disk full')

    clickButton((button) => button.textContent?.trim() === 'Close')
    expect(onClose).toHaveBeenCalled()
  })

  it('unsubscribes onProgress when unmounted mid-migration', async () => {
    const unsubscribe = vi.fn()
    installApi({
      onProgress: vi.fn(() => unsubscribe),
      migrate: vi.fn(() => new Promise<MigrationOutcome>(() => {}))
    })

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      root.unmount()
    })

    expect(unsubscribe).toHaveBeenCalled()
  })

  it('reaches a closable error state instead of sticking on "Checking…" when detectActive rejects', async () => {
    installApi({
      detectActive: vi.fn().mockRejectedValue(new Error('ipc down'))
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toMatch(/checking/i)
    expect(document.body.textContent).toMatch(/something went wrong/i)

    clickButton((button) => button.textContent?.trim() === 'Close')
    expect(onClose).toHaveBeenCalled()
  })

  it('reaches a closable error state when migrate rejects', async () => {
    installApi({
      migrate: vi.fn().mockRejectedValue(new Error('ipc down'))
    })
    const onClose = vi.fn()

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={onClose} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toMatch(/something went wrong/i)

    clickButton((button) => button.textContent?.trim() === 'Close')
    expect(onClose).toHaveBeenCalled()
  })

  it('swallows a rejected cancelMigrate instead of throwing an unhandled rejection', async () => {
    const api = installApi({
      migrate: vi.fn(() => new Promise<MigrationOutcome>(() => {})),
      cancelMigrate: vi.fn().mockRejectedValue(new Error('cancel failed'))
    })

    await act(async () => {
      root.render(<StorageMigrationModal targetPath="/mnt/data" onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(() => {
      clickButton((button) => button.textContent?.trim() === 'Cancel')
    }).not.toThrow()
    expect(api.cancelMigrate).toHaveBeenCalled()

    await act(async () => {
      await Promise.resolve()
    })
  })
})
