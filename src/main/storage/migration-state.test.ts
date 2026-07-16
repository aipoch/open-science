import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBoxSync: vi.fn() } }))

const { beginMigration, endMigration, isMigrationInProgress, installMigrationQuitGuard } =
  await import('./migration-state')

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
  vi.clearAllMocks()
})

describe('migration-state', () => {
  it('tracks in-progress state via begin/end', () => {
    expect(isMigrationInProgress()).toBe(false)
    beginMigration()
    expect(isMigrationInProgress()).toBe(true)
    endMigration()
    expect(isMigrationInProgress()).toBe(false)
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

  it('quit guard clears the flag and re-issues quit when the user confirms', () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(true)
    installMigrationQuitGuard(app, confirmQuit)
    beginMigration()

    const { prevented } = app.fireBeforeQuit()

    // Prevented on this pass, but the flag is cleared and quit re-issued so the next pass falls through.
    expect(prevented).toBe(true)
    expect(isMigrationInProgress()).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})
