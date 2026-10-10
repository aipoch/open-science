import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

import {
  authenticatePackagedAppEndpoint,
  appImageVersion,
  assertPackagedResources,
  findOne,
  launchAndProbe,
  packagedResourcePaths,
  parseArguments,
  parsePackagedAppEndpoint
} from './linux-package-smoke.mjs'

describe('Linux package smoke', () => {
  it.each([null, 'SIGABRT'] as const)(
    'probes the bundled Node backend and requires a clean shutdown (signal: %s)',
    async (signal) => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'linux-smoke-launch-'))
      roots.push(root)
      const token = 'linux_smoke_token_12345678901234567890'
      await writeFile(join(root, 'web-service.json'), JSON.stringify({ port: 44001 }))
      await writeFile(join(root, 'web-token'), token)
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn()
      })
      vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              appName: 'Open-Science',
              appVersion: '0.36.0',
              platform: 'linux'
            })
          )
        )
        .mockImplementationOnce(async () => {
          child.emit('exit', signal ? null : 0, signal)
          return new Response('', { status: 202 })
        })
      vi.stubGlobal('fetch', fetch)
      const resourceRoot = join(root, 'installed app 数据', 'resources')
      const env = { OPEN_SCIENCE_E2E_STORAGE_ROOT: root }
      const probe = launchAndProbe({ resourceRoot, expectedVersion: '0.36.0', env })
      const outcome = signal
        ? expect(probe).rejects.toThrow('exited with SIGABRT')
        : expect(probe).resolves.toBe('3.46.0')
      child.stdout.write(
        'Open-Science Web: http://127.0.0.1:44001/\n' +
          '[main] database runtime verified: sqlite_version=3.46.0\n'
      )
      await vi.advanceTimersByTimeAsync(250)
      await outcome
      expect(spawn).toHaveBeenCalledWith(
        join(resourceRoot, 'node-runtime', 'node'),
        [
          join(resourceRoot, 'backend', 'out', 'backend', 'index.cjs'),
          '--serve=0',
          '--credential-store=file'
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        `http://127.0.0.1:44001/api/shutdown?token=${token}`,
        expect.objectContaining({ method: 'POST' })
      )
    }
  )

  it.each(['x64', 'x86_64', 'arm64'])('accepts the %s AppImage filename', (arch) => {
    expect(appImageVersion(`aipoch-open-science-0.33.3-linux-${arch}.AppImage`)).toBe('0.33.3')
  })

  it('requires the ARM64 Prisma engine and rejects foreign engines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-arm64-engine-'))
    roots.push(root)
    const executable = join(root, 'open-science')
    const resources = join(root, 'resources')
    const prisma = join(resources, 'backend', 'resources', 'prisma-client')
    await mkdir(prisma, { recursive: true })
    await Promise.all(
      packagedResourcePaths(executable, resources).map(async (file: string) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, '')
      })
    )
    await expect(assertPackagedResources(executable, resources, 'arm64')).rejects.toThrow(
      /linux-arm64-openssl/
    )
    await writeFile(join(prisma, 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'), '')
    await expect(assertPackagedResources(executable, resources, 'arm64')).resolves.toBeUndefined()
    await writeFile(join(prisma, 'libquery_engine-rhel-openssl-3.0.x.so.node'), '')
    await expect(assertPackagedResources(executable, resources, 'arm64')).rejects.toThrow(
      /Prisma engines/
    )
    await expect(assertPackagedResources(executable, resources, 'ia32')).rejects.toThrow(
      /Unsupported/
    )
  })
  it('discovers one AppImage and derives stable or nightly versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-linux-artifacts-'))
    roots.push(root)
    const appImage = join(root, 'aipoch-open-science-0.11.0-nightly.abc1234-linux-x86_64.AppImage')
    await writeFile(appImage, '')

    await expect(findOne(root, /\.AppImage$/, 'AppImage')).resolves.toBe(appImage)
    expect(appImageVersion(appImage)).toBe('0.11.0-nightly.abc1234')
    await writeFile(join(root, 'second.AppImage'), '')
    await expect(findOne(root, /\.AppImage$/, 'AppImage')).rejects.toThrow(/exactly one/)
  })

  it('authenticates the token-free readiness endpoint through the service state contract', async () => {
    const output = 'Open-Science Web: http://127.0.0.1:44001/'
    expect(parsePackagedAppEndpoint(output)).toEqual({ endpoint: 'http://127.0.0.1:44001' })
    await expect(
      authenticatePackagedAppEndpoint(output, ['/config'], {
        readText: async (path: string) =>
          path.endsWith('web-service.json')
            ? JSON.stringify({ port: 44001 })
            : 'linux_smoke_token_12345678901234567890\n'
      })
    ).resolves.toEqual({
      endpoint: 'http://127.0.0.1:44001',
      auth: 'token=linux_smoke_token_12345678901234567890'
    })
  })

  it('requires explicit package and installed executable paths', () => {
    expect(
      parseArguments(['--artifact-dir', 'dist', '--installed-executable', '/usr/bin/open-science'])
    ).toMatchObject({ installedExecutable: resolve('/usr/bin/open-science') })
    expect(() => parseArguments([])).toThrow(/Usage:/)
  })

  it('fails closed when a packaged runtime resource is missing', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-package-'))
    roots.push(appRoot)
    const executable = join(appRoot, 'open-science')
    await writeFile(executable, '')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await writeFile(join(appRoot, 'resources', 'app.asar'), '')

    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /node-runtime/
    )
  })

  it('requires Debian and RHEL native Linux Prisma engines', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-engine-'))
    roots.push(appRoot)
    const executable = join(appRoot, 'open-science')
    const resources = join(appRoot, 'resources')
    const prismaClient = join(resources, 'backend', 'resources', 'prisma-client')
    await mkdir(prismaClient, { recursive: true })
    await Promise.all([
      ...packagedResourcePaths(executable, resources).map(async (file: string) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, '')
      }),
      writeFile(join(prismaClient, 'libquery_engine-debian-openssl-3.0.x.so.node'), ''),
      writeFile(join(prismaClient, 'libquery_engine-rhel-openssl-3.0.x.so.node'), '')
    ])

    await expect(assertPackagedResources(executable, undefined, 'x64')).resolves.toBeUndefined()
    // A valid legacy Electron engine directory must not hide a missing backend engine.
    const legacyPrisma = join(resources, 'node_modules', '.prisma', 'client')
    await mkdir(legacyPrisma, { recursive: true })
    const debianEngine = 'libquery_engine-debian-openssl-3.0.x.so.node'
    await writeFile(join(legacyPrisma, debianEngine), '')
    await rm(join(prismaClient, debianEngine))
    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /Prisma engines/
    )
    await writeFile(join(prismaClient, debianEngine), '')
    await writeFile(join(prismaClient, 'libquery_engine-darwin.dylib.node'), '')
    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /Prisma engines/
    )
  })

  it('rejects a Debian-only engine set because Fedora selects the RHEL runtime', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-fedora-engine-'))
    roots.push(appRoot)
    const executable = join(appRoot, 'open-science')
    const resources = join(appRoot, 'resources')
    const prismaClient = join(resources, 'backend', 'resources', 'prisma-client')
    await mkdir(prismaClient, { recursive: true })
    await Promise.all([
      ...packagedResourcePaths(executable, resources).map(async (file: string) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, '')
      }),
      writeFile(join(prismaClient, 'libquery_engine-debian-openssl-3.0.x.so.node'), '')
    ])

    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /rhel-openssl-3\.0\.x/
    )
  })
})
