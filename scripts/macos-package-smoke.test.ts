import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  authenticatePackagedAppEndpoint,
  artifactVersion,
  assertPackagedResources,
  findAppBundle,
  findArtifact,
  launchAndProbe,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint
} from './macos-package-smoke.mjs'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('macOS package smoke', () => {
  it('includes startup diagnostics when the app remains alive without becoming ready', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() })
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    const probe = launchAndProbe({
      executable: '/package/Open-Science',
      expectedVersion: '0.31.0',
      env: {},
      userDataRoot: '/profile'
    })
    child.stderr.write('credential-identity: initialization-probe-access-blocked')
    const failure = expect(probe).rejects.toThrow(
      /Timed out.*\ncredential-identity: initialization-probe-access-blocked/
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await failure
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.stderr.destroy()
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
    const prismaClient = join(resources, 'node_modules', '.prisma', 'client')
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
      writeFile(join(resources, 'micromamba'), ''),
      writeFile(join(resources, 'Assets.car'), ''),
      writeFile(join(resources, 'icon.icns'), ''),
      writeFile(join(prismaClient, 'libquery_engine-darwin-arm64.dylib.node'), ''),
      writeFile(processTreeNative, '')
    ])

    await expect(assertPackagedResources(appBundle)).resolves.toEqual({
      executable: join(executableDirectory, 'Open-Science'),
      micromamba: join(resources, 'micromamba'),
      processTreeNative
    })

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
