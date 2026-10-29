import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopRecoveryRestart,
  readDesktopRecoveryLaunch,
  desktopRecoveryRelaunchArgs,
  desktopOrdinaryRelaunchArgs
} from './desktop-recovery-restart'

const configuration = {
  configRoot: '/tmp/recovery-config',
  profilePath: '/tmp/recovery-profile',
  port: 3210,
  credentialStore: 'file' as const
}

describe('explicit desktop recovery restart', () => {
  it('keeps the window when saving fails and never schedules a later accidental restart', async () => {
    const prepare = vi.fn(async () => false)
    const quit = vi.fn()
    const relaunch = vi.fn()
    const restart = createDesktopRecoveryRestart({ prepare, quit, relaunch })
    expect(await restart.request(['app', '--kept'])).toBe('blocked')
    restart.beforeExit()
    expect(quit).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    prepare.mockResolvedValue(true)
    expect(await restart.request(['app', '--kept'])).toBe('restarting')
    expect(relaunch).not.toHaveBeenCalled()
    restart.cancel()
    restart.beforeExit()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('deduplicates clicks and relaunches only at the completed shutdown boundary', async () => {
    let saved!: (value: boolean) => void
    const prepare = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          saved = resolve
        })
    )
    const quit = vi.fn()
    const relaunch = vi.fn()
    const restart = createDesktopRecoveryRestart({ prepare, quit, relaunch })
    const first = restart.request(['app'])
    const second = restart.request(['app'])
    saved(true)
    expect(await first).toBe('restarting')
    expect(await second).toBe('restarting')
    expect(quit).toHaveBeenCalledOnce()
    expect(relaunch).not.toHaveBeenCalled()
    restart.beforeExit()
    restart.beforeExit()
    expect(relaunch).toHaveBeenCalledExactlyOnceWith(['app'])
  })

  it('does not quit when the request is canceled during saving', async () => {
    let saved!: (value: boolean) => void
    const quit = vi.fn()
    const restart = createDesktopRecoveryRestart({
      prepare: () =>
        new Promise<boolean>((resolve) => {
          saved = resolve
        }),
      quit,
      relaunch: vi.fn()
    })
    const pending = restart.request(['app'])
    restart.cancel()
    saved(true)
    expect(await pending).toBe('blocked')
    expect(quit).not.toHaveBeenCalled()
  })

  it('honors a later Quit while the stop authorization is still being read', async () => {
    let resolveArgs!: (args: string[]) => void
    const prepare = vi.fn(async () => true)
    const quit = vi.fn()
    const relaunch = vi.fn()
    const restart = createDesktopRecoveryRestart({ prepare, quit, relaunch })
    const pending = restart.request(
      () =>
        new Promise<string[]>((resolve) => {
          resolveArgs = resolve
        })
    )
    restart.cancel()
    resolveArgs(['app'])
    expect(await pending).toBe('blocked')
    expect(prepare).not.toHaveBeenCalled()
    restart.beforeExit()
    expect(quit).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('never replays a reviewed stop authorization on an ordinary later relaunch', () => {
    const args = desktopRecoveryRelaunchArgs(['app', '--kept'], {
      configuration,
      authorization: {
        version: 1,
        generation: '964505af-28f1-4a84-a815-52a09c4b5094',
        explicit: false,
        stopping: true,
        reason: 'disconnect'
      }
    })
    const ordinary = desktopOrdinaryRelaunchArgs(args)
    expect(readDesktopRecoveryLaunch(ordinary)).toEqual({ configuration })
    expect(ordinary.slice(0, 2)).toEqual(['app', '--kept'])
    expect(desktopOrdinaryRelaunchArgs(['app'])).toEqual(['app'])
  })

  it('preserves configuration without credentials, data-location snapshots or stale handoffs', () => {
    const args = desktopRecoveryRelaunchArgs(['--other'], { configuration })
    expect(readDesktopRecoveryLaunch(args)).toEqual({ configuration })
    const replacement = desktopRecoveryRelaunchArgs(args, {
      configuration: { ...configuration, port: 4321 }
    })
    expect(readDesktopRecoveryLaunch(replacement)?.configuration.port).toBe(4321)
    expect(replacement).toHaveLength(2)
    expect(() => readDesktopRecoveryLaunch([...args, args[1]!])).toThrow()
    expect(() =>
      desktopRecoveryRelaunchArgs([], {
        configuration: { ...configuration, configRoot: 'relative' }
      })
    ).toThrow()
  })
})
