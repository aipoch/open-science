import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  authenticatePackagedAppEndpoint,
  appImageVersion,
  assertPackagedResources,
  findOne,
  launchAndProbe,
  parseArguments,
  parsePackagedAppEndpoint
} from './linux-package-smoke.mjs'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

afterEach(() => vi.useRealTimers())

describe('Linux package smoke', () => {
  it('selects the supported file credential backend for headless package launches', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    const probe = launchAndProbe({
      executable: '/package/open-science',
      expectedVersion: '0.31.0',
      env: {}
    })
    child.emit('exit', 1)
    await expect(probe).rejects.toThrow('exited before becoming healthy')
    expect(spawn).toHaveBeenCalledWith(
      '/package/open-science',
      ['--open-science-headless', '--serve=0', '--no-sandbox', '--credential-store=file'],
      expect.objectContaining({ env: {} })
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

    await expect(assertPackagedResources(executable)).rejects.toThrow(/micromamba/)
  })

  it('requires exactly one native Linux Prisma engine', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-engine-'))
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

    await expect(assertPackagedResources(executable)).resolves.toBeUndefined()
    await writeFile(join(prismaClient, 'libquery_engine-rhel-openssl-3.0.x.so.node'), '')
    await expect(assertPackagedResources(executable)).rejects.toThrow(/exactly one Prisma engine/)
  })
})
