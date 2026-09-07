import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { WSL2_BASH_PREVIEW_MANIFEST } from '../src/shared/wsl2-preview-manifest'

import {
  assertPackagedResources,
  assertDatabaseDowngradeBlocked,
  authenticatePackagedAppEndpoint,
  assertUpgradeProfilePreserved,
  assertWsl2RestartCleanupBlocked,
  buildSmokePlan,
  cleanupOwnedSmokeRegistrations,
  cleanupSmokeRegistrations,
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  createWslCommandTempEvidence,
  executeSmokePlan,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  launchUninstallerLockHolder,
  observeChildClose,
  packagedArtifactSmokeRpcResult,
  packagedMainEntryPath,
  packagedResourcePaths,
  parseArguments,
  parsePackagedAppEndpoint,
  readPackagedAppConfigRoot,
  releasedMigrationCountForPhase,
  requestPackagedAppShutdown,
  removeWslCommandTempEvidence,
  runProcess,
  terminateDirectoryProcesses,
  terminateProcessTree,
  waitForShutdownExit,
  windowsProfileEnvironment,
  writeUpgradeSentinel
} from './windows-installer-smoke.mjs'

describe('Windows installer smoke plan', () => {
  it('selects one setup executable and rejects ambiguous artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-installer-artifacts-'))
    await writeFile(join(root, 'portable.zip'), '')
    await writeFile(join(root, 'aipoch-open-science-0.8.0-win-x64-setup.exe'), '')

    await expect(findSetupInstaller(root)).resolves.toBe(
      join(root, 'aipoch-open-science-0.8.0-win-x64-setup.exe')
    )

    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'aipoch-open-science-0.9.0-win-x64-setup.exe'), '')
    await expect(findSetupInstaller(root)).rejects.toThrow(/exactly one Windows setup executable/)
  })

  it('force-kills leftover processes whose executable still lives under the install directory', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })

    await terminateDirectoryProcesses('D:\\installed app 程序\\', run)

    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$root = $args[0]; Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        'D:\\installed app 程序\\'
      ],
      { allowNonZero: true }
    )
  })

  it('derives the packaged version from stable and nightly installer names', () => {
    expect(installerVersion('aipoch-open-science-0.8.0-win-x64-setup.exe')).toBe('0.8.0')
    expect(installerVersion('aipoch-open-science-0.8.0-nightly.abc1234-win-x64-setup.exe')).toBe(
      '0.8.0-nightly.abc1234'
    )
  })

  it('parses an optional positive released migration count', () => {
    expect(parseArguments(['--installer-dir', 'dist'])).toMatchObject({
      artifactRpcContract: 'reservation',
      expectedMigrationCount: undefined,
      retainInstallation: false
    })
    expect(parseArguments(['--installer-dir', 'dist', '--retain-installation'])).toMatchObject({
      retainInstallation: true
    })
    expect(
      parseArguments([
        '--installer-dir',
        'dist',
        '--previous-installer-dir',
        'previous',
        '--expected-migration-count',
        '4'
      ]).expectedMigrationCount
    ).toBe(4)
    for (const value of [
      undefined,
      '0',
      '-1',
      '1.5',
      'not-a-number',
      String(Number.MAX_SAFE_INTEGER + 1)
    ]) {
      expect(() =>
        parseArguments([
          '--installer-dir',
          'dist',
          '--expected-migration-count',
          ...(value === undefined ? [] : [value])
        ])
      ).toThrow(/migration count must be a positive/)
    }
  })

  it('accepts only the orphaned-uninstaller lock scenario', () => {
    expect(
      parseArguments(['--installer-dir', 'dist', '--scenario', 'orphaned-uninstaller-lock'])
        .scenario
    ).toBe('orphaned-uninstaller-lock')
    expect(() => parseArguments(['--installer-dir', 'dist', '--scenario', 'unsupported'])).toThrow(
      /Unsupported Windows installer smoke scenario/
    )
  })

  it('accepts a complete packaged WSL2 restart certification profile only', () => {
    expect(
      parseArguments([
        '--installer-dir',
        'dist',
        '--wsl-certification-distro',
        'Ubuntu-22.04',
        '--wsl-certification-user',
        'researcher'
      ])
    ).toMatchObject({
      wslCertificationProfile: {
        profileId: 'packaged-preview-v1',
        distro: 'Ubuntu-22.04',
        user: 'researcher'
      }
    })
    expect(() =>
      parseArguments(['--installer-dir', 'dist', '--wsl-certification-distro', 'Ubuntu-22.04'])
    ).toThrow(/must be provided together/)
  })

  it('creates exact valid and malformed command-temp ownership evidence', async () => {
    const ownerRoot = await mkdtemp(join(tmpdir(), 'open-science-wsl-restart-evidence-'))
    const profile = {
      profileId: 'packaged-preview-v1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    }
    const valid = await createWslCommandTempEvidence({ ownerRoot, profile, malformed: false })
    expect(await readFile(valid.receipt, 'utf8')).toBe(
      `v1 command-${valid.id} wsl2 packaged-preview-v1 Ubuntu-22.04 researcher\n`
    )
    expect(await readFile(join(valid.root, 'left-by-prior-process'), 'utf8')).toBe('certification')

    const malformed = await createWslCommandTempEvidence({
      ownerRoot,
      profile,
      malformed: true
    })
    expect(await readFile(malformed.receipt, 'utf8')).toContain('malformed')

    await removeWslCommandTempEvidence(valid)
    await removeWslCommandTempEvidence(malformed)
    await rm(ownerRoot, { recursive: true, force: true })
  })

  it('accepts malformed receipt startup only when the packaged app fails closed', () => {
    expect(() =>
      assertWsl2RestartCleanupBlocked({
        becameHealthy: false,
        output:
          'notebook-network-sandbox-initialize completed\nsandbox process preparation failed\napplication startup failed'
      })
    ).not.toThrow()
    expect(() =>
      assertWsl2RestartCleanupBlocked({ becameHealthy: true, output: 'healthy' })
    ).toThrow(/unexpectedly became healthy/)
    expect(() =>
      assertWsl2RestartCleanupBlocked({ becameHealthy: false, output: 'unrelated failure' })
    ).toThrow(/sandbox preparation/)
  })

  it('accepts only explicit packaged Artifact RPC contracts', () => {
    expect(
      parseArguments(['--installer-dir', 'dist', '--artifact-rpc-contract', 'legacy'])
        .artifactRpcContract
    ).toBe('legacy')
    for (const value of [undefined, 'automatic']) {
      expect(() =>
        parseArguments([
          '--installer-dir',
          'dist',
          '--artifact-rpc-contract',
          ...(value === undefined ? [] : [value])
        ])
      ).toThrow(/Artifact RPC contract must be legacy or reservation/)
    }
  })

  it('models the packaged Artifact reservation, Version, and release RPC contract', () => {
    const workspace = 'C:\\smoke\\workspace'
    const fileBytes = Buffer.byteLength('windows-rpc-smoke\n')
    const checksum = createHash('sha256').update('windows-rpc-smoke\n').digest('hex')
    const artifactScope = {
      projectId: 'installer-smoke-project',
      appSessionId: 'installer-smoke-session',
      artifactStorageSessionId: 'installer-smoke-session',
      artifactRunId: 'installer-smoke-artifact-run'
    }
    const writeOperationId = `artifact-write-${'a'.repeat(64)}`
    const reservation = packagedArtifactSmokeRpcResult(
      {
        method: 'artifactReserveWrite',
        params: {
          ...artifactScope,
          writeOperationId,
          filename: 'windows-rpc-smoke.txt',
          fileBytes
        }
      },
      workspace
    )
    expect(reservation).toMatchObject({
      id: 'installer-smoke-reservation',
      fileBytes,
      expiresAt: expect.any(Number)
    })

    const version = packagedArtifactSmokeRpcResult(
      {
        method: 'artifactCreateVersion',
        params: {
          ...artifactScope,
          writeOperationId,
          resourceReservationId: reservation.id,
          resourceSizeBytes: fileBytes,
          resourceChecksum: checksum
        }
      },
      workspace
    )
    expect(version).toMatchObject({
      versionId: 'installer-smoke-version',
      path: join(workspace, 'windows-rpc-smoke.txt'),
      size: fileBytes
    })
    expect(
      packagedArtifactSmokeRpcResult(
        {
          method: 'artifactReleaseWrite',
          params: { ...artifactScope, reservationId: reservation.id }
        },
        workspace
      )
    ).toEqual({ released: true })
    expect(() =>
      packagedArtifactSmokeRpcResult(
        {
          method: 'artifactCreateVersion',
          params: {
            ...artifactScope,
            writeOperationId,
            resourceReservationId: 'wrong-reservation',
            resourceSizeBytes: fileBytes,
            resourceChecksum: checksum
          }
        },
        workspace
      )
    ).toThrow(/reservation metadata/)
    expect(() =>
      packagedArtifactSmokeRpcResult(
        {
          method: 'artifactReserveWrite',
          params: {
            ...artifactScope,
            appSessionId: 'wrong-session',
            writeOperationId,
            filename: 'windows-rpc-smoke.txt',
            fileBytes
          }
        },
        workspace
      )
    ).toThrow(/write scope/)
  })

  it('supports the released legacy Artifact contract without weakening reservation enforcement', () => {
    const workspace = 'C:\\smoke\\workspace'
    const legacyRequest = {
      method: 'artifactCreateVersion',
      params: {
        projectId: 'installer-smoke-project',
        appSessionId: 'installer-smoke-session',
        artifactStorageSessionId: 'installer-smoke-session',
        artifactRunId: 'installer-smoke-artifact-run',
        writeOperationId: `artifact-write-${'a'.repeat(64)}`
      }
    }

    expect(packagedArtifactSmokeRpcResult(legacyRequest, workspace, 'legacy')).toMatchObject({
      versionId: 'installer-smoke-version',
      path: join(workspace, 'windows-rpc-smoke.txt')
    })
    expect(() => packagedArtifactSmokeRpcResult(legacyRequest, workspace, 'reservation')).toThrow(
      /reservation metadata/
    )
    expect(() =>
      packagedArtifactSmokeRpcResult(
        {
          ...legacyRequest,
          params: {
            ...legacyRequest.params,
            resourceReservationId: 'partial-reservation'
          }
        },
        workspace,
        'legacy'
      )
    ).toThrow(/must omit reservation metadata/)
  })

  it('uses the released migration prefix only for current-version launch phases', () => {
    expect(
      ['previous', 'current', 'rollback', 'restart'].map((phase) =>
        releasedMigrationCountForPhase(phase, 4)
      )
    ).toEqual([undefined, 4, undefined, 4])
  })

  it('restarts current before rollback and restores current after the rollback drill', async () => {
    const plan = buildSmokePlan({
      currentInstaller: 'current.exe',
      previousInstaller: 'previous.exe'
    })
    const runCycle = vi.fn().mockResolvedValue(undefined)

    await executeSmokePlan(plan, runCycle)

    expect(runCycle.mock.calls).toEqual([
      [{ installer: 'previous.exe', phase: 'previous' }],
      [{ installer: 'current.exe', phase: 'current', runningInstaller: 'previous.exe' }],
      [{ installer: 'current.exe', phase: 'restart', reuseInstallation: true }],
      [
        {
          installer: 'previous.exe',
          phase: 'rollback',
          runningInstaller: 'current.exe',
          launchInstalledApp: false
        }
      ],
      [{ installer: 'current.exe', phase: 'current' }]
    ])
  })

  it('installs, initializes, redetects, and restarts a current-only packaged app', () => {
    expect(
      buildSmokePlan({ currentInstaller: 'current.exe', previousInstaller: undefined })
    ).toEqual([
      { installer: 'current.exe', phase: 'current' },
      { installer: 'current.exe', phase: 'restart', reuseInstallation: true }
    ])
  })

  it('aborts an unresponsive installed-app health request', async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )

    await expect(
      fetchWithTimeout('http://127.0.0.1/health', {}, 5, fetchImpl)
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('drains the shutdown response before waiting for the packaged app to exit', async () => {
    const text = vi.fn().mockResolvedValue('{"ok":true}')
    const fetchImpl = vi.fn().mockResolvedValue({ status: 202, text })

    await expect(
      requestPackagedAppShutdown('http://127.0.0.1:44100', 'token=test', fetchImpl)
    ).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:44100/api/shutdown?token=test', {
      method: 'POST'
    })
    expect(text).toHaveBeenCalledOnce()
  })

  it('authenticates token-free readiness through state while accepting legacy token output', async () => {
    const output = 'Open Science Web: http://127.0.0.1:52378/'
    expect(parsePackagedAppEndpoint(output)).toEqual({
      endpoint: 'http://127.0.0.1:52378'
    })
    await expect(
      authenticatePackagedAppEndpoint(output, ['C:\\profile\\.open-science'], {
        readText: async (path: string) =>
          path.endsWith('web-service.json')
            ? JSON.stringify({ port: 52378 })
            : 'windows_smoke_token_12345678901234567890\n'
      })
    ).resolves.toEqual({
      auth: 'token=windows_smoke_token_12345678901234567890',
      endpoint: 'http://127.0.0.1:52378'
    })

    const legacyOutput = `
[main] app starting
Open Science Web: http://127.0.0.1:52378/?token=iUFHGSACwBz2k1kSJfPixHbclDywVg0CrcdTs42uvLE
`
    const legacyService = {
      auth: 'token=iUFHGSACwBz2k1kSJfPixHbclDywVg0CrcdTs42uvLE',
      endpoint: 'http://127.0.0.1:52378'
    }
    expect(parsePackagedAppEndpoint(legacyOutput)).toEqual(legacyService)
    await expect(authenticatePackagedAppEndpoint(legacyOutput)).resolves.toEqual(legacyService)
    expect(parsePackagedAppEndpoint('[main] app starting')).toBeUndefined()
  })

  it('accepts a blocked database downgrade regardless of process exit status', () => {
    expect(
      assertDatabaseDowngradeBlocked({
        becameHealthy: false,
        output: '[main] database_newer_than_app'
      })
    ).toBeUndefined()
  })

  it('rejects a database downgrade that became healthy', () => {
    expect(() =>
      assertDatabaseDowngradeBlocked({
        becameHealthy: true,
        output: '[main] database_newer_than_app'
      })
    ).toThrow(/unexpectedly became healthy/)
  })

  it('requires a compatibility diagnostic for a blocked database downgrade', () => {
    expect(() =>
      assertDatabaseDowngradeBlocked({
        becameHealthy: false,
        output: '[main] app exited'
      })
    ).toThrow(/expected compatibility error/)
  })

  it('accepts only a packaged bootstrap that reports an absolute Windows config root', async () => {
    const configRoot = 'C:\\Users\\runneradmin\\.open-science'
    await expect(
      readPackagedAppConfigRoot(
        {
          appName: 'Open Science',
          appVersion: '0.8.0',
          configRoot,
          platform: 'win32'
        },
        '0.8.0'
      )
    ).resolves.toBe(configRoot)
    await expect(
      readPackagedAppConfigRoot(
        { appName: 'Open Science', appVersion: '0.8.0', platform: 'win32' },
        '0.8.0'
      )
    ).rejects.toThrow(/config root/)
  })

  it('authenticates whichever legacy config-root candidate the previous app actually used', async () => {
    const runnerConfigRoot = 'C:\\Users\\runneradmin\\.open-science'
    const isolatedConfigRoot = 'D:\\smoke\\profile\\.open-science'
    const readToken = vi.fn(async (path: string) => {
      if (path === `${isolatedConfigRoot}\\web-token`) return 'legacy-token\n'
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })

    await expect(
      readPackagedAppConfigRoot(
        { appName: 'Open Science', appVersion: '0.7.0', platform: 'win32' },
        '0.7.0',
        {
          auth: 'token=legacy-token',
          legacyConfigRoots: [runnerConfigRoot, isolatedConfigRoot],
          readToken
        }
      )
    ).resolves.toBe(isolatedConfigRoot)
    expect(readToken.mock.calls).toEqual([
      [`${runnerConfigRoot}\\web-token`, 'utf8'],
      [`${isolatedConfigRoot}\\web-token`, 'utf8']
    ])
  })

  it('waits for child stdio close after exit before evaluating downgrade output', async () => {
    const child = new EventEmitter()
    let output = ''
    const close = observeChildClose(child)
    let closed = false
    void close.then(() => {
      closed = true
    })

    child.emit('exit', 0)
    output += '[main] database_newer_than_app'
    await Promise.resolve()
    expect(closed).toBe(false)

    child.emit('close', 0)
    await expect(close).resolves.toBe(0)
    expect(output).toContain('database_newer_than_app')
  })

  it('gives shutdown its own timeout budget after startup completes', async () => {
    vi.useFakeTimers()
    const terminate = vi.fn().mockResolvedValue(undefined)
    const exit = new Promise<number>(() => undefined)

    const result = waitForShutdownExit(exit, {}, () => 'still running', 60_000, terminate)
    const assertion = expect(result).rejects.toThrow(
      'Installed app did not exit after shutdown.\nstill running'
    )

    await vi.advanceTimersByTimeAsync(59_999)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(terminate).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('settles process-tree termination when taskkill never exits', async () => {
    vi.useFakeTimers()
    const terminator = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      unref: vi.fn()
    })
    const spawnProcess = vi.fn(() => terminator)
    const child = { pid: 4242, kill: vi.fn() }

    const termination = terminateProcessTree(child, 10, spawnProcess)
    const assertion = expect(termination).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(9)
    expect(terminator.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(terminator.kill).toHaveBeenCalledOnce()
    expect(terminator.unref).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('rejects a timed-out process even when non-zero exits are otherwise allowed', async () => {
    const terminateSlowly = async (child: { kill: () => unknown }): Promise<void> => {
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await expect(
      runProcess(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1_000)'],
        {
          allowNonZero: true,
          timeoutMs: 25
        },
        terminateSlowly
      )
    ).rejects.toThrow(/timed out after 25ms/)
  })

  it('terminates a lock holder when readiness fails', async () => {
    const installDirectory = await mkdtemp(join(tmpdir(), 'open-science-lock-holder-'))
    await writeFile(join(installDirectory, 'Uninstall open-science.exe'), '')
    const child = Object.assign(new EventEmitter(), { pid: 4242 })
    const spawnProcess = vi.fn(() => child)
    const waitForReady = vi.fn().mockRejectedValue(new Error('lock readiness failed'))
    const terminate = vi.fn().mockResolvedValue(undefined)

    await expect(
      launchUninstallerLockHolder(
        installDirectory,
        { TEMP: installDirectory },
        spawnProcess,
        waitForReady,
        terminate
      )
    ).rejects.toThrow('lock readiness failed')
    expect(terminate).toHaveBeenCalledWith(child)
  })

  it('terminates and awaits an aborted process', async () => {
    const controller = new AbortController()
    let finishTermination: (() => void) | undefined
    const termination = new Promise<void>((resolve) => {
      finishTermination = resolve
    })
    const terminate = vi.fn(async (child: { kill: () => unknown }): Promise<void> => {
      await termination
      child.kill()
    })
    const result = runProcess(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      { signal: controller.signal, timeoutMs: 60_000 },
      terminate
    )

    controller.abort(new Error('installer watcher cancelled'))
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce())
    await expect(
      Promise.race([
        result.then(
          () => 'settled',
          () => 'settled'
        ),
        Promise.resolve('pending')
      ])
    ).resolves.toBe('pending')

    finishTermination?.()
    await expect(result).rejects.toThrow('installer watcher cancelled')
  })

  it('writes and verifies the upgrade sentinel in the app-reported config root', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'open-science-upgrade-profile-'))
    const configRoot = join(profile, '.open-science')
    const sentinelName = 'installer-smoke-upgrade-sentinel-test'

    await writeUpgradeSentinel(configRoot, sentinelName)
    await expect(readFile(join(configRoot, sentinelName), 'utf8')).resolves.toBe(
      'previous-version-profile-preserved\n'
    )
    await expect(assertUpgradeProfilePreserved(configRoot, sentinelName)).resolves.toBeUndefined()

    await writeFile(join(configRoot, sentinelName), 'reset')
    await expect(assertUpgradeProfilePreserved(configRoot, sentinelName)).rejects.toThrow(
      /did not preserve/
    )
  })

  it('rejects an upgrade that starts the current app with a different config root', async () => {
    const previousConfigRoot = await mkdtemp(join(tmpdir(), 'open-science-previous-config-'))
    const currentConfigRoot = await mkdtemp(join(tmpdir(), 'open-science-current-config-'))
    const guard = createUpgradeProfileGuard(true, 'installer-smoke-upgrade-sentinel-root-change')

    await guard.verifyCycle('previous', previousConfigRoot)
    await expect(guard.verifyCycle('current', currentConfigRoot)).rejects.toThrow(
      /config root changed/
    )
    await guard.cleanup()
  })

  it('removes the upgrade sentinel during cleanup after the current app preserves it', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-upgrade-config-'))
    const sentinelName = 'installer-smoke-upgrade-sentinel-cleanup'
    const guard = createUpgradeProfileGuard(true, sentinelName)

    await guard.verifyCycle('previous', configRoot)
    await guard.verifyCycle('current', configRoot)
    await expect(readFile(join(configRoot, sentinelName), 'utf8')).resolves.toBe(
      'previous-version-profile-preserved\n'
    )
    await guard.cleanup()

    await expect(readFile(join(configRoot, sentinelName), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('requires a blocked downgrade when current added a migration unknown to previous', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-ledger-aware-upgrade-'))
    const readLedger = vi
      .fn()
      .mockResolvedValueOnce([{ id: '0001_runtime_schema_baseline' }])
      .mockResolvedValueOnce([{ id: '0001_runtime_schema_baseline' }, { id: '0002_future_schema' }])
    const guard = createUpgradeProfileGuard(
      true,
      'installer-smoke-ledger-aware-upgrade',
      readLedger
    )

    await guard.verifyCycle('previous', configRoot)
    expect(guard.shouldExpectDowngradeBlock()).toBe(false)
    await guard.verifyCycle('current', configRoot)
    expect(guard.shouldExpectDowngradeBlock()).toBe(true)
    await guard.cleanup()
  })

  it('never overwrites or removes a pre-existing upgrade sentinel collision', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'open-science-upgrade-collision-'))
    const sentinelName = 'installer-smoke-upgrade-sentinel-collision'
    const sentinelPath = join(configRoot, sentinelName)
    const guard = createUpgradeProfileGuard(true, sentinelName)
    await writeFile(sentinelPath, 'pre-existing')

    await expect(guard.verifyCycle('previous', configRoot)).rejects.toMatchObject({
      code: 'EEXIST'
    })
    await guard.cleanup()
    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('pre-existing')
  })

  it('tracks multiple packaged resources for uninstall verification', () => {
    const installDirectory = join('smoke', 'app')
    expect(packagedResourcePaths(installDirectory)).toEqual([
      join(installDirectory, 'open-science.exe'),
      join(installDirectory, 'resources', 'app.asar'),
      join(installDirectory, 'resources', 'micromamba.exe'),
      join(installDirectory, 'resources', 'notebook-network-sandbox', 'wsl2', 'manifest.json'),
      join(
        installDirectory,
        'resources',
        'node_modules',
        '.prisma',
        'client',
        'query_engine-windows.dll.node'
      )
    ])
  })

  it('requires exactly one native Windows Prisma engine', async () => {
    const installDirectory = await mkdtemp(join(tmpdir(), 'open-science-windows-engine-'))
    const resources = join(installDirectory, 'resources')
    const prismaClient = join(resources, 'node_modules', '.prisma', 'client')
    await mkdir(prismaClient, { recursive: true })
    await Promise.all([
      writeFile(join(installDirectory, 'open-science.exe'), ''),
      writeFile(join(resources, 'app.asar'), ''),
      writeFile(join(resources, 'micromamba.exe'), ''),
      mkdir(join(resources, 'notebook-network-sandbox', 'wsl2'), { recursive: true }).then(() =>
        writeFile(
          join(resources, 'notebook-network-sandbox', 'wsl2', 'manifest.json'),
          JSON.stringify(WSL2_BASH_PREVIEW_MANIFEST)
        )
      ),
      writeFile(join(prismaClient, 'query_engine-windows.dll.node'), '')
    ])

    await expect(assertPackagedResources(installDirectory)).resolves.toBeUndefined()
    await writeFile(
      join(resources, 'notebook-network-sandbox', 'wsl2', 'manifest.json'),
      JSON.stringify({
        ...WSL2_BASH_PREVIEW_MANIFEST,
        assets: [...WSL2_BASH_PREVIEW_MANIFEST.assets, 'uncertified-extra']
      })
    )
    await expect(assertPackagedResources(installDirectory)).rejects.toThrow(
      /missing or version-mismatched/
    )
    await rm(join(resources, 'notebook-network-sandbox'), { recursive: true, force: true })
    await expect(
      assertPackagedResources(installDirectory, { certifyWslPreview: false })
    ).resolves.toBeUndefined()
    await mkdir(join(resources, 'notebook-network-sandbox', 'wsl2'), { recursive: true })
    await writeFile(
      join(resources, 'notebook-network-sandbox', 'wsl2', 'manifest.json'),
      JSON.stringify(WSL2_BASH_PREVIEW_MANIFEST)
    )
    await writeFile(join(prismaClient, 'libquery_engine-debian-openssl-3.0.x.so.node'), '')
    await expect(assertPackagedResources(installDirectory)).rejects.toThrow(
      /exactly one Prisma engine/
    )
  })

  it('targets the bundled main entry for packaged MCP subprocesses', () => {
    expect(packagedMainEntryPath(join('smoke', 'app'))).toBe(
      join('smoke', 'app', 'resources', 'app.asar', 'out', 'main', 'index.js')
    )
  })

  it('builds an isolated profile environment for smoke child processes', () => {
    const profileDirectory = join('smoke', 'profile')

    expect(windowsProfileEnvironment(profileDirectory, { SystemRoot: 'C:\\Windows' })).toEqual({
      SystemRoot: 'C:\\Windows',
      HOME: profileDirectory,
      USERPROFILE: profileDirectory,
      APPDATA: join(profileDirectory, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(profileDirectory, 'AppData', 'Local'),
      TEMP: join(profileDirectory, 'Temp'),
      TMP: join(profileDirectory, 'Temp')
    })
  })

  it('preserves the primary smoke failure when cleanup also fails', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('locked DLL'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      cleanupSmokeRoot('safe-smoke-root', new Error('startup failed'), remove)
    ).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('locked DLL'))
    await expect(cleanupSmokeRoot('safe-smoke-root', undefined, remove)).rejects.toThrow(
      'locked DLL'
    )

    warning.mockRestore()
  })

  it('removes only stale registrations owned by the exact failed smoke root', async () => {
    const root = 'C:\\Temp\\open-science-installer-smoke-owned'
    const uninstall = join(root, 'installed app 程序', 'Uninstall open-science.exe')
    const install = join(root, 'installed app 程序')
    const run = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'delete') return { code: 0, stdout: '', stderr: '' }
      const output = args[1].includes('CurrentVersion')
        ? `DisplayName    REG_SZ    Open Science\r\nDisplayVersion    REG_SZ    0.25.1\r\nInstallLocation    REG_SZ    ${install}\r\nUninstallString    REG_SZ    "${uninstall}"\r\nQuietUninstallString    REG_SZ    "${uninstall}" /S\r\n`
        : `InstallLocation    REG_SZ    ${install}\r\n`
      return { code: 0, stdout: output, stderr: '' }
    })

    await cleanupOwnedSmokeRegistrations(root, '0.25.1', { run })

    expect(run.mock.calls.filter(([, args]) => args[0] === 'delete')).toEqual([
      [
        'reg.exe',
        [
          'delete',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a65c5229-0b29-5716-a0fe-d8755e62f3ca',
          '/f'
        ]
      ],
      ['reg.exe', ['delete', 'HKCU\\Software\\a65c5229-0b29-5716-a0fe-d8755e62f3ca', '/f']]
    ])
  })

  it('preserves unrelated installer registrations', async () => {
    const root = 'C:\\Temp\\open-science-installer-smoke-owned'
    const unrelated = 'C:\\Program Files\\Open Science\\Uninstall open-science.exe'
    const run = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'delete') throw new Error('unrelated registration was deleted')
      const output = args[1].includes('CurrentVersion')
        ? `DisplayName    REG_SZ    Open Science\r\nDisplayVersion    REG_SZ    0.25.1\r\nInstallLocation    REG_SZ    \r\nUninstallString    REG_SZ    "${unrelated}"\r\nQuietUninstallString    REG_SZ    "${unrelated}" /S\r\n`
        : 'InstallLocation    REG_SZ    C:\\Program Files\\Open Science\r\n'
      return { code: 0, stdout: output, stderr: '' }
    })

    await cleanupOwnedSmokeRegistrations(root, '0.25.1', { run })

    expect(run.mock.calls.filter(([, args]) => args[0] === 'delete')).toEqual([])
  })

  it('removes the observed owned uninstall registration with an empty install location', async () => {
    const root = 'C:\\Temp\\open-science-installer-smoke-owned'
    const uninstall = join(root, 'installed app 程序', 'Uninstall open-science.exe')
    const run = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'delete') return { code: 0, stdout: '', stderr: '' }
      if (!args[1].includes('CurrentVersion')) return { code: 1, stdout: '', stderr: '' }
      return {
        code: 0,
        stdout: `DisplayName    REG_SZ    Open Science\r\nDisplayVersion    REG_SZ    0.25.1\r\nInstallLocation    REG_SZ    \r\nUninstallString    REG_SZ    "${uninstall}"\r\nQuietUninstallString    REG_SZ    "${uninstall}" /S\r\n`,
        stderr: ''
      }
    })

    await cleanupOwnedSmokeRegistrations(root, '0.25.1', { run })

    expect(run.mock.calls.filter(([, args]) => args[0] === 'delete')).toEqual([
      [
        'reg.exe',
        [
          'delete',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a65c5229-0b29-5716-a0fe-d8755e62f3ca',
          '/f'
        ]
      ]
    ])
  })

  it('preserves an incomplete registration even when one path is under the smoke root', async () => {
    const root = 'C:\\Temp\\open-science-installer-smoke-owned'
    const uninstall = join(root, 'installed app 程序', 'Uninstall open-science.exe')
    const run = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'delete') throw new Error('incomplete registration was deleted')
      if (!args[1].includes('CurrentVersion')) return { code: 1, stdout: '', stderr: '' }
      return {
        code: 0,
        stdout: `DisplayName    REG_SZ    Open Science\r\nDisplayVersion    REG_SZ    0.25.1\r\nInstallLocation    REG_SZ    \r\nUninstallString    REG_SZ    "${uninstall}"\r\n`,
        stderr: ''
      }
    })

    await cleanupOwnedSmokeRegistrations(root, '0.25.1', { run })

    expect(run.mock.calls.filter(([, args]) => args[0] === 'delete')).toEqual([])
  })

  it('preserves the primary smoke failure when registration cleanup also fails', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('registry unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      cleanupSmokeRegistrations('safe-smoke-root', '0.25.1', new Error('startup failed'), cleanup)
    ).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('registry unavailable'))
    await expect(
      cleanupSmokeRegistrations('safe-smoke-root', '0.25.1', undefined, cleanup)
    ).rejects.toThrow('registry unavailable')

    warning.mockRestore()
  })

  it('rejects registration cleanup outside a generated installer smoke root', async () => {
    const run = vi.fn()

    await expect(
      cleanupOwnedSmokeRegistrations('C:\\Temp\\unrelated', '0.25.1', { run })
    ).rejects.toThrow('unexpected smoke root')
    expect(run).not.toHaveBeenCalled()
  })
})
