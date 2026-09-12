import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Header, Pax, c } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionPackageService } from './service'
import { withPackageTransfer } from './transfer'
import { packageInventoryEntrySchema } from '../../shared/session-package'
import { executionEvidenceSchema } from './execution-evidence'
import * as storageUsage from '../storage/usage'

const directories: string[] = []

it('rejects cumulative expansion before creating an entry that exceeds free space', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'science-package-expansion-space-'))
  directories.push(directory)
  const chunks: Buffer[] = []
  for (const id of ['a', 'b']) {
    const header = Buffer.alloc(512)
    new Header({ path: `objects/${id.repeat(64)}`, type: 'File', size: 512 }).encode(header)
    chunks.push(header, Buffer.alloc(512))
  }
  const archive = join(directory, 'expansion.science')
  await writeFile(archive, Buffer.concat([...chunks, Buffer.alloc(1024)]))
  const capacity = vi.spyOn(storageUsage, 'availableBytes').mockResolvedValue(2 * 1024 ** 3 + 800)
  const service = new SessionPackageService({
    storageRoot: directory,
    getClient: async () => {
      throw new Error('Application database must not be reached')
    }
  })
  await expect(service.inspect(archive)).rejects.toThrow('Not enough disk space')
  expect(capacity).toHaveBeenCalledTimes(1)
})

it('accepts 32 GiB inventory and execution evidence, rejecting one byte over', () => {
  const checksum = 'a'.repeat(64)
  const entry = { path: `objects/${checksum}`, kind: 'file', checksum, sizeBytes: 32 * 1024 ** 3 }
  const evidence = (sizeBytes: number): unknown => ({
    schemaVersion: 1,
    evidenceId: 'evidence',
    activityId: 'activity',
    activityKind: 'notebook-run',
    relations: [
      { generation: { generationId: 'generation', checksum, contentStorageKey: 'file', sizeBytes } }
    ]
  })
  expect(packageInventoryEntrySchema.safeParse(entry).success).toBe(true)
  expect(executionEvidenceSchema.safeParse(evidence(entry.sizeBytes)).success).toBe(true)
  expect(
    packageInventoryEntrySchema.safeParse({ ...entry, sizeBytes: entry.sizeBytes + 1 }).success
  ).toBe(false)
  expect(executionEvidenceSchema.safeParse(evidence(entry.sizeBytes + 1)).success).toBe(false)
})

it.each(['base-256', 'pax'])(
  'accepts a 32 GiB %s header but rejects its truncated body',
  async (encoding) => {
    const directory = await mkdtemp(join(tmpdir(), 'science-package-large-header-'))
    directories.push(directory)
    const entry = { path: `objects/${'a'.repeat(64)}`, type: 'File' as const, size: 32 * 1024 ** 3 }
    const header = Buffer.alloc(512)
    new Header({ ...entry, size: encoding === 'pax' ? 0 : entry.size }).encode(header)
    const pax =
      encoding === 'pax'
        ? new Pax({ path: entry.path, size: entry.size }).encode()!
        : Buffer.alloc(0)
    const archive = join(directory, 'truncated.science')
    await writeFile(archive, Buffer.concat([pax, header, Buffer.alloc(1024)]))
    const service = new SessionPackageService({
      storageRoot: directory,
      getClient: async () => {
        throw new Error('Application database must not be reached')
      }
    })
    await expect(service.inspect(archive)).rejects.toThrow('Truncated input')
  }
)

// NTFS extension may reserve the full length; keep this sparse metadata probe on POSIX hosts.
it.skipIf(process.platform === 'win32')(
  'rejects an archive over 256 GiB before reading its contents',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'science-package-archive-limit-'))
    directories.push(directory)
    const archive = join(directory, 'oversized.science')
    const handle = await open(archive, 'wx')
    try {
      await handle.truncate(256 * 1024 ** 3 + 1)
    } finally {
      await handle.close()
    }
    const service = new SessionPackageService({
      storageRoot: directory,
      getClient: async () => {
        throw new Error('Application database must not be reached')
      }
    })
    await expect(service.inspect(archive)).rejects.toThrow('exceeds the archive limit')
  }
)

it('cancels while decompressed output is waiting for its I/O budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'science-package-paced-extract-'))
  directories.push(directory)
  await mkdir(join(directory, 'objects'))
  const name = `objects/${'a'.repeat(64)}`
  await writeFile(join(directory, name), Buffer.alloc(2 * 1024 ** 2))
  const archive = join(directory, 'source.science')
  await c({ cwd: directory, file: archive, gzip: true }, [name])
  const controller = new AbortController()
  let read!: () => void
  const reading = new Promise<void>((resolve) => {
    read = resolve
  })
  let slow = false
  const service = new SessionPackageService({
    storageRoot: directory,
    getClient: async () => {
      throw new Error('Application database must not be reached')
    }
  })
  const pending = withPackageTransfer(
    () => service.inspect(archive, controller.signal),
    () => (slow ? 1 : 64 * 1024 ** 2),
    () => {
      slow = true
      read()
    }
  )
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await reading
  controller.abort()
  await cancelled
  expect((await stat(archive)).isFile()).toBe(true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it.each([
  { path: '../escaped', type: 'File', size: 0 },
  { path: '/absolute', type: 'File', size: 0 },
  { path: `objects/${'a'.repeat(64)}`, type: 'SymbolicLink', linkpath: '../../escaped', size: 0 },
  { path: `objects/${'a'.repeat(64)}`, type: 'Link', linkpath: 'session.json', size: 0 },
  { path: `objects/${'a'.repeat(64)}`, type: 'File', size: 32 * 1024 ** 3 + 1 },
  { path: 'records.json', type: 'File', size: 256 * 1024 ** 2 + 1 },
  { path: 'manifest.json', type: 'File', size: 8 * 1024 ** 2 + 1 }
] as const)(
  'rejects an unsafe archive entry before touching the application database: $type $path',
  async (entry) => {
    const directory = await mkdtemp(join(tmpdir(), 'science-package-hostile-'))
    directories.push(directory)
    const buffer = Buffer.alloc(512)
    new Header(entry).encode(buffer)
    const archive = join(directory, 'unsafe.science')
    await writeFile(archive, Buffer.concat([buffer, Buffer.alloc(1024)]))
    const service = new SessionPackageService({
      storageRoot: directory,
      getClient: async () => {
        throw new Error('Application database must not be reached')
      }
    })
    await expect(service.inspect(archive)).rejects.toThrow('unsafe, duplicate or oversized entry')
  }
)

it('rejects duplicate archive entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'science-package-duplicate-'))
  directories.push(directory)
  const header = Buffer.alloc(512)
  new Header({ path: 'session.json', type: 'File', size: 0 }).encode(header)
  const archive = join(directory, 'duplicate.science')
  await writeFile(archive, Buffer.concat([header, header, Buffer.alloc(1024)]))
  const service = new SessionPackageService({
    storageRoot: directory,
    getClient: async () => {
      throw new Error('Application database must not be reached')
    }
  })
  await expect(service.inspect(archive)).rejects.toThrow('unsafe, duplicate or oversized entry')
})
