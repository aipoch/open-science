import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { createActiveResearchSafeInstallGate, createDurableInstallGate } from './strategy'
import {
  clearApplicationShutdownTrigger,
  currentApplicationShutdownTrigger
} from '../application-shutdown-trigger'

afterEach(() => clearApplicationShutdownTrigger())

// The default autoUpdater is never exercised here (every test injects a FakeUpdater); mock the module
// so importing the strategy doesn't pull a real Electron runtime into the test process. A stub
// CancellationToken stands in for the real class so the default token factory works in download().
vi.mock('electron-updater', () => ({
  autoUpdater: {},
  CancellationToken: class {
    cancelled = false
    cancel(): void {
      this.cancelled = true
    }
  }
}))

type FakeToken = { cancelled: boolean; cancel(): void }

// Faithful fake of electron-updater's autoUpdater. Critically, downloadUpdate models AppUpdater's real
// re-entrancy (out/AppUpdater.js): while a download is in progress it returns the SAME live
// downloadPromise and IGNORES the passed token; the promise is only cleared in a finally after the
// underlying download settles. This is what makes a naive "release the slot in cancel()" retry reuse
// the cancelled download instead of starting a fresh one.
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  // The download body each call runs. Default: emit progress + downloaded and resolve. Tests override
  // it to hang, to inspect the token, or to count real starts.
  runDownload: (token?: FakeToken) => Promise<void> = async () => {
    this.emit('download-progress', {
      percent: 42,
      transferred: 4200,
      total: 10000,
      bytesPerSecond: 12345
    })
    this.emit('update-downloaded', { version: '0.3.0' })
  }
  private downloadPromise: Promise<void> | null = null
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    this.emit('update-available', {
      version: '0.3.0',
      releaseNotes: 'notes',
      files: [{ url: 'https://cdn/Open-Science-0.3.0.zip', size: 10000 }]
    })
  })
  downloadUpdate = vi.fn((token?: FakeToken): Promise<void> => {
    if (this.downloadPromise != null) return this.downloadPromise
    this.downloadPromise = this.runDownload(token).finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  })
  quitAndInstall = vi.fn()
}

const markUpdateReady = (updater: FakeUpdater): void => {
  updater.emit('update-downloaded', { version: '0.3.0' })
}

// Fake fetch returning a version.json manifest, so notes hydration never touches the network.
const manifestFetch = (manifest: object): typeof fetch =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  ) as unknown as typeof fetch

// Fake fetch that always fails, standing in for "no manifest reachable".
const offlineFetch = (): typeof fetch =>
  vi.fn(async () => {
    throw new Error('no network in test')
  }) as unknown as typeof fetch

const createLogSpy = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const diagnosticRecords = (log: Logger): Record<string, unknown>[] =>
  (['debug', 'info', 'warn', 'error'] as const).flatMap((level) =>
    vi.mocked(log[level]).mock.calls.map(([, data]) => data as Record<string, unknown>)
  )

describe('ElectronUpdaterStrategy', () => {
  it('disables auto download/install on construction', () => {
    const updater = new FakeUpdater()
    new ElectronUpdaterStrategy({ updater, currentVersion: '0.2.0', broadcast: vi.fn() })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('maps check → available with restart applyKind', async () => {
    const broadcast = vi.fn()
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.state).toBe('available')
    expect(status.latest).toBe('0.3.0')
    expect(status.applyKind).toBe('restart')
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'available' })
    )
  })

  it('records a completed in-place check without release notes or feed URLs', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      manifestUrl: 'https://diagnostic-private.example/version.json?token=secret',
      log
    })

    await strategy.check()

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-check',
          outcome: 'completed',
          result: 'available'
        })
      ])
    )
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('diagnostic-private')
    expect(serialized).not.toContain('notes')
  })

  it('maps download → progress then ready', async () => {
    const broadcast = vi.fn()
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    vi.mocked(log.info).mockClear()
    const status = await strategy.download()
    expect(broadcast).toHaveBeenCalledWith('update:progress', {
      phase: 'downloading',
      percent: 42,
      transferred: 4200,
      total: 10000,
      bytesPerSecond: 12345,
      attempt: 0
    })
    expect(status.state).toBe('ready')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'completed',
          result: 'ready'
        })
      ])
    )
  })

  it('preserves a completed in-place download when a check is requested during transfer', async () => {
    const updater = new FakeUpdater()
    let checkCalls = 0
    let releaseLateCheck: (() => void) | undefined
    const lateCheckGate = new Promise<void>((resolve) => {
      releaseLateCheck = resolve
    })
    updater.checkForUpdates = vi.fn(async () => {
      checkCalls += 1
      updater.emit('checking-for-update')
      if (checkCalls === 1) {
        updater.emit('update-available', {
          version: '0.3.0',
          releaseNotes: 'notes',
          files: [{ url: 'https://cdn/Open-Science-0.3.0.zip', size: 10000 }]
        })
        return
      }
      await lateCheckGate
      updater.emit('update-not-available', { version: '0.2.0' })
    })
    let releaseDownload: (() => void) | undefined
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve
    })
    updater.runDownload = async () => {
      await downloadGate
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })

    await strategy.check()
    const downloading = strategy.download()
    const checking = strategy.check()
    releaseDownload?.()
    await downloading
    releaseLateCheck?.()
    await checking

    const readyStatus = strategy.getStatus()
    expect(await strategy.check()).toBe(readyStatus)
    expect(checkCalls).toBe(2)
    expect(strategy.getStatus().state).toBe('ready')
  })

  it('preserves in-place ready on check failure but accepts a strictly newer update', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    await strategy.download()
    const readyStatus = strategy.getStatus()

    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('error', new Error('offline'))
    })
    expect(await strategy.check()).toBe(readyStatus)

    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('checking-for-update')
      updater.emit('update-available', {
        version: '0.4.0',
        releaseNotes: 'newer notes',
        files: [{ url: 'https://cdn/Open-Science-0.4.0.zip', size: 12000 }]
      })
    })
    expect(await strategy.check()).toEqual(
      expect.objectContaining({ state: 'available', latest: '0.4.0', totalBytes: 12000 })
    )
  })

  it('coalesces overlapping in-place checks onto the in-flight provider query', async () => {
    const updater = new FakeUpdater()
    let releaseCheck: (() => void) | undefined
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('checking-for-update')
      await checkGate
      updater.emit('update-available', { version: '0.3.0', releaseNotes: 'notes' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })

    const first = strategy.check()
    const second = strategy.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    releaseCheck?.()
    const [left, right] = await Promise.all([first, second])
    expect(left).toBe(right)
    expect(left.state).toBe('available')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight provider check before starting an in-place download', async () => {
    const updater = new FakeUpdater()
    let releaseCheck: (() => void) | undefined
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('checking-for-update')
      await checkGate
      updater.emit('update-available', { version: '0.3.0', releaseNotes: 'notes' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })

    const checking = strategy.check()
    expect(strategy.getStatus().state).toBe('checking')
    const downloading = strategy.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    releaseCheck?.()
    expect((await checking).state).toBe('available')
    expect((await downloading).state).toBe('ready')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not let pending notes hydration block an available in-place download', async () => {
    const updater = new FakeUpdater()
    let releaseNotes: (() => void) | undefined
    const notesGate = new Promise<void>((resolve) => {
      releaseNotes = resolve
    })
    const fetchImpl = vi.fn(async () => {
      await notesGate
      return new Response(
        JSON.stringify({
          version: '0.3.0',
          releaseDate: '',
          notes: 'cdn notes',
          localizedNotes: { 'zh-Hans': 'CDN 说明' },
          downloads: {}
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl
    })

    const checking = strategy.check()
    expect(strategy.getStatus()).toEqual(
      expect.objectContaining({ state: 'available', latest: '0.3.0', notes: 'notes' })
    )
    const downloading = strategy.download()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      await Promise.race([
        checking.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
    ).toBe('settled')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect((await downloading).state).toBe('ready')

    releaseNotes?.()
    await vi.waitFor(() => {
      expect(strategy.getStatus()).toEqual(
        expect.objectContaining({
          state: 'ready',
          notes: 'cdn notes',
          localizedNotes: { 'zh-Hans': 'CDN 说明' }
        })
      )
    })
  })

  it('preserves the offer and retries after a failed in-place download', async () => {
    const updater = new FakeUpdater()
    let starts = 0
    updater.runDownload = async () => {
      starts += 1
      if (starts === 1) throw new Error('private updater diagnostic detail')
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    const failed = await strategy.download()
    const retry = await strategy.download()

    expect.soft(failed).toEqual(
      expect.objectContaining({
        state: 'error',
        current: '0.2.0',
        latest: '0.3.0',
        notes: 'notes',
        totalBytes: 10000,
        error: 'private updater diagnostic detail'
      })
    )
    expect.soft(retry.state).toBe('ready')
    expect.soft(retry.error).toBeUndefined()
    expect.soft(starts).toBe(2)
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'failed',
          phase: 'transfer',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('private updater diagnostic detail')
  })

  it('cancel aborts an in-flight download and resets the status to available', async () => {
    const updater = new FakeUpdater()
    let release: (() => void) | undefined
    let seenToken: FakeToken | undefined
    // Hang the download until released, then mimic electron-updater rejecting a cancelled download.
    updater.runDownload = async (token) => {
      seenToken = token
      updater.emit('download-progress', {
        percent: 40,
        transferred: 4000,
        total: 10000,
        bytesPerSecond: 12000
      })
      await new Promise<void>((resolve) => (release = resolve))
      if (token?.cancelled) throw new Error('cancelled')
    }
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      log
    })
    await strategy.check()
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    const downloading = strategy.download()
    await vi.waitFor(() => {
      expect(strategy.getStatus()).toMatchObject({
        state: 'downloading',
        downloadedBytes: 4000,
        totalBytes: 10000
      })
    })
    const cancelled = await strategy.cancel()
    expect(cancelled.state).toBe('available')
    expect(cancelled).not.toHaveProperty('progress')
    expect(cancelled).not.toHaveProperty('downloadedBytes')
    expect(cancelled).not.toHaveProperty('downloadProgress')
    expect(cancelled.totalBytes).toBe(10000)
    expect(seenToken?.cancelled).toBe(true)

    // The rejected downloadUpdate must not clobber the reset status with an error.
    release?.()
    const final = await downloading
    expect(final.state).toBe('available')
    expect(final.error).toBeUndefined()
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'cancelled',
          reason: 'user'
        })
      ])
    )
  })

  it('cancel is a no-op when nothing is downloading', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    const status = await strategy.cancel()
    expect(status.state).toBe('available')
  })

  it('ignores a second download() while one is already in flight', async () => {
    const updater = new FakeUpdater()
    let release: (() => void) | undefined
    let starts = 0
    updater.runDownload = async () => {
      starts += 1
      await new Promise<void>((resolve) => (release = resolve))
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const first = strategy.download()
    const second = strategy.download()
    expect(starts).toBe(1)

    release?.()
    await Promise.all([first, second])
    expect(starts).toBe(1)
    expect(strategy.getStatus().state).toBe('ready')
  })

  it('does not download an installer again after the lifecycle is ready', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const ready = await strategy.download()
    const repeated = await strategy.download()

    expect(ready.state).toBe('ready')
    expect(repeated).toBe(ready)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('supports cancel followed by an immediate retry to completion', async () => {
    const updater = new FakeUpdater()
    let starts = 0
    let release: (() => void) | undefined
    // Models the real AppUpdater: the first (cancelled) download stays live until released; the retry
    // must NOT reuse it. Only a strategy that drains the old lifecycle before retrying lets the fake's
    // downloadPromise clear so downloadUpdate starts a genuine second download.
    updater.runDownload = async (token) => {
      starts += 1
      if (starts === 1) {
        await new Promise<void>((resolve) => (release = resolve))
        if (token?.cancelled) throw new Error('cancelled')
      } else {
        updater.emit('download-progress', { percent: 55, transferred: 5500, total: 10000 })
        updater.emit('update-downloaded', { version: '0.3.0' })
      }
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const first = strategy.download()
    const cancelled = await strategy.cancel()
    expect(cancelled.state).toBe('available')

    // Release the cancelled download so its live promise settles and clears, unblocking the retry's
    // drain. A real retry then starts a second, genuine download that completes.
    release?.()
    const retry = await strategy.download()
    expect(retry.state).toBe('ready')
    expect(starts).toBe(2)

    const firstFinal = await first
    expect(firstFinal.error).toBeUndefined()
  })

  it('reports up-to-date when no update is available', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-not-available', { version: '0.2.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await strategy.check()
    expect(status.state).toBe('up-to-date')
  })

  it('surfaces errors as status error', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('error', new Error('raw provider diagnostic detail'))
    })
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      log
    })
    const status = await strategy.check()
    expect(status.state).toBe('error')
    expect(status.error).toBe('raw provider diagnostic detail')
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-check',
          outcome: 'failed',
          phase: 'query-provider',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('raw provider diagnostic detail')
  })

  it.each([
    ['idle', () => {}],
    ['checking', (updater: FakeUpdater) => updater.emit('checking-for-update')],
    ['up-to-date', (updater: FakeUpdater) => updater.emit('update-not-available', {})],
    ['available', (updater: FakeUpdater) => updater.emit('update-available', {})],
    [
      'downloading',
      (updater: FakeUpdater) =>
        updater.emit('download-progress', { percent: 10, transferred: 1000, total: 10000 })
    ],
    ['error', (updater: FakeUpdater) => updater.emit('error', new Error('download failed'))]
  ])('ignores apply while the update state is %s', async (state, enterState) => {
    const updater = new FakeUpdater()
    const broadcast = vi.fn()
    const installGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const markUpdateShutdown = vi.fn(() => vi.fn())
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      installGate,
      markUpdateShutdown
    })
    enterState(updater)
    expect(strategy.getStatus().state).toBe(state)
    const statusBeforeApply = strategy.getStatus()
    broadcast.mockClear()

    const status = await strategy.apply()

    expect(status).toBe(statusBeforeApply)
    expect(strategy.getStatus()).toBe(statusBeforeApply)
    expect(broadcast).not.toHaveBeenCalled()
    expect(installGate).not.toHaveBeenCalled()
    expect(markUpdateShutdown).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('apply installs silently and relaunches (quitAndInstall(true, true))', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      log
    })
    markUpdateReady(updater)
    await strategy.apply()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(currentApplicationShutdownTrigger()).toBe('update')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'completed',
          result: 'handoff-requested'
        })
      ])
    )
  })

  it('can install silently without relaunching for a headless caller', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    markUpdateReady(updater)

    await strategy.apply({ relaunch: false })

    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, false)
  })

  it('rolls back the update handoff when quitAndInstall throws', async () => {
    const updater = new FakeUpdater()
    const releaseInstallHandoff = vi.fn()
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error('installer unavailable')
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: vi.fn(async () => ({ completed: true, reaped: true })),
      releaseInstallHandoff
    })
    markUpdateReady(updater)

    const status = await strategy.apply()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(status.state).toBe('error')
    expect(currentApplicationShutdownTrigger()).toBe('quit')
    expect(releaseInstallHandoff).toHaveBeenCalledOnce()
  })

  it('apply runs the install gate before quitAndInstall when the teardown is clean', async () => {
    const updater = new FakeUpdater()
    const backendTeardownGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const confirmRendererDurability = vi.fn(async () => true)
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: createDurableInstallGate(backendTeardownGate, confirmRendererDurability)
    })
    markUpdateReady(updater)

    await strategy.apply()

    expect(backendTeardownGate).toHaveBeenCalledOnce()
    expect(confirmRendererDurability).toHaveBeenCalledOnce()
    expect(backendTeardownGate.mock.invocationCallOrder[0]).toBeLessThan(
      confirmRendererDurability.mock.invocationCallOrder[0]
    )
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('blocks restart when renderer durability cannot be confirmed after teardown', async () => {
    const updater = new FakeUpdater()
    const backendTeardownGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const confirmRendererDurability = vi.fn(async () => false)
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: createDurableInstallGate(backendTeardownGate, confirmRendererDurability)
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(backendTeardownGate).toHaveBeenCalledOnce()
    expect(confirmRendererDurability).toHaveBeenCalledOnce()
    expect(backendTeardownGate.mock.invocationCallOrder[0]).toBeLessThan(
      confirmRendererDurability.mock.invocationCallOrder[0]
    )
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status).toMatchObject({
      state: 'error',
      error: 'Could not fully stop background processes before updating. Please try again.'
    })
  })

  it('blocks restart before backend teardown when delegated work is running', async () => {
    const updater = new FakeUpdater()
    const backendTeardownGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: createActiveResearchSafeInstallGate(() => ['delegated'], backendTeardownGate)
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(status).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/subagents are still running/i),
      blockedBy: ['delegated']
    })
    expect(backendTeardownGate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('blocks restart while an Agent Runtime installation is active', async () => {
    const updater = new FakeUpdater()
    const backendTeardownGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: createActiveResearchSafeInstallGate(
        () => ['settings-install'],
        backendTeardownGate
      )
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(status).toMatchObject({
      state: 'error',
      error:
        'An Agent Runtime is still installing. Wait for it to finish before restarting to update.',
      blockedBy: ['settings-install']
    })
    expect(backendTeardownGate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('blocks restart for root-agent, notebook, and reviewer work without tearing them down', async () => {
    const updater = new FakeUpdater()
    const backendTeardownGate = vi.fn(async () => ({ completed: true, reaped: true }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: createActiveResearchSafeInstallGate(
        () => ['agent', 'notebook', 'reviewer'],
        backendTeardownGate
      )
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(status).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/research work is still running/i),
      blockedBy: ['agent', 'notebook', 'reviewer']
    })
    expect(backendTeardownGate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('reports preparation immediately and ignores a repeat apply while teardown is pending', async () => {
    const updater = new FakeUpdater()
    const broadcast = vi.fn()
    let finishGate: (() => void) | undefined
    const gate = vi.fn(
      () =>
        new Promise<{ completed: true; reaped: true }>((resolve) => {
          finishGate = () => resolve({ completed: true, reaped: true })
        })
    )
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast,
      installGate: gate
    })
    markUpdateReady(updater)

    const applying = strategy.apply()
    expect(strategy.getStatus().state).toBe('applying')
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'applying' })
    )

    await strategy.apply()
    expect(gate).toHaveBeenCalledTimes(1)

    updater.emit('checking-for-update')
    await strategy.check()
    await strategy.download()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(strategy.getStatus().state).toBe('applying')

    finishGate?.()
    await applying
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('apply refuses to install and reports an error when the teardown times out', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: false, reaped: false }))
    const releaseInstallHandoff = vi.fn()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate,
      releaseInstallHandoff,
      log
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(releaseInstallHandoff).toHaveBeenCalledOnce()
    expect(status.state).toBe('error')
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'failed',
          phase: 'install-gate',
          reason: 'install-gate-refused',
          gateCompleted: false,
          processTreesReaped: false
        })
      ])
    )
  })

  it('records a thrown install-gate failure without its error message', async () => {
    const updater = new FakeUpdater()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: () => Promise.reject(new Error('private teardown diagnostic detail')),
      log
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(status.state).toBe('error')

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'failed',
          phase: 'install-gate',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('private teardown diagnostic detail')
  })

  it('ignores stale updater errors during preparation', async () => {
    const updater = new FakeUpdater()
    let finishGate: (() => void) | undefined
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: () =>
        new Promise((resolve) => {
          finishGate = () => resolve({ completed: true, reaped: true })
        })
    })
    markUpdateReady(updater)

    const applying = strategy.apply()
    updater.emit('error', new Error('stale download failure'))
    expect(strategy.getStatus().state).toBe('applying')
    finishGate?.()
    const status = await applying

    expect(status.state).toBe('applying')
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('restores an actionable error after the installer handoff starts', async () => {
    const updater = new FakeUpdater()
    const releaseInstallHandoff = vi.fn()
    const log = createLogSpy()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: vi.fn(async () => ({ completed: true, reaped: true })),
      releaseInstallHandoff,
      log
    })
    markUpdateReady(updater)

    await strategy.apply()
    expect(currentApplicationShutdownTrigger()).toBe('update')
    updater.emit('error', new Error('installer failed'))

    expect(strategy.getStatus().state).toBe('error')
    expect(strategy.getStatus().error).toBe('installer failed')
    expect(currentApplicationShutdownTrigger()).toBe('quit')
    expect(releaseInstallHandoff).toHaveBeenCalledOnce()
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-installer',
          outcome: 'failed',
          phase: 'handoff',
          errorCategory: 'error'
        })
      ])
    )
  })

  it('restores an actionable error when quitAndInstall throws', async () => {
    const updater = new FakeUpdater()
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('installer launch failed')
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(status.state).toBe('error')
    expect(status.error).toBe('installer launch failed')
  })

  it('restores an actionable error when the install gate throws', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch(),
      installGate: vi.fn(async () => Promise.reject(new Error('teardown failed')))
    })
    await strategy.check()
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
    expect(status.latest).toBe('0.3.0')
    expect(status.error).toContain('Please try again')
  })

  it('apply refuses to install when the teardown completed but a tree was not cleanly reaped', async () => {
    const updater = new FakeUpdater()
    const gate = vi.fn(async () => ({ completed: true, reaped: false }))
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      installGate: gate
    })
    markUpdateReady(updater)

    const status = await strategy.apply()

    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
  })

  it('hydrates notes from the CDN manifest when the version matches', async () => {
    const updater = new FakeUpdater()
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: manifestFetch({ version: '0.3.0', downloads: {}, notes: '## Highlights\n- new' })
    })
    await strategy.check()
    await vi.waitFor(() => {
      expect(strategy.getStatus().notes).toBe('## Highlights\n- new')
    })
  })

  it('keeps the GitHub-link fallback when the manifest version does not match', async () => {
    const updater = new FakeUpdater()
    // No releaseNotes in the feed, so without a matching manifest the notes stay empty.
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: manifestFetch({ version: '0.3.1', downloads: {}, notes: 'stale notes' })
    })
    const status = await strategy.check()
    expect(status.notes).toBe('')
  })

  it('keeps the fallback when the manifest fetch fails', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.notes).toBe('')
  })

  it('extracts totalBytes from the updater feed artifact for the current platform', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 99000 },
          { url: 'https://cdn/app-0.3.0.dmg', size: 12000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    // darwin/arm64 → the arm64 ZIP (99000), not the DMG (12000).
    expect(status.totalBytes).toBe(99000)
  })

  it('matches the correct architecture in a multi-arch macOS feed', async () => {
    // Real latest-mac.yml carries both arm64 and x64 ZIPs; x64 must not pick arm64's size.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => false,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBe(105000)
  })

  it('omits totalBytes when multiple files match the platform and arch ambiguously', async () => {
    // If two files somehow match the same platform+arch+extension, don't guess.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBeUndefined()
  })

  it('resolves x64 under Rosetta to arm64 for artifact size selection', async () => {
    // An x64 app running under Rosetta 2 on Apple Silicon downloads the arm64 ZIP (electron-updater's
    // MacUpdater.filterFilesForArch does the same via sysctl.proc_translated). The pre-download size
    // must match the arm64 entry, not the x64 one.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => true,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    // x64 + Rosetta → effective arm64 → picks 95000, not 105000.
    expect(status.totalBytes).toBe(95000)
  })

  it('keeps x64 arch when not under Rosetta', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => false,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    // Native Intel x64 → picks 105000.
    expect(status.totalBytes).toBe(105000)
  })

  it('omits totalBytes when Rosetta status is uncertain and feed has both arches', async () => {
    // When the Rosetta probe returns undefined (e.g. sysctl failed), electron-updater might still
    // pick arm64. Don't guess — omit the size so the user sees no pre-download size label.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', {
        version: '0.3.0',
        files: [
          { url: 'https://cdn/app-0.3.0-arm64.zip', size: 95000 },
          { url: 'https://cdn/app-0.3.0-x64.zip', size: 105000 }
        ]
      })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'x64',
      isRosetta: () => undefined,
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBeUndefined()
  })

  it('preserves check-time totalBytes when download-progress omits total', async () => {
    // Artifacts published with a size in the feed should keep that size even if a progress event
    // arrives without a total field.
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0', files: [{ size: 50000 }] })
    })
    updater.runDownload = async () => {
      // Progress event intentionally omits total — must not clobber the known 50000.
      updater.emit('download-progress', { percent: 10, transferred: 5000 })
      updater.emit('update-downloaded', { version: '0.3.0' })
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()
    expect(strategy.getStatus().totalBytes).toBe(50000)

    const status = await strategy.download()
    expect(status.totalBytes).toBe(50000)
    expect(status.downloadedBytes).toBe(5000)
  })

  it('omits totalBytes when the updater feed has no artifact size', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-available', { version: '0.3.0' })
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    const status = await strategy.check()
    expect(status.totalBytes).toBeUndefined()
  })

  it('resets downloadedBytes to 0 when starting a new download', async () => {
    // A retry after cancel must not carry over the previous download's transferred bytes.
    const updater = new FakeUpdater()
    let starts = 0
    let release: (() => void) | undefined
    updater.runDownload = async (token) => {
      starts += 1
      if (starts === 1) {
        await new Promise<void>((resolve) => (release = resolve))
        if (token?.cancelled) throw new Error('cancelled')
      } else {
        updater.emit('download-progress', { percent: 55, transferred: 5500, total: 10000 })
        updater.emit('update-downloaded', { version: '0.3.0' })
      }
    }
    const strategy = new ElectronUpdaterStrategy({
      updater,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      fetchImpl: offlineFetch()
    })
    await strategy.check()

    const first = strategy.download()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(strategy.getStatus().downloadedBytes).toBe(0)

    await strategy.cancel()
    release?.()
    const retry = await strategy.download()
    expect(retry.state).toBe('ready')
    expect(starts).toBe(2)
    // The retry's progress event should report fresh transferred, not stale bytes.
    expect(retry.downloadedBytes).toBe(5500)
    await first
  })
})
