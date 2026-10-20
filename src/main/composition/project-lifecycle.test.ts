import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialRequestBroker } from '../connectors/credential-request-broker'
import type { SessionDeletionHandlers } from '../session-persistence/coordinator'

const mocks = vi.hoisted(() => ({
  relay: vi.fn(),
  mainRelay: vi.fn(),
  uploads: vi.fn(),
  deletion: vi.fn(),
  archive: vi.fn(),
  projects: vi.fn(),
  files: vi.fn(),
  readHidden: vi.fn(),
  versions: vi.fn(),
  broadcast: vi.fn(),
  visionDelete: vi.fn(),
  visionReconcile: vi.fn(),
  archiveOwner: {
    withProjectDeletion: vi.fn(async (_id, operation) => operation()),
    restoreProjectDeletion: vi.fn(),
    releaseProjectDeletion: vi.fn(),
    setMarkReadSessions: vi.fn(),
    isSessionAvailableById: vi.fn(() => true),
    updateProjectArchive: vi.fn()
  }
}))
vi.mock('../acp/side-chat-relay-owner', () => ({ SideChatRelayOwner: mocks.relay }))
vi.mock('../side-chat/main-prompt-relay', () => ({
  createMainPromptSideChatRelay: mocks.mainRelay
}))
vi.mock('../uploads/command-owner', () => ({ createUploadCommandOwner: mocks.uploads }))
vi.mock('../projects/deletion-coordinator', () => ({ ProjectDeletionCoordinator: mocks.deletion }))
vi.mock('../archive/coordinator', () => ({ ArchiveCoordinator: mocks.archive }))
vi.mock('../projects/ipc', () => ({ createProjectHandlers: mocks.projects }))
vi.mock('../project-files/ipc', () => ({
  createProjectFilesHandlers: mocks.files,
  readHiddenArtifactChunk: mocks.readHidden
}))
vi.mock('../managed-file-versions/ipc', () => ({
  createManagedFileVersionHandlers: mocks.versions,
  createManagedFileVersionCommandOwner: (handlers: unknown) => handlers
}))
vi.mock('../session-persistence/ipc', () => ({ createDefaultReviewRepository: () => ({}) }))
vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers: mocks.broadcast }))
vi.mock('../acp/vision-evidence-repository', () => ({
  VisionEvidenceRepository: class {
    deleteSessions = mocks.visionDelete
    reconcileSessions = mocks.visionReconcile
  }
}))
vi.mock('../desktop-surface-declarations', () => ({}))

import { composeProjectLifecycle } from './project-lifecycle'

const fixture = (() => {
  let handlers: SessionDeletionHandlers | undefined
  const runtime = {
    getSnapshot: vi.fn(() => ({ promptInFlightSessionIds: [] as string[] })),
    hasPendingSideChatInteraction: vi.fn(() => false),
    liveSessionProjectId: vi.fn(() => 'project-1'),
    steerSideChatAdvisory: vi.fn(async () => ({ injected: true })),
    getActivePromptSessions: vi.fn(() => []),
    requestProjectAgentContextReload: vi.fn()
  }
  const notebook = {
    beginProjectDeletion: vi.fn(),
    deleteProjectFileEvidence: vi.fn(),
    deleteProjectInputs: vi.fn(),
    releaseProjectDeletion: vi.fn()
  }
  const broker = new CredentialRequestBroker({
    generateId: () => 'credential-1',
    broadcast: vi.fn()
  })
  const dependencies = {
    applicationEvents: {},
    notificationInbox: {
      setSessionAvailability: vi.fn(),
      invalidateSessions: vi.fn(),
      markSessionsRead: vi.fn(),
      reconcileSessionCatalog: vi.fn()
    },
    uploadRepository: {},
    managedFileVersionService: {
      openLatest: vi.fn(),
      openVersion: vi.fn(),
      openHiddenArtifactVersion: vi.fn()
    },
    runtimeRef: { current: runtime as typeof runtime | undefined },
    backgroundResultDelivery: {
      prepareProjectDeletion: vi.fn(),
      commitProjectDeletion: vi.fn(),
      abortProjectDeletion: vi.fn()
    },
    sideChatOwnerRef: {
      current: {
        invalidateParents: vi.fn(),
        completeProjectDeletion: vi.fn(),
        restoreProject: vi.fn(),
        hasForParent: vi.fn(() => false)
      }
    },
    projectRepository: {},
    artifactProvenanceRepository: {},
    bookmarkRepository: { deleteSessions: vi.fn() },
    reviewerProjectRuntime: {
      restoreProjectDeletion: vi.fn(),
      releaseProjectDeletion: vi.fn(),
      isProjectBusy: vi.fn(() => false)
    },
    notebookActivityRef: { current: { getActiveNotebookSessions: vi.fn(() => []) } },
    configRoot: '/unused-test-root',
    permissionGrantRegistry: {},
    projectFilesRepository: {},
    computeJobActivityRef: {
      current: {
        countNonTerminalBySession: vi.fn(async () => 0),
        findNonTerminal: vi.fn(async () => [] as { project_id: string }[])
      }
    },
    projectRuntimeQuiescenceRef: { current: { quiesceProject: vi.fn() } },
    artifactReproducibilityAttemptOwnerRef: {
      current: { cancelProject: vi.fn(), cancelSession: vi.fn() }
    },
    computeJobDeletionPort: {
      restoreProjectJobDeletion: vi.fn(),
      abortProjectJobDeletion: vi.fn()
    },
    getActiveDelegatedSessions: vi.fn(() => []),
    getActiveSideChatSessions: vi.fn(() => [{ projectId: 'project-1', sessionId: 'session-1' }]),
    sessionPersistenceCoordinator: {
      commitSideChatRelays: vi.fn(),
      runSessionMutation: vi.fn(),
      setSessionDeletionHandlers: (next: SessionDeletionHandlers) => {
        handlers = next
      }
    },
    clearSessionCredentials: (sessionId: string) => broker.clearSession(sessionId),
    getNotebookService: () => notebook
  }
  const result = composeProjectLifecycle(
    dependencies as unknown as Parameters<typeof composeProjectLifecycle>[0]
  )
  return { dependencies, runtime, notebook, broker, handlers: handlers!, result }
}) satisfies () => unknown

beforeEach(() => {
  vi.clearAllMocks()
  mocks.relay.mockImplementation(function () {
    return {}
  })
  mocks.deletion.mockImplementation(function () {
    return {}
  })
  mocks.archive.mockImplementation(function () {
    return mocks.archiveOwner
  })
  mocks.visionDelete.mockResolvedValue(undefined)
})

describe('Project lifecycle composition', () => {
  it('clears credential state on the shared durable commit even if another projection fails', async () => {
    const { dependencies, broker, handlers, result } = fixture()
    const info = {
      credentialId: 'openalex' as const,
      connector: 'literature',
      method: 'openalex_search_works',
      sessionId: 'session-1'
    }
    const first = broker.request(info)
    broker.respond('credential-1', false)
    await first
    await handlers.reconcile(['session-1'], ['session-1'])
    await expect(broker.request(info)).resolves.toBe(false)
    expect(mocks.visionReconcile).toHaveBeenCalledWith(['session-1'])
    const clearHosts = vi.fn()
    result.sessionEnabledComputeHostsOwnerRef.current = { clear: clearHosts } as never
    mocks.visionDelete.mockRejectedValueOnce(new Error('projection unavailable'))
    await expect(handlers.commit(['session-1'])).rejects.toThrow('projection unavailable')
    const next = broker.request(info)
    expect(broker.hasPendingForSession('session-1')).toBe(true)
    expect(clearHosts).toHaveBeenCalledWith(['session-1'])
    expect(dependencies.sideChatOwnerRef.current.invalidateParents).toHaveBeenCalledWith([
      'session-1'
    ])
    expect(dependencies.bookmarkRepository.deleteSessions).toHaveBeenCalledWith(['session-1'])
    expect(dependencies.notificationInbox.invalidateSessions).toHaveBeenCalledWith(['session-1'])
    await handlers.commit(['session-1'])
    await expect(next).resolves.toBe(false)
    expect(broker.hasPendingForSession('session-1')).toBe(false)
  })

  it('connects project deletion preparation, commit and rollback to every runtime owner', async () => {
    const { dependencies: d, notebook } = fixture()
    const hooks = mocks.deletion.mock.calls[0][5]
    await hooks.beforeProjectDelete('project-1')
    expect(notebook.beginProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(d.artifactReproducibilityAttemptOwnerRef.current.cancelProject).toHaveBeenCalledWith(
      'project-1'
    )
    expect(d.projectRuntimeQuiescenceRef.current.quiesceProject).toHaveBeenCalledWith('project-1')
    await hooks.restoreProjectDeletion('project-1')
    expect(d.backgroundResultDelivery.prepareProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(d.computeJobDeletionPort.restoreProjectJobDeletion).toHaveBeenCalledWith('project-1')
    await hooks.finalizeProjectDeletion('project-1')
    expect(d.sideChatOwnerRef.current.completeProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(notebook.deleteProjectFileEvidence).toHaveBeenCalledWith('project-1')
    expect(notebook.deleteProjectInputs).toHaveBeenCalledWith('project-1')
    expect(d.backgroundResultDelivery.commitProjectDeletion).toHaveBeenCalledWith('project-1')
    hooks.completeProjectDeletion('project-1')
    expect(notebook.releaseProjectDeletion).toHaveBeenCalledWith('project-1')
    await hooks.abortProjectDeletion('project-1')
    expect(d.sideChatOwnerRef.current.restoreProject).toHaveBeenCalledWith('project-1')
    expect(d.backgroundResultDelivery.abortProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(d.computeJobDeletionPort.abortProjectJobDeletion).toHaveBeenCalledWith('project-1')
  })

  it('keeps archive and export activity checks distinct and cancels work through its owner', async () => {
    const { dependencies: d, result, runtime } = fixture()
    const activity = mocks.archive.mock.calls[0][2]
    expect(result.detectSessionExportBlockingSessions()).toEqual([])
    await expect(activity.isSessionBusy('project-1', 'session-1')).resolves.toBe(true)
    await expect(activity.isSessionExportBusy('project-1', 'session-1')).resolves.toBe(false)
    await expect(activity.isProjectBusy('project-1')).resolves.toBe(true)
    d.getActiveSideChatSessions.mockReturnValue([])
    d.computeJobActivityRef.current.findNonTerminal.mockResolvedValue([{ project_id: 'project-1' }])
    await expect(activity.isProjectBusy('project-1')).resolves.toBe(true)
    d.computeJobActivityRef.current.findNonTerminal.mockResolvedValue([])
    await expect(activity.isProjectBusy('project-1')).resolves.toBe(false)
    expect(activity.liveSessionProjectId('session-1')).toBe('project-1')
    expect(runtime.liveSessionProjectId).toHaveBeenCalledWith('session-1')
    const cancellation = mocks.archive.mock.calls[0][3]
    await cancellation.cancelProject('project-1')
    await cancellation.cancelSession('project-1', 'session-1')
    expect(d.artifactReproducibilityAttemptOwnerRef.current.cancelSession).toHaveBeenCalledWith(
      'project-1',
      'session-1'
    )
    const availability = d.notificationInbox.setSessionAvailability.mock.calls[0][0]
    expect(availability('session-1')).toBe(true)
    mocks.archiveOwner.setMarkReadSessions.mock.calls[0][0](['session-1'])
    expect(d.notificationInbox.markSessionsRead).toHaveBeenCalledWith(['session-1'])
  })

  it('routes relays and file commands to the active owners with their original identities', async () => {
    const { dependencies: d, runtime } = fixture()
    const targetState = mocks.relay.mock.calls[0][0].targetState
    expect(targetState('session-1')).toBe('idle')
    runtime.getSnapshot.mockReturnValue({ promptInFlightSessionIds: ['session-1'] })
    expect(targetState('session-1')).toBe('running')
    runtime.hasPendingSideChatInteraction.mockReturnValue(true)
    expect(targetState('session-1')).toBe('waiting')
    const relay = mocks.mainRelay.mock.calls[0][0]
    const request = { sessionId: 'session-1' }
    await expect(relay.steerAdvisory(request)).resolves.toEqual({ injected: true })
    expect(runtime.steerSideChatAdvisory).toHaveBeenCalledWith(request)
    relay.commitSideChatRelays(request)
    expect(d.sessionPersistenceCoordinator.commitSideChatRelays).toHaveBeenCalledWith(request)
    relay.onDelivered(request)
    expect(mocks.broadcast).toHaveBeenCalledWith('side-chat:relay-delivered', request)
    d.runtimeRef.current = undefined
    expect(targetState('session-1')).toBe('completed')
    await expect(relay.steerAdvisory(request)).resolves.toEqual({ injected: false })

    const uploads = mocks.uploads.mock.calls[0][1]
    const file = { projectId: 'project-1', fileId: 'file-1', versionId: 'version-1' }
    uploads.openLatestManagedFile(file)
    uploads.openManagedFileVersion(file)
    expect(d.managedFileVersionService.openLatest).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'file-1'
    })
    expect(d.managedFileVersionService.openVersion).toHaveBeenCalledWith(
      { source: 'upload', projectId: 'project-1', fileId: 'file-1' },
      'version-1'
    )
    const mutation = vi.fn()
    uploads.withSessionMutation('project-1', 'session-1', mutation)
    expect(d.sessionPersistenceCoordinator.runSessionMutation).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      mutation
    )
    mocks.files.mock.calls[0][4]({
      source: 'artifact',
      sourceFileId: 'file-2',
      sourceVersionId: 'version-2',
      projectId: 'project-1'
    })
    expect(d.managedFileVersionService.openVersion).toHaveBeenCalledWith(
      { source: 'artifact', fileId: 'file-2', projectId: 'project-1' },
      'version-2'
    )
    const visibility = mocks.files.mock.calls[0][3]
    visibility.onChanged(file)
    expect(mocks.broadcast).toHaveBeenCalledWith('project-files:changed', file)
    visibility.readHiddenArtifact(file)
    expect(mocks.readHidden).toHaveBeenCalledWith(file, expect.any(Function))
    mocks.readHidden.mock.calls[0][1](file)
    expect(d.managedFileVersionService.openHiddenArtifactVersion).toHaveBeenCalledWith(
      file,
      'version-1'
    )
    mocks.versions.mock.calls[0][1].onChanged(file)
    expect(mocks.broadcast).toHaveBeenCalledWith('project-files:changed', file)
    const projects = mocks.projects.mock.calls[0][2]
    projects.updateArchive(request)
    expect(mocks.archiveOwner.updateProjectArchive).toHaveBeenCalledWith(request)
    d.runtimeRef.current = runtime
    projects.onAgentContextChanged('project-1')
    expect(runtime.requestProjectAgentContextReload).toHaveBeenCalledWith('project-1')
  })
})
