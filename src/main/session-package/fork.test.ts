import { createFrameNotebookLane } from '../notebook/lane-identity'
import { BookmarkRepository } from '../bookmarks/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { ArchiveCoordinator } from '../archive/coordinator'
import { ProjectRepository } from '../projects/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { UploadRepository } from '../uploads/repository'
import { createSessionPackageDesktop } from './desktop-composition'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { createAcpHandlerWorkflows } from '../acp/handler-workflows'
import {
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import * as storageRoots from '../storage-root'
import { afterEach, expect, it, vi } from 'vitest'
import { join, sep } from 'node:path'
import { stat, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import * as fileSystem from 'node:fs/promises'
import {
  createProvenanceTestFixture,
  createArtifactVersionRequest
} from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from './service'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  activateConversationBranch
} from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { preserveImportedSession } from '../session-persistence/imported-session'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))
const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})
const setup = async (): Promise<{
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  repository: SessionRepository
  service: SessionPackageService
}> => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  vi.spyOn(storageRoots, 'resolveDataRoot').mockReturnValue(fixture.storageRoot)
  await fixture.client.project.create({ data: { id: 'project-1', name: 'Fork research' } })
  const graph = forkEditedConversationMessage(
    createLinearConversationGraph({
      sessionId: 'session-1',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'question',
          role: 'user',
          content: 'Study',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'answer',
          role: 'agent',
          content: 'Result',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }),
    'question',
    'alternate',
    3
  )
  const session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Study',
    description: 'Research context',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    messages: [],
    conversationGraph: graph,
    permissionProfile: 'ask',
    pinned: true,
    providerSessionId: 'old-provider',
    agentFrameworkId: 'codex',
    agentModel: 'source-model',
    runtimeContext: {
      version: 1,
      revision: 2,
      sideChat: {
        version: 1,
        id: 'side',
        entries: [],
        lifecycle: 'open',
        frameworkId: 'codex',
        historyPreamble: '',
        createdAt: 1,
        updatedAt: 1
      }
    }
  }
  const repository = new SessionRepository(fixture.storageRoot)
  await repository.saveSession(session)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  return { fixture, repository, service }
}

it.each(['local', 'imported'] as const)(
  'forks a %s Session when the data folder is on a different volume from temporary files',
  async (sourceKind) => {
    const { fixture, repository, service } = await setup()
    let source = { projectId: 'project-1', sessionId: 'session-1' }
    if (sourceKind === 'imported') {
      const archive = join(fixture.storageRoot, 'source.science')
      await service.exportTo(source, archive)
      source = await service.importFrom(archive, undefined, undefined, undefined, {
        projectId: source.projectId
      })
    }
    const originalRename = fileSystem.rename
    const dataPrefix = fixture.storageRoot + sep
    vi.spyOn(fileSystem, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(dataPrefix) && !String(from).startsWith(dataPrefix)) {
        throw Object.assign(new Error('Cross-device link not permitted'), { code: 'EXDEV' })
      }
      return originalRename(from, to)
    })

    const child = await service.fork(source)
    expect(
      (await repository.loadSession(child.projectId, child.sessionId))?.forkOrigin
    ).toBeTruthy()
    expect(await fileSystem.readdir(fixture.storageRoot)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^open-science-package-(?:export|forward)-/)])
    )
  }
)

it('forks all branches with fresh identities, independent files, replay and no Side Chat', async () => {
  const { fixture, repository, service } = await setup()
  await fixture.stagePng('fork artifact', 'figure.png')
  const version = await fixture.repository.createVersion(
    createArtifactVersionRequest({ filename: 'figure.png' })
  )
  const source = (await repository.loadSession('project-1', 'session-1'))!
  const result = await service.fork({ projectId: source.projectId, sessionId: source.id })
  const fork = (await repository.loadSession(result.projectId, result.sessionId))!
  expect(fork.title).toBe('Study(2)')
  expect(fork.id).not.toMatch(/^import-/)
  expect(fork.packageOrigin).toBeUndefined()
  expect(fork.forkOrigin?.sourceSessionId).toBe(source.id)
  expect(fork.runtimeContext?.sideChat).toBeUndefined()
  expect(fork.providerSessionId).toBeUndefined()
  expect(fork.pendingHistoryReplay).toEqual({ kind: 'all' })
  expect(fork.pinned).not.toBe(true)
  expect(fork.conversationGraph?.branches).toHaveLength(2)
  expect(fork.conversationGraph?.messages.map((m) => m.content)).toEqual(
    source.conversationGraph?.messages.map((m) => m.content)
  )
  expect(
    fork.conversationGraph?.messages.every(
      (m) => !source.conversationGraph?.messages.some((old) => old.id === m.id)
    )
  ).toBe(true)
  expect(
    fork.conversationGraph?.messages.every((m) => m.usageOrigin?.sessionId === source.id)
  ).toBe(true)
  expect(fork.cwd).toBeTruthy()
  expect((await stat(fork.cwd)).isDirectory()).toBe(true)
  const copiedFiles = await fixture.client.artifactLineage.findMany({
    where: { projectId: result.projectId, sessionId: result.sessionId },
    include: { versions: true }
  })
  expect(copiedFiles).toHaveLength(1)
  expect(copiedFiles[0].versions[0].id).not.toBe(version.versionId)
  expect(
    await stat(
      join(fixture.storageRoot, 'artifacts', result.projectId, result.sessionId, '.session-package')
    ).catch(() => null)
  ).toBeNull()
  await repository.saveSession({ ...fork, title: 'Continued' })
  expect((await repository.loadSession(source.projectId, source.id))?.title).toBe('Study')
  await service.recover()
  expect((await repository.loadSession(result.projectId, result.sessionId))?.title).toBe(
    'Continued'
  )
  const copiedPath = join(fixture.storageRoot, copiedFiles[0].versions[0].contentStorageKey!)
  const copiedBytes = await readFile(copiedPath)
  expect(copiedBytes).toEqual(await readFile(version.path))
  await repository.deleteSession(source.projectId, source.id)
  await rm(version.path)
  expect(await readFile(copiedPath)).toEqual(copiedBytes)
  await service.close()
})

it('preserves pending Artifact evidence through repeated forks and database startup', async () => {
  const { fixture, repository, service } = await setup()
  await fixture.stagePng('interrupted turn artifact', 'figure.png')
  const version = await fixture.repository.createVersion(
    createArtifactVersionRequest({ filename: 'figure.png' })
  )
  const source = { projectId: 'project-1', sessionId: 'session-1' }
  const sourceSession = await repository.loadSession(source.projectId, source.sessionId)
  const sourceLineage = await fixture.client.artifactLineage.findUniqueOrThrow({
    where: { id: version.artifactId },
    include: { versions: true }
  })
  expect(sourceLineage.currentVersionId).toBeNull()
  expect(sourceLineage.versions[0].state).toBe('pending')
  const sourceBytes = await readFile(version.path)
  let parent = source
  const versionIds = new Set([version.versionId])
  for (let copy = 0; copy < 2; copy++) {
    const child = await service.fork(parent)
    const lineages = await fixture.client.artifactLineage.findMany({
      where: { projectId: child.projectId, sessionId: child.sessionId },
      include: { versions: true }
    })
    expect(lineages).toHaveLength(1)
    expect(lineages[0].currentVersionId).toBeNull()
    expect(lineages[0].versions).toHaveLength(1)
    const copied = lineages[0].versions[0]
    expect(copied).toMatchObject({
      state: 'pending',
      checksum: sourceLineage.versions[0].checksum,
      messageId: null,
      managedVisibleAt: null
    })
    expect(versionIds.has(copied.id)).toBe(false)
    versionIds.add(copied.id)
    expect(await readFile(join(fixture.storageRoot, copied.contentStorageKey))).toEqual(sourceBytes)
    // A new connection exercises the real startup audit, which previously rejected the Fork.
    const reopened = createProjectDbClient(fixture.storageRoot)
    try {
      await expect(migrateApplicationDatabase(reopened)).resolves.toBeDefined()
    } finally {
      await reopened.$disconnect()
    }
    parent = child
  }
  expect(await repository.loadSession(source.projectId, source.sessionId)).toEqual(sourceSession)
  expect(
    await fixture.client.artifactLineage.findUniqueOrThrow({
      where: { id: version.artifactId },
      include: { versions: true }
    })
  ).toEqual(sourceLineage)
  expect(await readFile(version.path)).toEqual(sourceBytes)
  await service.close()
})

it('forks imported history using the selected branch and receiving model defaults, leaving its original locked', async () => {
  const { repository, service, fixture } = await setup()
  await fixture.stagePng('imported artifact', 'figure.png')
  const version = await fixture.repository.createVersion(
    createArtifactVersionRequest({ filename: 'figure.png' })
  )
  const original = (await repository.loadSession('project-1', 'session-1'))!
  await repository.saveSession({
    ...original,
    artifacts: [
      {
        id: `artifact-version:${version.versionId}`,
        kind: 'managed-file',
        name: 'figure.png',
        path: version.path,
        fileUrl: version.fileUrl,
        size: version.size,
        mtimeMs: version.mtimeMs
      }
    ]
  })
  const path = join(fixture.storageRoot, 'source.science')
  await service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, path)
  const importedId = await service.importFrom(path, undefined, undefined, undefined, {
    projectId: 'project-1'
  })
  expect(importedId.sessionId).toMatch(/^import-/)
  const imported = (await repository.loadSession(importedId.projectId, importedId.sessionId))!
  const originalBranch = imported.conversationGraph!.branches[0].id
  const selected = {
    ...imported,
    conversationGraph: activateConversationBranch(imported.conversationGraph!, originalBranch)
  }
  await repository.saveSession(materializeSessionConversationGraph(selected))
  const source = (await repository.loadSession(importedId.projectId, importedId.sessionId))!
  const result = await service.fork(importedId)
  const fork = (await repository.loadSession(result.projectId, result.sessionId))!
  expect(fork.id).not.toMatch(/^import-/)
  expect(fork.packageOrigin).toBeUndefined()
  expect(fork.agentFrameworkId).toBeUndefined()
  expect(fork.agentConfiguration).toBeUndefined()
  expect(fork.artifacts?.[0].path).not.toBe(source.artifacts?.[0].path)
  expect(await readFile(fork.artifacts![0].path)).toEqual(await readFile(version.path))
  expect(fork.cwd).toBeTruthy()
  expect(fork.conversationGraph?.branches).toHaveLength(2)
  const selectedIndex = source.conversationGraph!.branches.findIndex(
    (b) => b.id === source.conversationGraph!.frames[0].activeBranchId
  )
  expect(fork.conversationGraph!.frames[0].activeBranchId).toBe(
    fork.conversationGraph!.branches[selectedIndex].id
  )
  const stillLocked = (await repository.loadSession(importedId.projectId, importedId.sessionId))!
  expect(stillLocked.packageOrigin).toBeTruthy()
  expect(() =>
    preserveImportedSession(stillLocked, { ...stillLocked, description: 'Changed research' })
  ).toThrow('read-only')
  await service.close()
})

it('rejects an active source without publishing a child', async () => {
  const { repository, service, fixture } = await setup()
  const source = (await repository.loadSession('project-1', 'session-1'))!
  await repository.saveSession({ ...source, status: 'running' })
  await expect(service.fork({ projectId: 'project-1', sessionId: 'session-1' })).rejects.toThrow(
    'Wait for'
  )
  expect(await fixture.client.fileOriginSession.count()).toBe(0)
  await service.close()
})

it('preserves omitted-file evidence through an imported fork and another fork', async () => {
  const { fixture, repository, service } = await setup()
  await fixture.stagePng('omitted bytes', 'figure.png')
  await fixture.repository.createVersion(createArtifactVersionRequest({ filename: 'figure.png' }))
  const path = join(fixture.storageRoot, 'compact.science')
  await service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, path, {
    selectFiles: async (files) =>
      files.filter((file) => !file.requiredForEvidence).map((file) => file.storageKey)
  })
  const imported = await service.importFrom(path, undefined, undefined, undefined, {
    projectId: 'project-1'
  })
  const first = await service.fork(imported)
  expect(
    (await repository.loadSession(first.projectId, first.sessionId))?.forkOrigin?.excludedFiles
      ?.length
  ).toBeGreaterThan(0)
  const second = await service.fork(first)
  expect(
    (await repository.loadSession(second.projectId, second.sessionId))?.forkOrigin?.excludedFiles
      ?.length
  ).toBeGreaterThan(0)
  await service.close()
})

it('recovers the same child after committed records fail to publish, without copying again', async () => {
  const { fixture, repository, service } = await setup()
  const source = (await repository.loadSession('project-1', 'session-1'))!
  await repository.saveSession({ ...source, cwd: fixture.storageRoot })
  const save = SessionRepository.prototype.saveSession
  let copiedSaves = 0
  const injected = vi
    .spyOn(SessionRepository.prototype, 'saveSession')
    .mockImplementation(function (this: SessionRepository, ...args) {
      if (args[0].forkOrigin && ++copiedSaves === 2)
        return Promise.reject(new Error('Injected projection failure'))
      return save.apply(this, args)
    })
  const failed = await service
    .fork({ projectId: source.projectId, sessionId: source.id })
    .catch((error) => error)
  injected.mockRestore()
  expect(failed.recovery).toMatchObject({ projectId: 'project-1', outcome: 'committed' })
  await service.recover()
  const child = await repository.loadSession('project-1', failed.recovery.sessionId)
  expect(child?.forkOrigin?.importId).toBe(failed.recovery.operationId)
  expect(child?.packageOrigin).toBeUndefined()
  const copied = (await repository.loadAll()).sessions.filter((s) => s.forkOrigin)
  expect(copied).toHaveLength(1)
  await service.recover()
  expect((await repository.loadSession('project-1', child!.id))?.id).toBe(child!.id)
  await service.close()
})

it.each(['local', 'imported'] as const)(
  'publishes a %s fork into live admission, then resumes, saves, switches branches and archives without restart',
  async (kind) => {
    const { fixture, service: sourceService } = await setup()
    const getClient = async (): Promise<typeof fixture.client> => fixture.client
    const repository = new SessionRepository(
      fixture.storageRoot,
      {},
      new SessionProjectionRepository(getClient)
    )
    const projects = new ProjectRepository(getClient, fixture.storageRoot)
    const files = new ManagedFileIndexRepository(
      getClient,
      fixture.storageRoot,
      new ManagedFileVersionService({ storageRoot: fixture.storageRoot, getClient }),
      new UploadRepository(fixture.storageRoot, { getClient })
    )
    const persistence = new SessionPersistenceCoordinator(repository, files)
    await persistence.loadAll()
    const archive = new ArchiveCoordinator(projects, persistence, {
      isSessionBusy: () => false,
      isProjectBusy: () => false,
      liveSessionProjectId: () => undefined
    })
    const service = new SessionPackageService({
      storageRoot: fixture.storageRoot,
      getClient,
      onSessionPublished: ({ projectId, sessionId }) =>
        persistence.adoptPublishedSession(projectId, sessionId)
    })
    const initial = { projectId: 'project-1', sessionId: 'session-1' }
    let source = initial
    if (kind === 'imported') {
      const path = join(fixture.storageRoot, 'source.science')
      await sourceService.exportTo(initial, path)
      source = await service.importFrom(path, undefined, undefined, undefined, {
        projectId: initial.projectId
      })
      expect(await persistence.sessionProjectId(source.sessionId)).toBe(source.projectId)
    }
    const notified: string[] = []
    const desktop = createSessionPackageDesktop({
      sessionPackageService: service,
      translate: englishNativeTranslator,
      archiveCoordinator: archive,
      sessionPersistenceCoordinator: persistence,
      applicationEvents: {
        publish: (channel, payload) => {
          if (channel === 'session:created')
            notified.push((payload as { session: PersistedChatSession }).session.id)
        }
      },
      projectRepository: projects,
      sessionRepository: repository,
      isPackageHandoffHeld: () => false
    })
    try {
      const child = (await desktop.fork(source))!
      expect(notified).toEqual([child.sessionId])
      expect(await persistence.sessionProjectId(child.sessionId)).toBe(child.projectId)
      const fork = await persistence.loadSessionForContinuation(child.projectId, child.sessionId)
      const resume = vi.fn(async (request: { sessionId: string; projectId?: string }) => ({
        sessionId: request.sessionId,
        contextReset: true
      }))
      const workflows = createAcpHandlerWorkflows(
        {
          getState: vi.fn(),
          hasLiveSession: () => false,
          captureSessionBackend: () => undefined,
          resumeSession: resume,
          startPrompt: vi.fn(),
          getLatestUserPrompt: () => undefined,
          startContinuation: vi.fn(),
          startContinuationWhenDispatchAdmitted: vi.fn()
        },
        { create: vi.fn() } as Parameters<typeof createAcpHandlerWorkflows>[1],
        undefined,
        archive
      )
      await workflows.resumeSession({ sessionId: child.sessionId, cwd: fork.cwd })
      expect(resume).toHaveBeenCalledWith(expect.objectContaining({ projectId: child.projectId }))
      const messages = [
        ...fork.messages,
        {
          id: 'new-question',
          role: 'user' as const,
          content: 'Continue research',
          status: 'complete' as const,
          eventIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ]
      const saved = await archive.withSessionAvailableById(child.sessionId, () =>
        persistence.saveSession({
          ...fork,
          messages,
          conversationGraph: synchronizeActiveConversationMessages(
            fork.conversationGraph!,
            messages,
            Date.now()
          ),
          updatedAt: Date.now()
        })
      )
      expect(saved.messages.at(-1)?.content).toBe('Continue research')
      expect(
        (await repository.loadSession(source.projectId, source.sessionId))?.messages.some(
          (m) => m.id === 'new-question'
        )
      ).toBe(false)
      const other = saved.conversationGraph!.branches.find(
        (b) => b.id !== saved.conversationGraph!.frames[0].activeBranchId
      )!
      const switchedGraph = activateConversationBranch(saved.conversationGraph!, other.id)
      const switched = await persistence.saveSession({
        ...saved,
        messages: resolveActiveConversationMessages(switchedGraph),
        conversationGraph: switchedGraph,
        updatedAt: Date.now()
      })
      expect(switched.conversationGraph?.messages.some((m) => m.id === 'new-question')).toBe(true)
      const archived = await archive.updateSessionArchive({
        ...child,
        archived: true,
        expectedRevision: switched.revision!
      })
      await expect(
        workflows.resumeSession({ sessionId: child.sessionId, cwd: fork.cwd })
      ).rejects.toThrow(/archived/i)
      await archive.updateSessionArchive({
        ...child,
        archived: false,
        expectedRevision: archived.revision!
      })
      await workflows.resumeSession({ sessionId: child.sessionId, cwd: fork.cwd })
      const grandchild = (await desktop.fork(child))!
      expect(await persistence.sessionProjectId(grandchild.sessionId)).toBe(child.projectId)
      const reloaded = new SessionPersistenceCoordinator(repository, files)
      await reloaded.loadAll()
      expect(await reloaded.sessionProjectId(child.sessionId)).toBe(child.projectId)
      expect(
        (
          await reloaded.loadSessionForContinuation(child.projectId, child.sessionId)
        ).conversationGraph?.messages.some((m) => m.id === 'new-question')
      ).toBe(true)
    } finally {
      await desktop.close()
      await service.close()
      await sourceService.close()
    }
  }
)

it.each(['local', 'imported'] as const)(
  'copies private bookmarks and notes with remapped targets for a %s fork and refork',
  async (kind) => {
    const { fixture, repository, service } = await setup()
    let sourceId = { projectId: 'project-1', sessionId: 'session-1' }
    if (kind === 'imported') {
      const path = join(fixture.storageRoot, 'bookmarked.science')
      await service.exportTo(sourceId, path)
      sourceId = await service.importFrom(path, undefined, undefined, undefined, {
        projectId: 'project-1'
      })
    }
    const source = (await repository.loadSession(sourceId.projectId, sourceId.sessionId))!
    const bookmarks = new BookmarkRepository(async () => fixture.client)
    const message = source.conversationGraph!.messages.find((m) => m.role === 'agent')!
    await bookmarks.create({
      ...sourceId,
      id: 'private-bookmark',
      note: 'Private research note',
      target: {
        kind: 'text',
        source: { kind: 'agent-message', sessionId: source.id, messageId: message.id },
        quote: message.content
      }
    })
    const childId = await service.fork(sourceId)
    const child = (await repository.loadSession(childId.projectId, childId.sessionId))!
    const copied = (await bookmarks.list(childId)).items
    expect(copied).toHaveLength(1)
    expect(copied[0].id).not.toBe('private-bookmark')
    expect(copied[0].note).toBe('Private research note')
    expect(copied[0].target.source).toEqual({
      kind: 'agent-message',
      sessionId: child.id,
      messageId: child.conversationGraph!.messages.find((m) => m.content === message.content)!.id
    })
    const grandchildId = await service.fork(childId)
    expect((await bookmarks.list(grandchildId)).items[0].target.source).toMatchObject({
      sessionId: grandchildId.sessionId
    })
    await bookmarks.updateNote({ ...sourceId, id: 'private-bookmark', note: 'Changed source note' })
    expect((await bookmarks.list(childId)).items[0].note).toBe('Private research note')
    const path = join(fixture.storageRoot, 'private-export.science')
    await service.exportTo(childId, path)
    const reimported = await service.importFrom(path, undefined, undefined, undefined, {
      projectId: 'project-1'
    })
    expect((await bookmarks.list(reimported)).items).toEqual([])
    await service.close()
  }
)

it('retains committed identity when live catalog adoption fails and recovers without duplicating a fork', async () => {
  const { fixture, service: original, repository } = await setup()
  let unavailable = true
  const published: string[] = []
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client,
    onSessionPublished: async ({ sessionId }) => {
      if (unavailable) throw new Error('Catalog adoption unavailable')
      published.push(sessionId)
    }
  })
  const failure = await service
    .fork({ projectId: 'project-1', sessionId: 'session-1' })
    .catch((error) => error)
  expect(failure.recovery).toMatchObject({ projectId: 'project-1', outcome: 'committed' })
  expect((await repository.loadAll()).sessions.filter((s) => s.forkOrigin)).toHaveLength(1)
  unavailable = false
  await service.recover()
  expect(published).toEqual([failure.recovery.sessionId])
  expect((await repository.loadAll()).sessions.filter((s) => s.forkOrigin)).toHaveLength(1)
  await service.close()
  await original.close()
})

it('copies writable file versions, file bookmarks and historical Plan references without sharing source edits', async () => {
  const { fixture, repository, service } = await setup()
  const files = new ManagedFileVersionService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  const note = await files.adoptLegacyArtifact({
    projectId: 'project-1',
    sessionId: 'session-1',
    sourceFileId: 'notes',
    logicalFilename: 'notes.md',
    content: Buffer.from('Original notes')
  })
  // This historical Plan lives outside the source Session and is referenced only by Plan history.
  const plan = await files.adoptLegacyArtifact({
    projectId: 'project-1',
    sessionId: 'upstream-plan',
    sourceFileId: 'plan',
    logicalFilename: 'plan.json',
    content: Buffer.from('{"plan":"historical"}')
  })
  const source = (await repository.loadSession('project-1', 'session-1'))!
  await repository.saveSession({
    ...source,
    planHistoryProjections: [
      {
        artifactId: plan.fileId,
        artifactVersionId: plan.versionId,
        artifactChecksum: plan.checksum,
        originatingPromptMessageId: 'question',
        revision: 1,
        approval: 'approved',
        lifecycle: 'completed',
        document: {
          schema_version: 1,
          task_summary: 'Study',
          phases: [
            {
              name: 'Research',
              delegations: [
                { name: 'Analysis', steps: [{ title: 'Read', description: 'Read evidence' }] }
              ]
            }
          ],
          desired_outputs: ['Report'],
          feasibility: { confidence: 'high', rationale: 'Available' }
        },
        stepStatuses: { Read: { status: 'completed', updatedAt: 1 } },
        stepStates: { Read: { status: 'completed' } },
        counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
      }
    ]
  })
  const bookmarks = new BookmarkRepository(async () => fixture.client)
  await bookmarks.create({
    projectId: source.projectId,
    sessionId: source.id,
    id: 'file-bookmark',
    note: 'Remember this',
    target: {
      kind: 'text',
      quote: 'Original notes',
      source: {
        kind: 'project-file',
        projectId: source.projectId,
        sessionId: source.id,
        fileSource: 'artifact',
        sourceFileId: note.fileId,
        versionId: note.versionId,
        path: note.storageRef,
        name: 'notes.md'
      }
    }
  })
  const child = await service.fork({ projectId: source.projectId, sessionId: source.id })
  const origin = await service.readOrigin(child)
  const clonedFileId = origin.identities[note.fileId]
  const clonedVersionId = origin.identities[note.versionId]
  expect(
    await files.inspect({ projectId: child.projectId, source: 'artifact', fileId: clonedFileId })
  ).toMatchObject({ canEdit: true, text: 'Original notes' })
  const copiedBookmark = (await bookmarks.list(child)).items[0]
  expect(copiedBookmark.target.source).toMatchObject({
    sessionId: child.sessionId,
    sourceFileId: clonedFileId,
    versionId: clonedVersionId
  })
  const copied = (await repository.loadSession(child.projectId, child.sessionId))!
  const copiedPlan = copied.planHistoryProjections![0]
  expect(copiedPlan.document.task_summary).toBe('Study')
  expect(copiedPlan.artifactVersionId).not.toBe(plan.versionId)
  expect(
    await files.inspect({
      projectId: child.projectId,
      source: 'artifact',
      fileId: copiedPlan.artifactId,
      versionId: copiedPlan.artifactVersionId
    })
  ).toMatchObject({ text: '{"plan":"historical"}' })
  await files.saveTextEdit({
    projectId: child.projectId,
    source: 'artifact',
    fileId: clonedFileId,
    basedOnVersionId: clonedVersionId,
    expectedHeadVersionId: clonedVersionId,
    content: 'Fork notes',
    operationId: 'fork-edit'
  })
  expect(
    await files.inspect({ projectId: child.projectId, source: 'artifact', fileId: clonedFileId })
  ).toMatchObject({ text: 'Fork notes' })
  expect(
    await files.inspect({ projectId: source.projectId, source: 'artifact', fileId: note.fileId })
  ).toMatchObject({ text: 'Original notes' })
  expect(
    await files.inspect({
      projectId: child.projectId,
      source: 'artifact',
      fileId: clonedFileId,
      versionId: clonedVersionId
    })
  ).toMatchObject({ text: 'Original notes' })
  const refork = await service.fork(child)
  expect((await bookmarks.list(refork)).items).toHaveLength(1)
  await service.close()
})

it.each(['ask', 'auto', 'full'] as const)(
  'uses the current global permission profile for local and imported forks (%s)',
  async (profile) => {
    const { fixture, repository, service } = await setup()
    const path = join(fixture.storageRoot, 'permissions.science')
    await service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, path)
    const imported = await service.importFrom(path, undefined, undefined, undefined, {
      projectId: 'project-1'
    })
    let currentProfile: 'ask' | 'auto' | 'full' = 'ask'
    const configured = new SessionPackageService({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client,
      getDefaultPermissionProfile: async () => currentProfile
    })
    currentProfile = profile
    for (const source of [{ projectId: 'project-1', sessionId: 'session-1' }, imported]) {
      const child = await configured.fork(source)
      expect(
        (await repository.loadSession(child.projectId, child.sessionId))?.permissionProfile
      ).toBe(profile)
      expect(
        (await repository.loadSession(source.projectId, source.sessionId))?.permissionProfile
      ).toBe('ask')
    }
  }
)

it('reforks Notebook files without copying the previous publication ownership marker', async () => {
  const { fixture, service } = await setup()
  const source = { projectId: 'project-1', sessionId: 'session-1' }
  const directory = join(fixture.storageRoot, 'notebooks', source.projectId, source.sessionId)
  await mkdir(join(directory, 'data'), { recursive: true })
  await writeFile(join(directory, 'data', 'research.txt'), 'Preserve research')
  const first = await service.fork(source)
  const second = await service.fork(first)
  for (const session of [first, second]) {
    const root = join(fixture.storageRoot, 'notebooks', session.projectId, session.sessionId)
    expect(await readFile(join(root, 'data', 'research.txt'), 'utf8')).toBe('Preserve research')
  }
  const marker = (session: typeof first): Promise<string> =>
    readFile(
      join(
        fixture.storageRoot,
        'notebooks',
        session.projectId,
        session.sessionId,
        '.session-package-owner'
      ),
      'utf8'
    )
  expect(await marker(second)).not.toBe(await marker(first))
  const archive = join(fixture.storageRoot, 'refork.science')
  await service.exportTo(second, archive)
  await expect(
    service.importFrom(archive, undefined, undefined, undefined, { projectId: source.projectId })
  ).resolves.toBeDefined()
})

it('numbers sibling forks and nests the direct source title', async () => {
  const { repository, service } = await setup()
  const source = { projectId: 'project-1', sessionId: 'session-1' }
  const first = await service.fork(source)
  const second = await service.fork(source)
  const nested = await service.fork(first)
  expect((await repository.loadSession(first.projectId, first.sessionId))?.title).toBe('Study(2)')
  expect((await repository.loadSession(second.projectId, second.sessionId))?.title).toBe('Study(3)')
  const child = await repository.loadSession(nested.projectId, nested.sessionId)
  expect(child?.title).toBe('Study(2)(2)')
  expect(child?.branchSource?.sessionId).toBe(first.sessionId)
})

it.each(['notebook-file-evidence', 'file-evidence'])(
  'preserves legacy Notebook evidence and generation bytes through fork and refork (%s)',
  async (scope) => {
    const { fixture, service } = await setup()
    const { createHash } = await import('node:crypto')
    const checksum = (text: string): string => createHash('sha256').update(text).digest('hex')
    const document = await fixture.notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: fixture.storageRoot,
      lane: createFrameNotebookLane('project-1', 'session-1', 'root-frame')
    })
    const key = `${scope}/project-1/session-1/run-old-run/evidence.json`
    const contentStorageKey = `${scope}/project-1/session-1/run-old-run/blobs/figure`
    const content = 'Historical figure bytes'
    await mkdir(
      join(fixture.storageRoot, scope, 'project-1', 'session-1', 'run-old-run', 'blobs'),
      { recursive: true }
    )
    await writeFile(join(fixture.storageRoot, contentStorageKey), content)
    const sidecar = JSON.stringify({
      schemaVersion: 1,
      evidenceId: 'notebook-file-evidence-old-run',
      runId: 'old-run',
      relations: [
        {
          generation: {
            generationId: 'generation',
            checksum: checksum(content),
            sizeBytes: Buffer.byteLength(content),
            contentStorageKey
          }
        }
      ]
    })
    await writeFile(join(fixture.storageRoot, key), sidecar)
    const summary = {
      schemaVersion: 1,
      evidenceId: 'notebook-file-evidence-old-run',
      state: 'partial',
      checksum: checksum(sidecar),
      storageKey: key,
      relationCount: 1,
      generationCount: 1,
      scientificOutputCount: 0,
      initialViewState: 'complete',
      managedRootsFinalState: 'partial',
      scientificOutputAnalysis: 'partial',
      fileReads: 'unavailable',
      externalPaths: 'unavailable',
      writerAttribution: 'unavailable',
      reasonCodes: ['file-reads-not-observed']
    }
    await writeFile(
      join(document.notebookSessionRoot, 'run.json'),
      JSON.stringify({
        ...document,
        runs: [
          {
            runId: 'old-run',
            cellId: 'cell',
            source: 'agent',
            script: 'draw()',
            status: 'completed',
            startedAt: 1,
            fileEvidence: summary
          }
        ]
      })
    )
    const first = await service.fork({ projectId: 'project-1', sessionId: 'session-1' })
    const second = await service.fork(first)
    for (const child of [first, second]) {
      const runs = await fixture.notebookRepository.readSessionRuns(
        child.projectId,
        child.sessionId
      )
      const run = runs[0]
      expect(run.runId).not.toBe('old-run')
      expect(run.fileEvidence?.activityId).toBe(run.runId)
      const evidenceBytes = await readFile(
        join(fixture.storageRoot, run.fileEvidence!.storageKey!),
        'utf8'
      )
      expect(checksum(evidenceBytes)).toBe(run.fileEvidence?.checksum)
      const evidence = JSON.parse(evidenceBytes)
      expect(evidence.activityId).toBe(run.runId)
      const generation = evidence.relations[0].generation
      expect(await readFile(join(fixture.storageRoot, generation.contentStorageKey), 'utf8')).toBe(
        content
      )
    }
    expect(
      JSON.parse(await readFile(join(document.notebookSessionRoot, 'run.json'), 'utf8')).runs[0]
        .runId
    ).toBe('old-run')
    await writeFile(join(fixture.storageRoot, key), sidecar + ' ')
    await expect(service.fork({ projectId: 'project-1', sessionId: 'session-1' })).rejects.toThrow(
      'Execution file evidence checksum mismatch.'
    )
  }
)

it.each(['agent-runtime:runtime:call', 'run\u0000delegate\u00001'])(
  'retains opaque runtime identities in a readable fork receipt (%s)',
  async (runtimeId) => {
    const { repository, service } = await setup()
    const source = (await repository.loadSession('project-1', 'session-1'))!
    const graph = source.conversationGraph!
    const segment = graph.runtimeSegments[0]
    const oldId = segment.id
    segment.id = runtimeId
    for (const message of graph.messages) {
      if (message.runtimeSegmentId === oldId) message.runtimeSegmentId = segment.id
    }
    await repository.saveSession(source)
    const child = await service.fork({ projectId: source.projectId, sessionId: source.id })
    await expect(service.fork(child)).resolves.toMatchObject({ projectId: source.projectId })
  }
)

it('persists distinct bounded titles for queued forks of a long Unicode title', async () => {
  const { fixture, repository, service } = await setup()
  const source = (await repository.loadSession('project-1', 'session-1'))!
  const title = '文'.repeat(76) + '👩‍🔬 research'
  await repository.saveSession({ ...source, title })
  const request = { projectId: source.projectId, sessionId: source.id }
  const children = await Promise.all([service.fork(request), service.fork(request)])
  const reader = new SessionRepository(fixture.storageRoot)
  const titles = await Promise.all(
    children.map(
      async (child) => (await reader.loadSession(child.projectId, child.sessionId))?.title
    )
  )
  expect(titles).toEqual(['文'.repeat(76) + '(2)', '文'.repeat(76) + '(3)'])
  expect((await repository.loadSession(source.projectId, source.id))?.title).toBe(title)
})
