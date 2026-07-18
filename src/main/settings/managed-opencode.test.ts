import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  classifyVerifyResult,
  defaultVerifyBinary,
  installManagedOpencode,
  managedOpencodeDir,
  resolveOpencodePlatform,
  runVersionProbe
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
      // Simulate a non-AVX2 host: the binary dies on an illegal instruction when probed.
      verifyBinary: () => ({ ok: false, reason: 'killed by SIGILL', illegalInstruction: true }),
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

  // A non-AVX2 x64 host: the standard build dies with SIGILL, so the installer retries the -baseline
  // variant, which runs cleanly. This is what makes the onboarding "auto-installable" claim hold.
  it('retries the -baseline variant when the standard x64 build reports SIGILL, then succeeds', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const standardTgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho standard\n') }
    ])
    const baselineTgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho baseline\n') }
    ])

    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      if (url.includes('/opencode-linux-x64-baseline/')) {
        requestedKeys.push('baseline')
        return { dist: { tarball: 'https://reg/baseline.tgz', integrity: sha512(baselineTgz) } }
      }
      requestedKeys.push('standard')
      return { dist: { tarball: 'https://reg/standard.tgz', integrity: sha512(standardTgz) } }
    }
    const fetchTarball = async (
      url: string
    ): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => {
      const tgz = url.includes('baseline') ? baselineTgz : standardTgz
      return { stream: Readable.from(tgz), totalBytes: tgz.length }
    }

    // First probe (standard) dies with SIGILL; second probe (baseline) runs.
    let probes = 0
    const outcome = await installManagedOpencode({
      installId: 'i5',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'linux-x64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      // AVX2 present, so the standard build is tried first — the SIGILL retry is the safety net.
      detectAvx2: () => true,
      verifyBinary: () => {
        probes += 1
        return probes === 1
          ? { ok: false, reason: 'killed by SIGILL', illegalInstruction: true }
          : { ok: true }
      },
      tmpDir: root
    })

    expect(requestedKeys).toEqual(['standard', 'baseline'])
    expect(outcome.result.ok).toBe(true)
    expect(outcome.version).toBe('1.18.3')
    expect(await readFile(outcome.resolvedPath!, 'utf8')).toContain('echo baseline')
  })

  // A musl x64 host: the baseline package name inserts `baseline` before the `-musl` suffix, so the
  // retry must request `opencode-linux-x64-baseline-musl` (NOT the non-existent linux-x64-musl-baseline).
  it('retries the linux-x64-baseline-musl variant for a musl x64 host', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const standardTgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho standard\n') }
    ])
    const baselineTgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho baseline\n') }
    ])

    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      if (url.includes('/opencode-linux-x64-baseline-musl/')) {
        requestedKeys.push('baseline')
        return { dist: { tarball: 'https://reg/baseline.tgz', integrity: sha512(baselineTgz) } }
      }
      requestedKeys.push('standard')
      return { dist: { tarball: 'https://reg/standard.tgz', integrity: sha512(standardTgz) } }
    }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => {
      const tgz = url.includes('baseline') ? baselineTgz : standardTgz
      return { stream: Readable.from(tgz), totalBytes: tgz.length }
    }

    let probes = 0
    const outcome = await installManagedOpencode({
      installId: 'i5b',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'linux-x64-musl', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      detectAvx2: () => true,
      verifyBinary: () => {
        probes += 1
        return probes === 1
          ? { ok: false, reason: 'killed by SIGILL', illegalInstruction: true }
          : { ok: true }
      },
      tmpDir: root
    })

    expect(requestedKeys).toEqual(['standard', 'baseline'])
    expect(outcome.result.ok).toBe(true)
    expect(await readFile(outcome.resolvedPath!, 'utf8')).toContain('echo baseline')
  })

  // On Windows an illegal instruction is an exit STATUS (NTSTATUS), not a signal, so a windows-x64 host
  // whose standard build reports that status must still retry `opencode-windows-x64-baseline`.
  it('retries windows-x64-baseline when the standard build reports an illegal-instruction status', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const standardTgz = buildTgz([
      { name: 'package/bin/opencode.exe', content: Buffer.from('standard\n') }
    ])
    const baselineTgz = buildTgz([
      { name: 'package/bin/opencode.exe', content: Buffer.from('baseline\n') }
    ])

    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      if (url.includes('/opencode-windows-x64-baseline/')) {
        requestedKeys.push('baseline')
        return { dist: { tarball: 'https://reg/baseline.tgz', integrity: sha512(baselineTgz) } }
      }
      requestedKeys.push('standard')
      return { dist: { tarball: 'https://reg/standard.tgz', integrity: sha512(standardTgz) } }
    }
    const fetchTarball = async (
      url: string
    ): Promise<{ stream: NodeJS.ReadableStream; totalBytes?: number }> => {
      const tgz = url.includes('baseline') ? baselineTgz : standardTgz
      return { stream: Readable.from(tgz), totalBytes: tgz.length }
    }

    // First probe (standard) exits with STATUS_ILLEGAL_INSTRUCTION classified via illegalInstruction;
    // second probe (baseline) runs.
    let probes = 0
    const outcome = await installManagedOpencode({
      installId: 'i5w',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'windows-x64', binName: 'opencode.exe' },
      fetchJson,
      fetchTarball,
      detectAvx2: () => true,
      verifyBinary: () => {
        probes += 1
        return probes === 1
          ? {
              ok: false,
              reason: '`--version` exited with code 3221225501',
              illegalInstruction: true
            }
          : { ok: true }
      },
      tmpDir: root
    })

    expect(requestedKeys).toEqual(['standard', 'baseline'])
    expect(outcome.result.ok).toBe(true)
    expect(await readFile(outcome.resolvedPath!, 'utf8')).toContain('baseline')
  })

  // arm64 has no baseline package, so a SIGILL there must NOT trigger a retry — it fails directly.
  it('does not retry baseline on arm64 (no baseline package exists)', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho arm\n') }
    ])
    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      requestedKeys.push(url)
      return { dist: { tarball: 'https://reg/arm.tgz', integrity: sha512(tgz) } }
    }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(tgz), totalBytes: tgz.length })

    const outcome = await installManagedOpencode({
      installId: 'i6',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'darwin-arm64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      verifyBinary: () => ({ ok: false, reason: 'killed by SIGILL', illegalInstruction: true }),
      tmpDir: root
    })

    // Never requested a -baseline package for arm64.
    expect(requestedKeys.some((url) => url.includes('baseline'))).toBe(false)
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toMatch(/AVX2/)
  })

  // If the -baseline package does not exist (404 at resolve), the SIGILL/AVX2 error is surfaced rather
  // than crashing on the unverifiable package name.
  it('surfaces the SIGILL/AVX2 error when no baseline package is available', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho standard\n') }
    ])
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      // The baseline package 404s at the registry.
      if (url.includes('-baseline/')) throw new Error('404 Not Found')
      return { dist: { tarball: 'https://reg/standard.tgz', integrity: sha512(tgz) } }
    }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(tgz), totalBytes: tgz.length })

    const outcome = await installManagedOpencode({
      installId: 'i7',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'linux-x64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      detectAvx2: () => true,
      verifyBinary: () => ({ ok: false, reason: 'killed by SIGILL', illegalInstruction: true }),
      tmpDir: root
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toMatch(/failed to run/)
    expect(outcome.result.error).toMatch(/AVX2/)
    // No broken binary left on disk.
    await expect(readFile(join(managedOpencodeDir(root), 'opencode'))).rejects.toThrow()
  })

  // A non-AVX2 x64 host detected up front installs the -baseline build on the FIRST try: no wasted
  // standard download + SIGILL. The baseline key is requested first and the standard key is never asked.
  it('installs the baseline build first when AVX2 is absent on x64 (no standard download)', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const baselineTgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho baseline\n') }
    ])

    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      if (url.includes('/opencode-linux-x64-baseline/')) {
        requestedKeys.push('baseline')
        return { dist: { tarball: 'https://reg/baseline.tgz', integrity: sha512(baselineTgz) } }
      }
      requestedKeys.push('standard')
      return { dist: { tarball: 'https://reg/standard.tgz', integrity: 'sha512-unused' } }
    }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(baselineTgz), totalBytes: baselineTgz.length })

    const outcome = await installManagedOpencode({
      installId: 'i8',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'linux-x64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      // Positively no AVX2 → prefer the baseline build up front.
      detectAvx2: () => false,
      verifyBinary: () => ({ ok: true }),
      tmpDir: root
    })

    // The baseline key is requested first, and the standard key is never requested at all.
    expect(requestedKeys[0]).toBe('baseline')
    expect(requestedKeys).not.toContain('standard')
    expect(outcome.result.ok).toBe(true)
    expect(await readFile(outcome.resolvedPath!, 'utf8')).toContain('echo baseline')
  })

  // The default path: AVX2 present ⇒ the standard build is requested first (baseline only via retry).
  it('installs the standard build first when AVX2 is present on x64', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const standardTgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho standard\n') }
    ])

    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      if (url.includes('-baseline/')) {
        requestedKeys.push('baseline')
        return { dist: { tarball: 'https://reg/baseline.tgz', integrity: 'sha512-unused' } }
      }
      requestedKeys.push('standard')
      return { dist: { tarball: 'https://reg/standard.tgz', integrity: sha512(standardTgz) } }
    }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(standardTgz), totalBytes: standardTgz.length })

    const outcome = await installManagedOpencode({
      installId: 'i9',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'linux-x64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      detectAvx2: () => true,
      verifyBinary: () => ({ ok: true }),
      tmpDir: root
    })

    expect(requestedKeys).toEqual(['standard'])
    expect(outcome.result.ok).toBe(true)
    expect(await readFile(outcome.resolvedPath!, 'utf8')).toContain('echo standard')
  })

  // arm64 has no baseline package, so it must never prefer baseline even when AVX2 detection says absent.
  it('never prefers baseline on arm64 regardless of AVX2 detection', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-opencode-'))
    const tgz = buildTgz([
      { name: 'package/bin/opencode', content: Buffer.from('#!/bin/sh\necho arm\n') }
    ])

    const requestedKeys: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/opencode-ai')) return { 'dist-tags': { latest: '1.18.3' } }
      requestedKeys.push(url)
      return { dist: { tarball: 'https://reg/arm.tgz', integrity: sha512(tgz) } }
    }
    const fetchTarball = async (): Promise<{
      stream: NodeJS.ReadableStream
      totalBytes?: number
    }> => ({ stream: Readable.from(tgz), totalBytes: tgz.length })

    const outcome = await installManagedOpencode({
      installId: 'i10',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform: { key: 'darwin-arm64', binName: 'opencode' },
      fetchJson,
      fetchTarball,
      detectAvx2: () => false,
      verifyBinary: () => ({ ok: true }),
      tmpDir: root
    })

    // No baseline key was ever requested on arm64.
    expect(requestedKeys.some((url) => url.includes('baseline'))).toBe(false)
    expect(outcome.result.ok).toBe(true)
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

describe('runVersionProbe', () => {
  it('spawns the binary with `--version` and a 15s timeout', () => {
    const spawn = vi.fn(() => ({ status: 0 }))
    runVersionProbe('/path/to/opencode', spawn)
    // Locks the exact probe contract: args and the 15s timeout the classifier depends on.
    expect(spawn).toHaveBeenCalledWith('/path/to/opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 15000
    })
  })
})

describe('classifyVerifyResult', () => {
  it('reports ok when the probe exits zero', () => {
    expect(classifyVerifyResult({ status: 0 })).toEqual({ ok: true })
  })

  it('classifies a non-zero exit (non-win32) as unrunnable, not an illegal instruction', () => {
    const result = classifyVerifyResult({ status: 3 }, 'linux')
    expect(result).toEqual({
      ok: false,
      reason: '`--version` exited with code 3',
      illegalInstruction: false
    })
  })

  it('classifies a spawn error as unrunnable (not an illegal instruction)', () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const result = classifyVerifyResult({ error }, 'linux')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/spawn error/)
      expect(result.illegalInstruction).toBe(false)
    }
  })

  it('classifies a timeout-shaped error as unrunnable', () => {
    const error = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const result = classifyVerifyResult({ error }, 'linux')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.illegalInstruction).toBe(false)
  })

  it('flags SIGILL as an illegal instruction', () => {
    const result = classifyVerifyResult({ signal: 'SIGILL' }, 'linux')
    expect(result).toEqual({
      ok: false,
      reason: 'killed by SIGILL',
      illegalInstruction: true
    })
  })

  it('classifies a non-SIGILL terminating signal as unrunnable, not an illegal instruction', () => {
    const result = classifyVerifyResult({ signal: 'SIGTERM' }, 'linux')
    expect(result).toEqual({
      ok: false,
      reason: 'killed by SIGTERM',
      illegalInstruction: false
    })
  })

  it('treats the NTSTATUS illegal-instruction exit status as illegal only on win32', () => {
    // Unsigned form on Windows → illegal instruction.
    const win = classifyVerifyResult({ status: 0xc000001d }, 'win32')
    expect(win.ok).toBe(false)
    if (!win.ok) expect(win.illegalInstruction).toBe(true)

    // Same status on linux is just a non-zero exit, not an illegal instruction.
    const linux = classifyVerifyResult({ status: 0xc000001d }, 'linux')
    expect(linux.ok).toBe(false)
    if (!linux.ok) expect(linux.illegalInstruction).toBe(false)
  })

  it('accepts the signed 32-bit form of the NTSTATUS illegal-instruction status on win32', () => {
    const result = classifyVerifyResult({ status: -1073741795 }, 'win32')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.illegalInstruction).toBe(true)
  })
})

describe('defaultVerifyBinary', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('reports ok for a binary that runs `--version` and exits zero', () => {
    // node itself answers `--version` with exit 0 — the real spawnSync path, host-independent.
    expect(defaultVerifyBinary(process.execPath)).toEqual({ ok: true })
  })

  it('reports a spawn error (unrunnable) when the binary path does not exist', () => {
    const result = defaultVerifyBinary(join(tmpdir(), 'no-such-opencode-binary-xyz'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/spawn error/)
  })

  // A non-zero `--version` exit classifies as unrunnable. Uses a chmod'd shell script, so it is skipped
  // on Windows (advisory CI leg) where the exec-bit trick does not apply.
  it.skipIf(process.platform === 'win32')(
    'reports a non-zero exit (unrunnable) from the real probe',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'verify-binary-'))
      const script = join(root, 'exit3.sh')
      await writeFile(script, '#!/bin/sh\nexit 3\n')
      await chmod(script, 0o755)

      const result = defaultVerifyBinary(script)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/exited with code 3/)
    }
  )

  // Genuinely exercises real spawnSync producing a `.signal`: a node child that kills itself with
  // SIGKILL. POSIX-only, since Windows has no such terminating-signal semantics.
  it.skipIf(process.platform === 'win32')(
    'classifies a real terminating signal from spawnSync as unrunnable',
    () => {
      const probe = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], {
        encoding: 'utf8',
        timeout: 15000
      })
      // Sanity: the real probe actually carried a terminating signal.
      expect(probe.signal).toBeTruthy()
      const result = classifyVerifyResult(probe)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/killed by/)
    }
  )
})
