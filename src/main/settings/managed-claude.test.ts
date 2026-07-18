import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import {
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
      fetchTarball: async () => ({ stream: Readable.from([tgz]), totalBytes: tgz.length })
    })

    expect(outcome.result.ok).toBe(true)
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
      fetchTarball: async () => ({ stream: Readable.from([tgz]) })
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
      fetchTarball: async () => ({ stream: Readable.from([Buffer.from('x')]) })
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toContain('boom')
    expect(
      events.some(
        (event) => event.kind === 'log' && event.chunk.includes('remove the incomplete runtime')
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
      fetchTarball: async () => ({ stream: Readable.from([]) })
    })

    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.error).toContain('Insufficient disk space')
    expect(
      events.some((event) => event.kind === 'log' && event.chunk.includes('Free some space'))
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

  it('is a no-op (never rejects) when nothing is installed', async () => {
    await expect(uninstallManagedClaude(root)).resolves.toBeUndefined()
  })
})
