import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { createArtifactHandlers } from '../artifacts/ipc'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { ArtifactRepository } from '../artifacts/repository'
import { NotebookRunRepository } from './repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPersistenceReconciliationOwner } from '../session-persistence/reconciliation-owner'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { initDataRoot } from '../storage-root'
import { createNotebookArtifactSourceScopeProvider } from './artifact-source-scope'
import { NotebookRuntimeService } from './runtime-service'
import { SessionOperationOwner, type SessionOperationDependencies } from './session-operation-owner'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'

export const operationTestScope = {
  projectId: 'project-1',
  sessionId: 'session-1',
  requestId: 'request-1'
}
const scope = operationTestScope

export type SessionOperationTestHarness = {
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  sessions: SessionRepository
  read: SessionOperationDependencies['sessions']['read']
  mutate: SessionOperationDependencies['sessions']['mutate']
  artifacts: ArtifactProvenanceRepository
  artifactTurns: ArtifactTurnOwner
  runtimeSessions: RuntimeSessionOwner
  dependencies: SessionOperationDependencies
  owner: SessionOperationOwner
  notebook: NotebookRuntimeService
  kernelExecute: () => never
  snapshots: ProvenanceMessageSnapshotRepository
  reserve: SessionOperationDependencies['reserveSession']
  recoverNotebookOperations: SessionOperationDependencies['recoverNotebookOperations']
  retryArtifactFinalization: SessionOperationDependencies['retryArtifactFinalization']
  restartedOwner(): SessionOperationOwner
}

export async function createSessionOperationTestHarness(
  cleanups: (() => Promise<unknown>)[],
  options: {
    canonicalStorageRoot?: boolean
    nativeSandbox?: boolean
    approvedNetworkHosts?: string[]
  } = {}
): Promise<SessionOperationTestHarness> {
  const fixture = await createProvenanceTestFixture()
  if (options.canonicalStorageRoot) {
    fixture.storageRoot = await realpath(fixture.storageRoot)
    fixture.compatibilityRepository = new ArtifactRepository(fixture.storageRoot)
    fixture.notebookRepository = new NotebookRunRepository(fixture.storageRoot)
    fixture.repositoryOptions = {
      ...fixture.repositoryOptions,
      storageRoot: fixture.storageRoot,
      compatibilityRepository: fixture.compatibilityRepository,
      notebookRepository: fixture.notebookRepository
    }
    fixture.repository = new ArtifactProvenanceRepository(fixture.repositoryOptions)
  }
  cleanups.push(fixture.dispose)
  initDataRoot(fixture.storageRoot)
  await fixture.client.project.create({ data: { id: scope.projectId, name: 'Real operation' } })
  const workspace = join(fixture.storageRoot, 'workspace')
  await mkdir(workspace)
  const sessions = new SessionRepository(fixture.storageRoot)
  await sessions.saveSession({
    id: scope.sessionId,
    projectId: scope.projectId,
    title: 'External controller',
    cwd: workspace,
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  const read: SessionOperationDependencies['sessions']['read'] = async ({
    projectId,
    sessionId
  }) => {
    const loaded = await sessions.loadSessionWithDiagnostics(projectId, sessionId, {
      preserveRuntimeState: true
    })
    if (loaded.status === 'unreadable') throw new Error('Fixture Session is unreadable')
    return loaded.status === 'found' ? loaded.session : undefined
  }
  let tail: Promise<unknown> = Promise.resolve()
  const mutate: SessionOperationDependencies['sessions']['mutate'] = (identity, change) => {
    const mutation = tail.then(async () => {
      const session = await read(identity)
      if (!session) throw new Error('Session missing')
      return sessions.saveSession(change(session), session.revision)
    })
    tail = mutation.catch(() => undefined)
    return mutation
  }
  const artifacts = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: (projectId, sessionId) => read({ projectId, sessionId })
  })
  const registry = new ArtifactRunRegistry()
  const handlers = createArtifactHandlers(fixture.compatibilityRepository, registry, {
    provenance: artifacts
  })
  const runtimeSessions = new RuntimeSessionOwner({
    loadSession: read,
    mutateSession: mutate,
    finalizeArtifacts: handlers.finalizeRunArtifacts
  })
  const artifactTurns = new ArtifactTurnOwner({
    dataRoot: fixture.storageRoot,
    repository: fixture.compatibilityRepository,
    runRegistry: registry,
    provenance: artifacts,
    notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(fixture.storageRoot)
  })
  const kernelExecute = vi.fn(() => {
    throw new Error('No kernel or model should be invoked by the Shell fixture')
  })
  const sandbox = options.nativeSandbox
    ? new NotebookNetworkSandboxOwner({
        resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
        temporaryRoot: join(fixture.storageRoot, 'commands'),
        getSettings: async () => ({
          ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
          allowedDomains:
            options.approvedNetworkHosts ?? DEFAULT_NOTEBOOK_NETWORK_SETTINGS.allowedDomains
        }),
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny'
      })
    : undefined
  if (sandbox) cleanups.push(() => sandbox.dispose())
  const notebook = new NotebookRuntimeService({
    configRoot: fixture.storageRoot,
    dataRoot: fixture.storageRoot,
    projectId: scope.projectId,
    repository: fixture.notebookRepository,
    ...(options.nativeSandbox ? {} : { shellExecutionMode: 'bounded' as const }),
    executorFactory: () => ({ execute: kernelExecute, shutdown: async () => ({ reaped: true }) }),
    // This fixture verifies real process execution and provenance, not OS policy containment.
    processSandbox: sandbox ?? {
      wrap: async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        annotateStderr: (text) => text,
        cleanup: async () => ({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      })
    }
  })
  cleanups.push(async () => {
    expect(await notebook.dispose()).toMatchObject({ reaped: true })
  })
  const reserve = vi.fn(async () => vi.fn())
  const recoverNotebookOperations = vi.fn(async () => {
    await notebook.recoverInterruptedOperations()
  })
  const reconciliation = new SessionPersistenceReconciliationOwner({
    repository: sessions,
    artifactStorage: artifacts,
    fileIndex: { syncSession: async () => [], reconcileActiveSessions: async () => undefined }
  })
  const retryArtifactFinalization = vi.fn(
    async (request: import('../../shared/artifacts').ReconcilePendingArtifactsRequest) => {
      const session = await read(request)
      if (!session) throw new Error('Session missing')
      return reconciliation.retryArtifactFinalization(session, request)
    }
  )
  const dependencies: SessionOperationDependencies = {
    dataRoot: fixture.storageRoot,
    sessions: { read, mutate },
    runtimeSessions,
    artifactTurns,
    artifacts,
    notebooks: fixture.notebookRepository,
    reserveSession: reserve,
    recoverNotebookOperations,
    retryArtifactFinalization
  }
  const owner = new SessionOperationOwner(dependencies)
  cleanups.push(() => owner.close())
  const snapshots = new ProvenanceMessageSnapshotRepository({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  return {
    fixture,
    sessions,
    read,
    mutate,
    artifacts,
    artifactTurns,
    runtimeSessions,
    dependencies,
    owner,
    notebook,
    kernelExecute,
    snapshots,
    reserve,
    recoverNotebookOperations,
    retryArtifactFinalization,
    restartedOwner: () =>
      new SessionOperationOwner({
        ...dependencies,
        runtimeSessions: new RuntimeSessionOwner({
          loadSession: read,
          mutateSession: mutate,
          finalizeArtifacts: handlers.finalizeRunArtifacts
        })
      })
  }
}
