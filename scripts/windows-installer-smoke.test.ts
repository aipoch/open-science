import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  assertUpgradeProfilePreserved,
  buildSmokePlan,
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  executeSmokePlan,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  packagedResourcePaths,
  parsePackagedAppEndpoint,
  readPackagedAppConfigRoot,
  requestPackagedAppShutdown,
  runProcess,
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
    await writeFile(join(root, 'aipoch-open-science-0.8.1-win-x64-setup.exe'), '')
    await expect(findSetupInstaller(root)).rejects.toThrow(/exactly one Windows setup executable/)
  })

  it('derives the packaged version from stable and nightly installer names', () => {
    expect(installerVersion('aipoch-open-science-0.8.0-win-x64-setup.exe')).toBe('0.8.0')
    expect(installerVersion('aipoch-open-science-0.8.0-nightly.abc1234-win-x64-setup.exe')).toBe(
      '0.8.0-nightly.abc1234'
    )
  })

  it('checks the previous version before the current version in one install location', async () => {
    const plan = buildSmokePlan({
      currentInstaller: 'current.exe',
      previousInstaller: 'previous.exe'
    })
    const runCycle = vi.fn().mockResolvedValue(undefined)

    await executeSmokePlan(plan, runCycle)

    expect(runCycle.mock.calls).toEqual([
      [{ installer: 'previous.exe', phase: 'previous' }],
      [{ installer: 'current.exe', phase: 'current' }]
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

  it('discovers the authenticated service endpoint from packaged app output', () => {
    expect(
      parsePackagedAppEndpoint(`
[main] app starting
Open Science Web: http://127.0.0.1:52378/?token=iUFHGSACwBz2k1kSJfPixHbclDywVg0CrcdTs42uvLE
`)
    ).toEqual({
      auth: 'token=iUFHGSACwBz2k1kSJfPixHbclDywVg0CrcdTs42uvLE',
      endpoint: 'http://127.0.0.1:52378'
    })
    expect(parsePackagedAppEndpoint('[main] app starting')).toBeUndefined()
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
})
