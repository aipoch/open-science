import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import type { createAcpRuntime } from '../acp/runtime-composition'
import type { ApplicationEventPublisher } from '../application-events'
import type { ApplicationModuleBuilder } from '../application-runtime'
import {
  ManagedExecutionExternalError,
  createManagedExecutionExternalPort,
  type ManagedExecutionExternalPort
} from '../managed-execution-external-port'
import { createNotebookArtifactSourceScopeProvider } from '../notebook/artifact-source-scope'
import { ManagedExecutionService } from '../notebook/managed-execution-service'
import {
  createManagedExecutionTurnPort,
  type ManagedExecutionPort
} from '../notebook/managed-execution-port'
import { ManagedResearchEnvironmentOwner } from '../notebook/managed-research-environment'
import { createManagedResearchNodeRuntimeRegistry } from '../notebook/managed-research-node-runtime'
import {
  createResearchMaterialAuthority,
  resolvePreparedResearchMaterialInput
} from '../notebook/research-material-authority'
import { SessionOperationOwner } from '../notebook/session-operation-owner'
import { createManagedSessionWorkflow } from '../session-persistence/create-managed-session'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { augmentedPathEnv } from '../settings/shell-path'
import { resolveDataRoot, resolveConfigRoot } from '../storage-root'
import { ResearchExecutionProfileStore } from '../research-execution-profiles/store'
import { withDataRootWrite } from '../storage/migration-state'
import { assertResearchSessionWritable } from '../storage/session-package-state'
import type { composeManagedFiles } from './managed-files'
import type { composeNotebookRuntime } from './notebook-runtime'
import type { composeProjectLifecycle } from './project-lifecycle'
import type { composeSessionAuthority } from './session-authority'
import type { composeSessionPackages } from './session-packages'

export type ManagedExecutionComposition = {
  service: ManagedExecutionService
  external: ManagedExecutionExternalPort
  internal: ManagedExecutionPort
  environments: ManagedResearchEnvironmentOwner
  operations: SessionOperationOwner
  runtimeSessions: RuntimeSessionOwner
  notebookLifecycle: Awaited<ReturnType<typeof composeNotebookRuntime>>['notebookLifecycle']
  getActiveSessions(): { projectId: string; sessionId: string }[]
  hold(): void
  resume(): void
  quiesce(): Promise<void>
  close(): Promise<void>
  recover(): Promise<void>
  reconcilePublishedOutputs(scope?: { projectId: string; sessionId: string }): Promise<void>
  stopSession(projectId: string, sessionId: string): Promise<void>
  stopProject(projectId: string): Promise<void>
}

export async function composeManagedExecution({
  applicationEvents,
  managedFiles,
  sessionAuthority,
  sessionPackages,
  projectLifecycle,
  notebookRuntime,
  runtimeRef,
  modules
}: {
  applicationEvents: ApplicationEventPublisher
  managedFiles: ReturnType<typeof composeManagedFiles>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  sessionPackages: Awaited<ReturnType<typeof composeSessionPackages>>
  projectLifecycle: ReturnType<typeof composeProjectLifecycle>
  notebookRuntime: Awaited<ReturnType<typeof composeNotebookRuntime>>
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  modules: ApplicationModuleBuilder
}): Promise<ManagedExecutionComposition> {
  const dataRoot = await realpath(resolveDataRoot()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return resolveDataRoot()
    throw error
  })
  let held = false
  let closed = false
  let resumePending = false
  type SessionScope = { projectId: string; sessionId: string }
  const activeSessions = new Map<string, SessionScope>()
  const admittedWrites = new Map<Promise<unknown>, SessionScope>()
  const stoppingSessions = new Map<string, Promise<void>>()
  const stoppingProjects = new Map<string, Promise<void>>()
  const activeWrites = new Set<Promise<unknown>>()
  const assertOpen = (scope?: SessionScope): void => {
    if (
      held ||
      closed ||
      (scope && (stoppingSessions.has(scope.sessionId) || stoppingProjects.has(scope.projectId)))
    )
      throw new ManagedExecutionExternalError(
        'unavailable',
        'Prepared execution is paused during application handoff.'
      )
  }
  const trackAdmitted = async <T>(operation: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(operation)
    activeWrites.add(work)
    try {
      return await work
    } finally {
      activeWrites.delete(work)
    }
  }
  const track = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertOpen()
    return trackAdmitted(operation)
  }
  const sessions = sessionAuthority.sessionPersistenceCoordinator
  const archive = projectLifecycle.archiveCoordinator
  const notebook = notebookRuntime.notebookService
  const baseNotebookLifecycle = notebookRuntime.notebookLifecycle
  const runtimeSessions = new RuntimeSessionOwner({
    loadSession: ({ projectId, sessionId }) =>
      sessions.loadSessionForContinuation(projectId, sessionId, { preserveRuntimeState: true }),
    mutateSession: (scope, mutate) => sessions.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: (request) => {
      const handlers = sessionAuthority.artifactHandlersRef.current
      if (!handlers) throw new Error('Artifact finalization is not initialized.')
      return handlers.finalizeRunArtifacts(request)
    },
    onTerminalCommitExhausted: (_scope, event, retry, waitForWriteRelease) =>
      sessions.recordRuntimeTerminalFailure(event, retry, waitForWriteRelease)
  })
  const artifactTurns = new ArtifactTurnOwner({
    dataRoot,
    repository: managedFiles.artifactRepository,
    runRegistry: managedFiles.artifactRunRegistry,
    provenance: managedFiles.artifactProvenanceRepository,
    notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot)
  })
  // Finder/Explorer launch environments omit common independent Node locations. Reuse Main's
  // host discovery PATH, but do not pass the rest of its environment into runtime probes.
  const runtimes = createManagedResearchNodeRuntimeRegistry({ path: augmentedPathEnv().PATH })
  const environments = new ManagedResearchEnvironmentOwner({
    dataRoot,
    socketRoot: await realpath(process.platform === 'darwin' ? '/private/tmp' : tmpdir()),
    verifyRuntime: (runtime) => runtimes.verify(runtime),
    stopExecution: async (scope) => ({
      verified: (await notebook.confirmManagedShellCleanup(scope, { retry: true })).reaped
    })
  })
  const operations = new SessionOperationOwner({
    dataRoot,
    sessions: {
      read: ({ projectId, sessionId }) =>
        sessions.readSessionSnapshot(projectId, sessionId, { preserveRuntimeState: true }),
      mutate: (scope, mutate) => sessions.mutateRuntimeSession(scope, mutate)
    },
    runtimeSessions,
    artifactTurns,
    artifacts: managedFiles.artifactProvenanceRepository,
    notebooks: managedFiles.notebookRepository,
    reserveSession: async (scope, onCancel) => {
      assertOpen(scope)
      // Take the short archive gate first. Deletion may hold that gate while cancelling all
      // admitted work, so a root reservation must never wait for it while appearing active.
      return archive.withSessionAvailable(scope.projectId, scope.sessionId, async () => {
        assertOpen(scope)
        const runtime = runtimeRef.current
        if (!runtime) throw new Error('Session admission is not initialized.')
        const releaseRoot = await runtime.reserveSessionOperation(
          scope,
          onCancel ?? (() => undefined)
        )
        try {
          assertOpen(scope)
          const releaseWork = archive.admitSessionWork(scope.projectId, scope.sessionId, true)
          activeSessions.set(scope.sessionId, {
            projectId: scope.projectId,
            sessionId: scope.sessionId
          })
          return () => {
            activeSessions.delete(scope.sessionId)
            releaseWork()
            releaseRoot()
          }
        } catch (error) {
          releaseRoot()
          throw error
        }
      })
    },
    recoverNotebookOperations: async () => {
      await notebook.recoverInterruptedOperations()
      await environments.recover()
    },
    retryArtifactFinalization: (request) => sessions.retryArtifactFinalization(request)
  })
  const creator = createManagedSessionWorkflow({
    dataRoot,
    sessions,
    withProjectAvailable: (projectId, operation) =>
      archive.withProjectAvailable(projectId, operation)
  })
  const service: ManagedExecutionService = new ManagedExecutionService({
    profiles: new ResearchExecutionProfileStore(resolveConfigRoot()),
    artifacts: managedFiles.artifactProvenanceRepository,
    dataRoot,
    notebooks: managedFiles.notebookRepository,
    environments,
    operations,
    runtime: notebook,
    runtimes,
    materials: (request) =>
      createResearchMaterialAuthority(
        {
          catalog: sessionAuthority.projectFilesRepository,
          inputAuthority: managedFiles.immutableInputAuthority,
          readSession: (projectId, sessionId) => sessions.readSessionSnapshot(projectId, sessionId),
          readOrigin: (request) => sessionPackages.sessionPackageService.readOrigin(request)
        },
        request
      ),
    resolvePreparedInputs: (receipt) =>
      Promise.all(
        (receipt.prepared?.inputs ?? []).map((input) =>
          resolvePreparedResearchMaterialInput(
            {
              catalog: sessionAuthority.projectFilesRepository,
              inputAuthority: managedFiles.immutableInputAuthority
            },
            {
              projectId: receipt.projectId,
              versionId: input.versionId,
              sha256: input.sha256,
              sizeBytes: input.sizeBytes
            }
          )
        )
      ),
    createSession: (request) =>
      track(async () => {
        const identity = await creator.create(request)
        const session = await sessions.readSessionSnapshot(identity.projectId, identity.sessionId, {
          preserveRuntimeState: true
        })
        if (session)
          applicationEvents.publish('session:created', {
            session,
            originClientId: 'main:managed-execution'
          })
        return identity
      }),
    withWritableSession: (scope, operation) =>
      track(() =>
        withDataRootWrite(async () => {
          const { completion } = await archive.withSessionAvailable(
            scope.projectId,
            scope.sessionId,
            async () => {
              assertOpen(scope)
              await assertResearchSessionWritable(dataRoot, scope.projectId, scope.sessionId)
              assertOpen(scope)
              const release = archive.admitSessionWork(scope.projectId, scope.sessionId)
              // Register only admitted work. Deletion must not await a waiter queued behind
              // its own archive gate; the long operation itself stays outside that gate.
              const completion = Promise.resolve().then(operation)
              admittedWrites.set(completion, {
                projectId: scope.projectId,
                sessionId: scope.sessionId
              })
              void completion.then(
                () => {
                  admittedWrites.delete(completion)
                  release()
                },
                () => {
                  admittedWrites.delete(completion)
                  release()
                }
              )
              return { completion }
            }
          )
          return completion
        })
      )
  })
  // Publication enrichment must drain before handoff, but cannot own a new execution or
  // hold a Session archive gate while waiting for reconciliation's own scoped admission.
  const reconcilePublishedOutputs = (scope?: SessionScope): Promise<void> =>
    track(() => withDataRootWrite(() => service.reconcilePublishedOutputs(scope)))
  const turnPort = createManagedExecutionTurnPort({
    dataRoot,
    service,
    artifacts: managedFiles.artifactProvenanceRepository,
    notebooks: managedFiles.notebookRepository,
    trackArtifactWrite: (sessionId, executionId, write) => {
      const runtime = runtimeRef.current
      if (!runtime) return Promise.reject(new Error('Agent runtime is not available.'))
      return runtime.trackManagedExecutionArtifactWrite(sessionId, executionId, write)
    }
  })
  const internal: ManagedExecutionPort = {
    call: async (method, payload, context) => {
      assertOpen(context)
      return turnPort.call(method, payload, context)
    }
  }
  const external = createManagedExecutionExternalPort({ service, assertOpen, withDataRootWrite })
  let draining: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    held = true
    resumePending = false
    draining ??= (async () => {
      const results = await Promise.allSettled([operations.quiesce(), environments.quiesce()])
      await Promise.allSettled([...activeWrites])
      // A material inspection admitted before the hold can finish preparing after the first
      // environment snapshot. Drain that final work before handing the data root away.
      results.push(...(await Promise.allSettled([environments.quiesce()])))
      const failures = results.filter((result) => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Managed execution cleanup failed.'
        )
    })().finally(() => {
      draining = undefined
      if (resumePending && !closed) held = false
      resumePending = false
    })
    return draining
  }
  const close = async (): Promise<void> => {
    closed = true
    await quiesce()
    await operations.close()
    await environments.close()
  }
  const getActiveSessions = (): SessionScope[] => [
    ...new Map(
      [...activeSessions.values(), ...admittedWrites.values()].map((scope) => [
        scope.sessionId,
        scope
      ])
    ).values()
  ]
  const stopScope = async (
    matches: (scope: SessionScope) => boolean,
    release: () => Promise<void>
  ): Promise<void> => {
    const results = await Promise.allSettled([
      ...[...activeSessions.values()]
        .filter(matches)
        .map((scope) => operations.cancelSession(scope)),
      release()
    ])
    await Promise.allSettled(
      [...admittedWrites].filter(([, scope]) => matches(scope)).map(([work]) => work)
    )
    results.push(...(await Promise.allSettled([release()])))
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Managed execution cleanup failed.'
      )
  }
  await modules.add(undefined, () => ({
    name: 'managed-research-execution',
    capability: undefined,
    dispose: close
  }))
  return {
    service,
    external,
    internal,
    environments,
    operations,
    runtimeSessions,
    notebookLifecycle: {
      getActiveNotebookSessions: () => [
        ...baseNotebookLifecycle.getActiveNotebookSessions(),
        ...getActiveSessions()
      ],
      dispose: async () => {
        await close()
        return baseNotebookLifecycle.dispose()
      },
      shutdownAll: async (options) => {
        await quiesce()
        return baseNotebookLifecycle.shutdownAll(options)
      }
    },
    close,
    quiesce,
    hold: () => {
      held = true
      resumePending = false
    },
    resume: () => {
      if (closed) return
      // A timed-out update can abort before teardown completes. Do not let its remaining
      // recovery pass cancel work admitted by the newly resumed application.
      if (draining) resumePending = true
      else held = false
    },
    getActiveSessions,
    reconcilePublishedOutputs,
    recover: async () => {
      await environments.recover()
      await operations.recover()
      await reconcilePublishedOutputs()
    },
    stopSession: (projectId, sessionId) => {
      let completion = stoppingSessions.get(sessionId)
      if (!completion) {
        completion = Promise.resolve()
          .then(async () => {
            return stopScope(
              (scope) => scope.projectId === projectId && scope.sessionId === sessionId,
              () => environments.releaseSession({ projectId, sessionId })
            )
          })
          .finally(() => {
            stoppingSessions.delete(sessionId)
          })
        stoppingSessions.set(sessionId, completion)
      }
      return completion
    },
    stopProject: (projectId) => {
      let completion = stoppingProjects.get(projectId)
      if (!completion) {
        completion = Promise.resolve()
          .then(async () => {
            return stopScope(
              (scope) => scope.projectId === projectId,
              () => environments.releaseProject(projectId)
            )
          })
          .finally(() => {
            stoppingProjects.delete(projectId)
          })
        stoppingProjects.set(projectId, completion)
      }
      return completion
    }
  }
}
