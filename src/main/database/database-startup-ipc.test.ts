import { describe, expect, it, vi } from 'vitest'

import { DATABASE_STARTUP_CHANNELS, type DatabaseStartupState } from '../../shared/database-startup'
import { installDatabaseStartupQuitGuard, registerDatabaseStartupIpc } from './database-startup-ipc'
import { createDatabaseStartupOwner, type DatabaseStartupOwner } from './database-startup-owner'

describe('database startup Electron bridge', () => {
  it('serves the current state and broadcasts owner changes', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let listener: ((state: DatabaseStartupState) => void) | undefined
    const retry = vi.fn(async () => ({ phase: 'checking' }) as const)
    const quit = vi.fn()
    const send = vi.fn()
    const owner = {
      getState: () => ({ phase: 'checking' }) as const,
      retry,
      subscribe: (next: (state: DatabaseStartupState) => void) => {
        listener = next
        return () => {
          listener = undefined
        }
      }
    } as unknown as DatabaseStartupOwner

    const dispose = registerDatabaseStartupIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (...args: unknown[]) => unknown)
        },
        removeHandler: (channel) => handlers.delete(channel)
      },
      owner,
      quit,
      getWindows: () => [{ isDestroyed: () => false, webContents: { send } } as never]
    })

    expect(handlers.get(DATABASE_STARTUP_CHANNELS.getState)?.()).toEqual({
      phase: 'checking'
    })
    await expect(handlers.get(DATABASE_STARTUP_CHANNELS.retry)?.()).resolves.toEqual({
      phase: 'checking'
    })
    handlers.get(DATABASE_STARTUP_CHANNELS.quit)?.()
    expect(quit).toHaveBeenCalledOnce()

    const blocked: DatabaseStartupState = {
      phase: 'blocked',
      error: {
        code: 'database_history_invalid',
        message: 'The database migration history could not be verified.',
        retryable: false
      }
    }
    listener?.(blocked)
    expect(send).toHaveBeenCalledWith(DATABASE_STARTUP_CHANNELS.stateChanged, blocked)

    dispose()
    expect(handlers.size).toBe(0)
  })

  it('hands a verified startup quit to the installed application lifecycle', async () => {
    let beforeQuit: ((event: { preventDefault: () => void }) => void) | undefined
    let settle: (() => void) | undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const quit = vi.fn()
    const app = {
      on: (_event: string, listener: typeof beforeQuit) => {
        beforeQuit = listener
      },
      removeListener: vi.fn(),
      quit
    }
    const guard = installDatabaseStartupQuitGuard({
      app: app as never,
      owner: {
        getState: () => ({ phase: 'migrating', migrationId: '0001' }),
        isMigrating: () => true,
        whenAttemptSettled: () => settled
      }
    })
    const preventDefault = vi.fn()

    beforeQuit?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()

    settle?.()
    await settled
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()

    guard.release()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('allows a blocked startup to quit without waiting for an application lifecycle', async () => {
    let beforeQuit: ((event: { preventDefault: () => void }) => void) | undefined
    let state: DatabaseStartupState = { phase: 'migrating', migrationId: '0001' }
    let settle: (() => void) | undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const quit = vi.fn()
    const guard = installDatabaseStartupQuitGuard({
      app: {
        on: (_event: string, listener: typeof beforeQuit) => {
          beforeQuit = listener
        },
        removeListener: vi.fn(),
        quit
      } as never,
      owner: {
        getState: () => state,
        isMigrating: () => true,
        whenAttemptSettled: () => settled
      }
    })

    beforeQuit?.({ preventDefault: vi.fn() })
    state = {
      phase: 'blocked',
      error: {
        code: 'database_history_invalid',
        message: 'The database migration history could not be verified.',
        retryable: false
      }
    }
    settle?.()
    await settled
    await Promise.resolve()

    expect(quit).toHaveBeenCalledOnce()
    guard.dispose()
  })
})

describe('D03 window delivery failure isolation', () => {
  it('delivers to surviving windows when another webContents.send throws', async () => {
    const owner = createDatabaseStartupOwner({
      verifyDatabase: async () => {},
      reportBlocked: vi.fn()
    })
    const destroyedSend = vi.fn()
    const healthySend = vi.fn()
    const dispose = registerDatabaseStartupIpc({
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
      owner,
      quit: vi.fn(),
      getWindows: () =>
        [
          { isDestroyed: () => true, webContents: { send: destroyedSend } },
          {
            isDestroyed: () => false,
            webContents: {
              send: (_channel: string, state: DatabaseStartupState) => {
                if (state.phase === 'starting') throw new Error('Object has been destroyed')
              }
            }
          },
          { isDestroyed: () => false, webContents: { send: healthySend } }
        ] as never
    })
    try {
      expect.soft(await owner.start()).toEqual({ phase: 'starting' })
      expect
        .soft(healthySend)
        .toHaveBeenCalledWith(DATABASE_STARTUP_CHANNELS.stateChanged, { phase: 'starting' })
      expect(destroyedSend).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})
