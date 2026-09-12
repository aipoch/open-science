import { createUploadVersionReference } from '../../shared/uploads'
import { join, sep } from 'node:path'
import { dirname } from 'node:path'
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { c as createTar, x as extractTar } from 'tar'
import { fileChecksum } from './archive'
import { ProjectRepository } from '../projects/repository'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../artifacts/provenance-test-fixtures'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ReviewRepository } from '../reviewer/repository'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { sha256 } from '../artifacts/provenance-canonical'
import { createPngBytes } from '../artifacts/artifact-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import {
  startWorkingFileObservation,
  deleteWorkingFileEvidenceProject
} from '../notebook/working-file-observer'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { FileTaskRunJournal } from '../tasks/task-run-journal'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  activateConversationBranch,
  resolveActiveConversationMessages,
  projectConversationMessage
} from '../../shared/conversation-graph'
import { SessionPackageService } from './service'
import * as fsPromises from 'node:fs/promises'
import * as storageUsage from '../storage/usage'
import * as fileIo from '../bounded-file-io'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { PrismaClient } from '@prisma/client'
import { withPackageTransfer } from './transfer'
import { PackageCleanupPendingError } from './cleanup'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []

it('imports a compact package with required duplicate evidence and forwards the same safe selection', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Compact research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Compact research',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: []
  })
  await source.stagePng('required evidence', 'evidence.png')
  const required = await source.repository.createVersion(
    createArtifactVersionRequest({ filename: 'evidence.png' })
  )
  await source.stagePng('optional output with a different length', 'optional.png')
  const optional = await source.repository.createVersion(
    createArtifactVersionRequest({ filename: 'optional.png', writeOperationId: 'write-2' })
  )
  const requiredRow = await source.client.artifactVersion.findUniqueOrThrow({
    where: { id: required.versionId }
  })
  const optionalRow = await source.client.artifactVersion.findUniqueOrThrow({
    where: { id: optional.versionId }
  })
  const evidenceKey = 'notebooks/project-1/session-1/data/evidence.png'
  await mkdir(dirname(join(source.storageRoot, evidenceKey)), { recursive: true })
  await writeFile(
    join(source.storageRoot, evidenceKey),
    await readFile(join(source.storageRoot, requiredRow.contentStorageKey))
  )
  const exporter = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const complete = join(source.storageRoot, 'full.science')
  await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, complete)
  const full = await importer.importFrom(complete)
  for (const path of ['native', 'forward'] as const) {
    const archive = join(source.storageRoot, `${path}-compact.science`)
    const choose = async (
      files: import('../../shared/session-package').PackageSelectableFile[]
    ): Promise<string[]> => {
      expect(files.find((file) => file.storageKey === requiredRow.contentStorageKey)).toMatchObject(
        { requiredForEvidence: true }
      )
      expect(files.find((file) => file.storageKey === optionalRow.contentStorageKey)).toMatchObject(
        { requiredForEvidence: false }
      )
      return files.filter((file) => !file.requiredForEvidence).map((file) => file.storageKey)
    }
    await (path === 'native' ? exporter : importer).exportTo(
      path === 'native' ? { projectId: 'project-1', sessionId: 'session-1' } : full,
      archive,
      { selectFiles: choose }
    )
    const imported = await importer.importFrom(archive)
    const receipt = await importer.readOrigin(imported)
    expect(receipt.sourceManifest.excludedFiles).toEqual([
      expect.objectContaining({ storageKey: optionalRow.contentStorageKey })
    ])
    expect(receipt.sourceManifest.inventory.map((entry) => entry.storageKey)).toEqual(
      expect.arrayContaining([requiredRow.contentStorageKey, evidenceKey])
    )
  }
}, 60_000)

it('reports oversized retained Artifact content as unavailable through the provenance reader', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await source.stagePng('original')
  const version = await source.repository.createVersion(createArtifactVersionRequest())
  const row = await source.client.artifactVersion.update({
    where: { id: version.versionId },
    data: { contentBlobId: null }
  })
  await fsPromises.appendFile(
    join(source.storageRoot, row.contentStorageKey),
    Buffer.alloc(1024 * 1024)
  )
  const provenance = await source.repository.getVersionProvenance({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: version.artifactId,
    versionId: version.versionId
  })
  expect(provenance.contentStatus).toEqual({ state: 'unavailable', reason: 'checksum-mismatch' })
})

it('leaves the application database available while a slow import copies files', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'source', name: 'Source' } })
  await target.client.project.create({ data: { id: 'target', name: 'Target' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'original',
    projectId: 'source',
    title: 'Research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const data = join(source.storageRoot, 'notebooks', 'source', 'original', 'data')
  await mkdir(data, { recursive: true })
  await writeFile(join(data, 'first.txt'), Buffer.alloc(64 * 1024, 'a'))
  await writeFile(join(data, 'second.txt'), Buffer.alloc(64 * 1024, 'b'))
  const archive = join(source.storageRoot, 'session.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'source', sessionId: 'original' }, archive)
  const controller = new AbortController()
  let copying!: () => void
  const started = new Promise<void>((resolve) => {
    copying = resolve
  })
  let slow = false
  let settled = false
  const pending = withPackageTransfer(
    () =>
      new SessionPackageService({
        storageRoot: target.storageRoot,
        getClient: async () => target.client
      }).importFrom(
        archive,
        controller.signal,
        (progress) => {
          if (progress.phase === 'importing' && progress.completedBytes) {
            slow = true
            copying()
          }
        },
        undefined,
        { projectId: 'target' }
      ),
    () => (slow ? 1 : 64 * 1024 ** 2)
  ).then(
    () => {
      settled = true
    },
    (error: unknown) => {
      settled = true
      return error
    }
  )
  try {
    await started
    // Both operations use the same single-connection Prisma client. A transaction spanning the
    // paced copy would queue these unrelated foreground reads/writes behind the stalled import.
    await target.client.project.update({
      where: { id: 'target' },
      data: { name: 'Foreground edit' }
    })
    expect((await target.client.project.findUniqueOrThrow({ where: { id: 'target' } })).name).toBe(
      'Foreground edit'
    )
    expect(settled).toBe(false)
  } finally {
    controller.abort()
    await pending
  }
  expect((await new SessionRepository(target.storageRoot).loadAll()).sessions).toHaveLength(0)
  expect(await target.client.fileOriginSession.count()).toBe(0)
})

it('validates Artifact payloads without allocating a whole-file buffer', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await source.stagePng('research output')
  const version = await source.repository.createVersion(createArtifactVersionRequest())
  const row = await source.client.artifactVersion.findUniqueOrThrow({
    where: { id: version.versionId }
  })
  const originalRead = fsPromises.readFile
  vi.spyOn(fsPromises, 'readFile').mockImplementation((...args) => {
    if (String(args[0]).endsWith(row.contentStorageKey.replaceAll('/', sep)))
      return Promise.reject(
        new Error('Whole-file allocation is not available for large research payloads.')
      )
    return Reflect.apply(originalRead, fsPromises, args)
  })
  await expect(
    new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      join(source.storageRoot, 'large.science')
    )
  ).resolves.toMatchObject({ fileCount: expect.any(Number) })
})

it.each(['commit', 'rollback'] as const)(
  'publishes a large review with bounded database round trips (%s)',
  async (outcome) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'source', name: 'Source' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'original',
      projectId: 'source',
      title: 'Research',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    await source.client.review.create({
      data: {
        id: 'review',
        projectId: 'source',
        sessionId: 'original',
        turnMessageId: 'turn',
        lifecycle: 'complete',
        outcome: 'pass'
      }
    })
    await source.client.finding.createMany({
      data: Array.from({ length: 2400 }, (_, index) => ({
        id: `finding-${index}`,
        reviewId: 'review',
        claim: `Finding ${index}: 'quoted' ?`,
        sortIndex: index
      }))
    })
    const archive = join(source.storageRoot, 'session.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'source', sessionId: 'original' }, archive)
    const client = new PrismaClient({
      datasources: {
        db: {
          url: `file:${join(target.storageRoot, 'open-science.db').replaceAll('\\', '/')}?connection_limit=1`
        }
      },
      log: [{ emit: 'event', level: 'query' }]
    })
    const statements: string[] = []
    client.$on('query', (event) => statements.push(event.query))
    try {
      if (outcome === 'rollback') {
        await client.$executeRawUnsafe(
          `CREATE TRIGGER reject_middle_finding BEFORE INSERT ON "Finding" WHEN NEW.sortIndex = 1200 BEGIN SELECT RAISE(ABORT, 'Injected publication failure'); END`
        )
        await expect(
          new SessionPackageService({
            storageRoot: target.storageRoot,
            getClient: async () => client
          }).importFrom(archive)
        ).rejects.toThrow('Injected publication failure')
        expect(await client.review.count()).toBe(0)
        expect(await client.finding.count()).toBe(0)
        expect(await client.fileOriginSession.count()).toBe(0)
        expect((await new SessionRepository(target.storageRoot).loadAll()).sessions).toHaveLength(0)
        return
      }
      const imported = await new SessionPackageService({
        storageRoot: target.storageRoot,
        getClient: async () => client
      }).importFrom(archive)
      const reviews = await new ReviewRepository(async () => client).getReviewsForProjectSession(
        imported.projectId,
        imported.sessionId
      )
      expect(reviews).toHaveLength(1)
      expect(reviews[0].checks).toHaveLength(2400)
      // A connection-occupancy budget, independent of batch sizes or SQL formatting. The old
      // publisher makes 2,400 round trips for these findings while holding the sole connection.
      expect(
        statements.filter((query) => /^INSERT INTO "Finding"/u.test(query)).length
      ).toBeLessThanOrEqual(50)
    } finally {
      await client.$disconnect()
    }
  }
)

it('clears copying counters while finalizing an import', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'source', name: 'Source' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'original',
    projectId: 'source',
    title: 'Research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const directory = join(source.storageRoot, 'notebooks', 'source', 'original', 'data')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'result.txt'), 'Recorded result')
  const archive = join(source.storageRoot, 'session.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'source', sessionId: 'original' }, archive)
  const progress: import('../../shared/session-package').PackageProgress[] = []
  const transaction = target.client.$transaction.bind(target.client)
  let publishing: import('../../shared/session-package').PackageProgress | undefined
  vi.spyOn(target.client, '$transaction').mockImplementationOnce(async (...args) => {
    publishing = progress.at(-1)
    return Reflect.apply(transaction, target.client, args)
  })
  await new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  }).importFrom(archive, undefined, (update) => progress.push(update))
  expect(progress.some((update) => update.totalBytes && update.completedBytes)).toBe(true)
  expect(publishing).toEqual({ phase: 'importing' })
  const lastCopy = progress.findLastIndex((update) => update.totalBytes !== undefined)
  expect(progress.slice(lastCopy + 1)).toContainEqual({ phase: 'validating' })
})

it.each(['success', 'rollback', 'late-ack', 'publication-retry', 'ownership-collision'] as const)(
  'imports into an existing project without changing its research (%s)',
  async (outcome) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'source', name: 'Source' } })
    await target.client.project.create({ data: { id: 'target', name: 'Keep project' } })
    const session = {
      id: 'original',
      projectId: 'source',
      title: 'Shared history',
      cwd: '',
      status: 'idle' as const,
      messages: [],
      createdAt: 1,
      updatedAt: 2
    }
    await new SessionRepository(source.storageRoot).saveSession(session)
    const sourceFile = join(
      source.storageRoot,
      'notebooks',
      'source',
      'original',
      'data',
      'shared.txt'
    )
    await mkdir(dirname(sourceFile), { recursive: true })
    await writeFile(sourceFile, 'Imported research')
    if (outcome === 'ownership-collision')
      await writeFile(
        join(dirname(dirname(sourceFile)), '.session-package-owner'),
        'Untrusted ownership'
      )
    const configRoot = join(target.storageRoot, 'config')
    const repository = new SessionRepository(configRoot)
    await repository.saveSession({ ...session, projectId: 'target', title: 'Keep conversation' })
    const keep = join(target.storageRoot, 'notebooks', 'target', 'original', 'keep.txt')
    await mkdir(dirname(keep), { recursive: true })
    await writeFile(keep, 'Keep research')
    const archive = join(source.storageRoot, 'session.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'source', sessionId: 'original' }, archive)
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      configRoot,
      getClient: async () => target.client
    })
    const transaction = target.client.$transaction.bind(target.client)
    if (outcome === 'rollback' || outcome === 'late-ack')
      vi.spyOn(target.client, '$transaction').mockImplementationOnce(async (...args) => {
        expect((await repository.loadAll()).sessions.map((item) => item.id)).toEqual(['original'])
        if (outcome === 'late-ack') await Reflect.apply(transaction, target.client, args)
        throw new Error('Injected transaction failure')
      })
    if (outcome === 'publication-retry') {
      const save = SessionRepository.prototype.saveSession
      let staged = false
      vi.spyOn(SessionRepository.prototype, 'saveSession').mockImplementation(async function (
        this: SessionRepository,
        ...args
      ) {
        if (args[0].packageOrigin && !staged) staged = true
        else if (args[0].packageOrigin && staged) {
          vi.mocked(SessionRepository.prototype.saveSession).mockRestore()
          throw new Error('Injected transaction failure')
        }
        return save.apply(this, args)
      })
    }
    const pending = importer.importFrom(archive, undefined, undefined, undefined, {
      projectId: 'target'
    })
    if (outcome === 'success' || outcome === 'late-ack')
      expect((await pending).projectId).toBe('target')
    else if (outcome === 'ownership-collision')
      await expect(pending).rejects.toThrow('reserved ownership filename')
    else await expect(pending).rejects.toThrow('Injected transaction failure')
    await importer.recover()
    expect(await target.client.project.findMany()).toMatchObject([
      { id: 'target', name: 'Keep project' }
    ])
    expect(await readFile(keep, 'utf8')).toBe('Keep research')
    expect((await repository.loadSession('target', 'original'))?.title).toBe('Keep conversation')
    const imported = (await repository.loadAll()).sessions.filter((item) => item.id !== 'original')
    expect(imported).toHaveLength(
      outcome === 'rollback' || outcome === 'ownership-collision' ? 0 : 1
    )
    if (outcome === 'ownership-collision')
      expect(await fsPromises.readdir(join(target.storageRoot, 'notebooks', 'target'))).toEqual([
        'original'
      ])
    if (outcome !== 'rollback' && outcome !== 'ownership-collision') {
      expect(imported[0]).toMatchObject({
        projectId: 'target',
        packageOrigin: { sourceProjectId: 'source' }
      })
      expect(
        await readFile(
          join(target.storageRoot, 'notebooks', 'target', imported[0].id, 'data', 'shared.txt'),
          'utf8'
        )
      ).toBe('Imported research')
      const { isImportedResearchSession } = await import('../storage/session-package-state')
      expect(await isImportedResearchSession(target.storageRoot, 'target', imported[0].id)).toBe(
        true
      )
      expect(await isImportedResearchSession(target.storageRoot, 'target', 'original')).toBe(false)
      await expect(
        repository.saveSession({
          ...imported[0],
          packageOrigin: undefined,
          messages: [
            {
              id: 'rewrite',
              role: 'user',
              content: 'Overwrite history',
              createdAt: 3,
              updatedAt: 3,
              status: 'complete',
              eventIds: []
            }
          ]
        })
      ).rejects.toThrow('read-only')
      const preserved = await repository.loadSession('target', imported[0].id)
      expect(preserved?.packageOrigin).toEqual(imported[0].packageOrigin)
      expect(preserved?.messages).toEqual(imported[0].messages)
      const again = await importer.importFrom(archive, undefined, undefined, undefined, {
        projectId: 'target'
      })
      expect(again.sessionId).not.toBe(imported[0].id)
      expect(await target.client.project.count()).toBe(1)
    }
  }
)

it.each([1, 12, 'unavailable'] as const)(
  'uses stage-level capacity queries for %s files and retains the normal transfer when queries are unavailable',
  async (count) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Capacity' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Capacity',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const directory = join(source.storageRoot, 'notebooks', 'project-1', 'session-1', 'data')
    await mkdir(directory, { recursive: true })
    for (let i = 0; i < (typeof count === 'number' ? count : 1); i++)
      await writeFile(join(directory, `result-${i}.csv`), 'sample,value\nA,1\n')
    const capacity = vi.spyOn(storageUsage, 'availableBytes').mockImplementation(async () => {
      if (count === 'unavailable') throw new Error('statfs is unavailable')
      return 100 * 1024 ** 3
    })
    const archive = join(source.storageRoot, 'source.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    expect(capacity).toHaveBeenCalledTimes(3)
    capacity.mockClear()
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    const imported = await importer.importFrom(archive)
    expect(capacity).toHaveBeenCalledTimes(5)
    expect(
      (
        await new SessionRepository(target.storageRoot).loadSession(
          imported.projectId,
          imported.sessionId
        )
      )?.title
    ).toBe('Capacity')
    capacity.mockClear()
    await importer.exportTo(imported, join(target.storageRoot, 'forwarded.science'))
    expect(capacity).toHaveBeenCalledTimes(3)
  }
)

it.each(['export', 'validation', 'compression', 'import', 'config'] as const)(
  'rejects insufficient %s capacity before publishing and checks fresh space after user input',
  async (boundary) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Capacity' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Capacity',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const payload = join(
      source.storageRoot,
      'notebooks',
      'project-1',
      'session-1',
      'data',
      'result.csv'
    )
    await mkdir(dirname(payload), { recursive: true })
    await writeFile(payload, 'sample,value\nA,1\n')
    const exporter = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    const archive = join(source.storageRoot, 'source.science')
    if (boundary === 'import' || boundary === 'config')
      await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    else await writeFile(archive, 'Keep existing export')
    const configRoot = join(target.storageRoot, 'config')
    let userResponded = false
    let rejectedAfterUserResponse = false
    const queried: string[] = []
    vi.spyOn(storageUsage, 'availableBytes').mockImplementation(async (path) => {
      queried.push(path)
      const blocked =
        boundary === 'export'
          ? path.includes('open-science-package-export-')
          : boundary === 'compression'
            ? path.includes('.open-science-save-')
            : boundary === 'validation'
              ? path.includes('open-science-package-validation-')
              : boundary === 'config'
                ? path.startsWith(configRoot)
                : userResponded &&
                  path.startsWith(join(target.storageRoot, 'session-package-imports'))
      if (blocked) {
        rejectedAfterUserResponse = userResponded
        return 0
      }
      return 100 * 1024 ** 3
    })
    const copies = vi.spyOn(fileIo, 'copyFileWithinBudget')
    const work =
      boundary === 'export' || boundary === 'validation' || boundary === 'compression'
        ? exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
            selectFiles: async () => {
              userResponded = true
              return []
            }
          })
        : new SessionPackageService({
            storageRoot: target.storageRoot,
            configRoot,
            getClient: async () => target.client
          }).importFrom(archive, undefined, undefined, async () => {
            userResponded = true
          })
    await expect(work).rejects.toThrow('Not enough disk space')
    expect(rejectedAfterUserResponse).toBe(true)
    expect(queried.length).toBeGreaterThan(0)
    if (boundary === 'export') expect(copies).not.toHaveBeenCalled()
    if (boundary === 'export' || boundary === 'validation' || boundary === 'compression')
      expect(await readFile(archive, 'utf8')).toBe('Keep existing export')
    expect(await target.client.project.count()).toBe(0)
    expect((await new SessionRepository(configRoot).loadAll()).sessions).toEqual([])
  }
)

it.each(['parent', 'operation', 'existing', 'cleanup', 'cleanup-recovery'] as const)(
  'cleans the config stage when the separate data %s directory cannot be allocated',
  async (boundary) => {
    const target = await createProvenanceTestFixture()
    fixtures.push(target)
    const cleanupFails = boundary.startsWith('cleanup')
    const configRoot = join(target.storageRoot, 'config')
    const dataRoot = join(target.storageRoot, 'data')
    const dataStages = join(dataRoot, 'session-package-imports')
    const originalMkdir = fsPromises.mkdir
    const failure = Object.assign(new Error('Data stage admission failed'), {
      code: boundary === 'existing' ? 'EEXIST' : 'ENOSPC'
    })
    let unclaimedFile: string | undefined
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (...args) => {
      const path = String(args[0])
      if (
        (boundary === 'parent' && path === dataStages) ||
        (boundary !== 'parent' && dirname(path) === dataStages)
      ) {
        if (boundary === 'existing') {
          await originalMkdir(path)
          unclaimedFile = join(path, 'keep.txt')
          await writeFile(unclaimedFile, 'Unclaimed data')
        }
        throw failure
      }
      return originalMkdir(...args)
    })
    const originalRm = fsPromises.rm
    const rmSpy = vi.spyOn(fsPromises, 'rm').mockImplementation(async (...args) => {
      if (cleanupFails && dirname(String(args[0])) === join(configRoot, 'session-package-imports'))
        throw Object.assign(new Error('Cleanup denied'), { code: 'EACCES' })
      return originalRm(...args)
    })
    try {
      const service = new SessionPackageService({
        storageRoot: dataRoot,
        configRoot,
        getClient: async () => target.client
      })
      const pending = service.importFrom(join(target.storageRoot, 'not-yet-opened.science'))
      const outcome = await pending.catch((error: unknown) => error)
      if (cleanupFails) {
        expect(outcome).toBeInstanceOf(PackageCleanupPendingError)
        expect(outcome).toMatchObject({ outcome: { error: failure } })
      } else expect(outcome).toBe(failure)
      expect(await fsPromises.readdir(join(configRoot, 'session-package-imports'))).toHaveLength(
        cleanupFails ? 1 : 0
      )
      if (unclaimedFile) expect(await readFile(unclaimedFile, 'utf8')).toBe('Unclaimed data')
      expect(await target.client.project.count()).toBe(0)
      if (cleanupFails) {
        rmSpy.mockRestore()
        if (!(outcome instanceof PackageCleanupPendingError))
          throw new Error('Expected pending cleanup')
        if (boundary === 'cleanup') await outcome.retryCleanup()
        // Recovery remains idempotent after an in-process cleanup retry.
        await service.recover()
        expect(await fsPromises.readdir(join(configRoot, 'session-package-imports'))).toEqual([])
      }
      await service.close()
    } finally {
      mkdirSpy.mockRestore()
      rmSpy.mockRestore()
    }
  }
)

it.each(['direct', 'forward'] as const)(
  'exports selected content through %s while retaining explicit omitted Artifact metadata across import and restart',
  async (path) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Selected research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Optional plot',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    await source.stagePng('optional large output')
    const version = await source.repository.createVersion(createArtifactVersionRequest())
    const row = await source.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    const inputCopyKey = 'notebooks/project-1/session-1/data/inputs/optional-plot.png'
    const session = await new SessionRepository(source.storageRoot).loadSession(
      'project-1',
      'session-1'
    )
    const frameId = session!.conversationGraph!.activeFrameId
    const frameCopyKey = `notebooks/project-1/session-1/frames/${frameId}/data/inputs/plot.png`
    const differentKey = 'notebooks/project-1/session-1/data/inputs/different.txt'
    const content = await readFile(join(source.storageRoot, row.contentStorageKey))
    for (const key of [inputCopyKey, frameCopyKey]) {
      await mkdir(dirname(join(source.storageRoot, key)), { recursive: true })
      await writeFile(join(source.storageRoot, key), content)
    }
    await writeFile(join(source.storageRoot, differentKey), Buffer.alloc(content.length, 'x'))
    const choose = vi.fn(
      async (files: import('../../shared/session-package').PackageSelectableFile[]) => {
        expect(files.find((file) => file.storageKey === row.contentStorageKey)).toMatchObject({
          requiredForEvidence: false
        })
        return files.filter((file) => !file.requiredForEvidence).map((file) => file.storageKey)
      }
    )
    const archive = join(source.storageRoot, 'selected.science')
    const exporter = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    if (path === 'forward') {
      const complete = join(source.storageRoot, 'complete.science')
      await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, complete)
      const imported = await importer.importFrom(complete)
      await importer.exportTo(imported, archive, { selectFiles: choose })
    } else {
      await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
        selectFiles: choose
      })
    }
    expect(choose).toHaveBeenCalledOnce()
    const identity = await importer.importFrom(archive)
    const receipt = await importer.readOrigin(identity)
    expect(receipt.sourceManifest.excludedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storageKey: row.contentStorageKey, filename: 'plot.png' }),
        expect.objectContaining({ storageKey: inputCopyKey, filename: 'plot.png' }),
        expect.objectContaining({ storageKey: frameCopyKey, filename: 'plot.png' })
      ])
    )
    expect(
      receipt.sourceManifest.inventory.some((entry) => entry.storageKey === row.contentStorageKey)
    ).toBe(false)
    expect(
      receipt.sourceManifest.inventory.some((entry) => entry.storageKey === inputCopyKey)
    ).toBe(false)
    expect(
      receipt.sourceManifest.inventory.some((entry) => entry.storageKey === frameCopyKey)
    ).toBe(false)
    expect(
      receipt.sourceManifest.inventory.some((entry) => entry.storageKey === differentKey)
    ).toBe(true)
    await expect(
      stat(
        join(
          target.storageRoot,
          'notebooks',
          identity.projectId,
          identity.sessionId,
          'data/inputs/optional-plot.png'
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const importedVersionId = receipt.identities[version.versionId]
    const localVersion = await target.client.artifactVersion.findUniqueOrThrow({
      where: { id: importedVersionId }
    })
    await expect(
      stat(join(target.storageRoot, localVersion.contentStorageKey))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await target.client.$disconnect()
    const reader = new ArtifactProvenanceRepository(target.repositoryOptions)
    await expect(
      reader.getVersionProvenance({
        projectId: identity.projectId,
        appSessionId: identity.sessionId,
        artifactId: receipt.identities[version.artifactId],
        versionId: importedVersionId
      })
    ).resolves.toMatchObject({ contentStatus: { state: 'unavailable', reason: 'missing' } })
    expect(
      (
        await new SessionRepository(target.storageRoot).loadSession(
          identity.projectId,
          identity.sessionId
        )
      )?.packageOrigin?.excludedFiles
    ).toEqual(expect.arrayContaining([expect.objectContaining({ filename: 'plot.png' })]))
  },
  60_000
)
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

it('reopens finalized provenance messages against the imported graph and keeps source hashes intact', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  const session = await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Finalized plot',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Draw a plot',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'message-1',
        role: 'agent',
        content: 'Saved plot.png',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
  })
  const graph = (
    await new SessionRepository(source.storageRoot).loadSession('project-1', 'session-1')
  )?.conversationGraph
  if (!graph) throw new Error('Source graph was not materialized')
  const request = createArtifactVersionRequest({
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: 'prompt-1'
  })
  const repository = new ArtifactProvenanceRepository({
    ...source.repositoryOptions,
    loadSession: async () => session
  })
  await source.stagePng('finalized plot')
  const version = await repository.createVersion(request)
  await repository.finalizeRun({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactRunId: request.artifactRunId,
    artifactVersionIds: [version.versionId],
    rootFrameId: request.rootFrameId,
    agentFrameId: request.agentFrameId,
    messageBranchId: request.messageBranchId,
    runtimeSegmentId: request.runtimeSegmentId,
    promptMessageId: request.promptMessageId,
    messageId: 'message-1'
  })
  await new ProvenanceMessageSnapshotRepository({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).captureFinalizedMessages(session)
  await new SessionRepository(source.storageRoot).saveSession({
    ...session,
    conversationGraph: {
      ...graph,
      messages: graph.messages.map((message) =>
        message.id === 'message-1'
          ? {
              ...message,
              parts: [
                {
                  type: 'artifact',
                  source: 'artifact',
                  id: version.artifactId,
                  versionId: version.versionId,
                  name: 'plot.png',
                  path: createArtifactVersionLocator({
                    projectId: 'project-1',
                    appSessionId: 'session-1',
                    artifactId: version.artifactId,
                    versionId: version.versionId
                  })
                }
              ]
            }
          : message
      )
    }
  })
  const archive = join(source.storageRoot, 'finalized.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const imported = await importer.importFrom(archive)
  const origin = await importer.readOrigin(imported)
  const importedSession = await new SessionRepository(target.storageRoot).loadSession(
    imported.projectId,
    imported.sessionId
  )
  expect(
    importedSession?.messages.find((message) => message.id === origin.identities['message-1'])
      ?.parts
  ).toMatchObject([
    {
      path: createArtifactVersionLocator({
        projectId: imported.projectId,
        appSessionId: imported.sessionId,
        artifactId: origin.identities[version.artifactId],
        versionId: origin.identities[version.versionId]
      })
    }
  ])
  const read = await new ArtifactProvenanceRepository(
    target.repositoryOptions
  ).getVersionProvenance({
    projectId: imported.projectId,
    appSessionId: imported.sessionId,
    artifactId: origin.identities[version.artifactId],
    versionId: origin.identities[version.versionId]
  })
  expect(read.messages).toMatchObject({
    state: 'available',
    items: [
      { id: origin.identities['prompt-1'], content: 'Draw a plot' },
      { id: origin.identities['message-1'], content: 'Saved plot.png' }
    ]
  })
  const evidence = origin.files.find((entry) => entry.sourceStorageKey.endsWith('/evidence.json'))
  expect(evidence).toBeDefined()
  expect(evidence?.localChecksum).not.toBe(evidence?.sourceChecksum)
  const sourceEntry = origin.sourceManifest.inventory.find(
    (entry) => entry.storageKey === evidence?.sourceStorageKey
  )!
  const retainedSource = join(
    target.storageRoot,
    'artifacts',
    imported.projectId,
    imported.sessionId,
    '.session-package',
    'source',
    sourceEntry.path
  )
  expect(await fileChecksum(retainedSource)).toBe(evidence?.sourceChecksum)
  expect(await fileChecksum(join(target.storageRoot, evidence!.localStorageKey))).toBe(
    evidence?.localChecksum
  )
  const forwarded = join(target.storageRoot, 'forwarded.science')
  await importer.exportTo(imported, forwarded)
  const forwardedImport = await importer.importFrom(forwarded)
  const forwardedOrigin = await importer.readOrigin(forwardedImport)
  expect(forwardedOrigin.sourceManifest).toEqual(origin.sourceManifest)
  expect(
    forwardedOrigin.files.find((entry) => entry.sourceStorageKey === evidence?.sourceStorageKey)
      ?.sourceChecksum
  ).toBe(evidence?.sourceChecksum)
})

it('keeps terminal Task and Compute results as evidence without installing jobs or recovery authority', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Task results',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await new FileTaskRunJournal(source.storageRoot).replace([
    {
      id: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      cwd: '',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      output: 'Task result',
      artifacts: [],
      preferredComputeHostIds: ['private-host']
    }
  ])
  await source.client.computeJob.create({
    data: {
      id: 'job-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      providerId: 'private-host',
      shape: 'direct_ssh',
      status: 'success',
      intent: 'Count samples',
      command: 'wc -l samples.csv',
      commandHash: sha256('wc -l samples.csv'),
      stdoutTail: '42',
      sensitiveDataEncrypted: false,
      finishedAt: new Date(2)
    }
  })
  const archive = join(source.storageRoot, 'tasks.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const imported = await importer.importFrom(archive)
  const origin = await importer.readOrigin(imported)
  expect(origin.history).toMatchObject({
    taskRuns: [{ status: 'completed', output: 'Task result' }],
    computeJobs: [{ status: 'success', stdout: '42' }]
  })
  await expect(new FileTaskRunJournal(target.storageRoot).load()).resolves.toEqual([])
  await expect(target.client.computeJob.count()).resolves.toBe(0)
})

it('does not remove an unclaimed directory when recovering an interrupted import', async () => {
  const target = await createProvenanceTestFixture()
  fixtures.push(target)
  const operation = '12345678-1234-4123-8123-123456789012'
  await mkdir(join(target.storageRoot, 'session-package-imports', operation), { recursive: true })
  const unrelated = join(target.storageRoot, 'artifacts', `import-${operation}`, 'keep.txt')
  await mkdir(dirname(unrelated), { recursive: true })
  await writeFile(unrelated, 'unrelated research')
  await new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  }).recover()
  await expect(readFile(unrelated, 'utf8')).resolves.toBe('unrelated research')
})

it('rejects a linked Notebook root without including files outside the selected Session', async () => {
  const source = await createProvenanceTestFixture()
  const outside = await createProvenanceTestFixture()
  fixtures.push(source, outside)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Linked data',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await writeFile(join(outside.storageRoot, 'unrelated.txt'), 'Other research')
  await mkdir(join(source.storageRoot, 'notebooks', 'project-1'), { recursive: true })
  await symlink(
    outside.storageRoot,
    join(source.storageRoot, 'notebooks', 'project-1', 'session-1'),
    'junction'
  )
  await expect(
    new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      join(source.storageRoot, 'linked.science')
    )
  ).rejects.toThrow(/link/)
  expect(await readFile(join(outside.storageRoot, 'unrelated.txt'), 'utf8')).toBe('Other research')
})

it('blocks recognized credentials in Notebook files instead of silently exporting or rewriting them', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Sensitive research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const file = join(source.storageRoot, 'notebooks', 'project-1', 'session-1', 'config.txt')
  await mkdir(dirname(file), { recursive: true })
  const secret = 'Authorization: Bearer synthetic-private-value'
  await writeFile(file, secret)
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  await expect(
    service.exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      join(source.storageRoot, 'private.science')
    )
  ).rejects.toThrow('Sensitive content detected')
  await expect(readFile(file, 'utf8')).resolves.toBe(secret)
})

it('rejects a Notebook file changed during export without replacing the destination', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Changing input',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const file = join(
    source.storageRoot,
    'notebooks',
    'project-1',
    'session-1',
    'data',
    'observations.txt'
  )
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'Original observation')
  const archive = join(source.storageRoot, 'research.science')
  await writeFile(archive, 'Previous export')
  let admissions = 0
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client,
    isSessionActive: () => {
      if (++admissions === 2) writeFileSync(file, 'Changed observation')
      return false
    }
  })
  await expect(
    service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  ).rejects.toThrow('changed during export')
  await expect(readFile(archive, 'utf8')).resolves.toBe('Previous export')
})

it('aborts active export and queued work when its lifecycle owner closes', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Closing export',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  let closing: Promise<void> | undefined
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client,
    isSessionActive: () => {
      closing = service.close()
      return false
    }
  })
  const archive = join(source.storageRoot, 'closed.science')
  const active = service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const queued = service.inspect(archive)
  const outcomes = await Promise.allSettled([active, queued])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
  await closing
  await expect(stat(archive)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['readable', 'unavailable'] as const)(
  'reconciles a lost database acknowledgement with a %s commit witness',
  async (witness) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Durable history',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const archive = join(source.storageRoot, 'durable.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    const transaction = target.client.$transaction.bind(target.client)
    let unpublishedSessions: unknown
    const failure = vi
      .spyOn(target.client, '$transaction')
      .mockImplementationOnce(async (...args) => {
        unpublishedSessions = (await new SessionRepository(target.storageRoot).loadAll()).sessions
        await Reflect.apply(transaction, target.client, args)
        throw new Error('Lost commit acknowledgement')
      })
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    if (witness === 'unavailable') {
      vi.spyOn(target.client.fileOriginSession, 'findUnique').mockRejectedValueOnce(
        new Error('Commit witness unavailable')
      )
      await expect(importer.importFrom(archive)).rejects.toThrow('Commit witness unavailable')
      expect(
        await fsPromises.readdir(join(target.storageRoot, 'session-package-imports'))
      ).toHaveLength(1)
    } else {
      await expect(importer.importFrom(archive)).resolves.toEqual({
        projectId: expect.any(String),
        sessionId: expect.any(String)
      })
    }
    failure.mockRestore()
    expect(unpublishedSessions).toEqual([])
    await importer.recover()
    const project = await target.client.project.findFirstOrThrow()
    const sessions = await new SessionRepository(target.storageRoot).loadAll()
    expect(sessions.sessions).toMatchObject([{ projectId: project.id, title: 'Durable history' }])
  }
)

it.each(['organized', 'deleted', 'projection-pending'] as const)(
  'preserves an already-published Session during staging recovery (%s)',
  async (state) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'source', name: 'Source' } })
    await target.client.project.create({ data: { id: 'target', name: 'Target' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'original',
      projectId: 'source',
      title: 'Original title',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const archive = join(source.storageRoot, 'session.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'source', sessionId: 'original' }, archive)
    const configRoot = join(target.storageRoot, 'config')
    const options = {
      configRoot,
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    }
    const { SessionProjectionRepository } = await import('../session-persistence/projection')
    const failure =
      state === 'projection-pending'
        ? 'Projection commit interrupted'
        : 'Staging cleanup interrupted'
    if (state === 'projection-pending') {
      vi.spyOn(SessionProjectionRepository.prototype, 'commitSave').mockRejectedValueOnce(
        new Error(failure)
      )
    } else {
      const remove = fsPromises.rm
      const cleanup = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, ...args) => {
        if (dirname(String(path)) === join(target.storageRoot, 'session-package-imports')) {
          cleanup.mockRestore()
          throw new Error(failure)
        }
        return remove(path, ...args)
      })
    }
    await expect(
      new SessionPackageService(options).importFrom(archive, undefined, undefined, undefined, {
        projectId: 'target'
      })
    ).rejects.toThrow(failure)
    const repository = new SessionRepository(
      configRoot,
      {},
      new SessionProjectionRepository(options.getClient)
    )
    const [published] = (await repository.loadAll()).sessions
    expect(published.packageOrigin).toBeDefined()
    if (state === 'organized')
      await repository.saveSession({ ...published, title: 'My organized research', pinned: true })
    else if (state === 'deleted') await repository.deleteSession(published.projectId, published.id)
    const recovery = new SessionPackageService(options)
    await expect(recovery.recover()).resolves.toBeUndefined()
    await expect(recovery.recover()).resolves.toBeUndefined()
    const current = await repository.loadSession(published.projectId, published.id)
    if (state === 'organized')
      expect(current).toMatchObject({
        title: 'My organized research',
        pinned: true,
        number: published.number
      })
    else if (state === 'deleted') expect(current).toBeUndefined()
    else expect(current).toMatchObject({ title: 'Original title', number: published.number })
    expect(await new SessionProjectionRepository(options.getClient).pending()).toEqual([])
    expect(await fsPromises.readdir(join(configRoot, 'session-package-imports'))).toEqual([])
    expect(await target.client.project.count()).toBe(1)
  }
)

it('transfers every conversation branch across separate config and data roots and reopens it offline', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  const sourceConfigRoot = join(source.storageRoot, 'config')
  const targetConfigRoot = join(target.storageRoot, 'config')
  const sourceSessions = new SessionRepository(sourceConfigRoot)
  const graph = forkEditedConversationMessage(
    createLinearConversationGraph({
      sessionId: 'session-1',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'question',
          role: 'user',
          content: 'Compare the samples',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'answer',
          role: 'agent',
          content: 'The original result',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }),
    'question',
    'alternative',
    3
  )
  await sourceSessions.saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Sample comparison',
    cwd: '',
    status: 'idle',
    messages: [],
    conversationGraph: graph,
    providerSessionId: 'private-provider-session',
    runtimeContext: {
      version: 1,
      revision: 1,
      sideChat: {
        version: 1,
        id: 'side-chat-1',
        lifecycle: 'interrupted',
        frameworkId: 'opencode',
        historyPreamble: 'Research context',
        providerSessionId: 'private-side-provider',
        entries: [
          {
            id: 'side-entry-1',
            kind: 'message',
            role: 'assistant',
            text: 'An alternative explanation'
          }
        ],
        createdAt: 1,
        updatedAt: 2
      }
    },
    permissionProfile: 'full',
    createdAt: 1,
    updatedAt: 3
  })
  const exporter = new SessionPackageService({
    storageRoot: source.storageRoot,
    configRoot: sourceConfigRoot,
    getClient: async () => source.client
  })
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    configRoot: targetConfigRoot,
    getClient: async () => target.client
  })
  const archive = join(source.storageRoot, 'research.science')
  await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const preview = await importer.inspect(archive)
  expect(preview).toMatchObject({ title: 'Sample comparison', branchCount: 2, messageCount: 2 })
  const imported = await importer.importFrom(archive)
  expect(imported.projectId).not.toBe('project-1')
  expect(imported.sessionId).not.toBe('session-1')
  await target.client.$disconnect()
  const reopened = await new SessionRepository(targetConfigRoot).loadSession(
    imported.projectId,
    imported.sessionId
  )
  const origin = await importer.readOrigin(imported)
  expect(reopened?.conversationGraph?.branches.map((branch) => branch.id)).toEqual(
    graph.branches.map((branch) => origin.identities[branch.id])
  )
  expect(reopened?.conversationGraph?.messages.map((message) => message.content)).toEqual([
    'Compare the samples',
    'The original result'
  ])
  expect(reopened?.providerSessionId).toBeUndefined()
  expect(reopened?.runtimeContext?.sideChat).toMatchObject({
    historyPreamble: 'Research context',
    entries: [{ text: 'An alternative explanation' }]
  })
  expect(reopened?.runtimeContext?.sideChat?.providerSessionId).toBeUndefined()
  expect(reopened?.runtimeContext?.sideChat?.id).toBe(origin.identities['side-chat-1'])
  expect(origin.identities['side-chat-1']).not.toBe('side-chat-1')
  expect(reopened?.status).toBe('idle')
  expect(reopened?.packageOrigin?.sourceSessionId).toBe('session-1')
  if (!reopened) throw new Error('Imported Session was not readable')
  const restoredGraph = activateConversationBranch(
    reopened.conversationGraph!,
    origin.identities[graph.branches[0].id]
  )
  await new SessionRepository(targetConfigRoot).saveSession({
    ...reopened,
    conversationGraph: restoredGraph,
    messages: resolveActiveConversationMessages(restoredGraph).map(projectConversationMessage),
    filesRevision: (reopened.filesRevision ?? 0) + 1
  })
  const restored = await new SessionRepository(targetConfigRoot).loadSession(
    imported.projectId,
    imported.sessionId
  )
  expect(restored?.messages.map((message) => message.content)).toEqual([
    'Compare the samples',
    'The original result'
  ])
  expect(restored?.packageOrigin).toEqual(reopened.packageOrigin)
  await expect(
    new SessionRepository(targetConfigRoot).saveSession({
      ...restored!,
      messages: restored!.messages.map((message) => ({ ...message, content: 'Changed research' }))
    })
  ).rejects.toThrow('read-only')
  await expect(
    new SessionRepository(targetConfigRoot).saveSession({
      ...reopened,
      packageOrigin: undefined,
      status: 'running'
    })
  ).rejects.toThrow('read-only')
  const duplicate = await importer.importFrom(archive)
  expect(duplicate.projectId).not.toBe(imported.projectId)
  expect(duplicate.sessionId).not.toBe(imported.sessionId)
  expect((await importer.readOrigin(duplicate)).identities[graph.rootFrameId]).not.toBe(
    origin.identities[graph.rootFrameId]
  )
  await expect(target.client.project.count()).resolves.toBe(2)
})

it('rejects self-consistent archive hashes when the embedded evidence contradicts its version', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Plot',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await source.stagePng('plot')
  await source.repository.createVersion(createArtifactVersionRequest())
  const archive = join(source.storageRoot, 'tampered.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const expanded = join(source.storageRoot, 'expanded')
  await mkdir(expanded)
  await extractTar({ cwd: expanded, file: archive })
  const records = JSON.parse(await readFile(join(expanded, 'records.json'), 'utf8'))
  const row = records.tables.ArtifactVersion[0]
  const evidence = JSON.parse(row.evidenceJson)
  evidence.filename = 'contradictory-filename.png'
  row.evidenceJson = JSON.stringify(evidence)
  row.evidenceChecksum = sha256(row.evidenceJson)
  await writeFile(join(expanded, 'records.json'), JSON.stringify(records))
  const manifest = JSON.parse(await readFile(join(expanded, 'manifest.json'), 'utf8'))
  const evidenceEntry = manifest.inventory.find(
    (entry: { storageKey?: string }) => entry.storageKey === row.evidenceStorageKey
  )
  await writeFile(join(expanded, evidenceEntry.path), row.evidenceJson)
  for (const entry of manifest.inventory) {
    entry.sizeBytes = (await stat(join(expanded, entry.path))).size
    entry.checksum = await fileChecksum(join(expanded, entry.path))
  }
  await writeFile(join(expanded, 'manifest.json'), JSON.stringify(manifest))
  await createTar({ cwd: expanded, file: archive, gzip: true }, [
    'manifest.json',
    'session.json',
    'records.json',
    'README.md',
    'objects'
  ])
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  await expect(importer.inspect(archive)).rejects.toThrow('metadata mismatch')
  await expect(importer.importFrom(archive)).rejects.toThrow('metadata mismatch')
  await expect(new ProjectRepository(async () => target.client).list()).resolves.toEqual([])
})

it.each(['root', 'frame'] as const)(
  'keeps exact cross-Session input bytes and %s Notebook execution evidence after import',
  async (laneKind) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Computed plot',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const inputStorageKey =
      'uploads/project-1/source-session/upload-1/versions/upload-version-1/content'
    const content = 'group\nA\n'
    await mkdir(dirname(join(source.storageRoot, inputStorageKey)), { recursive: true })
    await writeFile(join(source.storageRoot, inputStorageKey), content)
    await source.client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'source-session' }
    })
    await source.client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'source-session',
        filename: 'groups.txt',
        originalFilename: 'groups.txt',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: inputStorageKey,
            filename: 'groups.txt',
            originalFilename: 'groups.txt',
            contentType: 'text/plain',
            sizeBytes: BigInt(Buffer.byteLength(content)),
            checksum: sha256(content),
            createdAt: new Date(1000)
          }
        }
      }
    })
    await source.client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-1' }
    })
    const anchors = createArtifactVersionRequest(
      laneKind === 'root'
        ? {
            rootFrameId: 'root-frame-session-1',
            agentFrameId: 'root-frame-session-1'
          }
        : {}
    )
    const lane = createFrameNotebookLane('project-1', 'session-1', anchors.agentFrameId)
    const document = await source.notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: source.storageRoot,
      lane
    })
    const plot = join(document.notebookSessionRoot, 'data', 'plot.png')
    await mkdir(dirname(plot), { recursive: true })
    const observation = await startWorkingFileObservation(
      {
        dataRoot: document.dataRoot,
        notebookSessionRoot: document.notebookSessionRoot,
        fileEvidenceStorageRoot: source.storageRoot,
        fileEvidenceRoot: join(
          source.storageRoot,
          'execution-file-evidence',
          'project-1',
          'session-1'
        ),
        fileEvidenceStoragePrefix: 'execution-file-evidence/project-1/session-1',
        runId: 'notebook-run-1'
      },
      {
        watchDirectory: () => {
          throw new Error('Watcher unavailable in fixture')
        }
      }
    )
    await writeFile(plot, createPngBytes('portable plot'))
    const observed = await observation.finish()
    expect(observed.fileEvidence.generationCount).toBe(1)
    const metadata = await stat(plot)
    await source.notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane,
      run: {
        runId: 'notebook-run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        script: 'draw_plot()',
        fileEvidence: observed.fileEvidence,
        text: { stdout: 'done', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [
          {
            path: plot,
            relativePath: 'data/plot.png',
            kind: 'other',
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            createdByRunId: 'notebook-run-1'
          }
        ],
        rootFrameId: anchors.rootFrameId,
        agentFrameId: anchors.agentFrameId,
        messageBranchId: anchors.messageBranchId,
        runtimeSegmentId: anchors.runtimeSegmentId,
        promptMessageId: anchors.promptMessageId,
        environmentCapture: { state: 'unavailable', reason: 'environment-capture-failed' },
        inputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceVersionNumber: 1,
            sourceCreatedAt: new Date(1000).toISOString(),
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session',
            filename: 'groups.txt',
            contentType: 'text/plain',
            sizeBytes: Buffer.byteLength(content),
            checksum: sha256(content),
            storageKey: inputStorageKey,
            association: 'resolver-accessed'
          }
        ]
      }
    })
    await source.stagePng('portable plot')
    const version = await source.repository.createVersion({
      ...anchors,
      notebookSessionId: 'session-1',
      producerRunId: 'notebook-run-1',
      sourceFileObservation: {
        path: await realpath(plot),
        sizeBytes: metadata.size,
        mtimeMs: metadata.mtimeMs
      }
    })
    const sourceIdentity = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId,
      versionId: version.versionId
    }
    await expect(source.repository.getVersionCore(sourceIdentity)).resolves.toMatchObject({
      descriptor: { versionId: version.versionId }
    })
    // The dependency pins v1 even after the source file advances to an unrelated current head.
    await source.client.uploadVersion.create({
      data: {
        id: 'upload-version-2',
        uploadFileId: 'upload-1',
        versionNumber: 2,
        basedOnVersionId: 'upload-version-1',
        state: 'ready',
        contentStorageKey:
          'uploads/project-1/source-session/upload-1/versions/upload-version-2/content',
        filename: 'groups.txt',
        originalFilename: 'groups.txt',
        sizeBytes: BigInt(0),
        checksum: sha256(''),
        createdAt: new Date(2000)
      }
    })
    await source.client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-2' }
    })
    // This input was only read in a Notebook run; no Artifact points to it.
    const secondKey = 'uploads/project-1/source-session/upload-1/versions/upload-version-2/content'
    await mkdir(dirname(join(source.storageRoot, secondKey)), { recursive: true })
    await writeFile(join(source.storageRoot, secondKey), 'group\nB\n')
    await source.client.uploadVersion.update({
      where: { id: 'upload-version-2' },
      data: {
        sizeBytes: BigInt(8),
        checksum: sha256('group\nB\n'),
        contentType: 'text/plain'
      }
    })
    const previousRun = (
      await source.notebookRepository.readSessionRuns('project-1', 'session-1')
    )[0]
    await source.notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane,
      run: {
        ...previousRun,
        runId: 'notebook-run-2',
        cellId: 'cell-2',
        startedAt: 3,
        endedAt: 4,
        script: 'read_input()',
        fileEvidence: undefined,
        workingFiles: [],
        inputFiles: [
          {
            ...previousRun.inputFiles![0],
            inputFileVersionId: 'upload-version-2',
            sourceVersionNumber: 2,
            sourceCreatedAt: new Date(2000).toISOString(),
            checksum: sha256('group\nB\n'),
            storageKey: secondKey,
            sizeBytes: 8
          }
        ]
      }
    })
    const archive = join(source.storageRoot, 'inputs.science')
    const review = await new ReviewRepository(async () => source.client, {
      snapshotStorageRoot: source.storageRoot
    }).createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'question',
      lifecycle: 'complete',
      outcome: 'flagged',
      scope: {
        turnMessageId: 'question',
        blocks: [],
        artifactVersionIds: [version.versionId],
        sourceDocumentVersionIds: ['upload-version-1']
      },
      scopeSnapshot: []
    })
    const selectiveExporter = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    const sourceVersion = await source.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    // A generation blob and Notebook working file retain the same plot bytes. A selection that
    // claims to omit those bytes must fail before any user-visible archive is published.
    await expect(
      selectiveExporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
        selectFiles: async (files) => {
          // Input users, derived versions, Review scope and Notebook inputs all reach the
          // public selection inventory in a stable order, across Artifact and Upload identities.
          expect(
            files.find((file) => file.storageKey === sourceVersion.contentStorageKey)
          ).toMatchObject({ requiredForEvidence: true })
          expect(files.find((file) => file.storageKey === inputStorageKey)?.dependentFiles).toEqual(
            [sourceVersion.filename, 'groups.txt', `Review ${review.id}`, 'Notebook notebook-run-1']
          )
          expect(
            files.find((file) => file.storageKey === sourceVersion.contentStorageKey)
              ?.dependentFiles
          ).toEqual([`Review ${review.id}`])
          expect(files.find((file) => file.storageKey === secondKey)?.dependentFiles).toContain(
            'Notebook notebook-run-2'
          )
          return [sourceVersion.contentStorageKey]
        }
      })
    ).rejects.toThrow('excluded file also exists')
    await expect(stat(archive)).rejects.toMatchObject({ code: 'ENOENT' })
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    const destination = laneKind === 'frame' ? 'existing-project' : undefined
    if (destination)
      await target.client.project.create({ data: { id: destination, name: 'Existing research' } })
    const imported = await importer.importFrom(archive, undefined, undefined, undefined, {
      projectId: destination
    })
    const history = await importer.readOrigin(imported)
    expect(history.identities['upload-version-2']).toEqual(expect.any(String))
    const forwardingSelection = vi.fn(
      async (files: import('../../shared/session-package').PackageSelectableFile[]) => {
        expect(
          files.find((file) => file.storageKey === sourceVersion.contentStorageKey)
        ).toMatchObject({ requiredForEvidence: true })
        expect(files.find((file) => file.storageKey === secondKey)?.dependentFiles).toContain(
          'Notebook notebook-run-2'
        )
        return []
      }
    )
    await importer.exportTo(imported, join(target.storageRoot, 'forward-inputs.science'), {
      selectFiles: forwardingSelection
    })
    expect(forwardingSelection).toHaveBeenCalledOnce()
    const importedRun = (
      await target.notebookRepository.readSessionRuns(imported.projectId, imported.sessionId)
    )[0]
    const importedEvidence = importedRun.fileEvidence!
    expect(importedEvidence.storageKey).toBe(
      `execution-file-evidence/${imported.projectId}/${imported.sessionId}/activity-${importedRun.runId}/evidence.json`
    )
    const sidecarText = await readFile(
      join(target.storageRoot, ...importedEvidence.storageKey!.split('/')),
      'utf8'
    )
    expect(sha256(sidecarText)).toBe(importedEvidence.checksum)
    const sidecar = JSON.parse(sidecarText)
    expect(sidecar.activityId).toBe(importedRun.runId)
    await expect(
      readFile(
        join(target.storageRoot, ...sidecar.relations[0].generation.contentStorageKey.split('/'))
      )
    ).resolves.toEqual(createPngBytes('portable plot'))
    const reader = new ArtifactProvenanceRepository(target.repositoryOptions)
    const identity = {
      projectId: imported.projectId,
      appSessionId: imported.sessionId,
      artifactId: history.identities[version.artifactId],
      versionId: history.identities[version.versionId]
    }
    await expect(
      reader.readDependencyRelations({
        projectId: imported.projectId,
        versionId: identity.versionId,
        direction: 'up'
      })
    ).resolves.toMatchObject([{ dependsOnVersionId: history.identities['upload-version-1'] }])
    await expect(reader.getVersionProvenance(identity)).resolves.toMatchObject({
      execution: { runs: [{ script: 'draw_plot()' }] }
    })
    const localVersion = await target.client.artifactVersion.findUniqueOrThrow({
      where: { id: identity.versionId }
    })
    const sourceRecipe = JSON.parse(sourceVersion.executionSnapshotJson!).reproducibilityRecipe
    const localRecipe = JSON.parse(localVersion.executionSnapshotJson!).reproducibilityRecipe
    expect(localRecipe.targetVersionId).toBe(identity.versionId)
    expect(localRecipe.recipeId).not.toBe(sourceRecipe.recipeId)
    expect(localRecipe.graphChecksum).not.toBe(sourceRecipe.graphChecksum)
    const preservedRecords = JSON.parse(
      await readFile(
        join(
          target.storageRoot,
          'artifacts',
          imported.projectId,
          imported.sessionId,
          '.session-package',
          'source',
          'records.json'
        ),
        'utf8'
      )
    ) as import('./native-snapshot').PackageRecords
    expect(
      preservedRecords.tables.ArtifactVersion.find((row) => row.id === version.versionId)
        ?.executionSnapshotJson
    ).toBe(sourceVersion.executionSnapshotJson)
    expect(JSON.parse(localVersion.executionSnapshotJson!).analysisRevision).toMatchObject({
      lineageBuilder: JSON.parse(sourceVersion.executionSnapshotJson!).analysisRevision
        .lineageBuilder
    })
    const runs = await target.notebookRepository.readSessionRuns(
      imported.projectId,
      imported.sessionId
    )
    expect(runs.map((run) => run.script)).toEqual(['draw_plot()', 'read_input()'])
    const files = new ManagedFileVersionService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    await expect(
      files.inspect({
        projectId: imported.projectId,
        source: 'upload',
        fileId: history.identities['upload-1']
      })
    ).resolves.toMatchObject({ canEdit: false })
    await expect(
      files.saveTextEdit({
        projectId: imported.projectId,
        source: 'upload',
        fileId: history.identities['upload-1'],
        basedOnVersionId: history.identities['upload-version-1'],
        expectedHeadVersionId: history.identities['upload-version-1'],
        content: 'Changed evidence',
        operationId: 'edit-imported-input'
      })
    ).rejects.toThrow('read-only')
    const lineageCount = await target.client.artifactLineage.count()
    await expect(
      files.adoptLegacyArtifact({
        projectId: imported.projectId,
        sessionId: imported.sessionId,
        sourceFileId: 'new-legacy-artifact',
        logicalFilename: 'new-evidence.txt',
        content: Buffer.from('new evidence')
      })
    ).rejects.toThrow('read-only')
    expect(await target.client.artifactLineage.count()).toBe(lineageCount)
    const executorFactory = vi.fn(() => {
      throw new Error('An imported Session must never create an executor')
    })
    const notebook = new NotebookRuntimeService({
      projectId: imported.projectId,
      configRoot: target.storageRoot,
      dataRoot: target.storageRoot,
      repository: target.notebookRepository,
      executorFactory
    })
    const request = {
      projectId: imported.projectId,
      sessionId: imported.sessionId,
      workspaceCwd: target.storageRoot
    }
    await expect(notebook.state(request)).resolves.toMatchObject({
      runCount: 2,
      runs: [{ script: 'draw_plot()' }, { script: 'read_input()' }],
      environments: []
    })
    await expect(
      notebook.execute({ ...request, code: 'print(1)', source: 'user', language: 'python' })
    ).rejects.toThrow('read-only')
    expect(executorFactory).not.toHaveBeenCalled()
    await expect(
      deleteWorkingFileEvidenceProject(target.storageRoot, imported.projectId)
    ).resolves.toBeUndefined()
  }
)

it.each(['checksum', 'sidecar'] as const)(
  'rejects a Review-only Session with a corrupt %s before deriving evidence',
  async (corruption) => {
    const source = await createProvenanceTestFixture()
    fixtures.push(source)
    await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Reviewed history',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const reviews = new ReviewRepository(async () => source.client, {
      snapshotStorageRoot: source.storageRoot
    })
    const review = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'question',
      lifecycle: 'complete',
      outcome: 'pass',
      scope: { turnMessageId: 'question', blocks: [], artifactVersionIds: [] },
      scopeSnapshot: []
    })
    const snapshot = await source.client.reviewScopeSnapshot.findUniqueOrThrow({
      where: { reviewId: review.id }
    })
    if (corruption === 'checksum')
      await source.client.reviewScopeSnapshot.update({
        where: { id: snapshot.id },
        data: { checksum: '0'.repeat(64) }
      })
    else
      await writeFile(join(source.storageRoot, ...snapshot.storageKey.split('/')), '{"blocks":[]}')
    const service = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    await expect(
      service.exportTo(
        { projectId: 'project-1', sessionId: 'session-1' },
        join(source.storageRoot, 'review.science')
      )
    ).rejects.toThrow('Review snapshot')
  }
)

it('preserves a completed Review and its findings without restarting the Review', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Reviewed work',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await source.stagePng('Evidence reviewed from another Session')
  const reviewedVersion = await source.repository.createVersion(
    createArtifactVersionRequest({ appSessionId: 'reviewed-source' })
  )
  const reviews = new ReviewRepository(async () => source.client, {
    snapshotStorageRoot: source.storageRoot
  })
  const review = await reviews.createReview({
    projectId: 'project-1',
    sessionId: 'session-1',
    turnMessageId: 'question',
    lifecycle: 'complete',
    outcome: 'flagged',
    scope: {
      turnMessageId: 'question',
      blocks: [],
      artifactVersionIds: [reviewedVersion.versionId]
    },
    scopeSnapshot: []
  })
  await reviews.addChecks(review.id, [
    {
      status: 'warn',
      claim: 'Sample count is small',
      evidence: 'Only three samples',
      locator: {
        blockRef: { messageId: 'question', blockIndex: 0 },
        contentHash: sha256('Only three samples')
      }
    }
  ])
  const archive = join(source.storageRoot, 'review.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const imported = await importer.importFrom(archive)
  const origin = await importer.readOrigin(imported)
  expect(origin.identities[reviewedVersion.versionId]).toEqual(expect.any(String))
  await expect(
    target.repository.getVersionCore({
      projectId: imported.projectId,
      appSessionId: origin.identities['reviewed-source'],
      artifactId: origin.identities[reviewedVersion.artifactId],
      versionId: origin.identities[reviewedVersion.versionId]
    })
  ).resolves.toMatchObject({ descriptor: { name: 'plot.png' } })
  await expect(
    new ReviewRepository(async () => target.client).getReviewsForProjectSession(
      imported.projectId,
      imported.sessionId
    )
  ).resolves.toMatchObject([
    { lifecycle: 'complete', outcome: 'flagged', checks: [{ claim: 'Sample count is small' }] }
  ])
})

it('imports both immutable Artifact Versions and keeps original evidence distinct from local identities', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Plot history',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  await source.stagePng('first result')
  const first = await source.repository.createVersion(createArtifactVersionRequest())
  await source.stagePng('second result')
  await source.repository.createVersion(
    createArtifactVersionRequest({
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64)
    })
  )
  const exporter = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const archive = join(source.storageRoot, 'plots.science')
  await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const result = await importer.importFrom(archive)
  const history = await importer.readOrigin(result)
  const artifactId = history.identities[first.artifactId]
  const versionId = history.identities[first.versionId]
  expect(artifactId).not.toBe(first.artifactId)
  const provenance = new ArtifactProvenanceRepository(target.repositoryOptions)
  const identity = {
    projectId: result.projectId,
    appSessionId: result.sessionId,
    artifactId,
    versionId
  }
  await expect(provenance.getLineage(identity)).resolves.toMatchObject({
    versions: [{ versionNumber: 1 }, { versionNumber: 2 }]
  })
  await expect(provenance.getVersionCore(identity)).resolves.toMatchObject({
    descriptor: { versionId }
  })
  expect(history.sourceManifest.source.sessionId).toBe('session-1')
})

it.each(['pdf-context', 'pdf-annotation', 'text-annotation', 'image-annotation'] as const)(
  'includes a foreign immutable file referenced only by %s',
  async (kind) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'References' } })
    const content = Buffer.from('%PDF-1.4\nfixture evidence\n%%EOF')
    const storageKey = 'uploads/project-1/foreign-session/file-1/versions/version-1/paper.pdf'
    await mkdir(dirname(join(source.storageRoot, storageKey)), { recursive: true })
    await writeFile(join(source.storageRoot, storageKey), content)
    await source.client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'foreign-session' }
    })
    await source.client.uploadFile.create({
      data: {
        id: 'file-1',
        projectId: 'project-1',
        sessionId: 'foreign-session',
        filename: 'paper.pdf',
        originalFilename: 'paper.pdf',
        versions: {
          create: {
            id: 'version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: storageKey,
            filename: 'paper.pdf',
            originalFilename: 'paper.pdf',
            contentType: 'application/pdf',
            sizeBytes: BigInt(content.length),
            checksum: sha256(content)
          }
        }
      }
    })
    await source.client.uploadFile.update({
      where: { id: 'file-1' },
      data: { currentVersionId: 'version-1' }
    })
    const fileSource = {
      kind: 'upload-version' as const,
      projectId: 'project-1',
      sessionId: 'foreign-session',
      versionId: 'version-1',
      name: 'paper.pdf',
      path: createUploadVersionReference('version-1', {
        projectId: 'project-1',
        sessionId: 'foreign-session',
        fileId: 'file-1'
      }),
      checksum: sha256(content)
    }
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Read the evidence',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'question',
          role: 'user',
          content: 'Explain the reference',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1,
          ...(kind === 'pdf-context'
            ? {
                pdfContext: {
                  version: 1,
                  bindings: [
                    {
                      version: 1,
                      bindingId: 'binding-1',
                      sourceKind: 'upload-version',
                      sourceFileId: 'file-1',
                      sourceVersionId: 'version-1',
                      sourceSessionId: 'foreign-session',
                      name: 'paper.pdf',
                      mimeType: 'application/pdf',
                      sizeBytes: content.length,
                      checksum: sha256(content),
                      linkedAt: 1
                    }
                  ]
                }
              }
            : {}),
          annotations:
            kind === 'pdf-annotation'
              ? [
                  {
                    id: 'annotation-1',
                    kind: 'pdf',
                    target: 'agent',
                    source: fileSource,
                    selector: {
                      kind: 'text',
                      pageNumber: 1,
                      exact: 'evidence',
                      position: { start: 0, end: 8 },
                      quads: [{ x: 0, y: 0, width: 0.5, height: 0.1 }],
                      extractorVersion: 'fixture'
                    }
                  }
                ]
              : kind === 'text-annotation'
                ? [
                    {
                      id: 'annotation-1',
                      kind: 'text',
                      target: 'agent',
                      quote: 'evidence',
                      source: {
                        kind: 'project-file',
                        projectId: 'project-1',
                        path: fileSource.path
                      }
                    }
                  ]
                : kind === 'image-annotation'
                  ? [
                      {
                        id: 'annotation-1',
                        kind: 'image-point',
                        target: 'agent',
                        note: 'evidence',
                        source: { ...fileSource, mimeType: 'image/png' },
                        point: { x: 0.5, y: 0.5 },
                        naturalSize: { width: 100, height: 100 }
                      }
                    ]
                  : []
        }
      ]
    })
    const archive = join(source.storageRoot, 'reference.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    const imported = await importer.importFrom(archive)
    const origin = await importer.readOrigin(imported)
    expect(origin.identities['version-1']).toBeDefined()
    const version = await target.client.uploadVersion.findUniqueOrThrow({
      where: { id: origin.identities['version-1'] }
    })
    expect(await readFile(join(target.storageRoot, version.contentStorageKey))).toEqual(content)
    const session = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    if (kind === 'pdf-context')
      expect(session?.messages[0].pdfContext?.bindings[0].sourceVersionId).toBe(version.id)
    else expect(session?.messages[0].annotations).toHaveLength(1)
  }
)

it('refuses an idle Session with queued runtime delivery rather than importing runnable history', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Queued context',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    runtimeContext: {
      version: 1,
      revision: 1,
      sideChatRelays: [
        { id: 'relay-1', sideChatId: 'side-1', text: 'Queued instruction', createdAt: 2 }
      ]
    }
  })
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  await expect(
    service.exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      join(source.storageRoot, 'queued.science')
    )
  ).rejects.toThrow('finish')
})

it('blocks recognized sensitive content when forwarding an externally created package', async () => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'External research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const archive = join(source.storageRoot, 'external.science')
  await new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const expanded = join(source.storageRoot, 'external-package')
  await mkdir(expanded)
  await extractTar({ cwd: expanded, file: archive })
  const document = JSON.parse(await readFile(join(expanded, 'session.json'), 'utf8'))
  document.session.title = 'Authorization: Bearer synthetic-private-value'
  await writeFile(join(expanded, 'session.json'), JSON.stringify(document))
  const manifest = JSON.parse(await readFile(join(expanded, 'manifest.json'), 'utf8'))
  manifest.source.title = document.session.title
  for (const entry of manifest.inventory) {
    entry.sizeBytes = (await stat(join(expanded, entry.path))).size
    entry.checksum = await fileChecksum(join(expanded, entry.path))
  }
  await writeFile(join(expanded, 'manifest.json'), JSON.stringify(manifest))
  await createTar({ cwd: expanded, file: archive, gzip: true }, [
    'manifest.json',
    ...manifest.inventory.map((entry: { path: string }) => entry.path)
  ])
  const importer = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const imported = await importer.importFrom(archive)
  await expect(
    importer.exportTo(imported, join(target.storageRoot, 'forward.science'))
  ).rejects.toThrow('Sensitive content detected')
  expect((await importer.readOrigin(imported)).sourceManifest.source.title).toBe(
    document.session.title
  )
})

it('includes retained Notebook bytes in the content-selection summary even without optional files', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Workspace evidence' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Results',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: []
  })
  const key = 'notebooks/project-1/session-1/data/result.csv'
  await mkdir(dirname(join(source.storageRoot, key)), { recursive: true })
  await writeFile(join(source.storageRoot, key), Buffer.alloc(1024, 'a'))
  const choose = vi.fn(async () => [])
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  await service.exportTo(
    { projectId: 'project-1', sessionId: 'session-1' },
    join(source.storageRoot, 'results.science'),
    { selectFiles: choose }
  )
  expect(choose).toHaveBeenCalledWith(
    [],
    expect.any(AbortSignal),
    expect.objectContaining({
      retainedFiles: [expect.objectContaining({ storageKey: key, sizeBytes: 1024 })],
      metadataBytes: expect.any(Number)
    }),
    'Results'
  )
})

it.each(['accept', 'reject', 'cancel'] as const)(
  'owns the reviewed import staging through %s',
  async (decision) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Reviewed import' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Reviewed bytes',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: []
    })
    const archive = join(source.storageRoot, 'reviewed.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    const controller = new AbortController()
    const confirm = vi.fn(async (preview) => {
      expect(preview.title).toBe('Reviewed bytes')
      await writeFile(archive, 'No longer a readable archive')
      if (decision === 'reject') throw new Error('Import declined')
      if (decision === 'cancel') controller.abort(new Error('Import cancelled'))
    })
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    const pending = importer.importFrom(archive, controller.signal, undefined, confirm)
    if (decision === 'accept') {
      const identity = await pending
      expect(
        await new SessionRepository(target.storageRoot).loadSession(
          identity.projectId,
          identity.sessionId
        )
      ).toMatchObject({ title: 'Reviewed bytes' })
    } else {
      await expect(pending).rejects.toThrow(
        decision === 'reject' ? 'Import declined' : 'Import cancelled'
      )
      expect(await new SessionRepository(target.storageRoot).loadAll()).toMatchObject({
        sessions: []
      })
    }
    expect(confirm).toHaveBeenCalledOnce()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(target.storageRoot, 'session-package-imports'))).toEqual([])
  }
)

it('does not spend processing time while the user chooses export content', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Patient selection' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Patient selection',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: []
  })
  // Make the platform timeout observable by the same fake clock as processing timers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('Processing deadline elapsed')), ms)
    return controller.signal
  })
  let resume!: () => void
  let selectionSignal: AbortSignal | undefined
  const selection = new Promise<void>((resolve) => {
    resume = resolve
  })
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const pending = service
    .exportTo(
      { projectId: 'project-1', sessionId: 'session-1' },
      join(source.storageRoot, 'patient.science'),
      {
        selectFiles: async (_files, signal) => {
          selectionSignal = signal
          await selection
          return []
        }
      }
    )
    .catch((error: unknown) => error)
  try {
    await vi.waitFor(() => expect(selectionSignal).toBeDefined())
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(selectionSignal?.aborted).toBe(false)
  } finally {
    resume()
    timeout.mockRestore()
    vi.useRealTimers()
  }
  expect(await pending).toMatchObject({ title: 'Patient selection' })
})

it('still aborts processing after the budget expires while copying', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Bounded processing' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Bounded processing',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: []
  })
  const key = 'notebooks/project-1/session-1/data/large.csv'
  await mkdir(dirname(join(source.storageRoot, key)), { recursive: true })
  await writeFile(join(source.storageRoot, key), Buffer.alloc(1024 * 1024, 'a'))
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  let copying = false
  const archive = join(source.storageRoot, 'timed-out.science')
  try {
    await expect(
      service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
        onProgress: (progress) => {
          if (progress.phase === 'copying' && !copying) {
            copying = true
            vi.advanceTimersByTime(11 * 60_000)
          }
        }
      })
    ).rejects.toThrow(/abort|timed out/i)
  } finally {
    vi.useRealTimers()
  }
  expect(copying).toBe(true)
  await expect(stat(archive)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stat(join(source.storageRoot, key))).size).toBe(1024 * 1024)
})

it.each([false, true])(
  'preserves source reproducibility receipts and logs with omitted outputs=%s',
  async (omitOutput) => {
    const {
      ArtifactReproducibilityReceiptStore,
      listArtifactReproducibilityReceipts,
      getArtifactReproducibilityCheckLog,
      getArtifactReproducibilityOutput
    } = await import('../artifacts/artifact-reproducibility-receipts')
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Probe' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Probe',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    await source.stagePng('probe')
    const version = await source.repository.createVersion(createArtifactVersionRequest())
    const row = await source.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId,
      versionId: version.versionId
    }
    const store = new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => dirname(join(source.storageRoot, row.contentStorageKey))
    })
    const lock = JSON.stringify({
      schemaVersion: 1,
      format: 'environment-lock-bundle',
      kernelKind: 'python',
      environmentName: 'default-python',
      components: [
        {
          ecosystem: 'conda',
          format: 'conda-explicit-md5',
          resolution: 'locked',
          explicitLock:
            '@EXPLICIT\nhttps://repo.example.test/python-3.12.conda#0123456789abcdef0123456789abcdef\n',
          packages: ['python']
        }
      ]
    })
    const lockChecksum = sha256(lock)
    await mkdir(join(source.storageRoot, 'runtime/provenance/environment-locks'), {
      recursive: true
    })
    await writeFile(
      join(source.storageRoot, 'runtime/provenance/environment-locks', `${lockChecksum}.json`),
      lock
    )
    const output = Buffer.from('source result\n')
    expect(await store.retainOutput(request, output)).toBe(true)
    const originalReceipt = await store.append(request, {
      schemaVersion: 1,
      receiptId: 'probe-check',
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-02T00:01:00.000Z',
      outcome: 'different',
      artifactVersion: { ...request, targetChecksum: row.checksum! },
      frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
      recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
      environmentLocks: [
        {
          requirementId: 'python:analysis',
          kernelKind: 'python',
          environmentName: 'default-python',
          lockChecksum
        }
      ],
      completedStepIds: ['notebook:run-1'],
      comparisons: [
        {
          stepId: 'notebook:run-1',
          entityId: 'file-1',
          relativePath: 'result.csv',
          expectedChecksum: 'e'.repeat(64),
          expectedSizeBytes: output.length,
          actualChecksum: sha256(output),
          actualSizeBytes: output.length,
          status: 'different',
          reason: 'checksum-mismatch',
          outputCaptured: true
        }
      ]
    })
    const failedAttempt = await store.recordFailure(
      request,
      {
        attemptId: 'failed-source-check',
        startedAt: '2026-09-02T00:04:00.000Z',
        completedAt: '2026-09-02T00:05:00.000Z',
        artifactVersion: request,
        frontierId: 'original-inputs',
        phase: 'restoring-environments'
      },
      { entries: [], truncated: false }
    )
    expect((await store.list(request)).receipts).toHaveLength(1)
    const { SessionReproducibilityStore } =
      await import('../artifacts/session-reproducibility-store')
    const batch = {
      batchId: 'source-batch',
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      createdAt: '2026-09-02T00:00:00.000Z',
      status: 'completed' as const,
      targets: [
        {
          artifactId: request.artifactId,
          versionId: request.versionId,
          name: 'probe.png',
          status: 'different' as const,
          receiptChecksum: originalReceipt.receiptChecksum
        }
      ]
    }
    await new SessionReproducibilityStore(source.storageRoot).save(batch)
    const archive = join(source.storageRoot, 'probe.science')
    await new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
      selectFiles: async (files) => {
        const reproduced = files.filter((file) => file.source === 'reproducibility')
        expect(reproduced).toHaveLength(1)
        return omitOutput ? reproduced.map((file) => file.storageKey) : []
      }
    })
    const extracted = join(source.storageRoot, 'extracted')
    await mkdir(extracted)
    await extractTar({ file: archive, cwd: extracted })
    const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))
    expect(
      JSON.parse(await readFile(join(extracted, 'records.json'), 'utf8')).reproducibility
        .sourceSessionCheck
    ).toEqual(batch)
    const receipts = manifest.inventory.filter((entry: { storageKey?: string }) =>
      entry.storageKey?.includes('reproducibility-checks')
    )
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    const imported = await importer.importFrom(archive)
    const origin = await importer.readOrigin(imported)
    const importedRow = await target.client.artifactVersion.findUniqueOrThrow({
      where: { id: origin.identities[version.versionId] }
    })
    const scope = {
      projectId: imported.projectId,
      appSessionId: imported.sessionId,
      artifactId: origin.identities[version.artifactId],
      versionId: importedRow.id
    }
    const after = await listArtifactReproducibilityReceipts(target.repository, scope)
    expect(receipts.length).toBeGreaterThan(0)
    expect(after.receipts).toEqual([originalReceipt])
    expect(after.latestFailedAttempt).toEqual(failedAttempt)
    expect(
      await getArtifactReproducibilityCheckLog(target.repository, {
        ...scope,
        attemptId: failedAttempt.attemptId
      })
    ).toEqual(await store.getCheckLog({ ...request, attemptId: failedAttempt.attemptId }))
    expect(after.sourceArtifactVersion).toEqual(request)
    expect(
      await readFile(
        join(
          dirname(join(target.storageRoot, importedRow.contentStorageKey)),
          'reproducibility-locks',
          `${lockChecksum}.json`
        ),
        'utf8'
      )
    ).toBe(lock)
    expect(
      await stat(join(target.storageRoot, 'runtime/provenance/environment-locks')).catch(
        () => undefined
      )
    ).toBeUndefined()
    expect(
      await getArtifactReproducibilityCheckLog(target.repository, {
        ...scope,
        receiptChecksum: originalReceipt.receiptChecksum
      })
    ).toEqual(
      await store.getCheckLog({ ...request, receiptChecksum: originalReceipt.receiptChecksum })
    )
    if (omitOutput) {
      await expect(
        getArtifactReproducibilityOutput(
          target.repository,
          scope,
          originalReceipt.receiptChecksum,
          'file-1'
        )
      ).rejects.toThrow('not included')
      expect(
        manifest.excludedFiles.some((file: { filename: string }) => file.filename === 'result.csv')
      ).toBe(true)
    } else {
      await expect(
        getArtifactReproducibilityOutput(
          target.repository,
          scope,
          originalReceipt.receiptChecksum,
          'file-1'
        )
      ).resolves.toEqual(output)
    }
    const reusedSession = {
      id: 'reuse-source',
      projectId: imported.projectId,
      title: 'Reuse evidence',
      cwd: '',
      status: 'idle' as const,
      messages: [
        {
          id: 'reuse-message',
          role: 'user' as const,
          content: 'Inspect retained evidence',
          status: 'complete' as const,
          eventIds: [],
          createdAt: 1,
          updatedAt: 1,
          delegatedInputVersionIds: [importedRow.id]
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
    await new SessionRepository(target.storageRoot).saveSession(reusedSession)
    const reusedArchive = join(target.storageRoot, 'reused.science')
    await importer.exportTo(
      { projectId: imported.projectId, sessionId: reusedSession.id },
      reusedArchive
    )
    const reuseTarget = await createProvenanceTestFixture()
    fixtures.push(reuseTarget)
    const reuseService = new SessionPackageService({
      storageRoot: reuseTarget.storageRoot,
      getClient: async () => reuseTarget.client
    })
    const reusedImport = await reuseService.importFrom(reusedArchive)
    const reusedOrigin = await reuseService.readOrigin(reusedImport)
    const reusedScope = {
      projectId: reusedImport.projectId,
      appSessionId: reusedOrigin.identities[scope.appSessionId],
      artifactId: reusedOrigin.identities[scope.artifactId],
      versionId: reusedOrigin.identities[scope.versionId]
    }
    expect(
      (await listArtifactReproducibilityReceipts(reuseTarget.repository, reusedScope)).receipts
    ).toEqual([originalReceipt])
    await new SessionRepository(target.storageRoot).deleteSession(
      imported.projectId,
      reusedSession.id
    )
    const rollbackTarget = await createProvenanceTestFixture()
    fixtures.push(rollbackTarget)
    const rollbackService = new SessionPackageService({
      storageRoot: rollbackTarget.storageRoot,
      getClient: async () => rollbackTarget.client
    })
    await expect(
      rollbackService.importFrom(archive, undefined, (progress) => {
        if (progress.phase === 'importing') throw new Error('Stop before publication')
      })
    ).rejects.toThrow('Stop before publication')
    expect(await rollbackTarget.client.artifactVersion.count()).toBe(0)
    expect(await readdir(join(rollbackTarget.storageRoot, 'artifacts')).catch(() => [])).toEqual([])
    const forwarded = join(target.storageRoot, 'forwarded.science')
    await importer.exportTo(imported, forwarded)
    const forwardedRoot = join(target.storageRoot, 'forwarded')
    await mkdir(forwardedRoot)
    await extractTar({ file: forwarded, cwd: forwardedRoot })
    expect(await readFile(join(forwardedRoot, 'records.json'), 'utf8')).toBe(
      await readFile(join(extracted, 'records.json'), 'utf8')
    )
    const { SessionProjectionRepository } = await import('../session-persistence/projection')
    const sessions = new SessionRepository(
      target.storageRoot,
      {},
      new SessionProjectionRepository(async () => target.client)
    )
    const session = await sessions.loadSession(imported.projectId, imported.sessionId)
    await importer.prepareSessionDeletion(session!)
    await sessions.deleteSession(imported.projectId, imported.sessionId)
    await importer.recover({ collectDeletedPackages: true })
    await expect(
      stat(dirname(join(target.storageRoot, importedRow.contentStorageKey)))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await target.client.artifactVersion.count()).toBe(0)
    expect(
      await readFile(
        join(source.storageRoot, 'runtime/provenance/environment-locks', `${lockChecksum}.json`),
        'utf8'
      )
    ).toBe(lock)
  },
  60_000
)

it('retains a later Version lock when an earlier owner cannot supply the same checksum', async () => {
  const { ArtifactReproducibilityReceiptStore } =
    await import('../artifacts/artifact-reproducibility-receipts')
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.client.project.create({ data: { id: 'project-1', name: 'Lock ownership' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Locks',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  for (const filename of ['one.png', 'two.png']) {
    await fixture.stagePng(filename, filename)
    await fixture.repository.createVersion(
      createArtifactVersionRequest({ filename, writeOperationId: filename })
    )
  }
  const rows = await fixture.client.artifactVersion.findMany({ orderBy: { id: 'asc' } })
  expect(rows).toHaveLength(2)
  const lock = JSON.stringify({
    schemaVersion: 1,
    format: 'environment-lock-bundle',
    kernelKind: 'python',
    environmentName: 'analysis',
    components: [
      {
        ecosystem: 'conda',
        format: 'conda-explicit-md5',
        resolution: 'locked',
        explicitLock:
          '@EXPLICIT\nhttps://repo.example.test/python.conda#0123456789abcdef0123456789abcdef\n',
        packages: ['python']
      }
    ]
  })
  const checksum = sha256(lock)
  await mkdir(join(fixture.storageRoot, 'runtime/provenance/environment-locks'), {
    recursive: true
  })
  await writeFile(
    join(fixture.storageRoot, 'runtime/provenance/environment-locks', `${checksum}.json`),
    lock
  )
  for (const [index, row] of rows.entries()) {
    const scope = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: row.artifactId,
      versionId: row.id
    }
    const directory = dirname(join(fixture.storageRoot, row.contentStorageKey))
    await new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => directory
    }).append(scope, {
      schemaVersion: 1,
      receiptId: `check-${index}`,
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-02T00:01:00.000Z',
      outcome: 'matched',
      artifactVersion: { ...scope, targetChecksum: row.checksum! },
      frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
      recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
      environmentLocks: [
        {
          requirementId: 'python:analysis',
          kernelKind: 'python',
          environmentName: 'analysis',
          lockChecksum: checksum
        }
      ],
      completedStepIds: ['run'],
      comparisons: [
        {
          stepId: 'run',
          entityId: 'output',
          relativePath: row.filename,
          expectedChecksum: row.checksum!,
          actualChecksum: row.checksum!,
          expectedSizeBytes: Number(row.sizeBytes),
          actualSizeBytes: Number(row.sizeBytes),
          status: 'matched'
        }
      ]
    })
    if (index === 0)
      await writeFile(
        join(directory, 'reproducibility-source.json'),
        JSON.stringify({
          sourceScope: scope,
          entityIds: {},
          omittedOutputChecksums: [],
          lockChecksums: [checksum]
        })
      )
  }
  const archive = join(fixture.storageRoot, 'locks.science')
  await new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  }).exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const extracted = join(fixture.storageRoot, 'locks-extracted')
  await mkdir(extracted)
  await extractTar({ file: archive, cwd: extracted })
  const records = JSON.parse(await readFile(join(extracted, 'records.json'), 'utf8'))
  expect(records.reproducibility.versions[0].environmentLocks[0].serialized).toBeUndefined()
  expect(records.reproducibility.versions[1].environmentLocks[0].serialized).toBe(lock)
})

it('creates a named destination only after validation and final confirmation', async () => {
  const source = await createProvenanceTestFixture()
  const destination = await createProvenanceTestFixture()
  fixtures.push(source, destination)
  await source.client.project.create({ data: { id: 'source', name: 'Original project' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session',
    projectId: 'source',
    title: 'Research',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const exporter = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const importer = new SessionPackageService({
    storageRoot: destination.storageRoot,
    getClient: async () => destination.client
  })
  const archive = join(source.storageRoot, 'research.science')
  await exporter.exportTo({ projectId: 'source', sessionId: 'session' }, archive)
  const target = { projectName: 'Reproduction study' }
  const cancelled = vi.fn(async () => {
    expect(await destination.client.project.count()).toBe(0)
    throw new Error('User cancelled confirmation')
  })
  await expect(
    importer.importFrom(archive, undefined, undefined, cancelled, target)
  ).rejects.toThrow('User cancelled confirmation')
  expect(cancelled).toHaveBeenCalledOnce()
  expect(await destination.client.project.count()).toBe(0)
  const confirmed = vi.fn(async () => {
    expect(await destination.client.project.count()).toBe(0)
  })
  const result = await importer.importFrom(archive, undefined, undefined, confirmed, target)
  expect(confirmed).toHaveBeenCalledOnce()
  expect(await destination.client.project.findMany()).toMatchObject([
    { id: result.projectId, name: target.projectName }
  ])
  expect((await new SessionRepository(destination.storageRoot).loadAll()).sessions).toHaveLength(1)
})

it('compares large Session metadata without allocating serialized comparison copies', async () => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Metadata' } })
  const request = { projectId: 'project-1', sessionId: 'session-1' }
  const sessions = new SessionRepository(source.storageRoot)
  await sessions.saveSession({
    id: request.sessionId,
    projectId: request.projectId,
    title: 'Metadata',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'research evidence '.repeat(8192),
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 2
      }
    ]
  })
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const stringify = JSON.stringify
  let serializedBytes = 0
  const serialization = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
    const json = stringify(value, ...args)
    if ((value?.id === request.sessionId || value?.session?.id === request.sessionId) && json)
      serializedBytes += Buffer.byteLength(json)
    return json
  })
  const path = join(source.storageRoot, 'metadata.science')
  let metadataBytes = 0
  try {
    await service.exportTo(request, path, {
      selectFiles: async (_files, _signal, summary) => {
        metadataBytes = summary.metadataBytes
        return []
      }
    })
  } finally {
    serialization.mockRestore()
    await service.close()
  }
  expect(metadataBytes).toBeGreaterThan(256 * 1024)
  // One archive payload is necessary; source consistency checks must not allocate two more.
  expect(serializedBytes).toBeLessThan(2 * metadataBytes)
})

it.each(['inactive branch', 'task history'] as const)(
  'rejects changed %s metadata before replacing an export',
  async (changed) => {
    const source = await createProvenanceTestFixture()
    fixtures.push(source)
    await source.client.project.create({ data: { id: 'project-1', name: 'Metadata' } })
    const request = { projectId: 'project-1', sessionId: 'session-1' }
    const graph = forkEditedConversationMessage(
      createLinearConversationGraph({
        sessionId: request.sessionId,
        createdAt: 1,
        updatedAt: 2,
        messages: [
          {
            id: 'question',
            role: 'user',
            content: 'research evidence '.repeat(8192),
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      }),
      'question',
      'Alternative question',
      3
    )
    await new SessionRepository(source.storageRoot).saveSession({
      id: request.sessionId,
      projectId: request.projectId,
      title: 'Metadata',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 3,
      messages: resolveActiveConversationMessages(graph).map(projectConversationMessage),
      conversationGraph: graph
    })
    const archive = join(source.storageRoot, 'metadata.science')
    await writeFile(archive, 'Keep existing export')
    const service = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    try {
      await expect(
        service.exportTo(request, archive, {
          selectFiles: async () => {
            if (changed === 'inactive branch') {
              const path = join(
                source.storageRoot,
                'sessions',
                request.projectId,
                `${request.sessionId}.json`
              )
              const document = JSON.parse(await readFile(path, 'utf8'))
              document.session.conversationGraph.messages.find(
                (message: { id: string }) => message.id === 'question'
              ).content += ' changed'
              // Leave active projection, revision, title and timestamps untouched.
              await writeFile(path, JSON.stringify(document))
            } else {
              await new FileTaskRunJournal(source.storageRoot).replace([
                {
                  id: 'task-1',
                  ...request,
                  cwd: '',
                  status: 'completed',
                  startedAt: 1,
                  completedAt: 2,
                  output: 'New result',
                  artifacts: [],
                  preferredComputeHostIds: []
                }
              ])
            }
            return []
          }
        })
      ).rejects.toThrow('The Session changed during export')
      expect(await readFile(archive, 'utf8')).toBe('Keep existing export')
    } finally {
      await service.close()
    }
  }
)

it.each([false, true])(
  'uses a temporary validation database only for native rows (Artifact: %s)',
  async (withArtifact) => {
    const source = await createProvenanceTestFixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(source, target)
    await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await new SessionRepository(source.storageRoot).saveSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Research',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    const notebookKey = 'notebooks/project-1/session-1/data/notes.txt'
    await mkdir(dirname(join(source.storageRoot, notebookKey)), { recursive: true })
    await writeFile(join(source.storageRoot, notebookKey), 'Retained research notes')
    if (withArtifact) {
      await source.stagePng('plot')
      await source.repository.createVersion(createArtifactVersionRequest())
    }
    const databases: boolean[] = []
    const remove = fsPromises.rm
    vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (typeof path === 'string' && path.includes('open-science-package-validation-'))
        databases.push((await readdir(path)).includes('open-science.db'))
      return remove(path, options)
    })
    const exporter = new SessionPackageService({
      storageRoot: source.storageRoot,
      getClient: async () => source.client
    })
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    const archive = join(source.storageRoot, 'research.science')
    try {
      await exporter.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
      await expect(importer.inspect(archive)).resolves.toMatchObject({ title: 'Research' })
      const imported = await importer.importFrom(archive)
      expect(
        await readFile(
          join(
            target.storageRoot,
            'notebooks',
            imported.projectId,
            imported.sessionId,
            'data/notes.txt'
          ),
          'utf8'
        )
      ).toBe('Retained research notes')
      expect(databases.length).toBeGreaterThan(0)
      expect(databases.every((created) => created === withArtifact)).toBe(true)
      if (!withArtifact) {
        const expanded = join(source.storageRoot, 'expanded-empty-records')
        await mkdir(expanded)
        await extractTar({ cwd: expanded, file: archive })
        const records = JSON.parse(await readFile(join(expanded, 'records.json'), 'utf8'))
        expect(
          Object.values(records.tables).every((rows) => Array.isArray(rows) && rows.length === 0)
        ).toBe(true)
        records.reproducibility = {
          versions: [],
          sourceSessionCheck: {
            batchId: 'foreign-check',
            projectId: 'another-project',
            appSessionId: 'session-1',
            createdAt: '2026-09-02T00:00:00.000Z',
            status: 'completed',
            targets: [
              {
                artifactId: 'foreign-artifact',
                versionId: 'foreign-version',
                name: 'plot.png',
                status: 'blocked',
                reason: 'evidence-unavailable'
              }
            ]
          }
        }
        await writeFile(join(expanded, 'records.json'), JSON.stringify(records))
        const manifest = JSON.parse(await readFile(join(expanded, 'manifest.json'), 'utf8'))
        for (const entry of manifest.inventory) {
          entry.sizeBytes = (await stat(join(expanded, entry.path))).size
          entry.checksum = await fileChecksum(join(expanded, entry.path))
        }
        await writeFile(join(expanded, 'manifest.json'), JSON.stringify(manifest))
        await createTar({ cwd: expanded, file: archive, gzip: true }, [
          'manifest.json',
          ...manifest.inventory.map((entry: { path: string }) => entry.path)
        ])
        await expect(importer.inspect(archive)).rejects.toThrow(
          'Source Session check identity mismatch'
        )
        await expect(importer.importFrom(archive)).rejects.toThrow(
          'Source Session check identity mismatch'
        )
        expect(await target.client.project.count()).toBe(1)
        expect((await new SessionRepository(target.storageRoot).loadAll()).sessions).toHaveLength(1)
        expect(databases.every((created) => !created)).toBe(true)
      }
    } finally {
      await exporter.close()
      await importer.close()
    }
  }
)
