import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearApplicationShutdownTrigger,
  markApplicationShutdownTrigger
} from '../application-shutdown-trigger'

vi.mock('electron', () => ({ dialog: { showMessageBoxSync: vi.fn() } }))

const {
  acquireDataRootWriter,
  acceptMissingDataRoot,
  beginMigration,
  clearMigrationPending,
  endMigration,
  endMigrationCopy,
  initializeDataRootWriteAvailability,
  installMigrationQuitGuard,
  isMigrationInProgress,
  isMigrationPending,
  reconcileDataRootWriteAvailability,
  runDataRootStartupRecovery,
  waitForDataRootWriters,
  withDataRootWrite
} = await import('./migration-state')

// A minimal app double: records the before-quit listener and whether quit() was called.
type GuardApp = Parameters<typeof installMigrationQuitGuard>[0]
const makeApp = (): GuardApp & { fireBeforeQuit: () => { prevented: boolean } } => {
  let listener: ((event: { preventDefault: () => void }) => void) | undefined
  const quit = vi.fn()
  return {
    on: ((event: string, fn: (event: { preventDefault: () => void }) => void) => {
      if (event === 'before-quit') listener = fn
    }) as GuardApp['on'],
    quit,
    fireBeforeQuit: () => {
      let prevented = false
      listener?.({ preventDefault: () => (prevented = true) })
      return { prevented }
    }
  }
}

afterEach(() => {
  endMigration()
  initializeDataRootWriteAvailability(false)
  clearApplicationShutdownTrigger()
  vi.clearAllMocks()
})

describe('migration-state', () => {
  it('defers startup recovery and ordinary writes while the configured data root is missing', async () => {
    initializeDataRootWriteAvailability(true)
    const events: string[] = []

    await runDataRootStartupRecovery(async () => {
      events.push('recovery')
    })
    const write = withDataRootWrite(async () => {
      events.push('write')
    })
    await Promise.resolve()

    expect(events).toEqual([])

    await reconcileDataRootWriteAvailability(false)
    await write

    expect(events).toEqual(['recovery', 'write'])
  })

  it('keeps writers blocked when reconnect recovery fails and retries the failed recovery', async () => {
    initializeDataRootWriteAvailability(true)
    const recovery = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('recovery failed'))
      .mockResolvedValue(undefined)
    await runDataRootStartupRecovery(recovery)
    let writeStarted = false
    const write = withDataRootWrite(async () => {
      writeStarted = true
    })

    await expect(reconcileDataRootWriteAvailability(false)).rejects.toThrow('recovery failed')
    expect(writeStarted).toBe(false)

    await reconcileDataRootWriteAvailability(false)
    await write

    expect(recovery).toHaveBeenCalledTimes(2)
    expect(writeStarted).toBe(true)
  })

  it('reports deferred recovery failure without swallowing the gate rejection', async () => {
    initializeDataRootWriteAvailability(true)
    const recoveryError = new Error('deferred recovery failed')
    const reportFailure = vi.fn()

    await runDataRootStartupRecovery(() => Promise.reject(recoveryError), { reportFailure })

    await expect(reconcileDataRootWriteAvailability(false)).rejects.toBe(recoveryError)
    expect(reportFailure).toHaveBeenCalledWith(recoveryError)
  })

  it('reports present-root recovery failure while allowing startup to continue', async () => {
    initializeDataRootWriteAvailability(false)
    const recoveryError = new Error('startup recovery failed')
    const reportFailure = vi.fn()

    await expect(
      runDataRootStartupRecovery(() => Promise.reject(recoveryError), { reportFailure })
    ).resolves.toBeUndefined()
    expect(reportFailure).toHaveBeenCalledWith(recoveryError)
  })

  it('accepts an empty root without replaying recovery from the unavailable tree', async () => {
    initializeDataRootWriteAvailability(true)
    const recovery = vi.fn<() => Promise<void>>()
    await runDataRootStartupRecovery(recovery)

    await acceptMissingDataRoot()
    await expect(withDataRootWrite(async () => 'written')).resolves.toBe('written')

    expect(recovery).not.toHaveBeenCalled()
    await expect(reconcileDataRootWriteAvailability(true)).resolves.toBe(false)
  })

  it('rejects synchronous writer leases until the missing root is resolved', async () => {
    initializeDataRootWriteAvailability(true)

    expect(() => acquireDataRootWriter()).toThrow(/configured data folder is unavailable/i)

    await acceptMissingDataRoot()
    const release = acquireDataRootWriter()
    release()
  })

  it('tracks in-progress state via begin/end', () => {
    expect(isMigrationInProgress()).toBe(false)
    beginMigration()
    expect(isMigrationInProgress()).toBe(true)
    endMigration()
    expect(isMigrationInProgress()).toBe(false)
  })

  it('beginMigration sets both the copying (quit) and pending (write-gate) flags', () => {
    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)

    beginMigration()

    expect(isMigrationInProgress()).toBe(true)
    expect(isMigrationPending()).toBe(true)
  })

  it('endMigrationCopy relaxes the quit guard but keeps the write-gate pending', () => {
    beginMigration()
    endMigrationCopy()

    // The copy finished, so quit is no longer blocked — but a successful-but-uncommitted copy still
    // blocks writes until commit or discard resolves it.
    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(true)
  })

  it('clearMigrationPending lifts both flags (copy failed/cancelled/discarded, or switch failed)', () => {
    beginMigration()
    endMigrationCopy()
    clearMigrationPending()

    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)
  })

  it('endMigration clears both flags (quit-anyway path)', () => {
    beginMigration()
    endMigration()

    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)
  })

  it('drains writes that started before migration and rejects new writes after the gate rises', async () => {
    let releaseWrite: (() => void) | undefined
    let writeStarted = false
    const activeWrite = withDataRootWrite(
      () =>
        new Promise<void>((resolve) => {
          writeStarted = true
          releaseWrite = resolve
        })
    )
    expect(writeStarted).toBe(true)

    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(withDataRootWrite(async () => {})).rejects.toThrow(/moving your data/i)

    releaseWrite?.()
    await activeWrite
    await drainPromise
    expect(drained).toBe(true)
  })

  it('allows a drained writer to enter nested protected repositories after the gate rises', async () => {
    let continueOuter: (() => void) | undefined
    const outerStarted = new Promise<void>((resolve) => {
      continueOuter = resolve
    })
    let entered = false
    const operation = withDataRootWrite(async () => {
      await outerStarted
      await withDataRootWrite(async () => {
        entered = true
      })
    })
    beginMigration()

    continueOuter?.()
    await operation

    expect(entered).toBe(true)
  })

  it('keeps a logical writer active across calls until its idempotent release', async () => {
    const release = acquireDataRootWriter()
    beginMigration()

    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    release()
    release()
    await drainPromise
    expect(drained).toBe(true)
  })

  it('quit guard does not interfere when no migration is running', () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(false)
    installMigrationQuitGuard(app, confirmQuit)

    const { prevented } = app.fireBeforeQuit()

    expect(prevented).toBe(false)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quit guard blocks the quit and stays when the user declines mid-migration', () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(false)
    installMigrationQuitGuard(app, confirmQuit)
    beginMigration()

    const { prevented } = app.fireBeforeQuit()

    expect(prevented).toBe(true)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()
    expect(isMigrationInProgress()).toBe(true)
  })

  it('cancels a migration without prompting when system shutdown owns the quit', async () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(false)
    installMigrationQuitGuard(app, confirmQuit)
    beginMigration()
    markApplicationShutdownTrigger('system')

    const { prevented } = app.fireBeforeQuit()

    expect(prevented).toBe(true)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()

    await Promise.resolve()

    expect(isMigrationInProgress()).toBe(false)
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  })

  it('quit guard clears the flag before asynchronously re-issuing a confirmed quit', async () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(true)
    installMigrationQuitGuard(app, confirmQuit)
    beginMigration()

    const { prevented } = app.fireBeforeQuit()

    // Prevented on this pass; even without a registered command, cancellation completes at the next
    // microtask before the flag is cleared and quit is re-issued.
    expect(prevented).toBe(true)
    expect(isMigrationInProgress()).toBe(true)
    expect(app.quit).not.toHaveBeenCalled()

    await Promise.resolve()

    expect(isMigrationInProgress()).toBe(false)
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  })
})
