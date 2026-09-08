import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LiteratureAttachmentVersion, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestPdf } from '../../../test/fixtures/literature-pdf'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { LiteratureCitationStyleLibrary } from '../literature/citation-style-library'
import { LiteratureCitationFormatter } from '../literature/citation-formatter'
import { LiteratureBatchJobs } from '../literature/batch-jobs'
import { ContentRepository } from './content-repository'
import { classifyDataRoot, commitDataRootSwitch, runDataRootMigration } from './migration-service'
import { readMigrationMarker, scanInventory, writeMigrationMarker } from './migration-marker'
import { validateProvenanceMigrationState } from './provenance-migration-validation'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
vi.mock('./remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))

let root: string
let source: string
let parent: string
let target: string
let config: string
let client: PrismaClient
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const contentAt = (storageRoot: string): ContentRepository =>
  new ContentRepository({ storageRoot, getClient: async () => client })
const deps = (): Parameters<typeof runDataRootMigration>[0] & {
  setDataRoot: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
} => ({
  currentDataRoot: source,
  runtime: { disconnect: vi.fn(async () => undefined) },
  notebook: { shutdownAll: vi.fn(async () => undefined) },
  setDataRoot: vi.fn<(path: string) => Promise<void>>(async () => undefined),
  validateProvenanceState: (dataRoot: string) => validateProvenanceMigrationState(dataRoot, config)
})
const options = (): Parameters<typeof runDataRootMigration>[2] => ({
  signal: new AbortController().signal,
  onProgress: () => {}
})
const put = async (path: string, bytes: Buffer | string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'literature-migration-'))
  source = join(root, 'old', 'OpenScience')
  parent = join(root, 'new')
  target = join(parent, 'OpenScience')
  config = join(root, 'config')
  await Promise.all([source, parent, config].map((path) => mkdir(path, { recursive: true })))
  client = createProjectDbClient(config)
  await migrateApplicationDatabase(client)
})
afterEach(async () => {
  await client?.$disconnect()
  await rm(root, { recursive: true, force: true })
})

const seedAttachment = async (): Promise<{
  blob: Awaited<ReturnType<ContentRepository['publish']>>
  bytes: Buffer
  version: LiteratureAttachmentVersion
}> => {
  const bytes = createTestPdf()
  const selected = join(root, 'selected.pdf')
  await writeFile(selected, bytes)
  const blob = await contentAt(source).publish({
    sourcePath: selected,
    contentType: 'application/pdf'
  })
  const item = await client.literatureItem.create({
    data: { title: 'Paper', itemType: 'journalArticle' }
  })
  const attachment = await client.literatureAttachment.create({ data: { itemId: item.id } })
  const version = await client.literatureAttachmentVersion.create({
    data: {
      attachmentId: attachment.id,
      contentBlobId: blob.id,
      versionNumber: 1,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      checksum: blob.checksum,
      sizeBytes: blob.sizeBytes,
      pageCount: 1
    }
  })
  return { blob, bytes, version }
}

const copyAndCommit = async (): Promise<void> => {
  const dependencies = deps()
  expect(await runDataRootMigration(dependencies, parent, options())).toEqual({ ok: true })
  const marker = await readMigrationMarker(target)
  expect(
    await commitDataRootSwitch({ ...dependencies, expectedToken: marker!.token }, parent)
  ).toMatchObject({ ok: true })
  expect(dependencies.setDataRoot).toHaveBeenCalledWith(target)
}

const stylesAt = (dataRoot: string): LiteratureCitationStyleLibrary =>
  new LiteratureCitationStyleLibrary(join(dataRoot, 'literature', 'citation-styles'))
const style = `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
<info><title>Migration style</title><id>https://example.test/migration</id></info>
<citation><layout><text variable="title"/></layout></citation>
<bibliography><layout><text variable="title"/></layout></bibliography></style>`
const jobsAt = (dataRoot: string): LiteratureBatchJobs =>
  new LiteratureBatchJobs({
    path: join(dataRoot, 'literature', 'batch-jobs.json'),
    catalog: { get: vi.fn() },
    metadata: { complete: vi.fn(), applyReviewed: vi.fn() },
    fullText: { run: vi.fn() },
    onError: (error) => {
      throw error
    },
    spacingMs: 0
  })

describe('literature data relocation', () => {
  it('keeps a mixed library readable through attachment authority after committing the move', async () => {
    const { blob, bytes, version } = await seedAttachment()
    const versions = [version]
    for (const directory of ['uploads', 'artifacts']) {
      const legacyBytes = Buffer.concat([bytes, Buffer.from(`\n% ${directory}`)])
      const checksum = sha256(legacyBytes)
      const storageKey = `${directory}/legacy/paper.pdf`
      await put(join(source, storageKey), legacyBytes)
      const legacy = await client.contentBlob.create({
        data: {
          id: `sha256:${checksum}:${legacyBytes.length}`,
          checksum,
          storageKey,
          sizeBytes: BigInt(legacyBytes.length),
          contentType: 'application/pdf',
          state: 'available'
        }
      })
      versions.push(
        await client.literatureAttachmentVersion.create({
          data: {
            attachmentId: version.attachmentId,
            contentBlobId: legacy.id,
            versionNumber: versions.length + 1,
            filename: 'legacy.pdf',
            contentType: 'application/pdf',
            checksum,
            sizeBytes: legacy.sizeBytes
          }
        })
      )
    }
    await copyAndCommit()
    expect(await client.literatureAttachmentVersion.count()).toBe(3)
    // Open first to expose missing destination bytes without verification mutating authority state.
    const opened = await contentAt(target).open(blob.id)
    expect(await readFile(opened.path)).toEqual(bytes)
    const authority = new LiteratureAttachmentAuthority({
      getClient: async () => client,
      content: contentAt(target)
    })
    for (const row of versions) {
      const resolved = await authority.resolveVersion(row.id)
      expect(sha256(await readFile(resolved!.path))).toBe(row.checksum)
    }
    await expect(readFile(blob.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves custom CSL identity and formatting after committing the move', async () => {
    const library = stylesAt(source)
    const id = await library.import(style)
    const before = await new LiteratureCitationFormatter(library).formatStyleExample(id)
    await copyAndCommit()
    expect(await stylesAt(target).list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, source: 'custom' })])
    )
    expect(await new LiteratureCitationFormatter(stylesAt(target)).formatStyleExample(id)).toEqual(
      before
    )
  })

  it('preserves upgraded task indexes, records and durable recovery files for review', async () => {
    const id = randomUUID()
    const job = {
      id,
      mode: 'metadata',
      phase: 'search',
      state: 'review',
      createdAt: 1,
      updatedAt: 1,
      rows: [{ id: 'paper', status: 'ready', checked: true }]
    }
    const path = join(source, 'literature', 'batch-jobs.json')
    await put(path, JSON.stringify({ version: 1, jobs: [job] }))
    const oldJobs = jobsAt(source)
    try {
      expect((await oldJobs.run({ action: 'get', jobId: id })).jobs[0]).toEqual(job)
    } finally {
      await oldJobs.close()
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2, jobIds: [id] })
    // A durable write can survive a crash before rename; the existing reader recovers this file.
    const record = join(`${path}.d`, `${id}.json`)
    await rename(record, `${record}.123.tmp`)
    await copyAndCommit()
    const reopened = jobsAt(target)
    try {
      expect((await reopened.run({ action: 'get', jobId: id })).jobs[0]).toEqual(job)
      await reopened.run({
        action: 'review',
        jobId: id,
        selections: [{ itemId: 'paper', checked: false }]
      })
      expect((await reopened.run({ action: 'get', jobId: id })).jobs[0].rows[0].checked).toBe(false)
    } finally {
      await reopened.close()
    }
  })

  it.each(['content', 'literature'])(
    'recognizes a root containing only %s as adoptable',
    async (directory) => {
      await put(join(target, directory, 'retained.bin'), 'retained')
      expect(await classifyDataRoot(parent, source)).toEqual({ kind: 'adopt' })
    }
  )

  it.each(['added', 'changed'])(
    'rejects %s literature data after copy without switching or deleting the source',
    async (mutation) => {
      const path = join(source, 'literature', 'batch-jobs.json')
      if (mutation === 'changed') await put(path, 'before')
      const dependencies = deps()
      expect(await runDataRootMigration(dependencies, parent, options())).toEqual({ ok: true })
      await put(path, 'after')
      const marker = await readMigrationMarker(target)
      expect(
        await commitDataRootSwitch({ ...dependencies, expectedToken: marker!.token }, parent)
      ).toMatchObject({ ok: false })
      expect(dependencies.setDataRoot).not.toHaveBeenCalled()
      expect(await readFile(path, 'utf8')).toBe('after')
    }
  )

  it('rechecks an older verified copy against currently owned data directories', async () => {
    await put(join(source, 'literature', 'batch-jobs.json'), 'retained')
    const legacyDirs = [
      'artifacts',
      'compute',
      'delegation',
      'notebooks',
      'execution-file-evidence',
      'uploads',
      'workspaces',
      'notebook-file-evidence'
    ]
    await mkdir(target, { recursive: true })
    await writeMigrationMarker(target, {
      version: 1,
      token: 'older-copy',
      source,
      target,
      createdAt: 1,
      status: 'verified',
      migratedDirs: legacyDirs,
      inventory: await scanInventory(source, legacyDirs)
    })
    const dependencies = deps()
    expect(
      await commitDataRootSwitch({ ...dependencies, expectedToken: 'older-copy' }, parent)
    ).toMatchObject({ ok: false })
    expect(dependencies.setDataRoot).not.toHaveBeenCalled()
  })

  it.each(['uncommitted', 'cancelled'])(
    'preserves the original content and configuration when %s',
    async (mode) => {
      const { blob, bytes } = await seedAttachment()
      const id = await stylesAt(source).import(style)
      const dependencies = deps()
      const controller = new AbortController()
      if (mode === 'cancelled') controller.abort()
      const result = await runDataRootMigration(dependencies, parent, {
        ...options(),
        signal: controller.signal
      })
      expect(result).toMatchObject(
        mode === 'cancelled' ? { ok: false, cancelled: true } : { ok: true }
      )
      expect(dependencies.setDataRoot).not.toHaveBeenCalled()
      expect(await readFile(blob.path)).toEqual(bytes)
      expect(await stylesAt(source).list()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id })])
      )
    }
  )
})

describe('literature migration authority validation', () => {
  it('accepts historical content without a MIME type and leaves unreferenced staging alone', async () => {
    const { blob } = await seedAttachment()
    await client.contentBlob.update({ where: { id: blob.id }, data: { contentType: null } })
    await client.contentBlob.create({
      data: {
        id: 'unreferenced',
        checksum: '0'.repeat(64),
        sizeBytes: 0n,
        storageKey: 'content/blobs/unreferenced',
        state: 'staging'
      }
    })
    await expect(validateProvenanceMigrationState(source, config)).resolves.toBeUndefined()
  })

  it('rejects missing content retained by a deleted item', async () => {
    const { blob, version } = await seedAttachment()
    const attachment = await client.literatureAttachment.findUniqueOrThrow({
      where: { id: version.attachmentId }
    })
    await client.literatureItem.update({
      where: { id: attachment.itemId },
      data: { deletedAt: new Date() }
    })
    await rm(blob.path)
    await expect(validateProvenanceMigrationState(source, config)).rejects.toThrow(/content/i)
  })

  it('accepts intact referenced content against the fixed config database', async () => {
    const { blob } = await seedAttachment()
    const before = await client.contentBlob.findUniqueOrThrow({ where: { id: blob.id } })
    await expect(validateProvenanceMigrationState(source, config)).resolves.toBeUndefined()
    expect(await client.contentBlob.findUniqueOrThrow({ where: { id: blob.id } })).toEqual(before)
  })

  it.each(['missing', 'size', 'checksum', 'not-file', 'state'] as const)(
    'rejects %s shared content before migration',
    async (failure) => {
      const { blob, bytes } = await seedAttachment()
      if (failure === 'missing' || failure === 'not-file') await rm(blob.path)
      if (failure === 'not-file') await mkdir(blob.path)
      if (failure === 'size') await writeFile(blob.path, bytes.subarray(0, bytes.length - 1))
      if (failure === 'checksum') await writeFile(blob.path, Buffer.alloc(bytes.length, 32))
      if (failure === 'state')
        await client.contentBlob.update({ where: { id: blob.id }, data: { state: 'quarantined' } })
      const before = await client.contentBlob.findUniqueOrThrow({ where: { id: blob.id } })
      await expect(validateProvenanceMigrationState(source, config)).rejects.toThrow(
        /content|literature/i
      )
      expect(await client.contentBlob.findUniqueOrThrow({ where: { id: blob.id } })).toEqual(before)
    }
  )

  it.each(['checksum', 'sizeBytes', 'contentType'] as const)(
    'rejects attachment %s diverging from shared content authority',
    async (field) => {
      const { version } = await seedAttachment()
      await client.literatureAttachmentVersion.update({
        where: { id: version.id },
        data: {
          [field]: field === 'checksum' ? '0'.repeat(64) : field === 'sizeBytes' ? 1n : 'text/plain'
        }
      })
      await expect(validateProvenanceMigrationState(source, config)).rejects.toThrow(
        /attachment|literature/i
      )
    }
  )

  it.each(['checksum', 'sizeBytes'] as const)(
    'rejects Inbox PDF %s diverging from shared content authority',
    async (field) => {
      const { blob, version } = await seedAttachment()
      await client.literatureAttachmentVersion.delete({ where: { id: version.id } })
      const candidate = await client.literatureInboxCandidate.create({
        data: {
          dedupeKey: randomUUID(),
          itemType: 'journalArticle',
          title: 'Candidate',
          candidateJson: '{}',
          metadataChecksum: sha256('{}'),
          origin: 'agent'
        }
      })
      await client.literatureInboxPdf.create({
        data: {
          candidateId: candidate.id,
          contentBlobId: blob.id,
          filename: 'paper.pdf',
          checksum: field === 'checksum' ? '0'.repeat(64) : blob.checksum,
          sizeBytes: field === 'sizeBytes' ? 1n : blob.sizeBytes,
          pageCount: 1,
          sourceUrl: 'https://example.test/paper.pdf'
        }
      })
      await expect(validateProvenanceMigrationState(source, config)).rejects.toThrow(
        /inbox|literature/i
      )
    }
  )
})
