import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ProjectFilesQueryOwner } from '../project-files/query-owner'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { createProvenanceTestFixture } from './provenance-test-fixtures'

const original = '# Report\n\nParticipants: 80\n\n- [ ] Reviewed\n'
const edited = '# Report\n\nParticipants: 96\n\n- [x] Reviewed\n'
const updated = `${edited}\n## Follow-up\n\nAdditional analysis.\n`

let fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
let repository: ArtifactProvenanceRepository
let service: ManagedFileVersionService
let sourcePath: string

const messages = Array.from({ length: 6 }, (_, i) => ({
  id: `${i % 2 ? 'message' : 'prompt'}-${Math.floor(i / 2) + 1}`,
  role: i % 2 ? ('agent' as const) : ('user' as const),
  content: 'Publish a report',
  status: 'complete' as const,
  eventIds: [],
  createdAt: i + 1,
  updatedAt: i + 1
}))
const conversationGraph = createLinearConversationGraph({
  sessionId: 'session-1',
  messages,
  frameworkId: 'codex',
  createdAt: 1,
  updatedAt: 4
})

beforeEach(async () => {
  fixture = await createProvenanceTestFixture()
  await fixture.client.project.create({ data: { id: 'project-1', name: 'Manual edit regression' } })
  const workspace = join(fixture.storageRoot, 'workspace')
  await mkdir(workspace)
  sourcePath = join(workspace, 'report.md')
  await writeFile(sourcePath, original)
  repository = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: async () => ({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Report',
      cwd: workspace,
      status: 'idle',
      messages,
      conversationGraph,
      createdAt: 1,
      updatedAt: 4
    })
  })
  service = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
})

afterEach(async () => {
  await fixture?.dispose()
})

const prepare = async (run: number, content?: string, filename = 'report.md') => {
  const common = {
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactStorageSessionId: 'storage-1',
    artifactRunId: `run-${run}`,
    writeOperationId: `write-${run}`,
    rootFrameId: conversationGraph.rootFrameId,
    agentFrameId: conversationGraph.activeFrameId,
    messageBranchId: conversationGraph.branches[0].id,
    runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
    promptMessageId: `prompt-${run}`,
    filename,
    contentType: 'text/markdown'
  }
  const version = await repository.saveVersion(
    {
      ...common,
      source:
        content === undefined
          ? { kind: 'localPath', path: sourcePath }
          : { kind: 'inline', content: Buffer.from(content).toString('base64'), encoding: 'base64' }
    },
    { allowedImportRoots: [join(fixture.storageRoot, 'workspace')] }
  )
  return {
    version,
    proof: { ...common, artifactVersionIds: [version.versionId], messageId: `message-${run}` }
  }
}

const publish = async (prepared: Awaited<ReturnType<typeof prepare>>) => {
  await repository.finalizeRun(prepared.proof)
  await repository.activateFinalizedRun(prepared.proof)
}

const setupEditedReport = async () => {
  const first = await prepare(1)
  await publish(first)
  const identity = {
    source: 'artifact' as const,
    projectId: 'project-1',
    fileId: first.version.artifactId
  }
  const saved = await service.saveTextEdit({
    ...identity,
    basedOnVersionId: first.version.versionId,
    expectedHeadVersionId: first.version.versionId,
    operationId: 'edit-1',
    content: edited
  })
  if (saved.kind !== 'created') throw new Error('Expected a new user edit')
  return { first, identity, saved }
}

it.each(['local', 'casefold', 'inline', 'multiple-edits'] as const)(
  'preserves the user head when %s publication repeats pre-edit bytes, including replay',
  async (source) => {
    const { first, identity, saved } = await setupEditedReport()
    let expectedHead = saved.version.id
    let expectedText = edited
    if (source === 'multiple-edits') {
      const secondEdit = await service.saveTextEdit({
        ...identity,
        basedOnVersionId: expectedHead,
        expectedHeadVersionId: expectedHead,
        operationId: 'edit-2',
        content: updated
      })
      if (secondEdit.kind !== 'created') throw new Error('Expected second edit')
      expectedHead = secondEdit.version.id
      expectedText = updated
    }
    const stale = await prepare(
      2,
      source === 'inline' ? original : undefined,
      source === 'casefold' ? 'REPORT.MD' : 'report.md'
    )
    expect(stale.version.artifactId).toBe(first.version.artifactId)
    await publish(stale)
    await publish(stale)
    expect(await service.inspect(identity)).toMatchObject({
      headVersionId: expectedHead,
      text: expectedText
    })
    // Publication still retains the generated version and its immutable message evidence.
    expect(
      await fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: stale.version.versionId }
      })
    ).toMatchObject({
      state: 'finalized',
      messageId: 'message-2',
      managedVisibleAt: expect.any(Date)
    })
    expect(
      await service.inspect({ ...identity, versionId: stale.version.versionId })
    ).toMatchObject({ text: original })
    expect(await service.inspect({ ...identity, versionId: saved.version.id })).toMatchObject({
      text: edited
    })
    expect(await readFile(sourcePath, 'utf8')).toBe(original)
    const catalog = await new ProjectFilesQueryOwner(
      async () => fixture.client,
      () => true
    ).listFiles({ projectId: 'project-1', collection: { kind: 'all' }, limit: 10 })
    expect(catalog.items).toHaveLength(1)
    expect(catalog.items[0].sourceVersionId).toBe(expectedHead)
    const latestLease = await service.openLatest(identity)
    const historyLease = await service.openVersion(identity, stale.version.versionId)
    try {
      expect(Buffer.from(await latestLease.readRange(0, latestLease.size)).toString('utf8')).toBe(
        expectedText
      )
      expect(Buffer.from(await historyLease.readRange(0, historyLease.size)).toString('utf8')).toBe(
        original
      )
    } finally {
      await latestLease.close()
      await historyLease.close()
    }
  }
)

it('does not revert to an earlier user edit when that content is generated again', async () => {
  const { identity, saved } = await setupEditedReport()
  const second = await service.saveTextEdit({
    ...identity,
    basedOnVersionId: saved.version.id,
    expectedHeadVersionId: saved.version.id,
    operationId: 'edit-2',
    content: updated
  })
  if (second.kind !== 'created') throw new Error('Expected second edit')
  await publish(await prepare(2, edited))
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: second.version.id,
    text: updated
  })
})

it.each([
  ['new content', updated],
  ['unchanged edited content', edited]
])('allows %s to become the current version', async (_, content) => {
  const { identity } = await setupEditedReport()
  const next = await prepare(2, content)
  await publish(next)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: next.version.versionId,
    text: content
  })
})

it('keeps ordinary repeated publication working when no manual edit exists', async () => {
  const first = await prepare(1)
  await publish(first)
  const next = await prepare(2)
  await publish(next)
  expect(
    await service.inspect({
      source: 'artifact',
      projectId: 'project-1',
      fileId: first.version.artifactId
    })
  ).toMatchObject({
    headVersionId: next.version.versionId,
    text: original
  })
})

it.each([
  ['same edited bytes', edited],
  ['new follow-up content', updated]
])('preserves edits after publishing %s and then repeating the old source', async (_, content) => {
  const { identity } = await setupEditedReport()
  const next = await prepare(2, content)
  await publish(next)
  await publish(await prepare(3))
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: next.version.versionId,
    text: content
  })
})

it('allows subsequent new content and an explicit manual restoration of historical content', async () => {
  const { identity } = await setupEditedReport()
  await publish(await prepare(2, updated))
  const next = await prepare(3, `${updated}\nAnother new result.\n`)
  await publish(next)
  expect((await service.inspect(identity)).headVersionId).toBe(next.version.versionId)
  const restored = await service.saveTextEdit({
    ...identity,
    basedOnVersionId: next.version.versionId,
    expectedHeadVersionId: next.version.versionId,
    operationId: 'restore-original',
    content: original
  })
  if (restored.kind !== 'created') throw new Error('Expected manual restoration')
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: restored.version.id,
    text: original
  })
})

it.each(['pending', 'finalized but inactive'] as const)(
  'does not mistake an older %s candidate for published pre-edit history',
  async (state) => {
    const first = await prepare(1)
    await publish(first)
    const candidate = await prepare(2, updated)
    if (state === 'finalized but inactive') await repository.finalizeRun(candidate.proof)
    const identity = {
      source: 'artifact' as const,
      projectId: 'project-1',
      fileId: first.version.artifactId
    }
    await service.saveTextEdit({
      ...identity,
      basedOnVersionId: first.version.versionId,
      expectedHeadVersionId: first.version.versionId,
      operationId: 'edit-1',
      content: edited
    })
    const next = await prepare(3, updated)
    await publish(next)
    expect(await service.inspect(identity)).toMatchObject({
      headVersionId: next.version.versionId,
      text: updated
    })
  }
)

it('does not match historical bytes from another lineage', async () => {
  const other = await prepare(1, updated, 'other.md')
  await publish(other)
  const report = await prepare(2)
  await publish(report)
  const identity = {
    source: 'artifact' as const,
    projectId: 'project-1',
    fileId: report.version.artifactId
  }
  await service.saveTextEdit({
    ...identity,
    basedOnVersionId: report.version.versionId,
    expectedHeadVersionId: report.version.versionId,
    operationId: 'edit-1',
    content: edited
  })
  const next = await prepare(3, updated)
  await publish(next)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: next.version.versionId,
    text: updated
  })
})
