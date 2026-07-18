import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  installManagedOpencode,
  isManagedOpencodePath,
  managedOpencodeDir,
  resolveOpencodePlatform,
  uninstallManagedOpencode
} from './managed-opencode'

// One 512-byte ustar header + padded content — synthesizes the npm tarball shape the extractor reads.
const tarEntry = (name: string, content: Buffer): Buffer => {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'ascii')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')

  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)
  return Buffer.concat([header, padded])
}

const buildTgz = (entries: { name: string; content: Buffer }[]): Buffer =>
  gzipSync(Buffer.concat([...entries.map((e) => tarEntry(e.name, e.content)), Buffer.alloc(1024)]))

const sha512 = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

describe('installManagedOpencode', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('resolves opencode-ai latest, downloads the platform package, extracts package/bin/opencode', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([
      { name: 'package/package.json', content: Buffer.from('{"name":"opencode-darwin-arm64"}') },
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho opencode\n') }
    ])
    const integrity = sha512(tgz)

    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      // Platform package metadata is requested at the resolved version.
      expect(url).toContain('/opencode-darwin-arm64/1.18.3')
      return { dist: { tarball: 'https://reg/opencode-darwin-arm64.tgz', integrity } }
    }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({
      stream: Readable.from(tgz),
      totalBytes: tgz.length
    })

    const outcome = await installManagedOpencode({
      installId: 'i1',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'darwin-arm64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      // Injected pass keeps the test offline and host-independent (no real spawn of the extracted file).
      verifyBinary: () => ({ ok: true }),
      tmpDir: root
    })

    expect(outcome.result.ok).toBe(true)
    expect(outcome.version).toBe('1.18.3')
    expect(outcome.resolvedPath).toBe(join(managedOpencodeDir(root), 'opencode'))
    expect(await readFile(outcome.resolvedPath!, 'utf8')).toContain('echo opencode')
  })

  it('reports a structured failure (never throws) when the integrity check fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([{ name: 'package/bin/opencode', content: Buffer.from('x') }])

    const fetchJson = async (url: string): Promise<unknown> =>
      url.endsWith('/opencode-ai')
        ? { 'dist-tags': { latest: '1.18.3' } }
        : { dist: { tarball: 'https://reg/x.tgz', integrity: 'sha512-wrong' } }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({
      stream: Readable.from(tgz)
    })

    const outcome = await installManagedOpencode({
      installId: 'i2',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'darwin-arm64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      tmpDir: root
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.resolvedPath).toBeUndefined()
  })

  // A downloaded package that extracts cleanly but cannot run on this CPU (e.g. SIGILL on a non-AVX2
  // x64 host) must fail the install, not persist a broken path.
  it('fails cleanly and removes the binary when the smoke check reports it cannot run', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho opencode\n') }
    ])
    const integrity = sha512(tgz)

    const fetchJson = async (url: string): Promise<unknown> =>
      url.endsWith('/opencode-ai')
        ? { 'dist-tags': { latest: '1.18.3' } }
        : { dist: { tarball: 'https://reg/opencode-darwin-arm64.tgz', integrity } }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(tgz), totalBytes: tgz.length })

    const outcome = await installManagedOpencode({
      installId: 'i3',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'darwin-arm64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      // Simulate a non-AVX2 host: the binary dies with SIGILL when probed.
      verifyBinary: () => ({ ok: false, reason: 'killed by SIGILL', signal: 'SIGILL' }),
      tmpDir: root
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.resolvedPath).toBeUndefined()
    // Actionable error mentioning the failed probe and the likely AVX2 cause.
    expect(outcome.result.error).toMatch(/failed to run/)
    expect(outcome.result.error).toMatch(/AVX2/)
    // The unusable binary is not left on disk.
    await expect(readFile(join(managedOpencodeDir(root), 'opencode'))).rejects.toThrow()
  })

  it('succeeds when the smoke check confirms the binary runs', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho opencode\n') }
    ])
    const integrity = sha512(tgz)

    const fetchJson = async (url: string): Promise<unknown> =>
      url.endsWith('/opencode-ai')
        ? { 'dist-tags': { latest: '1.18.3' } }
        : { dist: { tarball: 'https://reg/opencode-darwin-arm64.tgz', integrity } }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(tgz), totalBytes: tgz.length })

    let verifiedPath: string | undefined
    const outcome = await installManagedOpencode({
      installId: 'i4',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'darwin-arm64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      verifyBinary: (binPath) => {
        verifiedPath = binPath
        return { ok: true }
      },
      tmpDir: root
    })

    expect(outcome.result.ok).toBe(true)
    expect(outcome.resolvedPath).toBe(join(managedOpencodeDir(root), 'opencode'))
    // The verifier is handed the installed binary path.
    expect(verifiedPath).toBe(join(managedOpencodeDir(root), 'opencode'))
  })
})

describe('resolveOpencodePlatform', () => {
  it('resolves the published host keys, including windows-arm64 and musl linux', () => {
    expect(resolveOpencodePlatform({ platform: 'darwin', arch: 'arm64' })).toEqual({
      key: 'darwin-arm64',
      binName: 'opencode'
    })
    expect(resolveOpencodePlatform({ platform: 'win32', arch: 'arm64' })).toEqual({
      key: 'windows-arm64',
      binName: 'opencode.exe'
    })
    expect(
      resolveOpencodePlatform({ platform: 'linux', arch: 'x64', detectMusl: () => true })
    ).toEqual({ key: 'linux-x64-musl', binName: 'opencode' })
  })

  it('promotes Rosetta-translated x64 darwin to the arm64 package', () => {
    expect(
      resolveOpencodePlatform({ platform: 'darwin', arch: 'x64', isRosetta: () => true })
    ).toEqual({ key: 'darwin-arm64', binName: 'opencode' })
  })

  it('throws for an arch opencode publishes no package for (no false auto-install)', () => {
    // opencode ships no linux-ia32 / linux-arm (32-bit) native package — resolving must fail rather
    // than hand back a key that 404s at the registry, so the environment check gates correctly.
    expect(() => resolveOpencodePlatform({ platform: 'linux', arch: 'ia32' })).toThrow(
      /Unsupported platform/
    )
    expect(() => resolveOpencodePlatform({ platform: 'linux', arch: 'arm' })).toThrow(
      /Unsupported platform/
    )
  })

  it('throws for an unsupported platform', () => {
    expect(() => resolveOpencodePlatform({ platform: 'aix', arch: 'x64' })).toThrow(
      /Unsupported platform/
    )
  })
})

describe('isManagedOpencodePath / uninstallManagedOpencode', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-uninstall-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('recognizes only a binary that lives directly in the managed bin dir', () => {
    expect(isManagedOpencodePath(join(managedOpencodeDir(root), 'opencode'), root)).toBe(true)
    // A PATH/npm/homebrew opencode we merely detected must never be treated as managed.
    expect(isManagedOpencodePath('/opt/homebrew/bin/opencode', root)).toBe(false)
    expect(isManagedOpencodePath(join(managedOpencodeDir(root), 'nested', 'opencode'), root)).toBe(
      false
    )
  })

  it('removes the whole managed install tree', async () => {
    const bin = join(managedOpencodeDir(root), 'opencode')
    await mkdir(managedOpencodeDir(root), { recursive: true })
    await writeFile(bin, '', 'utf8')

    await uninstallManagedOpencode(root)

    await expect(readFile(bin)).rejects.toThrow()
    await expect(readFile(join(root, 'opencode-managed', 'bin', 'opencode'))).rejects.toThrow()
  })

  it('is a no-op (never rejects) when nothing is installed', async () => {
    await expect(uninstallManagedOpencode(root)).resolves.toBeUndefined()
  })
})
