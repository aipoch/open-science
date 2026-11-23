import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type {
  ArtifactVersionFile,
  FinalizeArtifactVersionsRequest
} from '../../shared/artifact-provenance'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ProjectFolderStagedFiles } from '../project-folders/staged-files'
import {
  initializeProjectRecordStorage,
  registerProjectRecordStorage
} from '../projects/record-storage'
import { withProjectRecordIndexes } from '../projects/record-indexes'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { createProvenanceTestFixture } from './provenance-test-fixtures'
import { ArtifactOutputDelivery } from './output-delivery'

let fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
let folder: string
let externalRoot: string
let service: ManagedFileVersionService
let repository: ArtifactProvenanceRepository
let delivery: ArtifactOutputDelivery
let files: ProjectFolderStagedFiles
const approve = vi.fn(async () => true)
const messages = Array.from({ length: 12 }, (_, i) => ({
  id: `${i % 2 ? 'message' : 'prompt'}-${Math.floor(i / 2) + 1}`,
  role: i % 2 ? ('agent' as const) : ('user' as const),
  content: 'Publish result',
  status: 'complete' as const,
  eventIds: [],
  createdAt: i + 1,
  updatedAt: i + 1
}))
const graphs = new Map(
  ['session-1', 'session-2'].map((sessionId) => [
    sessionId,
    createLinearConversationGraph({
      sessionId,
      messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 12
    })
  ])
)

beforeEach(async () => {
  fixture = await createProvenanceTestFixture()
  externalRoot = await mkdtemp(join(tmpdir(), 'os-output-'))
  folder = join(externalRoot, 'project-folder')
  await mkdir(folder)
  await fixture.client.project.create({ data: { id: 'project-1', name: 'Outputs' } })
  service = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  approve.mockReset().mockResolvedValue(true)
  files = new ProjectFolderStagedFiles({
    storageRoot: fixture.storageRoot,
    approve,
    authorizeCreatedFile: async () => true
  })
  delivery = new ArtifactOutputDelivery({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client,
    files,
    openVersion: (request, versionId) => service.openVersion(request, versionId),
    getLayout: async (projectId, sessionId) => ({
      projectRoot: folder,
      artifactDirectoryRelativePath: `artifacts/${projectId}/${sessionId}`
    })
  })
  service.setArtifactOutputDelivery(delivery)
  repository = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    managedFileVersions: service,
    onHeadActivated: (versions) => delivery.deliverActivated(versions),
    loadSession: async (projectId, sessionId) => ({
      id: sessionId,
      projectId,
      title: 'Outputs',
      cwd: folder,
      status: 'idle',
      messages,
      conversationGraph: graphs.get(sessionId)!,
      createdAt: 1,
      updatedAt: 12
    })
  })
})
afterEach(async () => {
  await fixture?.dispose()
  await rm(externalRoot, { recursive: true, force: true })
})

const prepare = async (
  run: number,
  content: string | Uint8Array = 'first',
  filename = 'Report.txt',
  sessionId = 'session-1',
  sourcePath?: string
): Promise<{
  version: ArtifactVersionFile
  proof: FinalizeArtifactVersionsRequest
}> => {
  const graph = graphs.get(sessionId)!
  const common = {
    projectId: 'project-1',
    appSessionId: sessionId,
    artifactStorageSessionId: `storage-${sessionId}`,
    artifactRunId: `run-${run}-${sessionId}`,
    writeOperationId: `write-${run}-${sessionId}-${filename}`,
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: `prompt-${run}`,
    filename,
    contentType: filename.endsWith('.txt') ? 'text/plain' : 'application/octet-stream'
  }
  const version = await repository.saveVersion(
    {
      ...common,
      source: sourcePath
        ? { kind: 'localPath', path: sourcePath }
        : { kind: 'inline', content: Buffer.from(content).toString('base64'), encoding: 'base64' }
    },
    { allowedImportRoots: [folder] }
  )
  return {
    version,
    proof: { ...common, artifactVersionIds: [version.versionId], messageId: `message-${run}` }
  }
}
const publish = async (item: Awaited<ReturnType<typeof prepare>>): Promise<void> => {
  await repository.finalizeRun(item.proof)
  await repository.activateFinalizedRun(item.proof)
}
const identity = (
  item: Awaited<ReturnType<typeof prepare>>
): { source: 'artifact'; projectId: string; fileId: string } => ({
  source: 'artifact',
  projectId: 'project-1',
  fileId: item.version.artifactId
})
const target = (filename = 'Report.txt', sessionId = 'session-1'): string =>
  join(folder, 'artifacts/project-1', sessionId, filename)

it('publishes inline text/binary and allowed source files only after head activation into an empty target', async () => {
  const first = await prepare(1)
  await expect(readFile(target())).rejects.toMatchObject({ code: 'ENOENT' })
  await repository.finalizeRun(first.proof)
  await expect(readFile(target())).rejects.toMatchObject({ code: 'ENOENT' })
  await repository.activateFinalizedRun(first.proof)
  expect((await service.inspect(identity(first))).outputDelivery).toMatchObject({
    state: 'delivered'
  })
  expect(await readFile(target(), 'utf8')).toBe('first')
  expect((await service.inspect(identity(first))).outputDelivery).toMatchObject({
    state: 'delivered',
    versionId: first.version.versionId
  })
  const binary = await prepare(2, new Uint8Array([0, 255, 14, 0]), 'data.bin')
  await publish(binary)
  expect(await readFile(target('data.bin'))).toEqual(Buffer.from([0, 255, 14, 0]))
  const source = join(folder, 'source.txt')
  await writeFile(source, 'external allowed bytes')
  const external = await prepare(3, '', 'external.txt', 'session-1', source)
  await publish(external)
  expect(await readFile(target('external.txt'), 'utf8')).toBe('external allowed bytes')
  expect(await readFile(source, 'utf8')).toBe('external allowed bytes')
})

it('isolates Sessions, retains the first filename spelling, and refuses late old-head retries', async () => {
  const first = await prepare(1)
  await publish(first)
  const other = await prepare(1, 'other session', 'Report.txt', 'session-2')
  await publish(other)
  const second = await prepare(2, 'newest', 'REPORT.TXT')
  expect(second.version.artifactId).toBe(first.version.artifactId)
  await publish(second)
  expect(await readdir(join(folder, 'artifacts/project-1/session-1'))).toEqual(['Report.txt'])
  expect(await readFile(target(), 'utf8')).toBe('newest')
  expect(await readFile(target('Report.txt', 'session-2'), 'utf8')).toBe('other session')
  await expect(
    service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  await repository.activateFinalizedRun(first.proof)
  expect(await readFile(target(), 'utf8')).toBe('newest')
})

it('delivers only the current version when one run contains multiple same-name versions', async () => {
  const first = await prepare(1)
  const graph = graphs.get('session-1')!
  const second = await repository.saveVersion(
    {
      ...first.proof,
      artifactStorageSessionId: 'storage-session-1',
      writeOperationId: 'second-in-run',
      filename: 'report.txt',
      source: {
        kind: 'inline',
        content: Buffer.from('second version').toString('base64'),
        encoding: 'base64'
      },
      rootFrameId: graph.rootFrameId
    },
    { allowedImportRoots: [] }
  )
  const proof = { ...first.proof, artifactVersionIds: [first.version.versionId, second.versionId] }
  await repository.finalizeRun(proof)
  await repository.activateFinalizedRun(proof)
  expect(await readFile(target('report.txt'), 'utf8')).toBe('second version')
  expect(await readdir(join(folder, 'artifacts/project-1/session-1'))).toHaveLength(1)
})

it('delivers text, binary, derived edits and historical restore through exact managed-version readers', async () => {
  const first = await prepare(1)
  await publish(first)
  const id = identity(first)
  const edit = await service.saveTextEdit({
    ...id,
    basedOnVersionId: first.version.versionId,
    expectedHeadVersionId: first.version.versionId,
    operationId: 'text-edit',
    content: 'edited'
  })
  if (edit.kind !== 'created') throw new Error('Expected edit')
  expect(edit.outputDelivery?.state).toBe('delivered')
  expect(await readFile(target(), 'utf8')).toBe('edited')
  await service.inspect({ ...id, versionId: first.version.versionId })
  expect(await readFile(target(), 'utf8')).toBe('edited')
  const binary = await service.saveBinaryEdit({
    ...id,
    basedOnVersionId: edit.version.id,
    expectedHeadVersionId: edit.version.id,
    operationId: 'binary-edit',
    content: Buffer.from('binary edit'),
    actor: 'user',
    summary: 'Edit',
    opCount: 1
  })
  if (binary.kind !== 'created') throw new Error('Expected binary edit')
  expect(await readFile(target(), 'utf8')).toBe('binary edit')
  const derived = await service.saveDerivedArtifactEdit({
    ...id,
    basedOnVersionId: binary.version.id,
    expectedHeadVersionId: binary.version.id,
    operationId: 'derived-edit',
    content: Buffer.from('derived'),
    literature: {
      schemaVersion: 1,
      styleId: 'vancouver',
      locale: 'en-US',
      references: [
        {
          itemId: 'item-1',
          metadataRevision: 1,
          item: {
            itemType: 'journalArticle',
            title: 'Source',
            abstract: '',
            issuedText: '2024',
            issuedYear: 2024,
            containerTitle: 'Journal',
            shortTitle: '',
            language: 'en',
            rights: '',
            url: '',
            extra: '',
            typeFields: {},
            creators: [],
            identifiers: []
          }
        }
      ],
      citations: [{ citationId: 'citation-1', itemId: 'item-1', metadataRevision: 1 }]
    }
  })
  if (derived.kind !== 'created') throw new Error('Expected derived edit')
  expect(await readFile(target(), 'utf8')).toBe('derived')
  const restored = await service.saveTextEdit({
    ...id,
    basedOnVersionId: first.version.versionId,
    expectedHeadVersionId: derived.version.id,
    operationId: 'restore-edit',
    content: 'first',
    restore: true
  })
  expect(restored.kind).toBe('created')
  expect(await readFile(target(), 'utf8')).toBe('first')
})

it('detects an outside in-place edit before preparation, preserves rejection, and reuses backup/undo on approved retry', async () => {
  const first = await prepare(1)
  await publish(first)
  await writeFile(target(), 'user in-place update')
  approve.mockResolvedValue(false)
  const edit = await service.saveTextEdit({
    ...identity(first),
    basedOnVersionId: first.version.versionId,
    expectedHeadVersionId: first.version.versionId,
    operationId: 'conflicted-edit',
    content: 'app edit'
  })
  if (edit.kind !== 'created') throw new Error('Expected saved immutable edit')
  expect(edit.outputDelivery).toMatchObject({ state: 'conflict', errorCode: 'APPROVAL_REJECTED' })
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({ requiresConfirmation: true }),
    undefined,
    undefined
  )
  expect(await readFile(target(), 'utf8')).toBe('user in-place update')
  approve.mockResolvedValue(true)
  const count = await fixture.client.artifactVersion.count()
  expect(
    await service.retryOutputDelivery({ ...identity(first), versionId: edit.version.id })
  ).toMatchObject({ state: 'delivered' })
  expect(await fixture.client.artifactVersion.count()).toBe(count)
  const changes = await files.list({ projectId: 'project-1', sessionId: 'session-1' })
  const applied = changes.changes.find(
    (change) => change.state === 'applied' && change.operation === 'replace'
  )!
  await files.revert(applied, applied.id, folder)
  expect(await readFile(target(), 'utf8')).toBe('user in-place update')
  expect((await service.inspect(identity(first))).outputDelivery?.state).toBe('conflict')
})

it('keeps deletion absent on inspection/no-op save and recreates only on explicit same-version retry', async () => {
  const first = await prepare(1)
  await publish(first)
  await rm(target())
  expect((await service.inspect(identity(first))).outputDelivery?.state).toBe('pending')
  const noop = await service.saveTextEdit({
    ...identity(first),
    basedOnVersionId: first.version.versionId,
    expectedHeadVersionId: first.version.versionId,
    operationId: 'noop',
    content: 'first'
  })
  expect(noop.kind).toBe('noop')
  await expect(readFile(target())).rejects.toMatchObject({ code: 'ENOENT' })
  const count = await fixture.client.artifactVersion.count()
  await service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  expect(await readFile(target(), 'utf8')).toBe('first')
  expect(await fixture.client.artifactVersion.count()).toBe(count)
})

it('rechecks the head and deletion tombstone after approval without overwriting the external file', async () => {
  const first = await prepare(1)
  await publish(first)
  await writeFile(target(), 'user file')
  approve.mockImplementationOnce(async () => {
    await fixture.client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
      data: { state: 'deleted', deletedAt: new Date(), deletionOperationId: null }
    })
    return true
  })
  expect(
    await service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).toMatchObject({ state: 'cancelled', canRetry: false })
  expect(await readFile(target(), 'utf8')).toBe('user file')
  await expect(
    service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).rejects.toMatchObject({ code: 'FILE_DELETED' })
})

it('recovers an unjournaled activated head as a read-only pending status after a crash', async () => {
  const first = await prepare(1)
  await repository.finalizeRun(first.proof)
  const withoutDelivery = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: async () => ({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Outputs',
      cwd: folder,
      status: 'idle',
      messages,
      conversationGraph: graphs.get('session-1')!,
      createdAt: 1,
      updatedAt: 12
    })
  })
  await withoutDelivery.activateFinalizedRun(first.proof)
  expect((await service.inspect(identity(first))).outputDelivery).toMatchObject({
    state: 'pending',
    canRetry: true
  })
  await expect(readFile(target())).rejects.toMatchObject({ code: 'ENOENT' })
  expect(
    (
      await fixture.client.artifactLineage.findUniqueOrThrow({
        where: { id: first.version.artifactId }
      })
    ).outputDeliveryJson
  ).toBeNull()
})

it('retains the portable association and baseline through index loss and a folder copy without managed receipts', async () => {
  await initializeProjectRecordStorage(fixture.storageRoot, folder, {
    format: 'open-science-project',
    version: 2,
    outputLayout: 'session-v1',
    projectId: 'project-1',
    name: 'Outputs',
    createdAt: 1
  })
  const wrapped = withProjectRecordIndexes(fixture.client, fixture.storageRoot)
  let portable = new ArtifactOutputDelivery({
    storageRoot: fixture.storageRoot,
    getClient: async () => wrapped,
    files,
    openVersion: (request, versionId) => service.openVersion(request, versionId),
    getLayout: async () => ({
      projectRoot: folder,
      artifactDirectoryRelativePath: 'artifacts/project-1/session-1'
    })
  })
  service.setArtifactOutputDelivery(portable)
  const first = await prepare(1)
  await publish(first)
  await portable.deliver({ ...identity(first), versionId: first.version.versionId })
  const before = (
    await fixture.client.artifactLineage.findUniqueOrThrow({
      where: { id: first.version.artifactId }
    })
  ).outputDeliveryJson
  expect(
    JSON.parse(await readFile(join(folder, '.open-science/artifact-index.json'), 'utf8')).tables
      .ArtifactLineage[0].outputDeliveryJson
  ).toBe(before)
  const copied = join(externalRoot, 'copied-project')
  await cp(folder, copied, { recursive: true })
  folder = copied
  await registerProjectRecordStorage(fixture.storageRoot, folder, 'project-1')
  await fixture.client.$transaction(async (tx) => {
    await tx.artifactLineage.update({
      where: { id: first.version.artifactId },
      data: { currentVersionId: null }
    })
    await tx.artifactVersion.delete({ where: { id: first.version.versionId } })
    await tx.artifactLineage.delete({ where: { id: first.version.artifactId } })
  })
  await rm(join(fixture.storageRoot, 'project-folder-history'), { recursive: true, force: true })
  portable = new ArtifactOutputDelivery({
    storageRoot: fixture.storageRoot,
    getClient: async () => wrapped,
    files: new ProjectFolderStagedFiles({
      storageRoot: fixture.storageRoot,
      approve,
      authorizeCreatedFile: async () => true
    }),
    openVersion: (request, versionId) => service.openVersion(request, versionId),
    getLayout: async () => ({
      projectRoot: folder,
      artifactDirectoryRelativePath: 'artifacts/project-1/session-1'
    })
  })
  expect((await portable.inspect(identity(first)))?.state).toBe('conflict')
  expect(
    (
      await fixture.client.artifactLineage.findUniqueOrThrow({
        where: { id: first.version.artifactId }
      })
    ).outputDeliveryJson
  ).toBe(before)
  approve.mockResolvedValue(false)
  expect(
    await portable.deliver({ ...identity(first), versionId: first.version.versionId })
  ).toMatchObject({ state: 'conflict' })
  expect(approve).toHaveBeenCalled()
})

it('records a failed ordinary-file write and retries the same immutable version without adding history', async () => {
  await writeFile(join(folder, 'artifacts'), 'user-owned blocking file')
  const first = await prepare(1)
  await publish(first)
  expect((await service.inspect(identity(first))).outputDelivery).toMatchObject({
    state: 'failed',
    canRetry: true
  })
  const count = await fixture.client.artifactVersion.count()
  await rm(join(folder, 'artifacts'))
  expect(
    await service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).toMatchObject({ state: 'delivered' })
  expect(await readFile(target(), 'utf8')).toBe('first')
  expect(await fixture.client.artifactVersion.count()).toBe(count)
})

it('blocks a superseded attempt after approval and allows the newer head to deliver afterwards', async () => {
  const first = await prepare(1)
  await publish(first)
  const second = await prepare(2, 'new head')
  await repository.finalizeRun(second.proof)
  const activateOnly = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: async () => ({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Outputs',
      cwd: folder,
      status: 'idle',
      messages,
      conversationGraph: graphs.get('session-1')!,
      createdAt: 1,
      updatedAt: 12
    })
  })
  await writeFile(target(), 'outside edit')
  approve.mockImplementationOnce(async () => {
    await activateOnly.activateFinalizedRun(second.proof)
    return true
  })
  expect(
    await service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).toMatchObject({ state: 'cancelled', errorCode: 'VERSION_CONFLICT' })
  expect(await readFile(target(), 'utf8')).toBe('outside edit')
  expect(
    await service.retryOutputDelivery({ ...identity(first), versionId: second.version.versionId })
  ).toMatchObject({ state: 'delivered' })
  expect(await readFile(target(), 'utf8')).toBe('new head')
})

it('retains ordinary files and fences Project deletion without poisoning a temporarily archived Project', async () => {
  const first = await prepare(1)
  await publish(first)
  await fixture.client.project.update({
    where: { id: 'project-1' },
    data: { archivedAt: new Date() }
  })
  expect((await delivery.inspect(identity(first)))?.canRetry).toBe(false)
  await expect(
    service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).rejects.toMatchObject({ code: 'PROJECT_NOT_WRITABLE' })
  expect(await readFile(target(), 'utf8')).toBe('first')
  await fixture.client.project.update({ where: { id: 'project-1' }, data: { archivedAt: null } })
  expect(
    await service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).toMatchObject({ state: 'delivered' })
  await fixture.client.projectDeletionIntent.create({ data: { projectId: 'project-1' } })
  await expect(
    service.retryOutputDelivery({ ...identity(first), versionId: first.version.versionId })
  ).rejects.toMatchObject({ code: 'PROJECT_NOT_WRITABLE' })
  expect(await readFile(target(), 'utf8')).toBe('first')
})
