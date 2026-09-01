import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeElectronApplicationForCleanup,
  STAR_NUDGE_LAST_SHOWN_STORAGE_KEY,
  suppressWorkspaceStarNudge
} from '../e2e/fixtures/electron-app'

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
