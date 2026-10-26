import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectSmokeDiagnostics } from './package-smoke-diagnostics.mjs'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./package-smoke-diagnostics.mjs', () => ({ collectSmokeDiagnostics: vi.fn() }))

import {
  authenticatePackagedAppEndpoint,
  artifactVersion,
  assertPackagedResources,
  findAppBundle,
  findArtifact,
  installDmgApp,
  packagedLaunchArguments,
  launchAndProbe,
  parseArguments,
  parsePackagedAppEndpoint
} from './macos-package-smoke.mjs'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('macOS package smoke', () => {
  it('copies the complete DMG app and detaches before returning the installed launch path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dmg-install-'))
    roots.push(root)
    const mount = join(root, 'mounted image')
    const source = join(mount, 'Open Science.app')
    const installed = join(root, 'installed apps', 'Open Science.app')
    await mkdir(source, { recursive: true })
    const run = vi.fn().mockResolvedValue({})
    await expect(
      installDmgApp('signed.dmg', mount, join(root, 'installed apps'), run)
    ).resolves.toBe(installed)
    expect(run.mock.calls).toEqual([
      [
        '/usr/bin/hdiutil',
        ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, 'signed.dmg']
      ],
      ['/usr/bin/ditto', [source, installed]],
      ['/usr/bin/hdiutil', ['detach', '-force', mount]]
    ])
    run
      .mockReset()
      .mockResolvedValue({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('copy failed'))
    await expect(
      installDmgApp('signed.dmg', mount, join(root, 'installed apps'), run)
    ).rejects.toThrow('copy failed')
    expect(run).toHaveBeenLastCalledWith('/usr/bin/hdiutil', ['detach', '-force', mount])
    run.mockReset().mockRejectedValue(new Error('mount failed'))
    await expect(installDmgApp('signed.dmg', mount, root, run)).rejects.toThrow('mount failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('captures the backend log and process state before cleaning up a timed-out launch', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => events.push('kill'))
    })
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    vi.mocked(collectSmokeDiagnostics).mockImplementation(async () => {
      events.push('diagnostics')
      return 'backend startup blocked: diagnostic evidence'
    })
    const probe = launchAndProbe({
      executable: '/fixture/Open-Science',
      expectedVersion: '1.0.0',
      env: { OPEN_SCIENCE_E2E_STORAGE_ROOT: '/isolated' },
      userDataRoot: '/profile'
    })
    const outcome = expect(probe).rejects.toThrow(
      /Timed out[\s\S]*connect-node-runtime[\s\S]*diagnostic evidence/
    )
    child.stdout.write('phase: connect-node-runtime')
    await vi.advanceTimersByTimeAsync(60_000)
    await outcome
    expect(events).toEqual(['diagnostics', 'kill'])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(collectSmokeDiagnostics).toHaveBeenCalledWith({
      configRoot: '/isolated',
      pid: undefined,
      desktop: true
    })
  })

  it('selects one DMG and ZIP and derives their shared version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-macos-artifacts-'))
    roots.push(root)
    const dmg = join(root, 'aipoch-open-science-0.12.0-mac-arm64.dmg')
    const zip = join(root, 'aipoch-open-science-0.12.0-mac-arm64.zip')
    await Promise.all([
      writeFile(dmg, ''),
      writeFile(zip, ''),
      writeFile(join(root, 'latest.yml'), '')
    ])

    await expect(findArtifact(root, 'dmg')).resolves.toBe(dmg)
    await expect(findArtifact(root, 'zip')).resolves.toBe(zip)
    expect(artifactVersion(dmg)).toBe('0.12.0')
    expect(artifactVersion(zip)).toBe('0.12.0')
  })

  it('rejects ambiguous artifacts and app bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-macos-ambiguous-'))
    roots.push(root)
    await Promise.all([
      writeFile(join(root, 'one.dmg'), ''),
      writeFile(join(root, 'two.dmg'), ''),
      mkdir(join(root, 'One.app')),
      mkdir(join(root, 'Two.app'))
    ])

    await expect(findArtifact(root, 'dmg')).rejects.toThrow(/found 2/)
    await expect(findAppBundle(root)).rejects.toThrow(/found 2/)
  })

  it('parses isolated artifact and Gatekeeper options', () => {
    expect(parseArguments(['--artifact-dir', 'dist', '--gatekeeper'])).toEqual({
      artifactDirectory: resolve('dist'),
      gatekeeper: true
    })
    expect(() => parseArguments([])).toThrow(/Usage/)
  })

  it('authenticates the token-free readiness endpoint through the service state contract', async () => {
    const output = 'Open-Science Web: http://127.0.0.1:3210/'
    expect(parsePackagedAppEndpoint(output)).toEqual({ endpoint: 'http://127.0.0.1:3210' })
    await expect(
      authenticatePackagedAppEndpoint(output, ['/config'], {
        readText: async (path: string) =>
          path.endsWith('web-service.json')
            ? JSON.stringify({ port: 3210 })
            : 'macos_smoke_token_12345678901234567890\n'
      })
    ).resolves.toEqual({
      endpoint: 'http://127.0.0.1:3210',
      auth: 'token=macos_smoke_token_12345678901234567890'
    })
    expect(parsePackagedAppEndpoint('not ready')).toBeUndefined()
  })

  it('isolates Electron state without replacing the macOS home directory', () => {
    expect(packagedLaunchArguments('/tmp/open-science-profile')).toEqual([
      '--user-data-dir=/tmp/open-science-profile',
      '--open-science-headless',
      '--serve=0'
    ])
  })

  it('requires the adaptive icon catalog and its legacy ICNS fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-macos-app-'))
    roots.push(root)
    const appBundle = join(root, 'Open-Science.app')
    const executableDirectory = join(appBundle, 'Contents', 'MacOS')
    const resources = join(appBundle, 'Contents', 'Resources')
    const prismaClient = join(resources, 'backend', 'resources', 'prisma-client')
    const processTreeNative = join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@aipoch',
      'process-tree-native',
      'build',
      'Release',
      'process_tree_native.node'
    )
    await Promise.all([
      mkdir(executableDirectory, { recursive: true }),
      mkdir(resources, { recursive: true }),
      mkdir(prismaClient, { recursive: true }),
      mkdir(join(processTreeNative, '..'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(executableDirectory, 'Open-Science'), ''),
      writeFile(join(resources, 'app.asar'), ''),
      writeFile(join(resources, 'backend', 'resources', 'micromamba'), ''),
      writeFile(join(resources, 'Assets.car'), ''),
      writeFile(join(resources, 'icon.icns'), ''),
      writeFile(join(prismaClient, 'libquery_engine-darwin-arm64.dylib.node'), ''),
      writeFile(processTreeNative, '')
    ])

    await expect(assertPackagedResources(appBundle)).resolves.toEqual({
      executable: join(executableDirectory, 'Open-Science'),
      micromamba: join(resources, 'backend', 'resources', 'micromamba'),
      processTreeNative
    })

    await rm(join(resources, 'backend', 'resources', 'micromamba'))
    await writeFile(join(resources, 'micromamba'), 'obsolete duplicate')
    await expect(assertPackagedResources(appBundle)).rejects.toThrow()
    await writeFile(join(resources, 'backend', 'resources', 'micromamba'), '')

    await rm(join(resources, 'Assets.car'))
    await expect(assertPackagedResources(appBundle)).rejects.toThrow()

    await writeFile(join(resources, 'Assets.car'), '')
    await writeFile(join(prismaClient, 'libquery_engine-darwin.dylib.node'), '')
    await expect(assertPackagedResources(appBundle)).rejects.toThrow(/exactly one Prisma engine/)
    await rm(join(prismaClient, 'libquery_engine-darwin.dylib.node'))
    await rm(join(prismaClient, 'libquery_engine-darwin-arm64.dylib.node'))
    await expect(assertPackagedResources(appBundle)).rejects.toThrow(/Prisma engine/)
  })
})
