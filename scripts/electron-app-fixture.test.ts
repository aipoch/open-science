import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeElectronApplicationForCleanup,
  ElectronAppHarness,
  STAR_NUDGE_LAST_SHOWN_STORAGE_KEY,
  suppressWorkspaceStarNudge,
  waitForRendererReady
} from '../e2e/fixtures/electron-app'

describe('Electron E2E startup failure evidence', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reports the migration ID when database readiness times out', async () => {
    const page = {
      waitForLoadState: async () => undefined,
      evaluate: async () => ({ phase: 'migrating', migrationId: '0042_test_migration' })
    } as unknown as Page
    await expect(waitForRendererReady(page, 100)).rejects.toThrow('0042_test_migration')
  })

  it('preserves the main log before removing a failed first-launch profile', async () => {
    const startupError = new Error('database readiness timed out')
    let profileRoot = ''
    let capturedLog: string | undefined
    let captureError: unknown
    let windowCreated = false
    vi.spyOn(electron, 'launch').mockImplementation(async (options) => {
      profileRoot = dirname(options!.env!.OPEN_SCIENCE_STORAGE_ROOT!)
      const logs = join(profileRoot, 'logs')
      await mkdir(logs, { recursive: true })
      await writeFile(join(logs, 'main.log'), 'database migration started: 0042\n')
      return {
        evaluate: async (callback: (electron: unknown) => unknown) => {
          return callback({
            app: {
              getPath: () => {
                if (!windowCreated) throw new Error('Electron is not ready for diagnostics')
                return logs
              }
            },
            safeStorage: { setUsePlainTextEncryption: () => undefined }
          })
        },
        firstWindow: async () => {
          windowCreated = true
          return {
            emulateMedia: async () => undefined,
            on: () => undefined,
            consoleMessages: async () => [],
            pageErrors: async () => [],
            waitForLoadState: async () => {
              throw startupError
            }
          }
        },
        close: async () => undefined
      } as unknown as ElectronApplication
    })

    try {
      await expect(
        ElectronAppHarness.create('hidden', async (app) => {
          try {
            capturedLog = await app.captureMainLog('startup-regression.log')
          } catch (error) {
            captureError = error
          }
        })
      ).rejects.toBe(startupError)
      expect(captureError).toBeUndefined()
      expect(capturedLog).toBeDefined()
      expect(await readFile(capturedLog!, 'utf8')).toBe('database migration started: 0042\n')
      await expect(readFile(join(profileRoot, 'logs', 'main.log'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      if (capturedLog) await rm(capturedLog, { force: true })
    }
  })

  it('prepares an explicitly selected fake agent before the first Electron launch', async () => {
    const stopped = new Error('stop before launching an actual process')
    let initialSettings: Record<string, unknown> = {}
    let initialEnvironment: Record<string, string | undefined> = {}
    vi.spyOn(electron, 'launch').mockImplementation(async (options) => {
      initialEnvironment = options!.env!
      initialSettings = JSON.parse(
        await readFile(
          join(options!.env!.OPEN_SCIENCE_STORAGE_ROOT!, 'settings.json'),
          'utf8'
        ).catch(() => '{}')
      )
      throw stopped
    })
    await expect(ElectronAppHarness.create('hidden', undefined, true)).rejects.toBe(stopped)
    expect(initialEnvironment.OPEN_SCIENCE_AGENT_FRAMEWORK).toBe('opencode')
    expect(initialSettings).toMatchObject({ opencodeVersion: '1.0.0', localePreference: 'en' })
    expect(initialSettings.opencodePath).toMatch(/fake-agent-bin[/\\]opencode(?:\.cmd)?$/)
  })

  it('pins English before first launch even without a fake agent', async () => {
    const stopped = new Error('stop before launching an actual process')
    let initialSettings: Record<string, unknown> = {}
    vi.spyOn(electron, 'launch').mockImplementation(async (options) => {
      initialSettings = JSON.parse(
        await readFile(
          join(options!.env!.OPEN_SCIENCE_STORAGE_ROOT!, 'settings.json'),
          'utf8'
        ).catch(() => '{}')
      )
      throw stopped
    })
    await expect(ElectronAppHarness.create('hidden')).rejects.toBe(stopped)
    expect(initialSettings.localePreference).toBe('en')
    expect(initialSettings.opencodePath).toBeUndefined()
  })

  it('retains the startup error and cleans up when evidence capture fails', async () => {
    const startupError = new Error('Electron failed to launch')
    let storageRoot = ''
    let attemptedCapture = false
    vi.spyOn(electron, 'launch').mockImplementation(async (options) => {
      storageRoot = options!.env!.OPEN_SCIENCE_STORAGE_ROOT!
      throw startupError
    })
    await expect(
      ElectronAppHarness.create('hidden', async () => {
        attemptedCapture = true
        throw new Error('evidence directory is not writable')
      })
    ).rejects.toBe(startupError)
    expect(attemptedCapture).toBe(true)
    await expect(readFile(join(storageRoot, 'fake-remoteit-state.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

const deferred = (): {
  promise: Promise<void>
  resolve: () => void
} => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const runWithPageLocalStorage = (
  script: (key: string) => void,
  key: string,
  localStorage: Pick<Storage, 'setItem'>
): void => {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window: { localStorage: Pick<Storage, 'setItem'> } }).window = { localStorage }
  try {
    script(key)
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window: unknown }).window = previousWindow
  }
}

describe('Electron E2E cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a graceful close on the normal path', async () => {
    const forceClose = vi.fn(async () => undefined)

    await closeElectronApplicationForCleanup(
      { close: () => Promise.resolve(), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    )

    expect(forceClose).not.toHaveBeenCalled()
  })

  it('force-closes a fixture-owned process after the graceful budget', async () => {
    vi.useFakeTimers()
    const closing = deferred()
    const forceClose = vi.fn(async () => closing.resolve())
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => closing.promise, forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    )

    await vi.advanceTimersByTimeAsync(100)
    await cleanup

    expect(forceClose).toHaveBeenCalledOnce()
  })

  it('reaps a blocked restart without treating forced termination as a successful save', async () => {
    vi.useFakeTimers()
    const forceClose = vi.fn(async () => undefined)
    const closing = closeElectronApplicationForCleanup(
      { close: () => new Promise<void>(() => undefined), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100, requireGraceful: true }
    )
    await Promise.all([
      expect(closing).rejects.toThrow('graceful close did not finish within 100ms'),
      vi.advanceTimersByTimeAsync(100)
    ])
    expect(forceClose).toHaveBeenCalledOnce()
  })

  it('awaits forced reaping before propagating a graceful close error', async () => {
    const reaping = deferred()
    const forceClose = vi.fn(() => reaping.promise)
    let cleanupError: unknown
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => Promise.reject(new Error('close failed')), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    ).catch((error: unknown) => {
      cleanupError = error
    })

    await vi.waitFor(() => expect(forceClose).toHaveBeenCalledOnce())
    expect(cleanupError).toBeUndefined()

    reaping.resolve()
    await cleanup
    expect(cleanupError).toEqual(new Error('close failed'))
  })

  it('fails within a second bound when forced cleanup cannot reap the process', async () => {
    vi.useFakeTimers()
    const forceClose = vi.fn(() => new Promise<void>(() => undefined))
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => new Promise<void>(() => undefined), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 50 }
    )
    const rejection = expect(cleanup).rejects.toThrow('forced close did not finish within 50ms')

    await vi.advanceTimersByTimeAsync(150)
    await rejection
    expect(forceClose).toHaveBeenCalledOnce()
  })
})

describe('Electron E2E GitHub star nudge suppression', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the same cooldown key as GitHubStarBadge', async () => {
    const badgeSource = await readFile(
      resolve('src/renderer/src/components/GitHubStarBadge.tsx'),
      'utf8'
    )
    expect(badgeSource).toContain(`'${STAR_NUDGE_LAST_SHOWN_STORAGE_KEY}'`)
  })

  it('suppresses the workspace star nudge on every E2E platform', async () => {
    const fixtureSource = await readFile(resolve('e2e/fixtures/electron-app.ts'), 'utf8')
    expect(fixtureSource).toContain('await suppressWorkspaceStarNudge(page)')
    expect(fixtureSource).toContain("await page.reload({ waitUntil: 'domcontentloaded' })")
    expect(fixtureSource).not.toContain('addInitScript')
    expect(fixtureSource).not.toMatch(
      /if \(process\.platform === 'win32'\) \{\s*\/\/ The workspace GitHub star nudge/
    )
  })

  it('records the cooldown on the current page', async () => {
    const now = 1_700_000_000_000
    const store = new Map<string, string>()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    await suppressWorkspaceStarNudge({
      evaluate: async (script, arg) => {
        runWithPageLocalStorage(script, arg, {
          setItem: (name, value) => {
            store.set(name, value)
          }
        })
      }
    })

    expect(store.get(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY)).toBe(String(now))
  })

  it('does not throw when the document denies localStorage', async () => {
    await expect(
      suppressWorkspaceStarNudge({
        evaluate: async (script, arg) => {
          runWithPageLocalStorage(script, arg, {
            setItem: () => {
              throw new Error(
                "Failed to read the 'localStorage' property from 'Window': Access is denied for this document."
              )
            }
          })
        }
      })
    ).resolves.toBeUndefined()
  })
})
