import { load } from 'js-yaml'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from './windows-installer-smoke.mjs'

import {
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  classifyUpdaterDownloadStatus,
  invokeWebRpc,
  parseArguments,
  parseSingleRange,
  redactPackagedAppOutput,
  rewriteFeedPaths,
  observeInstaller
} from './windows-updater-certification.mjs'

describe('Windows updater certification', () => {
  it('redacts packaged app tokens before output reaches CI diagnostics', () => {
    expect(
      redactPackagedAppOutput(
        'Open Science Web: http://127.0.0.1:4321/?token=secret-token\nnext?mode=test&token=other'
      )
    ).toBe(
      'Open Science Web: http://127.0.0.1:4321/?token=<redacted>\nnext?mode=test&token=<redacted>'
    )
  })

  it('drives updater commands through the authenticated headless RPC', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ protocolVersion: 1, ok: true, result: { state: 'ready' } })
    )

    await expect(
      invokeWebRpc({
        endpoint: 'http://127.0.0.1:4321',
        auth: 'token=test-token',
        protocolVersion: 1,
        channel: 'update:download',
        fetchImpl
      })
    ).resolves.toEqual({ state: 'ready' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/rpc/update%3Adownload?token=test-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ protocolVersion: 1, args: [] })
      })
    )
  })

  it('observes the detached NSIS installer and preserves its exit code', async () => {
    const controller = new AbortController()
    const runProcessImpl = vi.fn(async () => ({ code: 2, stdout: '', stderr: 'installer failed' }))

    await expect(
      observeInstaller({
        installer: 'C:\\updates\\aipoch-open-science-0.11.1-win-x64-setup.exe',
        env: { LOCALAPPDATA: 'C:\\profile' },
        signal: controller.signal,
        runProcessImpl
      }).exit
    ).resolves.toEqual({ code: 2, stdout: '', stderr: 'installer failed' })
    expect(runProcessImpl).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-Command',
        expect.stringContaining('Get-CimInstance -ClassName Win32_Process')
      ]),
      expect.objectContaining({
        allowNonZero: true,
        env: expect.objectContaining({
          OPEN_SCIENCE_INSTALLER_WATCH_TARGET:
            'C:\\updates\\aipoch-open-science-0.11.1-win-x64-setup.exe'
        }),
        signal: controller.signal,
        timeoutMs: 370_000
      })
    )
  })

  it('waits for compiled observer readiness, including a split stdout marker', async () => {
    const completed = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>()
    let onStdout!: (output: string) => void
    const observer = observeInstaller({
      installer: 'C:\\updates\\setup.exe',
      env: {},
      runProcessImpl: (_executable, _args, options) => {
        onStdout = options.onStdout
        return completed.promise
      }
    })
    const apply = vi.fn()
    const applying = observer.ready.then(apply)
    onStdout('OPEN_SCIENCE_INSTALLER_OBSERVER_')
    await Promise.resolve()
    expect(apply).not.toHaveBeenCalled()
    onStdout('OPEN_SCIENCE_INSTALLER_OBSERVER_READY\r\n')
    await applying
    expect(apply).toHaveBeenCalledOnce()
    completed.resolve({ code: 7, stdout: '', stderr: '' })
    await expect(observer.exit).resolves.toMatchObject({ code: 7 })
  })

  it('rejects readiness if PowerShell fails before observation starts', async () => {
    const observer = observeInstaller({
      installer: 'C:\\updates\\setup.exe',
      env: {},
      runProcessImpl: async () => ({ code: 1, stdout: '', stderr: 'compilation failed' })
    })
    await expect(observer.ready).rejects.toThrow('compilation failed')
  })

  it.skipIf(process.platform !== 'win32')(
    'observes a short-lived process after actual PowerShell readiness',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'updater-observer-'))
      const installer = join(root, 'observer-fixture.exe')
      const controller = new AbortController()
      await copyFile(process.execPath, installer)
      const observer = observeInstaller({ installer, env: process.env, signal: controller.signal })
      try {
        await observer.ready
        const processExit = runProcess(
          installer,
          ['-e', 'setTimeout(() => process.exit(7), 1500)'],
          {
            allowNonZero: true
          }
        )
        await expect(observer.exit).resolves.toMatchObject({ code: 7 })
        await expect(processExit).resolves.toMatchObject({ code: 7 })
      } finally {
        controller.abort()
        await observer.exit.catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('points the installed updater at a local feed without weakening its signing policy', () => {
    const result = buildLocalUpdaterConfig(
      'provider: generic\nurl: https://example.test\nupdaterCacheDirName: app-updater\npublisherName: Old Signer\n',
      'http://127.0.0.1:4321'
    )

    expect(result.updaterCacheDirName).toBe('app-updater')
    expect(load(result.source)).toMatchObject({
      provider: 'generic',
      url: 'http://127.0.0.1:4321',
      channel: 'latest',
      useMultipleRangeRequest: false
    })
    expect(load(result.source)).toHaveProperty('publisherName', 'Old Signer')
  })

  it('accepts one bounded HTTP range and rejects multipart ranges', () => {
    expect(parseSingleRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseSingleRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseSingleRange('bytes=100-', 100)).toBeUndefined()
    expect(() => parseSingleRange('bytes=0-1,4-5', 100)).toThrow(/Unsupported HTTP range/)
  })

  it('models the production versioned feed used for skipped-version blockmap lookup', () => {
    expect(
      rewriteFeedPaths(
        'path: open-science-0.11.0-win-x64-setup.exe\nfiles:\n  - url: open-science-0.11.0-win-x64-setup.exe\n',
        '0.11.0'
      )
    ).toBe(
      'path: releases/0.11.0/open-science-0.11.0-win-x64-setup.exe\nfiles:\n  - url: releases/0.11.0/open-science-0.11.0-win-x64-setup.exe\n'
    )
  })

  it('fails when electron-updater falls back to a complete installer download', () => {
    const observation = {
      feedRequests: 1,
      blockmapRequests: 2,
      rangeRequests: 2,
      fullInstallerRequests: 0,
      downloadedInstallerBytes: 40,
      installerBytes: 100,
      versionedFeed: true,
      previousInstallerCacheVerified: true,
      previousVersion: '0.10.0',
      currentVersion: '0.11.0'
    }
    expect(assertDifferentialObservation(observation)).toBe(observation)
    expect(() =>
      assertDifferentialObservation({ ...observation, fullInstallerRequests: 1 })
    ).toThrow(/complete differential path/)
    expect(() =>
      assertDifferentialObservation({ ...observation, downloadedInstallerBytes: 100 })
    ).toThrow(/complete differential path/)
  })

  it('requires both release artifact directories and an evidence output', () => {
    expect(
      parseArguments([
        '--current-dir',
        'current',
        '--previous-dir',
        'previous',
        '--output',
        'observation.json'
      ])
    ).toMatchObject({
      currentDirectory: expect.stringContaining('current'),
      previousDirectory: expect.stringContaining('previous'),
      output: expect.stringContaining('observation.json')
    })
    expect(() => parseArguments(['--current-dir', 'current'])).toThrow(/Usage/)
  })

  it('retries download while a shipped updater still reports the in-flight check', () => {
    expect(
      classifyUpdaterDownloadStatus(
        { state: 'available', latest: '0.18.2', applyKind: 'restart' },
        '0.18.2'
      )
    ).toBe('pending')
    expect(classifyUpdaterDownloadStatus({ state: 'checking', current: '0.18.1' }, '0.18.2')).toBe(
      'pending'
    )
    expect(
      classifyUpdaterDownloadStatus(
        { state: 'downloading', latest: '0.18.2', applyKind: 'restart' },
        '0.18.2'
      )
    ).toBe('pending')
    expect(
      classifyUpdaterDownloadStatus(
        { state: 'ready', latest: '0.18.2', applyKind: 'restart' },
        '0.18.2'
      )
    ).toBe('ready')
    expect(classifyUpdaterDownloadStatus({ state: 'error', error: 'offline' }, '0.18.2')).toBe(
      'failed'
    )
    expect(
      classifyUpdaterDownloadStatus(
        { state: 'available', latest: '0.18.2', applyKind: 'restart' },
        '0.19.0'
      )
    ).toBe('unexpected')
  })
})
