import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchStandard, nonRegularMarkerPaths, markerReplacementsOnRead } = vi.hoisted(() => ({
  netFetchStandard: vi.fn(),
  nonRegularMarkerPaths: new Set<string>(),
  markerReplacementsOnRead: new Map<string, string>()
}))

vi.mock('../skills/net-fetch', () => ({ netFetchStandard }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (path: string) =>
      nonRegularMarkerPaths.has(String(path))
        ? ({ isFile: () => false } as Awaited<ReturnType<typeof actual.lstat>>)
        : actual.lstat(path),
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      const replacement = markerReplacementsOnRead.get(path)
      if (replacement !== undefined) {
        markerReplacementsOnRead.delete(path)
        const replacementPath = `${path}.replacement`
        await actual.writeFile(replacementPath, replacement, { flag: 'wx' })
        await actual.rm(path)
        await actual.rename(replacementPath, path)
      }
      return actual.readFile(...args)
    }
  }
})

afterEach(() => {
  nonRegularMarkerPaths.clear()
  markerReplacementsOnRead.clear()
})

import type { ClaudeInstallEvent } from '../../shared/settings'
import {
  defaultFetchJson,
  defaultFetchTarball,
  downloadAndVerify,
  extractFileFromTgz,
  getManagedPlatform,
  installManagedClaude,
  isManagedClaudePath,
  managedClaudeDir,
  resolveNativePackage,
  uninstallManagedClaude
} from './managed-claude'

// Builds one 512-byte ustar header + content padded to a 512 boundary — enough to synthesize the npm
// tarball shape the extractor consumes, without depending on a tar library.
const tarEntry = (name: string, content: Buffer): Buffer => {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000755\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('0', 156, 'ascii') // typeflag: regular file
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  // Checksum: sum of all bytes with the checksum field treated as spaces.
  header.write('        ', 148, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')

  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(padded)

  return Buffer.concat([header, padded])
}

const buildTgz = (entries: { name: string; content: Buffer }[]): Buffer => {
  const blocks = entries.map((entry) => tarEntry(entry.name, entry.content))
  // Two trailing zero blocks mark end-of-archive.
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

const sha512 = (data: Buffer): string =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

describe('managed-claude: default transport', () => {
  beforeEach(() => netFetchStandard.mockReset())
  afterEach(() => vi.useRealTimers())

  it('loads registry metadata through Electron net.fetch', async () => {
    netFetchStandard.mockResolvedValue(
      new Response(JSON.stringify({ version: '1.2.3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(defaultFetchJson('https://registry.example.test/package')).resolves.toEqual({
      version: '1.2.3'
    })
    expect(netFetchStandard).toHaveBeenCalledWith('https://registry.example.test/package', {
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
  })

  it('follows bounded HTTPS redirects for registry metadata', async () => {
    netFetchStandard
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.test/package' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: '1.2.3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )

    await expect(defaultFetchJson('https://registry.example.test/package')).resolves.toEqual({
      version: '1.2.3'
    })
    expect(netFetchStandard.mock.calls.map(([url]) => url)).toEqual([
      'https://registry.example.test/package',
      'https://cdn.example.test/package'
    ])
  })

  it('rejects an HTTPS installer redirect that downgrades to HTTP', async () => {
    netFetchStandard.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://cdn.example.test/package.tgz' }
      })
    )

    await expect(defaultFetchTarball('https://registry.example.test/package.tgz')).rejects.toThrow(
      /redirect.*non-HTTPS/i
    )
    expect(netFetchStandard).toHaveBeenCalledTimes(1)
  })

  it('rejects more than five HTTPS installer redirects', async () => {
    for (let index = 1; index <= 6; index += 1) {
      netFetchStandard.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://cdn.example.test/redirect-${index}` }
        })
      )
    }

    await expect(defaultFetchTarball('https://registry.example.test/package.tgz')).rejects.toThrow(
      'Too many redirects'
    )
    expect(netFetchStandard).toHaveBeenCalledTimes(6)
  })

  it('streams tarballs through Electron net.fetch and preserves content length', async () => {
    const payload = Buffer.from('managed-runtime-tarball')
    netFetchStandard.mockResolvedValue(
      new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) }
      })
    )

    const result = await defaultFetchTarball('https://registry.example.test/package.tgz')
    const chunks: Buffer[] = []
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk as Uint8Array))

    expect(Buffer.concat(chunks)).toEqual(payload)
    expect(result.totalBytes).toBe(payload.length)
    expect(netFetchStandard).toHaveBeenCalledWith('https://registry.example.test/package.tgz', {
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
  })

  it('aborts a tarball stream after 20 seconds without progress', async () => {
    vi.useFakeTimers()
    netFetchStandard.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: () => undefined
        }),
        { status: 200 }
      )
    )

    const result = await defaultFetchTarball('https://registry.example.test/stalled.tgz')
    const streamError = new Promise<Error>((resolve) =>
      result.stream.once('error', (error) => resolve(error as Error))
    )
    result.stream.resume()

    await vi.advanceTimersByTimeAsync(20_000)

    expect((await streamError).message).toBe(
      'Request timed out for https://registry.example.test/stalled.tgz'
    )
    const init = netFetchStandard.mock.calls[0]?.[1] as RequestInit
    expect(init.signal?.aborted).toBe(true)
  })

  it('resets the inactivity timeout whenever a tarball chunk arrives', async () => {
    vi.useFakeTimers()
    let body!: ReadableStreamDefaultController<Uint8Array>
    netFetchStandard.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            body = controller
          }
        }),
        { status: 200 }
      )
    )

    const result = await defaultFetchTarball('https://registry.example.test/progress.tgz')
    const errors: Error[] = []
    result.stream.on('error', (error) => errors.push(error as Error))
    result.stream.resume()

    await vi.advanceTimersByTimeAsync(15_000)
    const received = new Promise<void>((resolve) => result.stream.once('data', () => resolve()))
    body.enqueue(new Uint8Array([1]))
    await received
    await vi.advanceTimersByTimeAsync(15_000)

    expect(errors).toEqual([])
    body.close()
  })
})

describe('managed-claude: platform key', () => {
  it('maps darwin arm64', () => {
    const p = getManagedPlatform({ platform: 'darwin', arch: 'arm64' })
    expect(p).toEqual({
      key: 'darwin-arm64',
      pkg: '@anthropic-ai/claude-code-darwin-arm64',
      binName: 'claude'
    })
  })

  it('keeps darwin x64 when not translated', () => {
    const p = getManagedPlatform({ platform: 'darwin', arch: 'x64', isRosetta: () => false })
    expect(p.key).toBe('darwin-x64')
  })

  it('prefers arm64 for x64 under Rosetta', () => {
    const p = getManagedPlatform({ platform: 'darwin', arch: 'x64', isRosetta: () => true })
    expect(p.key).toBe('darwin-arm64')
  })

  it('detects musl on linux (no glibcVersionRuntime)', () => {
    const p = getManagedPlatform({
      platform: 'linux',
      arch: 'x64',
      getReport: () => ({ header: {} })
    })
    expect(p.key).toBe('linux-x64-musl')
  })

  it('uses glibc linux when glibcVersionRuntime is present', () => {
    const p = getManagedPlatform({
      platform: 'linux',
      arch: 'arm64',
      getReport: () => ({ header: { glibcVersionRuntime: '2.31' } })
    })
    expect(p.key).toBe('linux-arm64')
  })

  it('uses the .exe binary name on Windows', () => {
    const p = getManagedPlatform({ platform: 'win32', arch: 'x64' })
    expect(p).toMatchObject({ key: 'win32-x64', binName: 'claude.exe' })
  })

  it('throws on an unsupported platform', () => {
    expect(() =>
      getManagedPlatform({ platform: 'freebsd' as NodeJS.Platform, arch: 'x64' })
    ).toThrow(/Unsupported platform/)
  })
})

describe('managed-claude: registry resolution', () => {
  const platform = {
    key: 'linux-x64',
    pkg: '@anthropic-ai/claude-code-linux-x64',
    binName: 'claude'
  }

  it('resolves latest version then tarball + integrity', async () => {
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/@anthropic-ai%2fclaude-code'))
        return { 'dist-tags': { latest: '2.1.209' } }
      expect(url).toContain('@anthropic-ai%2fclaude-code-linux-x64/2.1.209')
      return { dist: { tarball: 'https://reg/x.tgz', integrity: 'sha512-abc' } }
    }

    const res = await resolveNativePackage({ registry: 'https://reg', platform, fetchJson })
    expect(res).toEqual({
      version: '2.1.209',
      tarball: 'https://reg/x.tgz',
      integrity: 'sha512-abc',
      registry: 'https://reg'
    })
  })

  it('uses a pinned version without querying dist-tags', async () => {
    let latestQueried = false
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith('/@anthropic-ai%2fclaude-code')) latestQueried = true
      return { dist: { tarball: 'https://reg/x.tgz', integrity: 'sha512-abc' } }
    }

    const res = await resolveNativePackage({
      registry: 'https://reg',
      platform,
      version: '2.0.0',
      fetchJson
    })
    expect(res.version).toBe('2.0.0')
    expect(latestQueried).toBe(false)
  })

  it('throws when metadata lacks tarball/integrity', async () => {
    const fetchJson = async (): Promise<unknown> => ({ dist: {} })
    await expect(
      resolveNativePackage({ registry: 'https://reg', platform, version: '1.0.0', fetchJson })
    ).rejects.toThrow(/Incomplete registry metadata/)
  })
})

describe('managed-claude: download + verify', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'managed-claude-dl-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the file when the sha512 matches', async () => {
    const payload = Buffer.from('a-native-binary')
    const dest = join(dir, 'out.tgz')
    await downloadAndVerify({
      url: 'https://reg/x.tgz',
      integrity: sha512(payload),
      destPath: dest,
      installId: 'i1',
      onEvent: () => undefined,
      fetchTarball: async () => ({ stream: Readable.from([payload]), totalBytes: payload.length })
    })
    expect((await readFile(dest)).equals(payload)).toBe(true)
  })

  it('emits determinate download progress ticks that finish at the total', async () => {
    const chunks = [
      Buffer.alloc(100, 1),
      Buffer.alloc(100, 2),
      Buffer.alloc(100, 3),
      Buffer.alloc(100, 4)
    ]
    const payload = Buffer.concat(chunks)
    const events: ClaudeInstallEvent[] = []
    await downloadAndVerify({
      url: 'https://reg/x.tgz',
      integrity: sha512(payload),
      destPath: join(dir, 'out.tgz'),
      installId: 'i1',
      onEvent: (e) => events.push(e),
      fetchTarball: async () => ({ stream: Readable.from(chunks), totalBytes: payload.length })
    })

    const progress = events.filter((e) => e.kind === 'progress' && e.phase === 'downloading')
    expect(progress.length).toBeGreaterThan(1)
    // No raw byte lines leak into the log stream anymore.
    expect(events.some((e) => e.kind === 'log')).toBe(false)
    const last = progress.at(-1)
    expect(last).toMatchObject({ receivedBytes: payload.length, totalBytes: payload.length })
  })

  it('rejects and removes the file on a sha512 mismatch', async () => {
    const dest = join(dir, 'out.tgz')
    await expect(
      downloadAndVerify({
        url: 'https://reg/x.tgz',
        integrity: 'sha512-wrong',
        destPath: dest,
        installId: 'i1',
        onEvent: () => undefined,
        fetchTarball: async () => ({ stream: Readable.from([Buffer.from('bytes')]) })
      })
    ).rejects.toThrow(/integrity check/)
    await expect(readFile(dest)).rejects.toThrow()
  })
})

describe('managed-claude: tgz extraction', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'managed-claude-ex-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts the target entry across block boundaries', async () => {
    // A payload larger than one 512 block to exercise multi-block bodies.
    const binary = Buffer.from('CLAUDE-BINARY-'.repeat(200))
    const tgz = buildTgz([
      { name: 'package/README.md', content: Buffer.from('hi') },
      { name: 'package/claude', content: binary }
    ])
    const tgzPath = join(dir, 'pkg.tgz')
    await writeFile(tgzPath, tgz)

    const dest = join(dir, 'bin', 'claude')
    const found = await extractFileFromTgz({ tgzPath, entryName: 'package/claude', destPath: dest })

    expect(found).toBe(true)
    expect((await readFile(dest)).equals(binary)).toBe(true)
  })

  it('returns false and leaves no file when the entry is absent', async () => {
    const tgz = buildTgz([{ name: 'package/other', content: Buffer.from('x') }])
    const tgzPath = join(dir, 'pkg.tgz')
    await writeFile(tgzPath, tgz)

    const dest = join(dir, 'bin', 'claude')
    const found = await extractFileFromTgz({ tgzPath, entryName: 'package/claude', destPath: dest })

    expect(found).toBe(false)
    await expect(readFile(dest)).rejects.toThrow()
  })
})

describe('managed-claude: install orchestration', () => {
  let root: string
  const platform = {
    key: 'linux-x64',
    pkg: '@anthropic-ai/claude-code-linux-x64',
    binName: 'claude'
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-claude-root-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const fixture = (): { tgz: Buffer; binary: Buffer } => {
    const binary = Buffer.from('NATIVE-CLAUDE-'.repeat(100))
    return { tgz: buildTgz([{ name: 'package/claude', content: binary }]), binary }
  }

  it('installs the binary and reports the resolved path + version', async () => {
    const { tgz, binary } = fixture()
    const events: ClaudeInstallEvent[] = []
    const interruptedStaging = join(
      root,
      'claude-code.staging-12345678-1234-1234-1234-123456789abc'
    )
    const interruptedPayload = join(interruptedStaging, 'partial-download')
    await mkdir(interruptedStaging, { recursive: true })
    await writeFile(
      join(interruptedStaging, '.open-science-managed-runtime'),
      'open-science:claude-code:v1\n'
    )
    await writeFile(interruptedPayload, 'partial')
    let stagingOwner: string | undefined
    const renamePath = async (...args: Parameters<typeof rename>): Promise<void> => {
      const [source] = args
      if (String(source).includes('.staging-')) {
        stagingOwner = await readFile(
          join(dirname(String(source)), '.open-science-managed-runtime'),
          'utf8'
        )
      }
      await rename(...args)
    }

    const outcome = await installManagedClaude({
      installId: 'i1',
      onEvent: (e) => events.push(e),
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson: async (url) =>
        url.endsWith('claude-code-linux-x64/2.1.209')
          ? { dist: { tarball: 'https://reg/x.tgz', integrity: sha512(tgz) } }
          : { 'dist-tags': { latest: '2.1.209' } },
      fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length }),
      verifyBinary: async () => '2.1.209',
      renamePath
    })

    expect(outcome.result.ok).toBe(true)
    expect(stagingOwner).toBe('open-science:claude-code:v1\n')
    await expect(readFile(interruptedPayload)).rejects.toThrow()
    expect(outcome.version).toBe('2.1.209')
    expect(outcome.resolvedPath).toBe(join(root, 'claude-code', 'bin', 'claude'))
    expect((await readFile(outcome.resolvedPath as string)).equals(binary)).toBe(true)

    const phases = events.filter((e) => e.kind === 'progress').map((e) => e.phase)
    expect(phases).toEqual(expect.arrayContaining(['resolving', 'downloading', 'extracting']))
    expect(
      events.some(
        (e) =>
          e.kind === 'log' && e.stream === 'system' && /Installed Claude 2\.1\.209/.test(e.chunk)
      )
    ).toBe(true)
  })

  it('aborts an in-flight download and removes its staging directory', async () => {
    const controller = new AbortController()
    const downloadStarted = Promise.withResolvers<void>()
    let downloadSignal: AbortSignal | undefined
    const install = installManagedClaude({
      installId: 'cancel-download',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      version: '2.1.209',
      platform,
      fetchJson: async () => ({
        dist: { tarball: 'https://reg/x.tgz', integrity: `sha512-${'x'.repeat(16)}` }
      }),
      fetchTarball: async (_url, signal) => {
        downloadSignal = signal
        downloadStarted.resolve()
        return { stream: new Readable({ read: () => undefined }) }
      },
      verifyBinary: async () => '2.1.209',
      signal: controller.signal
    })
    await downloadStarted.promise

    controller.abort()

    await expect(install).resolves.toMatchObject({ result: { ok: false } })
    expect(downloadSignal).toBe(controller.signal)
    expect((await readdir(root)).filter((name) => name.includes('.staging-'))).toEqual([])
  })

  it('preserves the existing runtime when the replacement archive is incomplete', async () => {
    const existingPath = join(managedClaudeDir(root), 'claude')
    await mkdir(managedClaudeDir(root), { recursive: true })
    await writeFile(existingPath, 'WORKING-CLAUDE')
    const tgz = buildTgz([{ name: 'package/not-claude', content: Buffer.from('replacement') }])

    const outcome = await installManagedClaude({
      installId: 'preserve-existing',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson: async (url) =>
        url.endsWith('claude-code-linux-x64/2.1.209')
          ? { dist: { tarball: 'https://reg/x.tgz', integrity: sha512(tgz) } }
          : { 'dist-tags': { latest: '2.1.209' } },
      fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length }),
      verifyBinary: async () => '2.1.209'
    })

    expect(outcome.result.ok).toBe(false)
    expect(await readFile(existingPath, 'utf8')).toBe('WORKING-CLAUDE')
  })

  it('rejects a symlinked runtime root without modifying its target', async () => {
    const externalRoot = join(root, 'external-claude')
    const externalMarker = join(externalRoot, '.open-science-managed-runtime')
    const managedRoot = dirname(managedClaudeDir(root))
    await mkdir(externalRoot, { recursive: true })
    await writeFile(externalMarker, 'EXTERNAL-DATA')
    await symlink(externalRoot, managedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const { tgz } = fixture()

    const outcome = await installManagedClaude({
      installId: 'reject-symlinked-root',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson: async (url) =>
        url.endsWith('claude-code-linux-x64/2.1.209')
          ? { dist: { tarball: 'https://reg/x.tgz', integrity: sha512(tgz) } }
          : { 'dist-tags': { latest: '2.1.209' } },
      fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length }),
      verifyBinary: async () => '2.1.209'
    })

    expect(await readFile(externalMarker, 'utf8')).toBe('EXTERNAL-DATA')
    expect(outcome.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/symbolic link/i)
    })
  })

  it('rejects a hard-linked ownership marker without modifying its external inode', async () => {
    const externalMarker = join(root, 'external-claude-marker')
    const managedRoot = dirname(managedClaudeDir(root))
    await mkdir(managedClaudeDir(root), { recursive: true })
    await writeFile(externalMarker, 'EXTERNAL-DATA')
    await link(externalMarker, join(managedRoot, '.open-science-managed-runtime'))
    const { tgz } = fixture()

    const outcome = await installManagedClaude({
      installId: 'reject-hard-linked-marker',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson: async (url) =>
        url.endsWith('claude-code-linux-x64/2.1.209')
          ? { dist: { tarball: 'https://reg/x.tgz', integrity: sha512(tgz) } }
          : { 'dist-tags': { latest: '2.1.209' } },
      fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length }),
      verifyBinary: async () => '2.1.209'
    })

    expect(await readFile(externalMarker, 'utf8')).toBe('EXTERNAL-DATA')
    expect(outcome.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/hard link/i)
    })
  })

  it('restores the existing runtime when publication fails', async () => {
    const existingPath = join(managedClaudeDir(root), 'claude')
    const managedRoot = dirname(managedClaudeDir(root))
    await mkdir(managedClaudeDir(root), { recursive: true })
    await writeFile(existingPath, 'WORKING-CLAUDE')
    const { tgz } = fixture()
    const renamePath = vi.fn(async (...args: Parameters<typeof rename>) => {
      const [source, destination] = args
      if (String(source).includes('.staging-') && String(destination) === managedRoot) {
        throw new Error('swap failed')
      }
      await rename(source, destination)
    })

    const outcome = await installManagedClaude({
      installId: 'restore-existing',
      onEvent: () => undefined,
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson: async (url) =>
        url.endsWith('claude-code-linux-x64/2.1.209')
          ? { dist: { tarball: 'https://reg/x.tgz', integrity: sha512(tgz) } }
          : { 'dist-tags': { latest: '2.1.209' } },
      fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length }),
      verifyBinary: async () => '2.1.209',
      renamePath
    })

    expect(outcome.result).toMatchObject({ ok: false, error: 'swap failed' })
    expect(await readFile(existingPath, 'utf8')).toBe('WORKING-CLAUDE')
    expect((await readdir(root)).filter((name) => name.includes('.backup-'))).toEqual([])
  })

  it('falls back to the next registry when the first fails', async () => {
    const { tgz } = fixture()
    const events: ClaudeInstallEvent[] = []
    const outcome = await installManagedClaude({
      installId: 'i2',
      onEvent: (event) => events.push(event),
      dataRoot: root,
      registries: ['https://bad', 'https://good'],
      platform,
      fetchJson: async (url) => {
        if (url.startsWith('https://bad')) throw new Error('network down')
        return url.includes('claude-code-linux-x64')
          ? { dist: { tarball: 'https://good/x.tgz', integrity: sha512(tgz) } }
          : { 'dist-tags': { latest: '2.1.209' } }
      },
      fetchTarball: async () => ({ stream: Readable.from([tgz]) }),
      verifyBinary: async () => '2.1.209'
    })

    expect(outcome.result.ok).toBe(true)
    expect(outcome.version).toBe('2.1.209')
    expect(
      events.some((event) => event.kind === 'log' && event.chunk.includes('network down'))
    ).toBe(true)
  })

  it('reports failure when every registry fails', async () => {
    const events: ClaudeInstallEvent[] = []
    const outcome = await installManagedClaude({
      installId: 'i3',
      onEvent: (event) => events.push(event),
      dataRoot: root,
      registries: ['https://bad'],
      platform,
      fetchJson: async () => {
        throw new Error('boom')
      },
      fetchTarball: async () => ({ stream: Readable.from([Buffer.from('x')]) }),
      verifyBinary: async () => '2.1.209'
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toContain('boom')
    expect(
      events.some(
        (event) =>
          event.kind === 'log' && event.chunk.includes('No candidate runtime was published')
      )
    ).toBe(true)
  })

  it('turns an out-of-space failure into an actionable install log', async () => {
    const events: ClaudeInstallEvent[] = []
    const outcome = await installManagedClaude({
      installId: 'i4',
      onEvent: (event) => events.push(event),
      dataRoot: root,
      registries: ['https://reg'],
      platform,
      fetchJson: async () => {
        throw Object.assign(new Error('no space left on device, write'), { code: 'ENOSPC' })
      },
      fetchTarball: async () => ({ stream: Readable.from([]) }),
      verifyBinary: async () => '2.1.209'
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toContain('Insufficient disk space')
    expect(
      events.some((event) => event.kind === 'log' && event.chunk.includes('Free some space'))
    ).toBe(true)
  })

  it('returns a structured failure when the staging directory cannot be created', async () => {
    const blockedDataRoot = join(root, 'blocked-data-root')
    const events: ClaudeInstallEvent[] = []
    await writeFile(blockedDataRoot, 'not a directory')

    const outcome = await installManagedClaude({
      installId: 'staging-setup-failure',
      onEvent: (event) => events.push(event),
      dataRoot: blockedDataRoot,
      registries: ['https://reg'],
      platform,
      fetchJson: async () => {
        throw new Error('registry should not be reached')
      },
      fetchTarball: async () => ({ stream: Readable.from([]) }),
      verifyBinary: async () => '2.1.209'
    })

    expect(outcome.result).toMatchObject({ ok: false, error: expect.stringContaining('ENOTDIR') })
    expect(
      events.some(
        (event) => event.kind === 'log' && event.stream === 'system' && /ENOTDIR/.test(event.chunk)
      )
    ).toBe(true)
  })
})

describe('isManagedClaudePath / uninstallManagedClaude', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-claude-uninstall-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('recognizes only a binary that lives directly in the managed bin dir', () => {
    expect(isManagedClaudePath(join(managedClaudeDir(root), 'claude'), root)).toBe(true)
    // A PATH/npm install we merely detected must never be treated as managed.
    expect(isManagedClaudePath('/usr/local/bin/claude', root)).toBe(false)
    // A copy one level deeper is not the managed layout either.
    expect(isManagedClaudePath(join(managedClaudeDir(root), 'nested', 'claude'), root)).toBe(false)
  })

  it('removes the whole managed install tree', async () => {
    const bin = join(managedClaudeDir(root), 'claude')
    await mkdir(managedClaudeDir(root), { recursive: true })
    await writeFile(bin, '', 'utf8')

    await uninstallManagedClaude(root)

    await expect(readFile(bin)).rejects.toThrow()
    // The `claude-code` parent (one level above bin) is gone, not just the file.
    await expect(readFile(join(root, 'claude-code', 'bin', 'claude'))).rejects.toThrow()
  })

  it('removes only owned staging and backup siblings', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const unownedUuid = 'abcdefab-cdef-abcd-efab-cdefabcdefab'
    const stagingMarker = join(root, `claude-code.staging-${uuid}`, 'marker')
    const backupMarker = join(root, `claude-code.backup-${uuid}`, 'marker')
    const unownedMarker = join(root, `claude-code.backup-${unownedUuid}`, 'marker')
    const lookalikeMarker = join(root, 'claude-code.backup-manual', 'marker')
    for (const marker of [stagingMarker, backupMarker, unownedMarker, lookalikeMarker]) {
      await mkdir(dirname(marker), { recursive: true })
      await writeFile(marker, 'present')
    }
    for (const ownedRoot of [dirname(stagingMarker), dirname(backupMarker)]) {
      await writeFile(
        join(ownedRoot, '.open-science-managed-runtime'),
        'open-science:claude-code:v1\n'
      )
    }

    await uninstallManagedClaude(root)

    await expect(readFile(stagingMarker)).rejects.toThrow()
    await expect(readFile(backupMarker)).rejects.toThrow()
    await expect(readFile(unownedMarker, 'utf8')).resolves.toBe('present')
    await expect(readFile(lookalikeMarker, 'utf8')).resolves.toBe('present')
  })

  it('preserves an orphan whose ownership marker is a symbolic link', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const orphanRoot = join(root, `claude-code.backup-${uuid}`)
    const orphanPayload = join(orphanRoot, 'user-data')
    const ownerMarker = join(orphanRoot, '.open-science-managed-runtime')
    await mkdir(orphanRoot, { recursive: true })
    await writeFile(orphanPayload, 'present')
    await writeFile(ownerMarker, 'open-science:claude-code:v1\n')
    // Windows CI cannot create file symlinks without extra privileges. Model the no-follow lstat
    // result at the filesystem boundary while retaining real directory and read/remove behavior.
    nonRegularMarkerPaths.add(ownerMarker)

    await uninstallManagedClaude(root)

    await expect(readFile(orphanPayload, 'utf8')).resolves.toBe('present')
  })

  it('preserves an orphan whose ownership marker has multiple hard links', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const orphanRoot = join(root, `claude-code.backup-${uuid}`)
    const orphanPayload = join(orphanRoot, 'user-data')
    const externalMarker = join(root, 'external-owner-marker')
    await mkdir(orphanRoot, { recursive: true })
    await writeFile(orphanPayload, 'present')
    await writeFile(externalMarker, 'open-science:claude-code:v1\n')
    await link(externalMarker, join(orphanRoot, '.open-science-managed-runtime'))

    await uninstallManagedClaude(root)

    await expect(readFile(orphanPayload, 'utf8')).resolves.toBe('present')
  })

  it('preserves an orphan when its ownership marker changes after metadata validation', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const orphanRoot = join(root, `claude-code.backup-${uuid}`)
    const orphanPayload = join(orphanRoot, 'user-data')
    const ownerMarker = join(orphanRoot, '.open-science-managed-runtime')
    await mkdir(orphanRoot, { recursive: true })
    await writeFile(orphanPayload, 'present')
    await writeFile(ownerMarker, 'unowned\n')
    markerReplacementsOnRead.set(ownerMarker, 'open-science:claude-code:v1\n')

    await uninstallManagedClaude(root)

    await expect(readFile(orphanPayload, 'utf8')).resolves.toBe('present')
  })

  it('is a no-op (never rejects) when nothing is installed', async () => {
    await expect(uninstallManagedClaude(root)).resolves.toBeUndefined()
  })
})
