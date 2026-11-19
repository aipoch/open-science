import {
  readPackageArchive,
  packageEntry,
  validatePackageDirectory,
  writePackageArchive,
  PACKAGE_REQUIRES_UPDATE
} from './archive'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Header, Pax, c, t } from 'tar'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionPackageService } from './service'
import { withPackageTransfer } from './transfer'
import { withFileIoPacing } from '../file-io-pacing'
import {
  PACKAGE_INSTRUCTION_PATH,
  PACKAGE_MAX_INSTRUCTION_BYTES,
  packageInventoryEntrySchema,
  type SessionPackageManifest
} from '../../shared/session-package'
import { PACKAGE_INSTRUCTION } from './opening-guide'
import {
  compactLaneViews,
  indexPortableEvidence,
  installLaneLogs,
  readLoggedEvidence,
  portableEvidenceSchema,
  remapLogEvidence,
  type PortableEvidence
} from '../artifacts/execution-evidence-log'
import { executionEvidenceSchema, readExecutionEvidence } from './execution-evidence'
import * as storageUsage from '../storage/usage'
import { sha256 } from '../artifacts/provenance-canonical'

const directories: string[] = []

const openingGuideFixture = async (): Promise<{
  root: string
  source: string
  manifest: SessionPackageManifest
  guide: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'science-package-opening-guide-'))
  directories.push(root)
  const source = join(root, 'source')
  const manifest = await readPackageArchive(
    join(__dirname, 'fixtures/session-package-v0.31.1-minimal.science'),
    source
  )
  const guide = join(source, PACKAGE_INSTRUCTION_PATH)
  await writeFile(guide, PACKAGE_INSTRUCTION)
  manifest.inventory.push(await packageEntry(source, PACKAGE_INSTRUCTION_PATH, 'readme'))
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  return { root, source, manifest, guide }
}

it('writes an early opening guide in a standard gzip member that also works without its comment', async () => {
  const { root, source, manifest } = await openingGuideFixture()
  const archive = join(root, 'sample.science')
  await writePackageArchive(source, archive)
  const paths: string[] = []
  await t({ file: archive, onReadEntry: (entry) => void paths.push(entry.path) })
  expect(paths.slice(0, 2)).toEqual(['manifest.json', PACKAGE_INSTRUCTION_PATH])
  expect(paths).toContain('README.md')
  const bytes = await readFile(archive)
  expect([...bytes.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 0x10])
  const commentEnd = bytes.indexOf(0, 10)
  expect(bytes.toString('ascii', 10, commentEnd)).toBe(
    'Open-Science session package (tar archive). See instruction-for-agent.md for opening guidance.'
  )
  const control = Buffer.concat([bytes.subarray(0, 10), bytes.subarray(commentEnd + 1)])
  control[3] &= ~0x10
  expect(gunzipSync(control)).toEqual(gunzipSync(bytes))
  const controlArchive = join(root, 'control.science')
  await writeFile(controlArchive, control)
  for (const path of [archive, controlArchive]) {
    const output = await mkdtemp(join(root, 'read-'))
    await expect(readPackageArchive(path, output)).resolves.toEqual(manifest)
    const exportedGuide = await readFile(join(output, PACKAGE_INSTRUCTION_PATH), 'utf8')
    expect(exportedGuide).toBe(PACKAGE_INSTRUCTION)
    expect(exportedGuide).toContain('# Open this Open-Science session package')
    expect(exportedGuide).not.toMatch(/\bOpen ?Science\b/)
  }
})

it.each(['tampered', 'missing', 'undeclared', 'duplicate', 'oversized'] as const)(
  'rejects a %s opening guide before import',
  async (fault) => {
    const { root, source, manifest, guide } = await openingGuideFixture()
    const paths = ['manifest.json', ...manifest.inventory.map((entry) => entry.path)]
    if (fault === 'missing') paths.pop()
    if (fault === 'undeclared') {
      manifest.inventory.pop()
      await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
    }
    if (fault === 'duplicate') paths.push(PACKAGE_INSTRUCTION_PATH)
    if (fault === 'oversized')
      await writeFile(guide, Buffer.alloc(PACKAGE_MAX_INSTRUCTION_BYTES + 1))
    if (fault === 'tampered')
      await writeFile(guide, 'x'.repeat(Buffer.byteLength(PACKAGE_INSTRUCTION)))
    const archive = join(root, 'invalid.science')
    await c({ cwd: source, file: archive, gzip: true }, paths)
    const expected = {
      tampered: /checksum|integrity/i,
      missing: /ENOENT|incomplete/i,
      undeclared: /incomplete/i,
      duplicate: /duplicate/i,
      oversized: /oversized/i
    }
    await expect(readPackageArchive(archive, join(root, 'read'))).rejects.toThrow(expected[fault])
  }
)

it('never accepts an opening guide as stored Session content', async () => {
  const { manifest } = await openingGuideFixture()
  const entry = manifest.inventory.find((item) => item.path === PACKAGE_INSTRUCTION_PATH)
  expect(packageInventoryEntrySchema.safeParse(entry).success).toBe(true)
  expect(packageInventoryEntrySchema.safeParse({ ...entry, kind: 'file' }).success).toBe(false)
  expect(
    packageInventoryEntrySchema.safeParse({
      ...entry,
      storageKey: 'artifacts/project/session/file'
    }).success
  ).toBe(false)
  expect(packageInventoryEntrySchema.safeParse({ ...entry, path: 'instruction.md' }).success).toBe(
    false
  )
})

it('bounds selected log records, their views and expanded generations when reading one activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-budget-'))
  directories.push(root)
  const lane = 'execution-file-evidence/p/s'
  const key = lane + '/activity-small/evidence.json'
  const path = 'a'.repeat(800)
  const sum = sha256('input')
  const rows: [string, string, number][] = [[path, sum, 5]]
  const view = sha256(JSON.stringify(rows))
  const body = {
    activityId: 'small',
    activityKind: 'notebook-run',
    evidenceId: 'small-evidence',
    relations: []
  }
  const digest = sha256(JSON.stringify(body, null, 2) + '\n')
  const small = {
    version: 1 as const,
    activityId: 'small',
    pre: view,
    post: view,
    checksum: digest,
    detail: JSON.stringify(body)
  }
  const large = {
    ...small,
    activityId: 'large',
    detail: JSON.stringify({
      ...body,
      activityId: 'large',
      evidenceId: Array.from({ length: 4000 }, (_, i) => sha256(String(i))).join('')
    })
  }
  await installLaneLogs(root, [{ key: lane, views: { [view]: rows }, records: [large, small] }])
  expect((await readLoggedEvidence(root, key, digest, 2048)).toString()).toBe(
    JSON.stringify(body, null, 2) + '\n'
  )
  await expect(readLoggedEvidence(root, key, digest, 650)).rejects.toThrow(/limit/i)
  await expect(
    readLoggedEvidence(root, lane + '/activity-large/evidence.json', digest, 2048)
  ).rejects.toThrow(/read limit/)
  const log = join(root, lane, '.shadow-evidence', 'log.jsonl')
  const [largeLine, smallLine] = (await readFile(log, 'utf8')).trimEnd().split('\n')
  await writeFile(log, largeLine.slice(0, -64) + '0'.repeat(64) + '\n' + smallLine + '\n')
  await expect(readLoggedEvidence(root, key, digest, 2048)).rejects.toThrow(/Invalid portable/)
  const detail = JSON.stringify({
    ...body,
    relations: Array.from({ length: 30 }, () => ({ generation: [0, 0, 'g', 'now'] }))
  })
  const otherLane = lane + '2'
  await installLaneLogs(root, [
    { key: otherLane, views: { [view]: rows }, records: [{ ...small, detail }] }
  ])
  await expect(
    readLoggedEvidence(root, otherLane + '/activity-small/evidence.json', digest, 2048)
  ).rejects.toThrow(/read limit/)
  const tinyLane = lane + '4'
  const emptyView = sha256('[]')
  const rawBytes = Buffer.from(JSON.stringify(body, null, 2) + '\n')
  await installLaneLogs(root, [
    {
      key: tinyLane,
      views: { [emptyView]: [] },
      records: [{ ...small, pre: emptyView, post: emptyView }]
    }
  ])
  expect((await stat(join(root, tinyLane, '.shadow-evidence', 'log.jsonl'))).size).toBeGreaterThan(
    rawBytes.length
  )
  const tinyKey = tinyLane + '/activity-small/evidence.json'
  await expect(readLoggedEvidence(root, tinyKey, digest, rawBytes.length)).resolves.toEqual(
    rawBytes
  )
  await expect(readLoggedEvidence(root, tinyKey, digest, rawBytes.length - 1)).rejects.toThrow(
    /read limit/
  )
  const bombLane = lane + '3'
  await installLaneLogs(root, [
    {
      key: bombLane,
      views: { [view]: rows },
      records: [{ ...small, detail: JSON.stringify({ ...body, padding: 'x'.repeat(64 * 1024) }) }]
    }
  ])
  await expect(
    readLoggedEvidence(root, bombLane + '/activity-small/evidence.json', digest, 2048)
  ).rejects.toThrow(/2048|buffer|larger/i)
})

it('verifies source sidecars and view identities before mapping log evidence', () => {
  const path = 'data/result.csv'
  const checksum = sha256('data')
  const rows: [string, string, number][] = [[path, checksum, 4]]
  const view = sha256(JSON.stringify(rows))
  const prefix = 'execution-file-evidence/project/session'
  const original = {
    version: 1,
    activityId: 'run',
    evidenceId: 'evidence-run',
    activityKind: 'notebook-run',
    relations: [
      {
        generation: {
          generationId: 'gen',
          relativePath: path,
          checksum,
          sizeBytes: 4,
          contentStorageKey: prefix + '/activity-run/blobs/sha256-' + checksum,
          capturedAt: 'now'
        }
      }
    ]
  }
  const hash = sha256(JSON.stringify(original, null, 2) + '\n')
  const detail = JSON.stringify({ ...original, relations: [{ generation: [0, 0, 'gen', 'now'] }] })
  const lane: PortableEvidence[number] = {
    key: prefix,
    views: { [view]: rows },
    records: [{ version: 1, activityId: 'run', checksum: hash, pre: view, post: view, detail }]
  }
  expect(indexPortableEvidence([lane]).size).toBe(1)
  const bad = structuredClone(lane)
  bad.records[0].checksum = '0'.repeat(64)
  expect(() => indexPortableEvidence([bad])).toThrow()
  expect(() =>
    indexPortableEvidence([
      { ...lane, views: { [view]: { base: view, removed: [], changed: [] } } }
    ])
  ).toThrow()
  expect(
    portableEvidenceSchema.safeParse([
      { ...lane, views: { [view]: [[...rows[0], 'generation-id']] } }
    ]).success
  ).toBe(false)
  expect(() =>
    remapLogEvidence(
      [lane],
      { run: 'next', 'evidence-run': 'next-evidence', gen: 'next-gen' },
      sha256('manifest'),
      (value) => value,
      () => prefix
    )
  ).toThrow()
  const other = structuredClone(lane)
  const secondRows = Array.from({ length: 10 }, (_, i): [string, string, number] => [
    'data/' + i,
    checksum,
    4
  ])
  const second = sha256(JSON.stringify(secondRows))
  const thirdRows = secondRows.slice(1)
  const third = sha256(JSON.stringify(thirdRows))
  other.views = { [second]: secondRows, [third]: thirdRows }
  other.records[0] = { ...other.records[0], pre: second, post: third }
  expect(compactLaneViews(other).views[third]).toEqual({
    base: second,
    changed: [],
    removed: ['data/0']
  })
})

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

it('deduplicates identical content objects in a self-contained package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'science-package-content-dedupe-'))
  directories.push(directory)
  const session = JSON.stringify({ version: 2, session: { id: 'session' } })
  const records = JSON.stringify({ schemaVersion: 1, tables: {} })
  const readme = 'Content dedupe fixture'
  const content = Buffer.from('identical version bytes')
  const checksum = sha256(content)
  const objectPath = `objects/${checksum}`
  await mkdir(join(directory, 'objects'))
  await writeFile(join(directory, 'session.json'), session)
  await writeFile(join(directory, 'records.json'), records)
  await writeFile(join(directory, 'README.md'), readme)
  await writeFile(join(directory, objectPath), content)
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      format: 'open-science-session',
      requiredFeatures: ['content-dedupe'],
      schemaVersion: 1,
      createdAt: 1,
      source: {
        projectId: 'project',
        sessionId: 'session',
        projectName: 'Research',
        title: 'Content dedupe'
      },
      inventory: [
        {
          path: 'session.json',
          kind: 'session',
          sizeBytes: Buffer.byteLength(session),
          checksum: sha256(session)
        },
        {
          path: 'records.json',
          kind: 'records',
          sizeBytes: Buffer.byteLength(records),
          checksum: sha256(records)
        },
        {
          path: 'README.md',
          kind: 'readme',
          sizeBytes: Buffer.byteLength(readme),
          checksum: sha256(readme)
        },
        {
          path: objectPath,
          kind: 'file',
          sizeBytes: content.byteLength,
          checksum,
          storageKey: 'artifacts/project/session/artifact/managed-versions/v1_result.csv'
        },
        {
          path: objectPath,
          kind: 'file',
          sizeBytes: content.byteLength,
          checksum,
          storageKey: 'artifacts/project/session/artifact/managed-versions/v2_result.csv'
        }
      ],
      excludedFiles: [],
      omissions: []
    })
  )
  const archive = join(directory, 'deduplicated.science')

  await writePackageArchive(directory, archive)
  const extracted = join(directory, 'extracted')
  const manifest = await readPackageArchive(archive, extracted)

  expect(manifest.requiredFeatures).toContain('content-dedupe')
  expect(manifest.inventory.filter((entry) => entry.storageKey).map((entry) => entry.path)).toEqual(
    [objectPath, objectPath]
  )
  await expect(readdir(join(extracted, 'objects'))).resolves.toEqual([checksum])
  await expect(readFile(join(extracted, objectPath))).resolves.toEqual(content)
  let readBytes = 0
  await withFileIoPacing(
    async (bytes) => {
      readBytes += bytes
    },
    () => validatePackageDirectory(extracted)
  )
  expect(readBytes).toBe(
    Buffer.byteLength(session) +
      Buffer.byteLength(records) +
      Buffer.byteLength(readme) +
      content.length * (process.platform === 'win32' ? 2 : 1)
  )
  // Export may omit optional objects; default import validation and required aliases stay strict.
  const keys = manifest.inventory.flatMap((entry) => (entry.storageKey ? [entry.storageKey] : []))
  await rm(join(extracted, objectPath))
  await expect(validatePackageDirectory(extracted)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    validatePackageDirectory(extracted, undefined, undefined, undefined, new Set([keys[0]]))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    validatePackageDirectory(extracted, undefined, undefined, undefined, new Set(keys))
  ).resolves.toEqual(manifest)
  await writeFile(join(extracted, objectPath), content)
  // Reusing object bytes must not accept an alias that claims different content.
  manifest.inventory[manifest.inventory.length - 1].checksum = 'b'.repeat(64)
  await writeFile(join(extracted, 'manifest.json'), JSON.stringify(manifest))
  await expect(validatePackageDirectory(extracted)).rejects.toThrow('duplicate entries')
})

it('bounds the reconstructed size of content-dedupe aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'science-package-content-dedupe-limit-'))
  directories.push(directory)
  const checksum = 'a'.repeat(64)
  const objectPath = `objects/${checksum}`
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      format: 'open-science-session',
      requiredFeatures: ['content-dedupe'],
      schemaVersion: 1,
      createdAt: 1,
      source: {
        projectId: 'project',
        sessionId: 'session',
        projectName: 'Research',
        title: 'Oversized reconstruction'
      },
      inventory: Array.from({ length: 9 }, (_, index) => ({
        path: objectPath,
        kind: 'file',
        sizeBytes: 32 * 1024 ** 3,
        checksum,
        storageKey: `artifacts/project/session/artifact/managed-versions/v${index}_result.csv`
      })),
      excludedFiles: [],
      omissions: []
    })
  )

  await expect(validatePackageDirectory(directory)).rejects.toThrow('reconstructed content limit')
})

it.each(['base-256', 'pax'])(
  'accepts a 32 GiB %s header but rejects its truncated body',
  async (encoding) => {
    const directory = await mkdtemp(join(tmpdir(), 'science-package-large-header-'))
    directories.push(directory)
    // Exercise header decoding and truncation independently of the runner's free disk space.
    vi.spyOn(storageUsage, 'availableBytes').mockResolvedValue(64 * 1024 ** 3)
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

it('normalizes only a valid legacy Notebook evidence owner', () => {
  const legacy = {
    schemaVersion: 1,
    evidenceId: 'notebook-file-evidence-run-1',
    runId: 'run-1',
    relations: []
  }
  expect(readExecutionEvidence(legacy)).toMatchObject({
    activityId: 'run-1',
    activityKind: 'notebook-run'
  })
  expect(() => readExecutionEvidence({ ...legacy, evidenceId: 'unrelated' })).toThrow()
  expect(() => readExecutionEvidence({ ...legacy, activityKind: 'compute-job' })).toThrow()
  expect(() => readExecutionEvidence(null)).toThrow()
})

// Unknown future members may precede the compatibility header; none may be extracted.
it.each(
  [
    { schemaVersion: 2 },
    { schemaVersion: 1, requiredFeatures: ['future-capability'] },
    { schemaVersion: 1, requiredFeatures: ['literature', 'ro-crate', 'future-capability'] }
  ].flatMap((header) => [true, false].map((manifestFirst) => ({ header, manifestFirst })))
)(
  'requires an update before accepting future package $header (manifest first: $manifestFirst)',
  async ({ header, manifestFirst }) => {
    const directory = await mkdtemp(join(tmpdir(), 'science-package-future-'))
    directories.push(directory)
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ format: 'open-science-session', ...header })
    )
    await mkdir(join(directory, 'future'))
    await writeFile(join(directory, 'future', 'metadata.json'), '{}')
    const archive = join(directory, 'future.science')
    await c(
      { cwd: directory, file: archive, gzip: true },
      manifestFirst ? ['manifest.json', 'future'] : ['future', 'manifest.json']
    )
    const extracted = join(directory, 'extracted')
    await expect(readPackageArchive(archive, extracted)).rejects.toThrow(PACKAGE_REQUIRES_UPDATE)
    await expect(stat(join(extracted, 'future'))).rejects.toMatchObject({ code: 'ENOENT' })
    const getClient = vi.fn(async () => {
      throw new Error('Application database must not be reached')
    })
    const service = new SessionPackageService({ storageRoot: directory, getClient })
    try {
      await expect(service.importFrom(archive)).rejects.toThrow(PACKAGE_REQUIRES_UPDATE)
      expect(getClient).not.toHaveBeenCalled()
    } finally {
      await service.close()
    }
  }
)

it.each([
  { format: 'another-format', schemaVersion: 2 },
  { format: 'open-science-session', schemaVersion: '2' },
  { format: 'open-science-session', schemaVersion: 1, requiredFeatures: [123] },
  { format: 'open-science-session', schemaVersion: 1 }
])(
  'does not label malformed, foreign or unsupported undeclared entries as a newer package: %j',
  async (header) => {
    const directory = await mkdtemp(join(tmpdir(), 'science-package-invalid-header-'))
    directories.push(directory)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(header))
    await writeFile(join(directory, 'future.json'), '{}')
    const archive = join(directory, 'invalid.science')
    await c({ cwd: directory, file: archive, gzip: true }, ['future.json', 'manifest.json'])
    const result = readPackageArchive(archive, join(directory, 'extracted'))
    await expect(result).rejects.toThrow()
    await expect(result).rejects.not.toThrow(PACKAGE_REQUIRES_UPDATE)
    await expect(stat(join(directory, 'extracted', 'future.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  }
)
