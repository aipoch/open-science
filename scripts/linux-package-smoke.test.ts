import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  authenticatePackagedAppEndpoint,
  appImageVersion,
  assertPackagedResources,
  findOne,
  parseArguments,
  parsePackagedAppEndpoint
} from './linux-package-smoke.mjs'

describe('Linux package smoke', () => {
  it.each(['x64', 'x86_64', 'arm64'])('accepts the %s AppImage filename', (arch) => {
    expect(appImageVersion(`aipoch-open-science-0.33.3-linux-${arch}.AppImage`)).toBe('0.33.3')
  })

  it('requires the ARM64 Prisma engine and rejects foreign engines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-arm64-engine-'))
    const executable = join(root, 'open-science')
    const resources = join(root, 'resources')
    const prisma = join(resources, 'node_modules', '.prisma', 'client')
    await mkdir(prisma, { recursive: true })
    await Promise.all(
      [executable, join(resources, 'app.asar'), join(resources, 'micromamba')].map((file) =>
        writeFile(file, '')
      )
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
    const executable = join(appRoot, 'open-science')
    await writeFile(executable, '')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await writeFile(join(appRoot, 'resources', 'app.asar'), '')

    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /micromamba/
    )
  })

  it('requires Debian and RHEL native Linux Prisma engines', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-engine-'))
    const executable = join(appRoot, 'open-science')
    const resources = join(appRoot, 'resources')
    const prismaClient = join(resources, 'node_modules', '.prisma', 'client')
    await mkdir(prismaClient, { recursive: true })
    await Promise.all([
      writeFile(executable, ''),
      writeFile(join(resources, 'app.asar'), ''),
      writeFile(join(resources, 'micromamba'), ''),
      writeFile(join(prismaClient, 'libquery_engine-debian-openssl-3.0.x.so.node'), ''),
      writeFile(join(prismaClient, 'libquery_engine-rhel-openssl-3.0.x.so.node'), '')
    ])

    await expect(assertPackagedResources(executable, undefined, 'x64')).resolves.toBeUndefined()
    await writeFile(join(prismaClient, 'libquery_engine-darwin.dylib.node'), '')
    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /Prisma engines/
    )
  })

  it('rejects a Debian-only engine set because Fedora selects the RHEL runtime', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-fedora-engine-'))
    const executable = join(appRoot, 'open-science')
    const resources = join(appRoot, 'resources')
    const prismaClient = join(resources, 'node_modules', '.prisma', 'client')
    await mkdir(prismaClient, { recursive: true })
    await Promise.all([
      writeFile(executable, ''),
      writeFile(join(resources, 'app.asar'), ''),
      writeFile(join(resources, 'micromamba'), ''),
      writeFile(join(prismaClient, 'libquery_engine-debian-openssl-3.0.x.so.node'), '')
    ])

    await expect(assertPackagedResources(executable, undefined, 'x64')).rejects.toThrow(
      /rhel-openssl-3\.0\.x/
    )
  })
})
