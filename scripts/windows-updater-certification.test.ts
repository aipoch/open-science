import { load } from 'js-yaml'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { inspectInstalledProcess, runProcess } from './windows-installer-smoke.mjs'

import {
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  classifyUpdaterDownloadStatus,
  invokeWebRpc,
  prepareNotebookWorkload,
  prepareActiveNotebookWork,
  requireObservedInstallerExit,
  parseArguments,
  parseSingleRange,
  redactPackagedAppOutput,
  rewriteFeedPaths,
  observeInstaller
} from './windows-updater-certification.mjs'

describe('Windows updater certification', () => {
  it('does not confuse observer failure or a live writer timeout with a completed failed installer', () => {
    expect(
      requireObservedInstallerExit({
        code: 2,
        stdout: 'OPEN_SCIENCE_INSTALLER_OBSERVER_ACQUIRED\ninstaller pid=42 exit=2',
        stderr: ''
      })
    ).toEqual({ pid: 42, code: 2 })
    for (const code of [124, 125, 126])
      expect(() =>
        requireObservedInstallerExit({
          code,
          stdout: 'OPEN_SCIENCE_INSTALLER_OBSERVER_READY',
          stderr: 'writer still active or unavailable'
        })
      ).toThrow(/writer exit was not verified/)
    expect(() =>
      requireObservedInstallerExit({ code: 0, stdout: 'installer pid=42 exit=2', stderr: '' })
    ).toThrow(/writer exit was not verified/)
  })
  it('requires a real live kernel and persisted output before claiming a workload exists', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'updater-workload-test-'))
    const connection = { endpoint: 'http://localhost:1', auth: 'token=test', protocolVersion: 1 }
    const rpc = vi.fn(async ({ channel, args }) => {
      if (channel === 'settings:install-notebook-network') return { kind: 'ready' }
      if (channel === 'notebook-env:provision') return undefined
      if (channel === 'projects:create') return { id: 'project-id' }
      if (channel === 'notebook:execute') {
        const content = JSON.parse(/\.write_text\((".*?"), encoding/.exec(args[0].code)![1])
        await writeFile(join(workspace, 'update-preserved-output.txt'), content)
        return { runId: 'run-id', status: 'completed', text: { stdout: 'UPDATE_KERNEL_PID=42' } }
      }
      if (channel === 'notebook:state')
        return { pythonPath: 'python.exe', environments: [{ kind: 'python', status: 'idle' }] }
      throw new Error(`Unexpected RPC ${channel}`)
    })
    const identity = { pid: 42, startedAt: 100, executablePath: 'python.exe' }
    try {
      await expect(
        prepareNotebookWorkload({ connection, workspace, rpc, probeProcess: async () => identity })
      ).resolves.toMatchObject({ runId: 'run-id', process: identity })
      await expect(
        prepareNotebookWorkload({ connection, workspace, rpc, probeProcess: async () => undefined })
      ).rejects.toThrow(/verified live Python kernel/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses to replace an unavailable Notebook sandbox with an unprotected workload', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'updater-unprotected-test-'))
    const rpc = vi.fn(async () => ({ kind: 'unavailable' }))
    try {
      await expect(prepareNotebookWorkload({ connection: {}, workspace, rpc })).rejects.toThrow(
        /sandbox did not become ready/
      )
      expect(rpc).toHaveBeenCalledTimes(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('leaves real active work for production apply without introducing an active-work gate', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'updater-active-test-'))
    const pending = Promise.withResolvers<unknown>()
    const rpc = vi.fn(async ({ channel, args }) => {
      if (channel === 'notebook:execute') {
        expect(args[0].code).toContain('time.sleep(600)')
        await writeFile(join(workspace, 'active-work-started'), 'started')
        return pending.promise
      }
      if (channel === 'notebook:state')
        return { activeRunId: 'active-run', environments: [{ kind: 'python', status: 'running' }] }
      throw new Error(`Unexpected RPC ${channel}`)
    })
    try {
      await expect(
        prepareActiveNotebookWork({
          connection: {},
          workload: { scope: { workspaceCwd: workspace } },
          rpc
        })
      ).resolves.toEqual({ runId: 'active-run', activeBeforeApply: true })
      expect(rpc.mock.calls.map(([request]) => request.channel)).not.toContain('update:apply')
      pending.reject(new Error('The production shutdown disconnected the execution request.'))
    } finally {
      pending.resolve(undefined)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('accepts only the explicitly supported production update scenarios', () => {
    const args = [
      '--current-dir',
      'current',
      '--previous-dir',
      'previous',
      '--output',
      'result.json'
    ]
    for (const scenario of [
      'basic',
      'workload',
      'active-work',
      'downgrade',
      'multi-profile',
      'unresponsive-profile',
      'no-protocol-runtime',
      'missing-exe-recovery',
      'cancel-cleanup',
      'writer-shortcut-wait'
    ])
      expect(parseArguments([...args, '--scenario', scenario]).scenario).toBe(scenario)
    expect(() => parseArguments([...args, '--scenario', 'supervised'])).toThrow(
      /Unknown updater scenario/
    )
  })

  it('redacts packaged app tokens before output reaches CI diagnostics', () => {
    expect(
      redactPackagedAppOutput(
        'Open-Science Web: http://127.0.0.1:4321/?token=secret-token\nnext?mode=test&token=other'
      )
    ).toBe(
      'Open-Science Web: http://127.0.0.1:4321/?token=<redacted>\nnext?mode=test&token=<redacted>'
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
        expect.stringContaining('[Diagnostics.Process]::GetProcessesByName')
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

  it('retries process discovery and handle acquisition after observer readiness', async () => {
    let command = ''
    const completed = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>()
    const observer = observeInstaller({
      installer: 'C:\\updates\\setup.exe',
      env: {},
      runProcessImpl: (_executable, args, options) => {
        command = String(args[args.indexOf('-Command') + 1])
        options.onStdout?.('OPEN_SCIENCE_INSTALLER_OBSERVER_READY\r\n')
        return completed.promise
      }
    })

    await expect(observer.ready).resolves.toBeUndefined()
    completed.resolve({ code: 126, stdout: '', stderr: 'process was not observable' })
    await expect(observer.exit).resolves.toMatchObject({ code: 126 })
    expect(command).toContain('$handle = [IntPtr]::Zero')
    expect(command).toContain('while ($handle -eq [IntPtr]::Zero')
  })

  it('publishes a retained installer identity only after the full native record arrives', async () => {
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
    let acquired = false
    void observer.acquired.then(() => {
      acquired = true
    })
    onStdout('OPEN_SCIENCE_INSTALLER_OBSERVER_READY\nOPEN_SCIENCE_INSTALLER_IDENTITY=42,123')
    await Promise.resolve()
    expect(acquired).toBe(false)
    onStdout('OPEN_SCIENCE_INSTALLER_OBSERVER_READY\nOPEN_SCIENCE_INSTALLER_IDENTITY=42,123456\n')
    await expect(observer.acquired).resolves.toEqual({
      pid: 42,
      startedAt: 123456,
      executablePath: 'C:\\updates\\setup.exe'
    })
    completed.resolve({ code: 0, stdout: 'installer pid=42 exit=0', stderr: '' })
    await observer.exit
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
      const release = join(root, 'release')
      const controller = new AbortController()
      await copyFile(process.execPath, installer)
      const acquired = Promise.withResolvers<void>()
      const observer = observeInstaller({
        installer,
        env: process.env,
        signal: controller.signal,
        runProcessImpl: (executable, args, options) =>
          runProcess(executable, args, {
            ...options,
            onStdout: (output) => {
              options.onStdout?.(output)
              if (output.split(/\r?\n/).includes('OPEN_SCIENCE_INSTALLER_OBSERVER_ACQUIRED'))
                acquired.resolve()
            }
          })
      })
      let processExit: ReturnType<typeof runProcess> | undefined
      try {
        await observer.ready
        processExit = runProcess(
          installer,
          [
            '-e',
            'setInterval(() => { if (require("node:fs").existsSync(process.argv[1])) process.exit(7) }, 20)',
            release
          ],
          {
            allowNonZero: true,
            signal: controller.signal,
            timeoutMs: 15_000
          }
        )
        // Enumerator readiness is not handle acquisition. Release the real process
        // only once the observer owns its handle, including under CI contention.
        await Promise.race([
          acquired.promise,
          observer.exit.then((result) => {
            throw new Error(
              `Observer exited before acquiring the process: ${JSON.stringify(result)}`
            )
          }),
          processExit.then((result) => {
            throw new Error(`Fixture exited before observation: ${JSON.stringify(result)}`)
          })
        ])
        const identity = await observer.acquired
        await expect(inspectInstalledProcess(installer, identity.pid)).resolves.toEqual(identity)
        const otherInstaller = join(root, 'different-installer.exe')
        await copyFile(installer, otherInstaller)
        await expect(inspectInstalledProcess(otherInstaller, identity.pid)).resolves.toBeUndefined()
        await writeFile(release, '')
        await expect(observer.exit).resolves.toMatchObject({ code: 7 })
        await expect(processExit).resolves.toMatchObject({ code: 7 })
      } finally {
        controller.abort()
        await Promise.allSettled([observer.exit, processExit])
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
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
