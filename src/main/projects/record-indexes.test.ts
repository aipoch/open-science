import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as fsPath from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { getArtifactCurrentRunFilePath } from '../artifacts/repository'
import {
  createProvenanceTestFixture,
  createArtifactVersionRequest
} from '../artifacts/provenance-test-fixtures'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import {
  initializeProjectRecordStorage,
  registerProjectRecordStorage,
  markProjectRecordDetached
} from './record-storage'
import {
  reconcileProjectRecordIndexes,
  restoreLocatedProjectRecordIndexes,
  restoreProjectRecordIndexes,
  withProjectRecordIndexes
} from './record-indexes'
import { ProjectRepository } from './repository'
import { getAuthoritativeOverviewCounts } from '../project-files/query-support'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { NodeVersionFileOperator } from '../managed-file-versions/version-file-operator'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) }
})

const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const setup = async (version: 1 | 2 = 1) => {
  const f = await createProvenanceTestFixture()
  fixtures.push(f)
  const folder = join(f.storageRoot, 'chosen-project')
  await mkdir(folder)
  await initializeProjectRecordStorage(f.storageRoot, folder, {
    format: 'open-science-project',
    ...(version === 1
      ? { version: 1 as const }
      : { version: 2 as const, outputLayout: 'session-v1' as const }),
    projectId: 'project-1',
    name: 'Research',
    createdAt: 1
  })
  const client = withProjectRecordIndexes(f.client, f.storageRoot)
  const repository = new ArtifactProvenanceRepository({
    ...f.repositoryOptions,
    getClient: async () => client
  })
  return { ...f, folder, wrapped: client, repository }
}

it('restores immutable versions and generation facts after losing the index and relocating the folder', async () => {
  const f = await setup()
  await f.stagePng('first')
  const first = await f.repository.createVersion(createArtifactVersionRequest())
  await f.stagePng('second')
  const second = await f.repository.createVersion(
    createArtifactVersionRequest({
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64)
    })
  )
  const before = await f.client.artifactVersion.findMany({ orderBy: { versionNumber: 'asc' } })
  expect(before).toHaveLength(2)
  const firstBytes = await readFile(resolveStorageKey(f.storageRoot, before[0].contentStorageKey))
  const nextFolder = join(f.storageRoot, 'relocated-project')
  await rename(f.folder, nextFolder)
  await registerProjectRecordStorage(f.storageRoot, nextFolder, 'project-1')
  await f.client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  for (const table of [
    'ArtifactVersionInput',
    'ArtifactLiteratureManifest',
    'ArtifactVersion',
    'ArtifactLineage',
    'ArtifactMessageSnapshot',
    'FileOriginSession',
    'ContentBlob'
  ])
    await f.client.$executeRawUnsafe(`DELETE FROM "${table}"`)
  await f.client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  await restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')
  const restored = await f.client.artifactVersion.findMany({ orderBy: { versionNumber: 'asc' } })
  expect(restored).toEqual(before)
  expect(restored.map((v) => v.id)).toEqual([first.versionId, second.versionId])
  const files = new NodeVersionFileOperator({ storageRoot: f.storageRoot })
  const lease = await files.openImmutable(restored[0].contentStorageKey, {
    checksum: restored[0].checksum,
    sizeBytes: Number(restored[0].sizeBytes)
  })
  expect(Buffer.from(await lease.readRange(0, lease.sizeBytes))).toEqual(firstBytes)
  await lease.close()
  await writeFile(resolveStorageKey(f.storageRoot, restored[0].contentStorageKey), 'corrupt')
  await expect(
    files.openImmutable(
      restored[0].contentStorageKey,
      { checksum: restored[0].checksum, sizeBytes: Number(restored[0].sizeBytes) },
      { forceVerify: true }
    )
  ).rejects.toThrow()
})

it('rolls back the whole checkpoint restore when a Review identity belongs to another Project', async () => {
  const f = await setup()
  const origin = { projectId: 'project-1', sessionId: 'session-1' }
  const originWhere = { projectId_sessionId: origin }
  await f.wrapped.fileOriginSession.create({ data: { ...origin, titleSnapshot: 'checkpoint' } })
  await f.wrapped.review.create({
    data: {
      ...origin,
      id: 'review-1',
      turnMessageId: 'turn-1',
      lifecycle: 'complete',
      outcome: 'pass'
    }
  })

  await f.client.fileOriginSession.update({
    where: originWhere,
    data: { titleSnapshot: 'local title' }
  })
  const localReview = await f.client.review.update({
    where: { id: 'review-1' },
    data: { projectId: 'project-2', model: 'local model' }
  })

  await expect(restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')).rejects.toThrow(
    'Conflicting project Artifact index identity: Review.projectId'
  )
  expect(await f.client.review.findUnique({ where: { id: localReview.id } })).toEqual(localReview)
  expect(
    (await f.client.fileOriginSession.findUniqueOrThrow({ where: originWhere })).titleSnapshot
  ).toBe('local title')
})

it('preserves an existing Artifact Version when its checkpoint and local lineage identities differ', async () => {
  const f = await setup()
  await f.stagePng('first')
  const created = await f.repository.createVersion(createArtifactVersionRequest())
  const localLineage = await f.client.artifactLineage.create({
    data: {
      id: 'local-lineage',
      projectId: 'project-1',
      sessionId: 'session-1',
      filename: 'local.png',
      normalizedFilename: 'local.png'
    }
  })
  await f.client.artifactLineage.update({
    where: { id: created.artifactId },
    data: { currentVersionId: null }
  })
  const localVersion = await f.client.artifactVersion.update({
    where: { id: created.versionId },
    data: { artifactId: localLineage.id }
  })

  await expect(restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')).rejects.toThrow(
    'Conflicting project Artifact index identity: ArtifactVersion.artifactId'
  )
  expect(await f.client.artifactVersion.findUnique({ where: { id: localVersion.id } })).toEqual(
    localVersion
  )
  expect(
    (await f.client.artifactLineage.findUniqueOrThrow({ where: { id: created.artifactId } }))
      .currentVersionId
  ).toBeNull()
})

it.each(['pending', 'staging'] as const)(
  'checks immutable Artifact bytes when the local Version state is %s',
  async (state) => {
    const f = await setup()
    await f.stagePng('first')
    const created = await f.repository.createVersion(createArtifactVersionRequest())
    const where = { id: created.versionId }
    const checkpointVersion = await f.client.artifactVersion.findUniqueOrThrow({ where })
    const localVersion = await f.client.artifactVersion.update({
      where,
      data: {
        state,
        contentStorageKey: 'artifacts/project-1/session-1/local-version.png'
      }
    })

    const restore = restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')
    if (state === 'pending') {
      await expect(restore).rejects.toThrow(
        'Conflicting project Artifact index identity: ArtifactVersion.contentStorageKey'
      )
      expect(await f.client.artifactVersion.findUnique({ where })).toEqual(localVersion)
    } else {
      await restore
      expect(await f.client.artifactVersion.findUnique({ where })).toEqual(checkpointVersion)
    }
  }
)

it.each(['ready', 'staging'] as const)(
  'checks the linked ContentBlob when the restored Upload Version state is %s',
  async (state) => {
    const f = await setup()
    const scope = { projectId: 'project-1', sessionId: 'session-1' }
    await f.client.fileOriginSession.create({ data: scope })
    const upload = await f.client.uploadFile.create({
      data: { ...scope, id: 'upload-1', filename: 'sample.txt', originalFilename: 'sample.txt' }
    })
    const content = await f.client.contentBlob.create({
      data: {
        id: 'blob-1',
        checksum: 'a'.repeat(64),
        storageKey: 'uploads/project-1/session-1/sample.txt',
        sizeBytes: 10n
      }
    })
    const version = await f.client.uploadVersion.create({
      data: {
        id: 'upload-version-1',
        uploadFileId: upload.id,
        versionNumber: 1,
        filename: upload.filename,
        originalFilename: upload.originalFilename,
        state,
        checksum: content.checksum,
        contentStorageKey: content.storageKey,
        contentBlobId: content.id,
        sizeBytes: 9n
      }
    })
    await f.wrapped.fileOriginSession.update({
      where: { projectId_sessionId: scope },
      data: { titleSnapshot: 'checkpoint' }
    })
    await f.client.uploadVersion.delete({ where: { id: version.id } })

    const restore = restoreProjectRecordIndexes(f.wrapped, f.storageRoot, scope.projectId)
    if (state === 'ready') {
      await expect(restore).rejects.toThrow(
        'Conflicting project Artifact index content binding: UploadVersion.contentBlobId'
      )
      expect(await f.client.uploadVersion.count()).toBe(0)
      expect(await f.client.contentBlob.findUnique({ where: { id: content.id } })).toEqual(content)
    } else {
      await restore
      expect(await f.client.uploadVersion.findUnique({ where: { id: version.id } })).toEqual(
        version
      )
    }
  }
)

it.each(['missing', 'unlinked'] as const)(
  'restores a published Artifact Version with %s ContentBlob metadata',
  async (binding) => {
    const f = await setup()
    await f.stagePng('first')
    const created = await f.repository.createVersion(createArtifactVersionRequest())
    const where = { id: created.versionId }
    const version = await f.client.artifactVersion.findUniqueOrThrow({ where })
    const contentBlobId = version.contentBlobId
    if (!contentBlobId) throw new Error('Expected a ContentBlob from Artifact publication')
    await f.client.contentBlob.delete({ where: { id: contentBlobId } })
    if (binding === 'unlinked')
      await f.client.artifactVersion.update({ where, data: { contentBlobId: null } })
    await f.wrapped.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
      data: { titleSnapshot: 'checkpoint' }
    })

    await restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')
    expect(await f.client.artifactVersion.findUnique({ where })).toMatchObject({
      contentBlobId: binding === 'unlinked' ? null : contentBlobId,
      checksum: version.checksum,
      sizeBytes: version.sizeBytes
    })
  }
)

it('preserves a local Review scope snapshot if pruning its Review would cross Project scope', async () => {
  const f = await setup()
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'project-1', sessionId: 'session-1' }
  })
  const review = await f.client.review.create({
    data: {
      id: 'review-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1'
    }
  })
  const snapshot = await f.client.reviewScopeSnapshot.create({
    data: {
      id: 'snapshot-1',
      projectId: 'project-2',
      sessionId: 'session-1',
      reviewId: review.id,
      scopeTurnMessageId: 'turn-1',
      storageKey: 'snapshot.json',
      snapshotJson: '{}',
      checksum: 'checksum',
      blockCount: 0
    }
  })

  await expect(restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')).rejects.toThrow(
    'Conflicting project Artifact index prune scope: Review'
  )
  expect(await f.client.review.findUnique({ where: { id: review.id } })).toEqual(review)
  expect(await f.client.reviewScopeSnapshot.findUnique({ where: { id: snapshot.id } })).toEqual(
    snapshot
  )
})

it.each([
  { label: 'a matching scope', projectId: 'project-1', sessionId: 'session-1', valid: true },
  { label: 'a different Session', projectId: 'project-1', sessionId: 'session-2', valid: false },
  { label: 'a different Project', projectId: 'project-2', sessionId: 'session-1', valid: false }
])(
  'validates a Finding disposition whose cause Review is in $label',
  async ({ projectId, sessionId, valid }) => {
    const f = await setup()
    const scope = { projectId: 'project-1', sessionId: 'session-1' }
    const source = await f.client.review.create({
      data: { ...scope, id: 'source-review', turnMessageId: 'turn-1' }
    })
    const cause = await f.client.review.create({
      data: { id: 'cause-review', projectId, sessionId, turnMessageId: 'turn-1' }
    })
    const finding = await f.client.finding.create({
      data: { id: 'finding-1', reviewId: source.id, status: 'warn' }
    })
    await f.client.reviewFindingDisposition.createMany({
      data: [
        {
          id: 'assessment',
          sourceFindingId: finding.id,
          causeReviewId: cause.id,
          sequence: 1,
          trigger: 'review_submission',
          outcome: 'still_open'
        },
        {
          id: 'aborted',
          sourceFindingId: finding.id,
          sequence: 2,
          trigger: 'aborted',
          outcome: 'unaddressed'
        }
      ]
    })
    await f.wrapped.fileOriginSession.create({ data: scope })
    await f.client.reviewFindingDisposition.deleteMany({ where: { sourceFindingId: finding.id } })

    const restore = restoreProjectRecordIndexes(f.wrapped, f.storageRoot, scope.projectId)
    if (valid) {
      await restore
      expect(
        await f.client.reviewFindingDisposition.findMany({ orderBy: { sequence: 'asc' } })
      ).toMatchObject([
        { id: 'assessment', causeReviewId: cause.id },
        { id: 'aborted', causeReviewId: null }
      ])
    } else {
      await expect(restore).rejects.toThrow(
        'Conflicting project Artifact index parent: ReviewFindingDisposition.causeReviewId'
      )
      expect(await f.client.reviewFindingDisposition.count()).toBe(0)
      expect(await f.client.review.findUnique({ where: { id: cause.id } })).toEqual(cause)
    }
  }
)

it('rejects a checkpoint containing Review metadata from another Project', async () => {
  const f = await setup()
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'project-1', sessionId: 'session-1' }
  })
  const path = join(f.folder, '.open-science', 'artifact-index.json')
  const checkpoint = JSON.parse(await readFile(path, 'utf8'))
  checkpoint.tables.Review.push({
    id: 'out-of-scope-review',
    projectId: 'project-2',
    sessionId: 'session-1'
  })
  await writeFile(path, JSON.stringify(checkpoint))

  await expect(restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')).rejects.toThrow(
    'Conflicting project Artifact index scope: Review'
  )
  expect(await f.client.review.count()).toBe(0)
})

it('retains the durable checkpoint through detached project index deletion', async () => {
  const f = await setup()
  await f.stagePng('original')
  await f.repository.createVersion(createArtifactVersionRequest())
  const path = join(f.folder, '.open-science', 'artifact-index.json')
  const original = await readFile(path, 'utf8')
  await markProjectRecordDetached(f.storageRoot, 'project-1')
  await f.wrapped.$transaction(async (tx) => {
    await tx.fileOriginSession.updateMany({ data: { titleSnapshot: 'deleted-index' } })
  })
  expect(await readFile(path, 'utf8')).toEqual(original)
  const version = await f.client.artifactVersion.findFirstOrThrow()
  const content = resolveStorageKey(f.storageRoot, version.contentStorageKey)
  const bytes = await readFile(content)
  await f.repository.deleteProjectProvenance('project-1')
  expect(await f.client.artifactVersion.count()).toBe(0)
  expect(await readFile(content)).toEqual(bytes)
  expect(await readFile(path, 'utf8')).toEqual(original)
  await registerProjectRecordStorage(f.storageRoot, f.folder, 'project-1')
  await restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')
  expect((await f.client.artifactVersion.findFirstOrThrow()).id).toBe(version.id)
})

it('preserves lazy array transactions and leaves ordinary project bytes managed', async () => {
  const f = await setup()
  const pending = f.wrapped.fileOriginSession.create({
    data: { projectId: 'legacy', sessionId: 's' }
  })
  expect(await f.client.fileOriginSession.count({ where: { projectId: 'legacy' } })).toBe(0)
  await f.wrapped.$transaction([
    pending,
    f.wrapped.fileOriginSession.count({ where: { projectId: 'legacy' } })
  ])
  expect(await f.client.fileOriginSession.count({ where: { projectId: 'legacy' } })).toBe(1)
  const files = new NodeVersionFileOperator({ storageRoot: f.storageRoot })
  const plan = files.planImmutable({
    scope: { source: 'artifact', projectId: 'legacy', sessionId: 's', logicalFileId: 'a' },
    operationId: 'op',
    logicalFilename: 'x.txt',
    candidateIndex: 0
  })
  const content = Buffer.from('original')
  const input = {
    scope: { source: 'artifact' as const, projectId: 'legacy', sessionId: 's', logicalFileId: 'a' },
    operationId: 'op',
    logicalFilename: 'x.txt',
    candidateIndex: 0,
    plannedFile: plan,
    content
  }
  await files.publishImmutable(input)
  expect(await readFile(join(f.storageRoot, plan.storageRef), 'utf8')).toBe('original')
  await expect(
    files.publishImmutable({ ...input, content: Buffer.from('changed') })
  ).rejects.toThrow()
})

it('fails a write without committing a DB-only record when its checkpoint cannot publish', async () => {
  const f = await setup()
  await mkdir(join(f.folder, '.open-science', 'artifact-index.json'))
  await expect(
    f.wrapped.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'unacknowledged' }
    })
  ).rejects.toThrow()
  expect(await f.client.fileOriginSession.count({ where: { projectId: 'project-1' } })).toBe(0)
})

it('rebuilds a lost live index before the first startup read or unrelated write can checkpoint it', async () => {
  const f = await setup()
  await f.stagePng('startup')
  await f.repository.createVersion(createArtifactVersionRequest())
  const saved = await readFile(join(f.folder, '.open-science', 'artifact-index.json'), 'utf8')
  await f.client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  for (const table of [
    'ArtifactVersionInput',
    'ArtifactLiteratureManifest',
    'ArtifactVersion',
    'ArtifactLineage',
    'ArtifactMessageSnapshot',
    'FileOriginSession',
    'ContentBlob'
  ])
    await f.client.$executeRawUnsafe(`DELETE FROM "${table}"`)
  await f.client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  const startup = withProjectRecordIndexes(f.client, f.storageRoot)
  expect(await startup.artifactVersion.count()).toBe(1)
  await startup.fileOriginSession.create({
    data: { projectId: 'legacy-unrelated', sessionId: 's' }
  })
  expect(await readFile(join(f.folder, '.open-science', 'artifact-index.json'), 'utf8')).toEqual(
    saved
  )
})

it('reconciles the published checkpoint after a database commit fails', async () => {
  const f = await setup()
  await f.stagePng('commit')
  await f.repository.createVersion(createArtifactVersionRequest())
  let rejectCommit = false
  const failing = new Proxy(f.client, {
    get(target, key) {
      if (key === '$transaction')
        return (body: (tx: typeof f.client) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const value = await body(tx as typeof f.client)
            if (rejectCommit) {
              rejectCommit = false
              throw new Error('simulated commit failure')
            }
            return value
          })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const live = withProjectRecordIndexes(failing, f.storageRoot)
  await live.artifactVersion.count()
  rejectCommit = true
  await expect(
    live.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
      data: { titleSnapshot: 'durable before failed commit' }
    })
  ).rejects.toThrow('simulated commit failure')
  expect((await f.client.fileOriginSession.findFirstOrThrow()).titleSnapshot).toBeNull()
  expect(
    (
      await live.fileOriginSession.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } }
      })
    ).titleSnapshot
  ).toBe('durable before failed commit')
})

it('recovers staged bytes when the Artifact checkpoint publishes before SQLite aborts', async () => {
  const f = await setup()
  await f.stagePng('recoverable bytes')
  const request = createArtifactVersionRequest()
  let interrupt = true
  const failing = new Proxy(f.client, {
    get(target, key) {
      if (key === '$transaction')
        return (body: (tx: typeof f.client) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const result = await body(tx as typeof f.client)
            if (
              interrupt &&
              (await tx.artifactVersion.findUnique({
                where: { writeOperationId: request.writeOperationId }
              }))
            ) {
              interrupt = false
              throw new Error('simulated Artifact staging commit failure')
            }
            return result
          })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const live = withProjectRecordIndexes(failing, f.storageRoot)
  const repository = new ArtifactProvenanceRepository({
    ...f.repositoryOptions,
    getClient: async () => live
  })
  await expect(repository.createVersion(request)).rejects.toThrow(
    'simulated Artifact staging commit failure'
  )
  const recovered = await f.client.artifactVersion.findUniqueOrThrow({
    where: { writeOperationId: request.writeOperationId }
  })
  expect(recovered.state).toBe('staging')
  const version = await repository.createVersion(request)
  expect(version.versionId).toBe(recovered.id)
  expect(await readFile(resolveStorageKey(f.storageRoot, recovered.contentStorageKey))).toEqual(
    await readFile(version.path)
  )
})

it('keeps foreign key enforcement active for writes after a cold replay', async () => {
  const f = await setup()
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'project-1', sessionId: 'saved' }
  })
  const path = join(f.folder, '.open-science', 'artifact-index.json')
  const before = await readFile(path, 'utf8')
  const startup = withProjectRecordIndexes(f.client, f.storageRoot)
  await expect(
    startup.artifactLineage.create({
      data: {
        id: 'invalid-artifact',
        projectId: 'project-1',
        sessionId: 'missing-origin',
        filename: 'x.txt',
        normalizedFilename: 'x.txt'
      }
    })
  ).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(await startup.fileOriginSession.count({ where: { projectId: 'project-1' } })).toBe(1)
})

it('reconciles Project Files raw reads using their explicit catalog scope', async () => {
  const f = await setup()
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'project-1', sessionId: 'saved' }
  })
  await f.client.fileOriginSession.deleteMany()
  const startup = withProjectRecordIndexes(f.client, f.storageRoot)
  await getAuthoritativeOverviewCounts(startup, 'managed', undefined)
  expect(await f.client.fileOriginSession.count()).toBe(0)
  await getAuthoritativeOverviewCounts(startup, 'project-1', undefined)
  expect(await f.client.fileOriginSession.count()).toBe(1)
})

it('keeps live foreign lineage heads and source edges when restoring or detaching referenced projects', async () => {
  const f = await setup()
  const folderB = join(f.storageRoot, 'project-b')
  await mkdir(folderB)
  await initializeProjectRecordStorage(f.storageRoot, folderB, {
    format: 'open-science-project',
    version: 1,
    projectId: 'project-b',
    name: 'B',
    createdAt: 1
  })
  const publishB = async (
    payload: string,
    operation: string
  ): ReturnType<ArtifactProvenanceRepository['createVersion']> => {
    await f.compatibilityRepository.writePendingFile({
      projectId: 'project-b',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'source.txt',
      source: { kind: 'inline', content: payload, encoding: 'utf8' }
    })
    return f.repository.createVersion(
      createArtifactVersionRequest({
        projectId: 'project-b',
        filename: 'source.txt',
        contentType: 'text/plain',
        writeOperationId: operation
      })
    )
  }
  const bv1 = await publishB('first', 'b-one')
  await f.wrapped.artifactLineage.update({
    where: { id: bv1.artifactId },
    data: { currentVersionId: bv1.versionId }
  })
  await f.stagePng('uses b')
  const av1 = await f.repository.createVersion(createArtifactVersionRequest())
  const source = await f.client.artifactVersion.findUniqueOrThrow({ where: { id: bv1.versionId } })
  await f.wrapped.artifactVersionInput.create({
    data: {
      id: 'cross-project-input',
      artifactVersionId: av1.versionId!,
      ordinal: 0,
      inputFileVersionId: bv1.versionId!,
      sourceKind: 'artifact-version',
      sourceFileId: bv1.artifactId!,
      sourceArtifactVersionId: bv1.versionId!,
      sourceProjectId: 'project-b',
      sourceSessionId: 'session-1',
      filename: 'source.txt',
      sizeBytes: source.sizeBytes,
      checksum: source.checksum,
      storageKey: source.contentStorageKey,
      strongestAssociation: 'captured-version'
    }
  })
  const checkpointA = await readFile(join(f.folder, '.open-science', 'artifact-index.json'), 'utf8')
  await markProjectRecordDetached(f.storageRoot, 'project-1')
  await f.repository.deleteProjectProvenance('project-1')
  const bv2 = await publishB('second', 'b-two')
  await f.wrapped.artifactLineage.update({
    where: { id: bv2.artifactId },
    data: { currentVersionId: bv2.versionId }
  })
  expect(await readFile(join(f.folder, '.open-science', 'artifact-index.json'), 'utf8')).toBe(
    checkpointA
  )
  await registerProjectRecordStorage(f.storageRoot, f.folder, 'project-1')
  await restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')
  expect(
    (await f.client.artifactLineage.findUniqueOrThrow({ where: { id: bv1.artifactId } }))
      .currentVersionId
  ).toBe(bv2.versionId)
  expect(await f.client.artifactVersionInput.count({ where: { id: 'cross-project-input' } })).toBe(
    1
  )
  await markProjectRecordDetached(f.storageRoot, 'project-b')
  await f.repository.deleteProjectProvenance('project-b')
  expect(await f.client.artifactVersionInput.count({ where: { id: 'cross-project-input' } })).toBe(
    1
  )
  expect(await readFile(join(f.folder, '.open-science', 'artifact-index.json'), 'utf8')).toBe(
    checkpointA
  )
})

it('keeps turn staging managed and publishes across volumes into the project records', async () => {
  const f = await setup()
  await f.stagePng('cross-volume')
  const pending = await f.compatibilityRepository.listPendingRunFiles({
    projectId: 'project-1',
    sessionId: 'artifact-session-1',
    runId: 'artifact-run-1'
  })
  expect(pending[0].path).not.toContain('.open-science')
  expect(
    getArtifactCurrentRunFilePath(f.storageRoot, 'project-1', 'artifact-session-1')
  ).not.toContain('.open-science')
  const version = await f.repository.createVersion(createArtifactVersionRequest())
  const nativeRename = (
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  ).rename
  const spy = vi.mocked(fs.rename).mockImplementation(async (source, target) => {
    if (String(source).includes('/.pending/') && String(target).includes('/.open-science/'))
      throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' })
    return nativeRename(source, target)
  })
  try {
    const finalized = await f.compatibilityRepository.finalizeRunArtifacts({
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceSessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      messageId: 'message-1',
      artifactVersionIds: [version.versionId!]
    })
    expect(finalized).toHaveLength(1)
    expect(finalized[0].path).toContain('.open-science')
    expect(finalized[0].versionId).toBe(version.versionId)
    expect(await f.compatibilityRepository.resolveManagedFilePath({ path: pending[0].path })).toBe(
      finalized[0].path
    )
  } finally {
    spy.mockRestore()
  }
})

it('isolates corrupt or disconnected checkpoints from unrelated projects and home reads', async () => {
  const f = await setup()
  await f.stagePng('healthy project')
  await f.repository.createVersion(createArtifactVersionRequest())
  const folder = join(f.storageRoot, 'broken-project')
  await mkdir(folder)
  await initializeProjectRecordStorage(f.storageRoot, folder, {
    format: 'open-science-project',
    version: 1,
    projectId: 'broken',
    name: 'Broken',
    createdAt: 1
  })
  const brokenIndex = join(await fs.realpath(folder), '.open-science', 'artifact-index.json')
  const healthyIndex = join(await fs.realpath(f.folder), '.open-science', 'artifact-index.json')
  await fs.writeFile(brokenIndex, '{invalid JSON')
  const live = withProjectRecordIndexes(f.client, f.storageRoot)
  const checkpointReads = (): string[] =>
    vi
      .mocked(readFile)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => fsPath.basename(path) === 'artifact-index.json')
  vi.mocked(readFile).mockClear()
  expect(await live.project.findMany()).toEqual([])
  expect(await live.$queryRawUnsafe('SELECT 1 AS settings')).toHaveLength(1)
  await live.$transaction(async (tx) => {
    await tx.sessionHistoryIndex.create({
      data: {
        projectId: 'legacy-other',
        sessionId: 'ordinary-conversation',
        revision: 1n,
        sourceFingerprint: 'source',
        scopeKey: 'scope',
        headerJson: '{}',
        totalItems: 0
      }
    })
    expect(await tx.$queryRaw`SELECT 1`).toHaveLength(1)
  })
  expect(
    await live.sessionHistoryIndex.findUnique({ where: { sessionId: 'ordinary-conversation' } })
  ).toMatchObject({ projectId: 'legacy-other' })
  expect(await live.artifactLineage.findUnique({ where: { id: 'missing-legacy-file' } })).toBeNull()
  expect(
    await live.artifactVersion.count({ where: { artifact: { projectId: 'legacy-other' } } })
  ).toBe(0)
  await live.fileOriginSession.create({ data: { projectId: 'legacy-other', sessionId: 's' } })
  expect(checkpointReads()).toEqual([])

  await live.$transaction([
    live.artifactVersion.count({ where: { artifact: { projectId: 'project-1' } } }),
    live.fileOriginSession.count({ where: { projectId: 'project-1' } })
  ])
  expect(checkpointReads()).toEqual([healthyIndex])
  vi.mocked(readFile).mockClear()
  await expect(live.artifactLineage.findMany({ where: { projectId: 'broken' } })).rejects.toThrow(
    'Project Artifact records are unavailable'
  )
  await expect(
    live.fileOriginSession.create({
      data: { projectId: 'broken', sessionId: 'should-not-publish' }
    })
  ).rejects.toThrow('Project Artifact records are unavailable')
  expect(checkpointReads()).toEqual([brokenIndex, brokenIndex])
  expect(await readFile(brokenIndex, 'utf8')).toBe('{invalid JSON')
  await fs.rm(folder, { recursive: true })
  expect(await live.project.findMany()).toEqual([])
  await expect(live.artifactLineage.findMany({ where: { projectId: 'broken' } })).rejects.toThrow(
    'Project Artifact records are unavailable'
  )
})

it('rejects multi-project checkpoint transactions before either durable authority changes', async () => {
  const f = await setup()
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'project-1', sessionId: 's', titleSnapshot: 'A' }
  })
  const folder = join(f.storageRoot, 'second')
  await mkdir(folder)
  await initializeProjectRecordStorage(f.storageRoot, folder, {
    format: 'open-science-project',
    version: 1,
    projectId: 'second',
    name: 'Second',
    createdAt: 1
  })
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'second', sessionId: 's', titleSnapshot: 'B' }
  })
  const paths = [
    join(f.folder, '.open-science', 'artifact-index.json'),
    join(folder, '.open-science', 'artifact-index.json')
  ]
  const original = await Promise.all(paths.map((path) => readFile(path, 'utf8')))
  await expect(
    f.wrapped.$transaction(async (tx) => {
      await tx.fileOriginSession.update({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 's' } },
        data: { titleSnapshot: 'changed A' }
      })
      await tx.fileOriginSession.update({
        where: { projectId_sessionId: { projectId: 'second', sessionId: 's' } },
        data: { titleSnapshot: 'changed B' }
      })
    })
  ).rejects.toThrow('one Project')
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(original)
  expect(
    (await f.client.fileOriginSession.findMany({ orderBy: { projectId: 'asc' } })).map(
      (row) => row.titleSnapshot
    )
  ).toEqual(['A', 'B'])
})

it.each(['artifacts', 'artifacts/project-1/session-1/.provenance'])(
  'rejects Artifact publication through a symlink at %s',
  async (suffix) => {
    const f = await setup()
    const outside = join(f.storageRoot, 'outside-records')
    await mkdir(outside)
    const path = join(f.folder, '.open-science', suffix)
    await mkdir(fsPath.dirname(path), { recursive: true })
    await fs.symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
    await f.stagePng('must stay private')
    await expect(f.repository.createVersion(createArtifactVersionRequest())).rejects.toThrow(
      'links or special files'
    )
    expect(await fs.readdir(outside)).toEqual([])
  }
)

it('rejects a linked compatibility message directory and linked checkpoint metadata', async () => {
  const f = await setup()
  await f.stagePng('durable')
  await f.repository.createVersion(createArtifactVersionRequest())
  const outside = join(f.storageRoot, 'outside-messages')
  await mkdir(outside)
  const message = join(f.folder, '.open-science', 'artifacts/project-1/session-1/message-linked')
  await fs.symlink(outside, message, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(
    f.compatibilityRepository.finalizeRunArtifacts({
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceSessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      messageId: 'message-linked'
    })
  ).rejects.toThrow('links or special files')
  expect(await fs.readdir(outside)).toEqual([])
  const metadataMessage = join(
    f.folder,
    '.open-science',
    'artifacts/project-1/session-1/metadata-linked'
  )
  await mkdir(metadataMessage)
  await fs.symlink(
    outside,
    join(metadataMessage, '.metadata'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(
    f.compatibilityRepository.finalizeRunArtifacts({
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceSessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      messageId: 'metadata-linked'
    })
  ).rejects.toThrow('links or special files')
  await expect(
    f.compatibilityRepository.listMessageFiles({
      projectId: 'project-1',
      sessionId: 'session-1',
      messageId: 'metadata-linked'
    })
  ).rejects.toThrow('links or special files')
  expect(await fs.readdir(outside)).toEqual([])
  const index = join(f.folder, '.open-science', 'artifact-index.json')
  const outsideIndex = join(outside, 'external-index.json')
  await fs.rename(index, outsideIndex)
  // An unprivileged Windows host can create a junction at the checkpoint path.
  if (process.platform === 'win32') await fs.symlink(outside, index, 'junction')
  else await fs.symlink(outsideIndex, index, 'file')
  await expect(restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')).rejects.toThrow(
    'links or special files'
  )
  const live = withProjectRecordIndexes(f.client, f.storageRoot)
  expect(await live.project.findMany()).toEqual([])
  await expect(
    live.artifactLineage.findMany({ where: { projectId: 'project-1' } })
  ).rejects.toThrow('Project Artifact records are unavailable')
})

it('retries the same scoped reviewer read after a missing project folder is located', async () => {
  const f = await setup()
  await f.stagePng('before relocation')
  await f.repository.createVersion(createArtifactVersionRequest())
  await f.wrapped.review.create({
    data: {
      id: 'review-before-move',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'turn-1',
      lifecycle: 'complete',
      outcome: 'pass'
    }
  })
  const query = (): ReturnType<typeof f.wrapped.review.findMany> =>
    f.wrapped.review.findMany({ where: { projectId: 'project-1', sessionId: 'session-1' } })
  expect(await query()).toHaveLength(1)
  const moved = join(f.storageRoot, 'located-project')
  await fs.rename(f.folder, moved)
  await expect(query()).rejects.toMatchObject({ code: 'project-folder-not-found' })
  await registerProjectRecordStorage(f.storageRoot, moved, 'project-1')
  expect((await query()).map((review) => review.id)).toEqual(['review-before-move'])
  await f.wrapped.review.update({
    where: { id: 'review-before-move' },
    data: { model: 'after-locate' }
  })
  expect((await query())[0].model).toBe('after-locate')
})

it('validates the checkpoint in a located folder before changing its binding', async () => {
  const f = await setup()
  const originalFolder = await fs.realpath(f.folder)
  await f.client.project.create({
    data: { id: 'project-1', name: 'Research', rootPath: originalFolder }
  })
  await f.wrapped.fileOriginSession.create({
    data: { projectId: 'project-1', sessionId: 'saved', titleSnapshot: 'durable title' }
  })
  const moved = join(await fs.realpath(f.storageRoot), 'new-project-folder')
  await rename(f.folder, moved)
  const checkpoint = join(moved, '.open-science', 'artifact-index.json')
  const original = await readFile(checkpoint, 'utf8')
  const projects = new ProjectRepository(
    async () => f.wrapped,
    undefined,
    {
      dataRoot: join(f.storageRoot, 'managed-data'),
      configRoot: join(f.storageRoot, 'config'),
      homePath: join(f.storageRoot, 'home'),
      preflight: async () => undefined
    },
    {
      storageRoot: () => f.storageRoot,
      assertLocation: async () => undefined,
      reconcileIndexes: (client, id) => reconcileProjectRecordIndexes(client, [id]),
      restoreIndexes: (tx, id, folder) =>
        restoreLocatedProjectRecordIndexes(tx, f.storageRoot, id, folder!)
    }
  )
  const locate = (): ReturnType<ProjectRepository['locateFolder']> =>
    projects.locateFolder(
      { projectId: 'project-1', expectedRootPath: originalFolder, path: moved },
      (commit) => commit()
    )
  await writeFile(checkpoint, '{invalid JSON')
  await expect(locate()).rejects.toMatchObject({ code: 'project-folder-unavailable' })
  expect(await projects.get('project-1')).toMatchObject({ rootPath: originalFolder })

  await writeFile(checkpoint, original)
  await f.client.fileOriginSession.deleteMany({ where: { projectId: 'project-1' } })
  expect(await locate()).toMatchObject({ rootPath: moved })
  expect(await projects.checkFolder({ projectId: 'project-1' })).toMatchObject({ ok: true })
  expect(
    await f.wrapped.fileOriginSession.findUnique({
      where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'saved' } }
    })
  ).toMatchObject({ titleSnapshot: 'durable title' })
})

it.each([1, 2] as const)(
  'keeps delivery state out of v1 checkpoints until explicit layout enablement (v%s)',
  async (version) => {
    const f = await setup(version)
    await f.stagePng('version')
    const created = await f.repository.createVersion(createArtifactVersionRequest())
    const delivery = JSON.stringify({ format: 1, state: 'pending', versionId: created.versionId })
    await f.wrapped.artifactLineage.update({
      where: { id: created.artifactId },
      data: { outputDeliveryJson: delivery }
    })
    const index = JSON.parse(
      await readFile(join(f.folder, '.open-science', 'artifact-index.json'), 'utf8')
    )
    const row = index.tables.ArtifactLineage.find(
      (row: { id: string }) => row.id === created.artifactId
    )
    if (version === 1) expect(row).not.toHaveProperty('outputDeliveryJson')
    else expect(row.outputDeliveryJson).toBe(delivery)
    await f.client.artifactLineage.update({
      where: { id: created.artifactId },
      data: { filename: 'PLOT.png', outputDeliveryJson: null }
    })
    await restoreProjectRecordIndexes(f.wrapped, f.storageRoot, 'project-1')
    expect(
      await f.client.artifactLineage.findUniqueOrThrow({ where: { id: created.artifactId } })
    ).toMatchObject({ filename: 'plot.png', outputDeliveryJson: version === 1 ? null : delivery })
  }
)
