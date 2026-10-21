import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  SessionPackageInventoryEntry,
  SessionPackageManifest
} from '../../shared/session-package'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import * as usage from '../storage/usage'
import { createPackageMaterializer } from './materialize'
import { parseNativeRecords, prepareNativeImport } from './native-snapshot'
import { COLUMNS } from './records-contract'
import { validatePackageRecords } from './validation'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>())
}))
vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

let root: string
let source: string
let destination: string
const payload = Buffer.alloc(4096, 42)
const checksum = createHash('sha256').update(payload).digest('hex')
const blobKey = (activity: string, project = 'project'): string =>
  `execution-file-evidence/${project}/session/activity-${activity}/blobs/sha256-${checksum}`
const entry = (storageKey: string, path = `objects/${checksum}`): SessionPackageInventoryEntry => ({
  storageKey,
  path,
  checksum,
  sizeBytes: payload.length,
  kind: 'file'
})
const inode = async (path: string): Promise<string> => {
  const info = await fs.stat(path)
  return `${info.dev}:${info.ino}`
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'package-materialize-'))
  source = join(root, 'source')
  destination = join(root, 'destination')
  await fs.mkdir(join(source, 'objects'), { recursive: true })
  await fs.writeFile(join(source, 'objects', checksum), payload)
  vi.spyOn(usage, 'availableBytes').mockResolvedValue(
    LOCAL_RESOURCE_BUDGETS.diskReserveBytes + 1024 ** 3
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it.each(['shared archive object', 'legacy separate objects'])(
  'shares only destination-owned blobs from %s',
  async (layout) => {
    const entries = [entry(blobKey('one')), entry(blobKey('two'))]
    if (layout === 'legacy separate objects') {
      entries[1].path = `objects/${'b'.repeat(64)}`
      await fs.writeFile(join(source, entries[1].path), payload)
    }
    const copy = await createPackageMaterializer(source, destination, entries)
    for (const item of entries) await copy(item)
    const [first, second] = entries.map((item) => join(destination, item.storageKey!))
    expect(await inode(first)).toBe(await inode(second))
    expect(await inode(first)).not.toBe(await inode(join(source, entries[0].path)))
    await fs.rm(source, { recursive: true })
    await fs.rm(first)
    expect(await fs.readFile(second)).toEqual(payload)
  }
)

it('keeps mutable files, metadata, other projects and unknown blob layouts isolated', async () => {
  const entries = [
    entry(blobKey('one')),
    entry(blobKey('two', 'other')),
    entry('notebooks/project/session/data/result.bin'),
    entry('artifacts/project/session/content'),
    entry('execution-file-evidence/project/session/activity-one/evidence.json'),
    entry(`execution-file-evidence/project/session/unknown/blobs/sha256-${checksum}`)
  ]
  const copy = await createPackageMaterializer(source, destination, entries)
  for (const item of entries) await copy(item)
  expect(
    new Set(await Promise.all(entries.map((item) => inode(join(destination, item.storageKey!)))))
      .size
  ).toBe(entries.length)
  await fs.writeFile(join(destination, entries[2].storageKey!), 'changed working file')
  expect(await fs.readFile(join(destination, entries[0].storageKey!))).toEqual(payload)
})

it.each(['ArtifactMessageSnapshot', 'ReviewScopeSnapshot'] as const)(
  'isolates blob-shaped %s metadata before native import rewrites it',
  async (table) => {
    const metadata = JSON.stringify({ projectId: 'project', sessionId: 'session', messages: [] })
    const digest = createHash('sha256').update(metadata).digest('hex')
    await fs.writeFile(join(source, 'objects', digest), metadata)
    const entries = ['evidence', 'metadata'].map((activity) => ({
      ...entry(blobKey(activity).replace(checksum, digest), `objects/${digest}`),
      checksum: digest,
      sizeBytes: Buffer.byteLength(metadata)
    }))
    const records = parseNativeRecords({
      schemaVersion: 1,
      tables: Object.fromEntries(Object.keys(COLUMNS).map((name) => [name, []]))
    })
    records.tables[table].push({
      id: 'snapshot',
      projectId: 'project',
      sessionId: 'session',
      storageKey: entries[1].storageKey!,
      checksum: digest,
      ...(table === 'ReviewScopeSnapshot' ? { snapshotJson: metadata } : {})
    })
    const manifest: SessionPackageManifest = {
      schemaVersion: 1,
      format: 'open-science-session',
      createdAt: 1,
      source: {
        projectId: 'project',
        sessionId: 'session',
        projectName: 'Research',
        title: 'Evidence'
      },
      inventory: entries,
      omissions: [],
      excludedFiles: []
    }
    await prepareNativeImport(source, destination, manifest, records, 'new-project', 'new-session')
    const [evidence, snapshot] = entries.map((item) =>
      join(destination, item.storageKey!.replace('/project/session/', '/new-project/new-session/'))
    )
    expect(await inode(evidence)).not.toBe(await inode(snapshot))
    expect(await fs.readFile(evidence, 'utf8')).toBe(metadata)
    expect(JSON.parse(await fs.readFile(snapshot, 'utf8'))).toMatchObject({
      projectId: 'new-project',
      sessionId: 'new-session'
    })
  }
)

it.each(['notebook-file-evidence', 'file-evidence'])(
  'shares verified %s legacy run and project-pool blobs within one-copy capacity',
  async (namespace) => {
    vi.mocked(usage.availableBytes).mockResolvedValue(
      LOCAL_RESOURCE_BUDGETS.diskReserveBytes + payload.length
    )
    const entries = ['one', 'two'].map((run) =>
      entry(`${namespace}/project/session/frames/frame/run-${run}/blobs/sha256-${checksum}`)
    )
    entries.push(entry(`${namespace}/project/blobs/sha256-${checksum}`))
    const copy = await createPackageMaterializer(source, destination, entries)
    for (const item of entries) await copy(item)
    expect(
      new Set(await Promise.all(entries.map((item) => inode(join(destination, item.storageKey!)))))
        .size
    ).toBe(1)
  }
)

it.each(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'])(
  'falls back to isolated copies when linking fails with %s',
  async (code) => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('link unavailable'), { code }))
    const entries = [entry(blobKey('one')), entry(blobKey('two'))]
    const copy = await createPackageMaterializer(source, destination, entries)
    for (const item of entries) await copy(item)
    const [first, second] = entries.map((item) => join(destination, item.storageKey!))
    expect(await inode(first)).not.toBe(await inode(second))
    expect(await fs.readFile(second)).toEqual(payload)
  }
)

it('budgets unique blobs initially and reserves additional space before fallback writes', async () => {
  vi.mocked(usage.availableBytes).mockResolvedValue(
    LOCAL_RESOURCE_BUDGETS.diskReserveBytes + payload.length
  )
  const entries = [entry(blobKey('one')), entry(blobKey('two')), entry(blobKey('three'))]
  const copy = await createPackageMaterializer(source, destination, entries)
  await copy(entries[0])
  await copy(entries[1])
  vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }))
  await expect(copy(entries[2])).rejects.toThrow('Not enough disk space')
  await expect(fs.stat(join(destination, entries[2].storageKey!))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

it.each([0, 1])(
  'rejects corrupt source bytes at copy %i without publishing that alias',
  async (index) => {
    const entries = [entry(blobKey('one')), entry(blobKey('two'), `objects/${'b'.repeat(64)}`)]
    await fs.writeFile(join(source, entries[1].path), payload)
    const copy = await createPackageMaterializer(source, destination, entries)
    if (index) await copy(entries[0])
    await fs.writeFile(join(source, entries[index].path), Buffer.alloc(payload.length, 1))
    await expect(copy(entries[index])).rejects.toThrow('checksum mismatch')
    await expect(fs.stat(join(destination, entries[index].storageKey!))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  }
)

it('rejects a changed destination seed instead of sharing stale content', async () => {
  const entries = [entry(blobKey('one')), entry(blobKey('two'))]
  const copy = await createPackageMaterializer(source, destination, entries)
  await copy(entries[0])
  await fs.writeFile(join(destination, entries[0].storageKey!), 'changed')
  await expect(copy(entries[1])).rejects.toThrow('materialized content changed')
})

it('never overwrites an existing destination or treats EEXIST as unsupported sharing', async () => {
  const entries = [entry(blobKey('one')), entry(blobKey('two'))]
  const copy = await createPackageMaterializer(source, destination, entries)
  await copy(entries[0])
  const target = join(destination, entries[1].storageKey!)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, 'existing')
  await expect(copy(entries[1])).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await fs.readFile(target, 'utf8')).toBe('existing')
})

it('cleans a just-linked alias on cancellation while preserving the other owner', async () => {
  const entries = [entry(blobKey('one')), entry(blobKey('two'))]
  const controller = new AbortController()
  const copy = await createPackageMaterializer(source, destination, entries, controller.signal)
  await copy(entries[0])
  const reason = new Error('cancel materialization')
  await expect(copy(entries[1], undefined, () => controller.abort(reason))).rejects.toBe(reason)
  await expect(fs.stat(join(destination, entries[1].storageKey!))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect(await fs.readFile(join(destination, entries[0].storageKey!))).toEqual(payload)
})

it('uses sharing in native remapping and disposable validation, leaving source and working files isolated', async () => {
  const entries = [
    entry(blobKey('one')),
    entry(blobKey('two')),
    entry('notebooks/project/session/data/result.bin')
  ]
  const records = parseNativeRecords({
    schemaVersion: 1,
    tables: Object.fromEntries(Object.keys(COLUMNS).map((name) => [name, []]))
  })
  const manifest: SessionPackageManifest = {
    schemaVersion: 1,
    format: 'open-science-session',
    createdAt: 1,
    source: {
      projectId: 'project',
      sessionId: 'session',
      projectName: 'Research',
      title: 'Evidence'
    },
    inventory: entries,
    omissions: [],
    excludedFiles: []
  }
  const links = vi.spyOn(fs, 'link')
  await validatePackageRecords(source, manifest, records, undefined, manifest.source, root)
  expect(links).toHaveBeenCalledOnce()
  expect(
    (await fs.readdir(root)).filter((name) => name.startsWith('open-science-package-validation-'))
  ).toEqual([])
  links.mockClear()
  const result = await prepareNativeImport(
    source,
    destination,
    manifest,
    records,
    'new-project',
    'new-session'
  )
  expect(result.identities.project).toBe('new-project')
  expect(links).toHaveBeenCalledOnce()
  const remapped = entries.map((item) =>
    join(destination, item.storageKey!.replace('/project/session/', '/new-project/new-session/'))
  )
  expect(await inode(remapped[0])).toBe(await inode(remapped[1]))
  expect(await inode(remapped[0])).not.toBe(await inode(remapped[2]))
  await fs.rm(source, { recursive: true })
  await fs.writeFile(remapped[2], 'continued work')
  expect(await fs.readFile(remapped[0])).toEqual(payload)
})
