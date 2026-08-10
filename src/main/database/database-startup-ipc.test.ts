import { describe, expect, it, vi } from 'vitest'

import { DATABASE_STARTUP_CHANNELS, type DatabaseStartupState } from '../../shared/database-startup'
import { installDatabaseStartupQuitGuard, registerDatabaseStartupIpc } from './database-startup-ipc'
import type { DatabaseStartupOwner } from './database-startup-owner'

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

  it('holds an ordinary quit until an active schema attempt settles', async () => {
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
    installDatabaseStartupQuitGuard({
      app: app as never,
      owner: { isMigrating: () => true, whenAttemptSettled: () => settled }
    })
    const preventDefault = vi.fn()

    beforeQuit?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()

    settle?.()
    await settled
    await Promise.resolve()
    expect(quit).toHaveBeenCalledOnce()
  })
})
