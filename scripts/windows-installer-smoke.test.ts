import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  assertUpgradeProfilePreserved,
  buildSmokePlan,
  cleanupSmokeRoot,
  executeSmokePlan,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  packagedResourcePaths,
  parsePackagedAppEndpoint,
  requestPackagedAppShutdown,
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

  it('detects when an upgrade removes the previous profile', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'open-science-upgrade-profile-'))

    await writeUpgradeSentinel(profile)
    await expect(assertUpgradeProfilePreserved(profile)).resolves.toBeUndefined()

    await writeFile(join(profile, '.open-science', 'installer-smoke-upgrade-sentinel'), 'reset')
    await expect(assertUpgradeProfilePreserved(profile)).rejects.toThrow(/did not preserve/)
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

  it('uses one isolated Windows profile for installers and the packaged app', () => {
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
