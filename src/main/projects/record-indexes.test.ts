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
import { restoreProjectRecordIndexes, withProjectRecordIndexes } from './record-indexes'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { NodeVersionFileOperator } from '../managed-file-versions/version-file-operator'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
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
  expect((await live.fileOriginSession.findFirstOrThrow()).titleSnapshot).toBe(
    'durable before failed commit'
  )
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
  await fs.writeFile(join(folder, '.open-science', 'artifact-index.json'), '{invalid JSON')
  const live = withProjectRecordIndexes(f.client, f.storageRoot)
  expect(await live.project.findMany()).toEqual([])
  expect(await live.$queryRawUnsafe('SELECT 1 AS settings')).toHaveLength(1)
  expect(
    await live.artifactVersion.count({ where: { artifact: { projectId: 'project-1' } } })
  ).toBe(1)
  await live.fileOriginSession.create({ data: { projectId: 'legacy-other', sessionId: 's' } })
  await expect(live.artifactLineage.findMany({ where: { projectId: 'broken' } })).rejects.toThrow(
    'Project Artifact records are unavailable'
  )
  expect(await readFile(join(folder, '.open-science', 'artifact-index.json'), 'utf8')).toBe(
    '{invalid JSON'
  )
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
    expect(
      (await f.client.artifactLineage.findUniqueOrThrow({ where: { id: created.artifactId } }))
        .outputDeliveryJson
    ).toBe(delivery)
  }
)
