import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureEnvironmentSnapshot,
  EnvironmentSnapshotInUseError,
  restoreEnvironmentSnapshot,
  materializeEnvironmentSnapshot,
  relocateEnvironmentSnapshot,
  readEnvironmentSnapshot,
  removeEnvironmentSnapshot
} from './environment-snapshot'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    statfs: vi.fn(actual.statfs),
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    writeFile: vi.fn(actual.writeFile)
  }
})

const roots: string[] = []
const fixture = async (): Promise<{ root: string; prefix: string; store: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'environment-snapshot-'))
  roots.push(root)
  const prefix = join(root, 'source'),
    store = join(root, 'store')
  await mkdir(join(prefix, 'lib'), { recursive: true })
  await mkdir(join(prefix, 'conda-meta'))
  await writeFile(join(prefix, 'lib', 'package.py'), 'VERSION = "2"\n')
  await writeFile(join(prefix, 'lib', 'old_only.py'), 'RESIDUAL = True\n')
  await writeFile(join(prefix, 'conda-meta', 'package-1.json'), '{"version":"1"}')
  await writeFile(join(prefix, 'conda-meta', 'package-2.json'), '{"version":"2"}')
  return { root, prefix, store }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('environment file snapshots', () => {
  it('streams text prefixes across read boundaries without changing source bytes', async () => {
    const { root, prefix, store } = await fixture()
    const source = await fs.realpath(prefix)
    const text = `${'a'.repeat(64 * 1024 - 3)}${source}/lib/α\n`.repeat(16)
    await writeFile(join(prefix, 'large.txt'), text)
    const { checksum } = await captureEnvironmentSnapshot(prefix, store)
    const destination = join(root, 'r')
    const snapshot = await materializeEnvironmentSnapshot(store, checksum, destination)
    await relocateEnvironmentSnapshot(snapshot, destination)
    expect(await readFile(join(destination, 'large.txt'), 'utf8')).toBe(
      text.replaceAll(source, await fs.realpath(destination))
    )
    expect(await readFile(join(prefix, 'large.txt'), 'utf8')).toBe(text)
  })

  it('reuses existing file objects without reserving a second full capture', async () => {
    const { prefix, store } = await fixture()
    await writeFile(join(prefix, 'large.dat'), Buffer.alloc(2 * 1024 * 1024, 42))
    const captured = await captureEnvironmentSnapshot(prefix, store)
    const disk = await fs.statfs(prefix)
    vi.mocked(fs.statfs).mockResolvedValue({ ...disk, bsize: 1, bavail: 512 * 1024 * 1024 + 4096 })
    try {
      expect(await captureEnvironmentSnapshot(prefix, store)).toEqual(captured)
    } finally {
      vi.mocked(fs.statfs).mockReset().mockResolvedValue(disk)
    }
  })

  it('streams padded binary prefixes across chunks while batching large zero regions', async () => {
    const { root, prefix, store } = await fixture()
    const source = await fs.realpath(prefix)
    const header = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(65529, 65)])
    const body = Buffer.from(`${source}/lib:${source}/share`)
    const zeros = Buffer.alloc(2 * 1024 * 1024)
    const original = Buffer.concat([header, body, zeros, Buffer.from('tail')])
    await writeFile(join(prefix, 'lib', 'native'), original)
    await writeFile(
      join(prefix, 'conda-meta', 'native.json'),
      JSON.stringify({
        paths_data: {
          paths: [
            {
              _path: 'lib/native',
              sha256_in_prefix: createHash('sha256').update(original).digest('hex')
            }
          ]
        }
      })
    )
    const { checksum, snapshot } = await captureEnvironmentSnapshot(prefix, store)
    const destination = join(root, 'r')
    await materializeEnvironmentSnapshot(store, checksum, destination)
    const open = vi.mocked(fs.open).getMockImplementation()!
    const writes: Array<() => number> = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).includes('.relocating-')) {
        const spy = vi.spyOn(handle, 'write')
        writes.push(() => spy.mock.calls.length)
      }
      return handle
    })
    try {
      await relocateEnvironmentSnapshot(snapshot, destination)
      const restored = await fs.realpath(destination)
      expect(await readFile(join(destination, 'lib', 'native'))).toEqual(
        Buffer.concat([
          header,
          Buffer.from(`${restored}/lib:${restored}/share`),
          Buffer.alloc(2 * (Buffer.byteLength(source) - Buffer.byteLength(restored))),
          zeros,
          Buffer.from('tail')
        ])
      )
      expect(writes.reduce((sum, count) => sum + count(), 0)).toBeLessThan(200)
      expect(await readFile(join(prefix, 'lib', 'native'))).toEqual(original)
    } finally {
      vi.mocked(fs.open).mockImplementation(open)
    }
  })

  it.each(['changed', 'manifest'] as const)(
    'rolls back only new objects after %s capture failure',
    async (failure) => {
      const { root, prefix, store } = await fixture()
      const baseline = await captureEnvironmentSnapshot(prefix, store)
      const baselineObjects = (await readdir(join(store, 'objects'))).sort()
      await writeFile(join(prefix, 'lib', 'package.py'), 'new unpublished package bytes')
      const link = vi.mocked(fs.link).getMockImplementation()!
      const write = vi.mocked(fs.writeFile).getMockImplementation()!
      let changed = false
      vi.mocked(fs.link).mockImplementation(async (...args) => {
        await link(...args)
        if (failure === 'changed' && !changed) {
          changed = true
          await write(join(prefix, 'lib', 'package.py'), 'changed during capture')
        }
      })
      vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
        if (
          failure === 'manifest' &&
          Buffer.isBuffer(args[1]) &&
          args[1].includes(Buffer.from('"schemaVersion":1'))
        )
          throw new Error('manifest publication failed')
        return write(...args)
      })
      try {
        await expect(captureEnvironmentSnapshot(prefix, store)).rejects.toThrow(
          failure === 'changed' ? 'changed during capture' : 'manifest publication failed'
        )
        expect((await readdir(join(store, 'objects'))).sort()).toEqual(baselineObjects)
        const destination = join(root, 'r')
        await materializeEnvironmentSnapshot(store, baseline.checksum, destination)
        expect(await readFile(join(destination, 'lib', 'package.py'), 'utf8')).toBe(
          'VERSION = "2"\n'
        )
      } finally {
        vi.mocked(fs.link).mockImplementation(link)
        vi.mocked(fs.writeFile).mockImplementation(write)
      }
    }
  )

  it('serializes rollback against a concurrent capture adopting the same objects', async () => {
    const { root, prefix, store } = await fixture()
    let proceed!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      proceed = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const link = vi.mocked(fs.link).getMockImplementation()!
    let paused = false
    vi.mocked(fs.link).mockImplementation(async (...args) => {
      await link(...args)
      if (!paused) {
        paused = true
        entered()
        await gate
        await writeFile(join(prefix, 'lib', 'package.py'), 'changed during first capture')
      }
    })
    const first = captureEnvironmentSnapshot(prefix, store)
    const firstResult = expect(first).rejects.toThrow('changed during capture')
    try {
      await started
      const second = captureEnvironmentSnapshot(prefix, store)
      proceed()
      await firstResult
      const captured = await second
      const destination = join(root, 'r')
      await materializeEnvironmentSnapshot(store, captured.checksum, destination)
      expect(await readFile(join(destination, 'lib', 'package.py'), 'utf8')).toBe(
        'changed during first capture'
      )
    } finally {
      proceed()
      vi.mocked(fs.link).mockImplementation(link)
    }
  })

  it('rejects oversized manifests before reading them into memory', async () => {
    const { prefix, store } = await fixture()
    const { checksum } = await captureEnvironmentSnapshot(prefix, store)
    await fs.truncate(join(store, 'objects', checksum), 64 * 1024 * 1024 + 1)
    await expect(readEnvironmentSnapshot(store, checksum)).rejects.toThrow('too large')
  })

  it('rejects insufficient capture space before publishing any object', async () => {
    const { prefix, store } = await fixture()
    const disk = await fs.statfs(prefix)
    vi.mocked(fs.statfs).mockResolvedValueOnce({ ...disk, bavail: 0 })
    await expect(captureEnvironmentSnapshot(prefix, store)).rejects.toThrow('free space')
    expect(await readdir(join(store, 'objects'))).toEqual([])
    expect(await readFile(join(prefix, 'lib', 'package.py'), 'utf8')).toContain('VERSION')
  })

  it('rejects insufficient restore space before creating a clone', async () => {
    const { root, prefix, store } = await fixture()
    const { checksum } = await captureEnvironmentSnapshot(prefix, store)
    const disk = await fs.statfs(prefix)
    vi.mocked(fs.statfs).mockResolvedValueOnce({ ...disk, bavail: 0 })
    const destination = join(root, 'r')
    await expect(materializeEnvironmentSnapshot(store, checksum, destination)).rejects.toThrow(
      'free space'
    )
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a restored prefix when verification process termination is unconfirmed', async () => {
    const { root, prefix, store } = await fixture()
    const { checksum } = await captureEnvironmentSnapshot(prefix, store, {
      runtimeVersion: '3.12.14',
      packages: []
    })
    const destination = join(root, 'r')
    await expect(
      restoreEnvironmentSnapshot(store, checksum, destination, async () => {
        throw new EnvironmentSnapshotInUseError(new Error('timeout'))
      })
    ).rejects.toBeInstanceOf(EnvironmentSnapshotInUseError)
    expect(await readFile(join(destination, 'lib', 'package.py'), 'utf8')).toContain('VERSION')
  })

  it.each(['matching', 'mismatched', 'missing', 'invalid'] as const)(
    'uses cached binary relocation declarations only with matching archive and installed hashes: %s',
    async (evidence) => {
      const { root, prefix, store } = await fixture()
      const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(prefix))
      const bytes = Buffer.from(`terminfo\0${canonical}/share\0`)
      await writeFile(join(prefix, 'lib', 'terminal'), bytes)
      const cache = join(root, 'cache')
      await mkdir(join(cache, 'info'), { recursive: true })
      const archiveHash = createHash('sha256').update('original archive bytes').digest('hex')
      await writeFile(
        join(cache, 'info', 'paths.json'),
        JSON.stringify({
          paths: [
            {
              _path: 'lib/terminal',
              file_mode: 'binary',
              prefix_placeholder: '/build/placeholder',
              ...(evidence === 'missing'
                ? {}
                : { sha256: evidence === 'invalid' ? 'not-a-hash' : archiveHash })
            }
          ]
        })
      )
      await writeFile(
        join(prefix, 'conda-meta', 'terminal.json'),
        JSON.stringify({
          link: { source: cache },
          paths_data: {
            paths: [
              {
                _path: 'lib/terminal',
                sha256_in_prefix: createHash('sha256').update(bytes).digest('hex'),
                ...(evidence === 'missing'
                  ? {}
                  : {
                      sha256:
                        evidence === 'matching'
                          ? archiveHash
                          : evidence === 'invalid'
                            ? 'not-a-hash'
                            : '0'.repeat(64)
                    })
              }
            ]
          }
        })
      )
      const { checksum, snapshot } = await captureEnvironmentSnapshot(prefix, store)
      const file = snapshot.entries.find((entry) => entry.path === 'lib/terminal')
      expect(file).toMatchObject(
        evidence === 'matching' ? { condaBinaryPrefix: true } : { kind: 'file' }
      )
      const destination = join(root, 'r')
      await materializeEnvironmentSnapshot(store, checksum, destination)
      if (evidence === 'matching') {
        await relocateEnvironmentSnapshot(snapshot, destination)
        expect(await readFile(join(destination, 'lib', 'terminal'))).not.toEqual(bytes)
      } else {
        expect(file).not.toHaveProperty('condaBinaryPrefix')
        await expect(relocateEnvironmentSnapshot(snapshot, destination)).rejects.toThrow(
          'evidence is unavailable'
        )
      }
      expect(await readFile(join(prefix, 'lib', 'terminal'))).toEqual(bytes)
    }
  )

  it('relocates installed text and attested padded binaries without replacing residual bytes', async () => {
    const { root, prefix, store } = await fixture()
    const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(prefix))
    const binary = Buffer.concat([
      Buffer.from('7f454c4600', 'hex'),
      Buffer.from(`${canonical}/lib/code`),
      Buffer.alloc(12),
      Buffer.from('tail')
    ])
    await writeFile(join(prefix, 'lib', 'native'), binary)
    await writeFile(join(prefix, 'lib', 'config'), `home=${canonical}\n`)
    await writeFile(
      join(prefix, 'conda-meta', 'native.json'),
      JSON.stringify({
        paths_data: {
          paths: [
            {
              _path: 'lib/native',
              sha256_in_prefix: createHash('sha256').update(binary).digest('hex')
            }
          ]
        }
      })
    )
    const { checksum, snapshot } = await captureEnvironmentSnapshot(prefix, store)
    const destination = join(root, 'r')
    await materializeEnvironmentSnapshot(store, checksum, destination)
    await relocateEnvironmentSnapshot(snapshot, destination)
    const restored = await import('node:fs/promises').then(({ realpath }) => realpath(destination))
    expect(await readFile(join(destination, 'lib', 'config'), 'utf8')).toBe(`home=${restored}\n`)
    const patched = await readFile(join(destination, 'lib', 'native'))
    expect(patched.length).toBe(binary.length)
    expect(patched.includes(Buffer.from(`${restored}/lib/code\0`))).toBe(true)
    expect(patched.subarray(-4).toString()).toBe('tail')
    expect(await readFile(join(prefix, 'lib', 'native'))).toEqual(binary)
  })

  it.skipIf(process.platform === 'win32')(
    'cleans an isolated snapshot with read-only package directories',
    async () => {
      const { root, prefix, store } = await fixture()
      await chmod(join(prefix, 'lib'), 0o555)
      try {
        const { checksum } = await captureEnvironmentSnapshot(prefix, store)
        const destination = join(root, 'restored')
        await materializeEnvironmentSnapshot(store, checksum, destination)
        await removeEnvironmentSnapshot(destination)
        await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(join(prefix, 'lib'))).mode & 0o777).toBe(0o555)
      } finally {
        await chmod(join(prefix, 'lib'), 0o755)
      }
    }
  )

  it('rejects binary serialization even when Conda records its installed checksum', async () => {
    const { root, prefix, store } = await fixture()
    const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(prefix))
    const bytes = Buffer.from(`serialized\0${canonical}/data\0`)
    await writeFile(join(prefix, 'lib', 'object'), bytes)
    await writeFile(
      join(prefix, 'conda-meta', 'object.json'),
      JSON.stringify({
        paths_data: {
          paths: [
            {
              _path: 'lib/object',
              sha256_in_prefix: createHash('sha256').update(bytes).digest('hex')
            }
          ]
        }
      })
    )
    const { checksum, snapshot } = await captureEnvironmentSnapshot(prefix, store)
    const destination = join(root, 'r')
    await materializeEnvironmentSnapshot(store, checksum, destination)
    await expect(relocateEnvironmentSnapshot(snapshot, destination)).rejects.toThrow(
      'evidence is unavailable'
    )
    expect(await readFile(join(prefix, 'lib', 'object'))).toEqual(bytes)
  })

  it('rejects an unverified binary prefix instead of certifying a relocatable environment', async () => {
    const { root, prefix, store } = await fixture()
    const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(prefix))
    await writeFile(join(prefix, 'lib', 'native'), Buffer.from(`\0${canonical}/lib/code\0`))
    const { checksum, snapshot } = await captureEnvironmentSnapshot(prefix, store)
    const destination = join(root, 'r')
    await materializeEnvironmentSnapshot(store, checksum, destination)
    await expect(relocateEnvironmentSnapshot(snapshot, destination)).rejects.toThrow(
      'evidence is unavailable'
    )
  })

  it('preserves the installed mixture, deduplicates captures and does not hardlink restored writes', async () => {
    const { root, prefix, store } = await fixture()
    const first = await captureEnvironmentSnapshot(prefix, store)
    const objects = await readdir(join(store, 'objects'))
    expect(await captureEnvironmentSnapshot(prefix, store)).toEqual(first)
    expect(await readdir(join(store, 'objects'))).toEqual(objects)
    const restored = join(root, 'restored')
    await materializeEnvironmentSnapshot(store, first.checksum, restored)
    expect(await readdir(join(restored, 'conda-meta'))).toEqual([
      'package-1.json',
      'package-2.json'
    ])
    expect(await readFile(join(restored, 'lib', 'old_only.py'), 'utf8')).toContain('RESIDUAL')
    await writeFile(join(restored, 'lib', 'package.py'), 'changed')
    expect(await readFile(join(prefix, 'lib', 'package.py'), 'utf8')).toBe('VERSION = "2"\n')
    const second = join(root, 'second')
    await materializeEnvironmentSnapshot(store, first.checksum, second)
    expect(await readFile(join(second, 'lib', 'package.py'), 'utf8')).toBe('VERSION = "2"\n')
  })

  it('rejects damaged payloads and removes an incomplete materialization', async () => {
    const { root, prefix, store } = await fixture()
    const capture = await captureEnvironmentSnapshot(prefix, store)
    const file = capture.snapshot.entries.find((entry) => entry.kind === 'file')!
    if (file.kind !== 'file') throw new Error('Missing fixture file')
    await writeFile(join(store, 'objects', file.checksum), 'damaged')
    const restored = join(root, 'restored')
    await expect(materializeEnvironmentSnapshot(store, capture.checksum, restored)).rejects.toThrow(
      /checksum|size/
    )
    await expect(lstat(restored)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['../outside', '/absolute', 'C:/outside', 'lib\\outside'])(
    'rejects nonportable manifest path %s',
    async (path) => {
      const { prefix, store } = await fixture()
      const { snapshot } = await captureEnvironmentSnapshot(prefix, store)
      snapshot.entries[0]!.path = path
      const bytes = JSON.stringify(snapshot),
        checksum = createHash('sha256').update(bytes).digest('hex')
      await writeFile(join(store, 'objects', checksum), bytes)
      await expect(readEnvironmentSnapshot(store, checksum)).rejects.toThrow('path')
    }
  )

  it('does not materialize over an existing directory or inside the source', async () => {
    const { prefix, store } = await fixture()
    const { checksum } = await captureEnvironmentSnapshot(prefix, store)
    await expect(materializeEnvironmentSnapshot(store, checksum, prefix)).rejects.toThrow('source')
    await expect(
      materializeEnvironmentSnapshot(store, checksum, join(prefix, 'nested'))
    ).rejects.toThrow('source')
    await expect(materializeEnvironmentSnapshot(store, checksum, store)).rejects.toMatchObject({
      code: 'EEXIST'
    })
    expect(await readdir(join(store, 'objects'))).not.toHaveLength(0)
  })

  it.skipIf(process.platform === 'win32')(
    'relocates internal symlink chains and preserves executable modes',
    async () => {
      const { root, prefix, store } = await fixture()
      await chmod(join(prefix, 'lib', 'package.py'), 0o755)
      await symlink(join(prefix, 'lib', 'package.py'), join(prefix, 'z-link'))
      await symlink('z-link', join(prefix, 'a-link'))
      const { checksum } = await captureEnvironmentSnapshot(prefix, store)
      const restored = join(root, 'restored')
      await materializeEnvironmentSnapshot(store, checksum, restored)
      await writeFile(join(restored, 'lib', 'package.py'), 'restored')
      expect(await readFile(join(restored, 'a-link'), 'utf8')).toBe('restored')
      expect((await lstat(join(restored, 'lib', 'package.py'))).mode & 0o777).toBe(0o755)
      expect(await readFile(join(prefix, 'a-link'), 'utf8')).toBe('VERSION = "2"\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects external links without changing the target',
    async () => {
      const { root, prefix, store } = await fixture()
      const external = join(root, 'outside')
      await writeFile(external, 'unchanged')
      await symlink(external, join(prefix, 'outside'))
      await expect(captureEnvironmentSnapshot(prefix, store)).rejects.toThrow(
        'external symbolic link'
      )
      expect(await readFile(external, 'utf8')).toBe('unchanged')
    }
  )
})
