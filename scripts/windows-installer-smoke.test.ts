import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  assertUpgradeProfilePreserved,
  buildSmokePlan,
  executeSmokePlan,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  packagedResourcePaths,
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
})
