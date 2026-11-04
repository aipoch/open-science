import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ArtifactVersionFile,
  FinalizeArtifactVersionsRequest
} from '../../shared/artifact-provenance'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { ManagedFileIdentity, SaveTextEditResult } from '../../shared/managed-file-versions'
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

const prepare = async (
  run: number,
  content?: string,
  filename = 'report.md'
): Promise<{ version: ArtifactVersionFile; proof: FinalizeArtifactVersionsRequest }> => {
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

const publish = async (prepared: Awaited<ReturnType<typeof prepare>>): Promise<void> => {
  await repository.finalizeRun(prepared.proof)
  await repository.activateFinalizedRun(prepared.proof)
}

const setupEditedReport = async (): Promise<{
  first: Awaited<ReturnType<typeof prepare>>
  identity: ManagedFileIdentity
  saved: Extract<SaveTextEditResult, { kind: 'created' }>
}> => {
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
  'activates a new %s publication of historical bytes without losing edits',
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
    expectedHead = stale.version.versionId
    expectedText = original
    await publish(first)
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

it('activates a new publication even when its bytes match an earlier edit', async () => {
  const { identity, saved } = await setupEditedReport()
  const second = await service.saveTextEdit({
    ...identity,
    basedOnVersionId: saved.version.id,
    expectedHeadVersionId: saved.version.id,
    operationId: 'edit-2',
    content: updated
  })
  if (second.kind !== 'created') throw new Error('Expected second edit')
  const republished = await prepare(2, edited)
  await publish(republished)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: republished.version.versionId,
    text: edited
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
])('activates historical bytes after publishing %s', async (_, content) => {
  const { identity } = await setupEditedReport()
  const next = await prepare(2, content)
  await publish(next)
  const republished = await prepare(3)
  await publish(republished)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: republished.version.versionId,
    text: original
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

// Reopening the service and replaying old completion must preserve the explicit restoration.
it('publishes v3, restores edited v2 as v4 and retains that head after restart and replay', async () => {
  const { first, identity, saved } = await setupEditedReport()
  const third = await prepare(2)
  await publish(third)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: third.version.versionId,
    text: original
  })
  expect(third.version.versionNumber).toBe(3)
  const historical = await service.inspect({ ...identity, versionId: saved.version.id })
  expect(historical.text).toBe(edited)
  const restored = await service.saveTextEdit({
    ...identity,
    basedOnVersionId: saved.version.id,
    expectedHeadVersionId: third.version.versionId,
    operationId: 'restore-v2',
    restore: true,
    content: edited
  })
  if (restored.kind !== 'created') throw new Error('Expected a new restoration')
  expect(restored.version.versionNumber).toBe(4)
  service = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  await publish(first)
  await publish(third)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: restored.version.id,
    text: edited
  })
  expect(await service.inspect({ ...identity, versionId: saved.version.id })).toMatchObject({
    text: edited
  })
  expect(await service.inspect({ ...identity, versionId: third.version.versionId })).toMatchObject({
    text: original
  })
})

// Older app versions published the row but suppressed its head based on content equality.
it('does not silently promote a previously suppressed version during completion replay', async () => {
  const { identity, saved } = await setupEditedReport()
  const suppressed = await prepare(2)
  await publish(suppressed)
  await fixture.client.artifactLineage.update({
    where: { id: identity.fileId },
    data: { currentVersionId: saved.version.id }
  })
  await publish(suppressed)
  expect(
    await fixture.client.artifactLineage.findUniqueOrThrow({
      where: { id: identity.fileId }
    })
  ).toMatchObject({ currentVersionId: saved.version.id })
  expect(await service.inspect({ ...identity, versionId: saved.version.id })).toMatchObject({
    headVersionId: saved.version.id,
    text: edited
  })
  expect(
    await service.inspect({ ...identity, versionId: suppressed.version.versionId })
  ).toMatchObject({ text: original })
  const fresh = await prepare(3)
  await publish(fresh)
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: fresh.version.versionId,
    text: original
  })
})

// Reproduce persisted heads left behind by the former same-content publication policy.
it('repairs a suppressed Markdown head on default open without rewriting immutable versions', async () => {
  const { first, identity, saved } = await setupEditedReport()
  const suppressed = await prepare(2)
  await publish(suppressed)
  await fixture.client.artifactLineage.update({
    where: { id: identity.fileId },
    data: { currentVersionId: saved.version.id }
  })
  const before = await fixture.client.artifactVersion.findMany({
    where: { artifactId: identity.fileId },
    orderBy: { versionNumber: 'asc' }
  })
  // An explicit history read neither changes the selection nor repairs the current pointer.
  expect(await service.inspect({ ...identity, versionId: first.version.versionId })).toMatchObject({
    selectedVersionId: first.version.versionId,
    headVersionId: saved.version.id,
    text: original
  })
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: suppressed.version.versionId,
    selectedVersionId: suppressed.version.versionId,
    text: original
  })
  expect(
    await fixture.client.artifactVersion.findMany({
      where: { artifactId: identity.fileId },
      orderBy: { versionNumber: 'asc' }
    })
  ).toEqual(before)
  expect(await service.inspect({ ...identity, versionId: saved.version.id })).toMatchObject({
    text: edited
  })
  const catalog = await new ProjectFilesQueryOwner(
    async () => fixture.client,
    () => true
  ).listFiles({ projectId: identity.projectId, collection: { kind: 'all' }, limit: 10 })
  expect(catalog.items[0].sourceVersionId).toBe(suppressed.version.versionId)
  const restored = await service.saveTextEdit({
    ...identity,
    expectedHeadVersionId: suppressed.version.versionId,
    basedOnVersionId: saved.version.id,
    operationId: 'legacy-restore',
    restore: true,
    content: edited
  })
  if (restored.kind !== 'created') throw new Error('Expected restoration')
  expect(restored.version.versionNumber).toBe(4)
  await publish(first)
  await publish(suppressed)
  service = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  expect(await service.inspect(identity)).toMatchObject({
    headVersionId: restored.version.id,
    text: edited
  })
})

it.each(['pending', 'finalized but inactive', 'corrupt', 'missing', 'unrelated content'] as const)(
  'does not repair a Markdown head using %s content',
  async (state) => {
    const { identity, saved } = await setupEditedReport()
    const candidate = await prepare(2, state === 'unrelated content' ? updated : original)
    if (state !== 'pending') await repository.finalizeRun(candidate.proof)
    if (state === 'corrupt' || state === 'missing' || state === 'unrelated content') {
      await repository.activateFinalizedRun(candidate.proof)
      await fixture.client.artifactLineage.update({
        where: { id: identity.fileId },
        data: { currentVersionId: saved.version.id }
      })
    }
    if (state === 'corrupt' || state === 'missing') {
      const row = await fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: candidate.version.versionId }
      })
      const path = join(fixture.storageRoot, row.contentStorageKey)
      if (state === 'missing') await rename(path, path + '.held-for-test')
      else await writeFile(path, 'damaged bytes')
    }
    expect(await service.inspect(identity)).toMatchObject({
      headVersionId: saved.version.id,
      text: edited
    })
    expect(
      (await fixture.client.artifactLineage.findUniqueOrThrow({ where: { id: identity.fileId } }))
        .currentVersionId
    ).toBe(saved.version.id)
  }
)

it('repairs the old suppression pattern after an intervening generated publication', async () => {
  const { identity, saved } = await setupEditedReport()
  const intervening = await prepare(2, updated)
  await publish(intervening)
  const suppressed = await prepare(3)
  await publish(suppressed)
  await fixture.client.artifactLineage.update({
    where: { id: identity.fileId },
    data: { currentVersionId: intervening.version.versionId }
  })
  const lease = await service.openLatest(identity)
  try {
    expect(lease.version.id).toBe(suppressed.version.versionId)
    expect(Buffer.from(await lease.readRange(0, lease.size)).toString('utf8')).toBe(original)
  } finally {
    await lease.close()
  }
  expect(await service.inspect({ ...identity, versionId: saved.version.id })).toMatchObject({
    text: edited
  })
})

it('keeps a concurrent manual save when legacy head repair loses its compare-and-set', async () => {
  const { identity, saved } = await setupEditedReport()
  const suppressed = await prepare(2)
  await publish(suppressed)
  await fixture.client.artifactLineage.update({
    where: { id: identity.fileId },
    data: { currentVersionId: saved.version.id }
  })
  // Commit a real save immediately before the repair's transaction starts.
  const transaction = fixture.client.$transaction.bind(fixture.client)
  const spy = vi.spyOn(fixture.client, '$transaction')
  let concurrentId: string | undefined
  spy.mockImplementationOnce(async (...args) => {
    spy.mockRestore()
    const concurrent = await service.saveTextEdit({
      ...identity,
      basedOnVersionId: saved.version.id,
      expectedHeadVersionId: saved.version.id,
      operationId: 'concurrent-legacy-save',
      content: updated
    })
    if (concurrent.kind !== 'created') throw new Error('Expected concurrent save')
    concurrentId = concurrent.version.id
    return transaction(...args)
  })
  try {
    const result = await service.inspect(identity)
    expect(concurrentId).toBeDefined()
    expect(result).toMatchObject({ headVersionId: concurrentId, text: updated })
  } finally {
    spy.mockRestore()
  }
})
