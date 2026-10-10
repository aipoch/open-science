import {
  createObservationAssociationReader,
  importedObservationIdentity
} from '../research-replay/observation-association'
import type { ReplayReaderApi } from '../../renderer/src/lib/replay/source'
import type {
  ReadObservationBindingsRequest,
  ReadObservationBindingsResult
} from '../../shared/research-replay-observations'
import { ResearchReplayService } from '../research-replay/service'
import { ResearchReplayHttpHost } from '../research-replay/http-host'
import { createResearchReplayExternalPort } from '../research-replay/external-port'
import { realpath } from 'node:fs/promises'
import {
  createResearchRunInspectionPort,
  type ResearchRunInspectionPort
} from '../research-runs/inspection'
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
import { ResearchDemoOwner } from '../research-demos/owner'
import { ResearchExecutionProfileStore } from '../research-execution-profiles/store'
import { withDataRootWrite } from '../storage/migration-state'
import { assertResearchSessionWritable } from '../storage/session-package-state'
import { ManagedRuntimeViews } from '../managed-runtime-views'
import { createManagedRunObservationReader } from '../managed-run-observation'
import { RunObservationOwner } from '../run-observation/owner'
import { ObservationViewers } from '../run-observation/viewers'
import { RunObservationRecorder } from '../run-observation/recorder'
import { ManagedRunObservationCoordinator } from '../run-observation/managed-coordinator'
import { createManagedObservationPort } from '../run-observation/managed-port'
import { createManagedRecordingStatusReader } from '../run-observation/managed-status'
import { createRecordedObservationReader } from '../run-observation/recorded-reader'
import {
  ObservationMediaCollector,
  ObservationMediaCaptureError
} from '../run-observation/media-collector'
import { createLogger } from '../logger'
import { readObservationProjectExport } from '../run-observation/project-export-reader'
import { startManagedProjectRecording } from '../project-recordings/managed-adapter'
import { createDesktopObservationBridge } from '../observation-desktop/bridge'
import type { ObservationNativeInvoke } from '../observation-desktop/contract'
import { RuntimeViewOwner } from '../runtime-view/owner'
import { ReplayViewerHttpHost } from '../replay-viewer/http-host'
import { createReplayViewerAssetReader } from '../replay-viewer/assets'
import { createRunObservationExternalPort } from '../run-observation-external-port'
import { BrowserRecordingOwner } from '../browser-recordings/owner'
import { createBrowserRecordingExternalPort } from '../browser-recordings/external-port'
import type { composeManagedFiles } from './managed-files'
import type { composeNotebookRuntime } from './notebook-runtime'
import type { composeProjectLifecycle } from './project-lifecycle'
import type { composeSessionAuthority } from './session-authority'
import type { composeSessionPackages } from './session-packages'

export type ManagedExecutionComposition = {
  service: ManagedExecutionService
  researchRuns: ResearchRunInspectionPort
  readObservationBindings(
    request: ReadObservationBindingsRequest
  ): Promise<ReadObservationBindingsResult>
  researchDemos: ResearchDemoOwner
  external: ManagedExecutionExternalPort
  internal: ManagedExecutionPort
  environments: ManagedResearchEnvironmentOwner
  operations: SessionOperationOwner
  runtimeSessions: RuntimeSessionOwner
  observationViewers: ObservationViewers
  projectViews: ManagedRuntimeViews
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
  desktopLocale,
  invokeObservationNative,
  modules
}: {
  applicationEvents: ApplicationEventPublisher
  managedFiles: ReturnType<typeof composeManagedFiles>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  sessionPackages: Awaited<ReturnType<typeof composeSessionPackages>>
  projectLifecycle: ReturnType<typeof composeProjectLifecycle>
  notebookRuntime: Awaited<ReturnType<typeof composeNotebookRuntime>>
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  desktopLocale?: () => import('../../shared/locale').Locale
  invokeObservationNative?: ObservationNativeInvoke
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
  const observationDesktop = createDesktopObservationBridge(
    invokeObservationNative ??
      (async () => {
        throw new Error('Desktop observation is unavailable.')
      })
  )
  const projectViews = new ManagedRuntimeViews(new RuntimeViewOwner({}, observationDesktop.frames))
  const observationMedia = new ObservationMediaCollector()
  const browserRecordings = new BrowserRecordingOwner({
    dataRoot,
    startDriver: observationDesktop.startDriver
  })
  const observationCoordinator = new ManagedRunObservationCoordinator({
    dataRoot,
    artifacts: managedFiles.artifactProvenanceRepository,
    recorder: () => observationRecorder
  })
  const observationAdapter = createManagedObservationPort(observationCoordinator)
  const service: ManagedExecutionService = new ManagedExecutionService({
    profiles: new ResearchExecutionProfileStore(resolveConfigRoot()),
    artifacts: managedFiles.artifactProvenanceRepository,
    dataRoot,
    notebooks: managedFiles.notebookRepository,
    environments,
    operations,
    runtime: notebook,
    registerProjectService: (registration) => projectViews.register(registration),
    registerBrowserRecording: (input) =>
      browserRecordings.register({
        target: input.target,
        signal: input.signal,
        save: input.saveAuxiliaryOutput,
        assertCurrent: () => {
          input.signal.throwIfAborted()
          assertOpen(input.target)
        }
      }),
    registerProjectRecording: (input) =>
      startManagedProjectRecording(input, () => {
        input.signal.throwIfAborted()
        assertOpen(input.target)
      }),
    registerObservationMedia: (input) => {
      const recording = observationAdapter.resolveRecording(input.recording)
      const outputs = input.outputs.filter((output) => /\.(png|jpe?g|webp)$/i.test(output.filename))
      const assertCurrent = (): void => {
        input.signal.throwIfAborted()
        if (closed) throw new Error('Observation capture is closed.')
      }
      return observationMedia.register({
        target: input.target,
        generationId: input.generationId,
        recording,
        signal: input.signal,
        assertCurrent,
        projectExports: outputs.map((output) => output.filename),
        readProjectExport: async (key, signal) => {
          const matches = outputs.filter((output) => output.filename === key)
          if (matches.length !== 1) throw new Error('The declared project export is unavailable.')
          return readObservationProjectExport({
            authority: input.outputAuthority,
            scope: input.target,
            path: matches[0].path,
            signal
          })
        },
        sampleCurrent: async (signal) => {
          signal.throwIfAborted()
          assertCurrent()
          await recording.sample()
          const current = await observationRecorder.load(recording.target)
          signal.throwIfAborted()
          assertCurrent()
          const sample = current?.history.snapshots.at(-1)
          if (
            !sample ||
            current?.status !== 'recording' ||
            sample.run?.runId !== input.target.runId ||
            sample.run.status !== 'running'
          )
            throw new Error('The current recorded Run is unavailable.')
          return sample
        },
        saveAuxiliaryOutput: input.saveAuxiliaryOutput
      })
    },
    observation: observationAdapter.port,
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
  // This observer is Main-owned and independent of viewer grants/LRU. It is admitted by the
  // existing execution turn, so never reacquire an archive gate while that turn is draining.
  const authorizeRecording = async (target: {
    projectId: string
    sessionId: string
  }): Promise<void> => {
    if (closed || !(await sessions.readSessionSnapshot(target.projectId, target.sessionId)))
      throw new Error('The recorded Session is unavailable.')
  }
  const recordingObserver: RunObservationOwner = new RunObservationOwner({
    authorize: authorizeRecording,
    read: createManagedRunObservationReader(service)
  })
  const observationRecorder: RunObservationRecorder = new RunObservationRecorder({
    dataRoot,
    authorize: authorizeRecording,
    read: async (target, signal) => {
      signal.throwIfAborted()
      const snapshot = await recordingObserver.snapshot(target, {
        viewerId: 'main-recording-' + target.executionInvocationId
      })
      signal.throwIfAborted()
      return snapshot
    },
    isPublished: async (target, reference) => {
      const versions = await managedFiles.artifactProvenanceRepository.resolveVersionDescriptors({
        projectId: target.projectId,
        appSessionId: target.sessionId,
        versionIds: [reference.versionId]
      })
      return versions.some(
        (version) =>
          version.projectId === target.projectId &&
          version.sessionId === target.sessionId &&
          version.versionId === reference.versionId &&
          (!reference.artifactId || version.artifactId === reference.artifactId) &&
          version.checksum === reference.checksum &&
          version.size === reference.sizeBytes &&
          version.state === 'finalized' &&
          version.isPublished === true
      )
    }
  })
  const recordingStatus = createManagedRecordingStatusReader({
    inspect: (target) => service.inspectExecution(target),
    coordinator: observationCoordinator,
    recorder: observationRecorder,
    artifacts: managedFiles.artifactProvenanceRepository
  })
  const observation: RunObservationOwner = new RunObservationOwner({
    authorize: (target, viewer) => observationViewers.assertViewer(target, viewer),
    read: createManagedRunObservationReader(service)
  })
  const authorizeObservationScope = async (scope: {
    projectId: string
    sessionId: string
  }): Promise<void> => {
    assertOpen(scope)
    // Observing an imported research Session is read-only. The execution admission gate rejects
    // packageOrigin by design, so keep the Project lifecycle fence and use the existing non-owning
    // Session read instead. Execute/material/write entry points retain their writable admission.
    await archive.withProjectAvailable(scope.projectId, async () => {
      const session = await sessions.readSessionSnapshot(scope.projectId, scope.sessionId, {
        preserveRuntimeState: true
      })
      if (
        !session ||
        session.id !== scope.sessionId ||
        session.projectId !== scope.projectId ||
        session.archivedAt !== undefined
      )
        throw new Error('The observed Session is unavailable.')
    })
    assertOpen(scope)
  }
  const recordedObservations = createRecordedObservationReader({
    immutableInputAuthority: managedFiles.immutableInputAuthority,
    projectFilesRepository: sessionAuthority.projectFilesRepository,
    artifactProvenanceRepository: managedFiles.artifactProvenanceRepository,
    authorizeScope: authorizeObservationScope,
    readSourceVersionMapping: async (target, archiveIdentity) => {
      const browserNative = await browserRecordings.readNativeSourceVersionMapping(
        target,
        archiveIdentity
      )
      if (browserNative) return browserNative
      // A working copy can contain both imported archives and new native recordings.
      const native = await observationCoordinator.readNativeSourceVersionMapping(
        target,
        archiveIdentity
      )
      if (native) return native
      const source = await sessions.readSessionSnapshot(target.projectId, target.sessionId)
      const receipt = source?.packageOrigin ?? source?.forkOrigin
      if (!receipt) return undefined
      return sessionPackages.sessionPackageService.readArtifactSourceVersionMapping(
        { projectId: target.projectId, sessionId: target.sessionId },
        {
          artifactId: target.artifactId,
          versionId: target.versionId,
          checksum: archiveIdentity.checksum,
          sizeBytes: archiveIdentity.sizeBytes
        }
      )
    }
  })
  const observationViewers: ObservationViewers = new ObservationViewers({
    observer: observation,
    authorizeScope: authorizeObservationScope,
    recorded: {
      authorizeScope: authorizeObservationScope,
      read: (target) => recordedObservations.read(target),
      readProject: (target) => recordedObservations.readProject(target),
      readBrowser: (target) => recordedObservations.readBrowser(target),
      selectBrowserMoment: (target, offsetMs) =>
        recordedObservations.selectBrowserMoment(target, offsetMs),
      selectFile: (target, mediaKey, format) => {
        if (format === 'web-recording') throw new Error('Select a recorded project moment instead.')
        return recordedObservations.selectFile({ target, mediaKey, format })
      }
    },
    onRevoked: (viewerId) => {
      viewerHost.closeViewer(viewerId)
      projectViews.closeViewer(viewerId)
    }
  })
  const mediaTarget = async (
    target: import('../../shared/run-observation').RunObservationTarget
  ): Promise<Required<import('../../shared/run-observation').RunObservationTarget>> => {
    const inspected = await service.inspectExecution(target)
    if (!inspected?.run || inspected.run.status !== 'running')
      throw new Error('The observed execution is not running.')
    return {
      projectId: inspected.identity.projectId,
      sessionId: inspected.identity.sessionId,
      operationId: inspected.identity.operationId,
      executionInvocationId: inspected.identity.executionInvocationId,
      runId: inspected.run.runId
    }
  }
  const viewerHost: ReplayViewerHttpHost = new ReplayViewerHttpHost({
    desktopLocale,
    desktopFrames: observationDesktop.frames,
    browserRecording: async (method, input) => {
      input.assertAuthorized()
      if (method === 'status') return browserRecordings.status(input.viewerId)
      if (method === 'pause' || method === 'resume' || method === 'stop')
        return browserRecordings.control(method, input.viewerId, input.request)
      const inspected = await service.inspectExecution(input.target)
      input.assertAuthorized()
      const exact = inspected
        ? {
            projectId: inspected.identity.projectId,
            sessionId: inspected.identity.sessionId,
            operationId: inspected.identity.operationId,
            executionInvocationId: inspected.identity.executionInvocationId,
            ...(inspected.run ? { runId: inspected.run.runId } : {})
          }
        : undefined
      if (method === 'inspect')
        return {
          supported: !!input.host && !!exact && browserRecordings.inspect(exact),
          ...(!input.host
            ? { reason: 'desktop-required' as const }
            : !exact || !browserRecordings.inspect(exact)
              ? { reason: 'source-unavailable' as const }
              : {}),
          active: browserRecordings.status(input.viewerId)
        }
      if (!input.host || !exact || inspected?.run?.status !== 'running')
        throw new Error('A running project page is required for recording.')
      return browserRecordings.start({
        target: exact,
        viewerId: input.viewerId,
        host: input.host,
        request: input.request,
        assertAuthorized: input.assertAuthorized
      })
    },
    listCaptures: async (target, signal) => {
      signal.throwIfAborted()
      try {
        return observationMedia.listFrames(await mediaTarget(target), {
          assertAuthorized: () => assertOpen(target),
          signal
        })
      } catch {
        return []
      }
    },
    readCapture: async (target, captureId, signal) => {
      const frame = observationMedia.readFrame(await mediaTarget(target), captureId, {
        assertAuthorized: () => assertOpen(target),
        signal
      })
      return frame ? { body: frame.bytes, mimeType: frame.mimeType } : undefined
    },
    captureOptions: async (target, hostViewAvailable) => {
      try {
        return observationMedia.options(await mediaTarget(target), {
          assertAuthorized: () => assertOpen(target),
          hostViewAvailable
        })
      } catch {
        return { hostView: false, projectExports: [] }
      }
    },
    capture: async ({ target, request, assertAuthorized, signal, host }) => {
      let stage: 'preflight' | 'collector' | 'host-capture' | 'collector-after-host' = 'preflight'
      try {
        const exact = await mediaTarget(target)
        signal.throwIfAborted()
        assertAuthorized()
        let created = false
        stage = 'collector'
        const result = await observationMedia.capture(exact, request, {
          assertAuthorized,
          signal,
          onCreated: () => {
            created = true
          },
          ...(host
            ? {
                captureHostView: async (captureSignal: AbortSignal) => {
                  stage = 'host-capture'
                  const image = await observationDesktop.capture({
                    ...host,
                    signal: captureSignal
                  })
                  stage = 'collector-after-host'
                  return image
                }
              }
            : {})
        })
        return { result, created }
      } catch (error) {
        // Main-only bounded classification: do not log project URLs, capture keys or arbitrary
        // thrown text. This also distinguishes decoding/sampling/writing from host geometry.
        try {
          createLogger('observation-capture').warn('Project image intake rejected', {
            stage,
            reason: error instanceof ObservationMediaCaptureError ? error.code : 'unavailable'
          })
        } catch {
          /* Logging never changes optional image-capture behavior. */
        }
        throw error
      }
    },
    recordingStatus: (target) => recordingStatus(target),
    viewers: observationViewers,
    projectViews,
    readAsset: createReplayViewerAssetReader(),
    readRecordingMedia: (target, mediaKey, signal, format) =>
      format === 'web-recording'
        ? recordedObservations.readBrowserMedia(target, mediaKey, signal)
        : format === 'project-recording'
          ? recordedObservations.readProjectMedia(target, mediaKey, signal)
          : recordedObservations.readMedia(target, mediaKey, signal),
    readArtifact: async ({ target, artifact, signal }) => {
      signal.throwIfAborted()
      if (
        !artifact.artifactId ||
        !artifact.checksum ||
        artifact.sizeBytes === undefined ||
        artifact.sizeBytes > 16 * 1024 * 1024
      )
        return undefined
      const input = await managedFiles.immutableInputAuthority.resolveVersion({
        projectId: target.projectId,
        sourceKind: 'artifact-version',
        inputFileVersionId: artifact.versionId,
        expectedSourceFileId: artifact.artifactId
      })
      if (
        !input ||
        input.sourceSessionId !== target.sessionId ||
        input.checksum !== artifact.checksum ||
        input.sizeBytes !== artifact.sizeBytes
      )
        return undefined
      const lease = await managedFiles.immutableInputAuthority.openContent(input)
      try {
        signal.throwIfAborted()
        const body = await lease.readRange(0, input.sizeBytes)
        await lease.verifyUnchanged()
        signal.throwIfAborted()
        return { body, mimeType: artifact.mimeType ?? 'application/octet-stream' }
      } finally {
        await lease.close()
      }
    },
    cancelRun: async ({ target, runId, caller, signal }) => {
      assertOpen(target)
      signal.throwIfAborted()
      if (!caller.isAuthorizationCurrent() || caller.location !== 'local')
        throw new Error('Current local authorization is required.')
      const inspected = await service.inspectExecution({ ...target, runId })
      signal.throwIfAborted()
      if (!inspected || inspected.run?.runId !== runId || !caller.isAuthorizationCurrent())
        throw new Error('The observed Run is unavailable.')
      await withDataRootWrite(() =>
        notebook.cancelManagedShellRun({
          projectId: target.projectId,
          sessionId: target.sessionId,
          executionInvocationId: inspected.identity.executionInvocationId,
          runId
        })
      )
    }
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
  const researchRuns = createResearchRunInspectionPort({
    materials: {
      catalog: sessionAuthority.projectFilesRepository,
      inputAuthority: managedFiles.immutableInputAuthority,
      readSession: (projectId, sessionId) => sessions.readSessionSnapshot(projectId, sessionId),
      readOrigin: (request) => sessionPackages.sessionPackageService.readOrigin(request)
    },
    runtimes: service,
    assertOpen,
    track
  })
  const external = createManagedExecutionExternalPort({ service, assertOpen, withDataRootWrite })
  const researchDemos = new ResearchDemoOwner({
    dataRoot,
    materials: {
      catalog: sessionAuthority.projectFilesRepository,
      inputAuthority: managedFiles.immutableInputAuthority,
      readSession: (projectId, sessionId) => sessions.readSessionSnapshot(projectId, sessionId),
      readOrigin: (request) => sessionPackages.sessionPackageService.readOrigin(request)
    },
    service: {
      runtimes: () => service.runtimes(),
      createSession: (request) => service.createSession(request),
      prepare: (request, signal) => service.prepare(request, signal),
      executeDemo: (request, options) => service.executeDemo(request, options),
      getOperation: (request) => service.getOperation(request),
      waitOperation: (request) => service.waitOperation(request),
      cancelOperation: (request) => service.cancelOperation(request),
      releaseEnvironment: (request) => service.releaseEnvironment(request),
      inspectExecution: (request) => service.inspectExecution(request),
      recordingStatus
    },
    track: (operation) => trackAdmitted(() => withDataRootWrite(operation)),
    createCarrierSession: (request) =>
      creator.create(request as Parameters<typeof creator.create>[0]),
    findCarrierSession: (request) => creator.lookup(request),
    onCarrierCreated: async (projectId, sessionId) => {
      const session = await sessions.readSessionSnapshot(projectId, sessionId)
      if (session)
        applicationEvents.publish('session:created', {
          session,
          originClientId: 'main:replay-demo'
        })
    },
    readSelection: (viewerId, caller) => observationViewers.selection(viewerId, { caller }),
    findPreparedEnvironment: (scope) => environments.lookupPrepared(scope),
    sessionExists: async (projectId, sessionId) => {
      const session = await sessions.readSessionSnapshot(projectId, sessionId)
      return Boolean(session && !session.packageOrigin && session.archivedAt === undefined)
    },
    assertOpen
  })
  external.observation = createRunObservationExternalPort({
    viewers: observationViewers,
    assertOpen,
    captureOptions: (viewerId, caller) => viewerHost.captureOptions(viewerId, caller),
    capture: (viewerId, request, caller) => viewerHost.capture(viewerId, request, caller),
    captures: (viewerId, caller) => viewerHost.captures(viewerId, caller),
    captureContent: (viewerId, request, caller) =>
      viewerHost.captureContent(viewerId, request, caller),
    recordingStatus: async (target) => {
      await authorizeObservationScope(target)
      const status = await recordingStatus(target)
      await authorizeObservationScope(target)
      return status
    },
    readRecorded: (target) => recordedObservations.read(target),
    readProjectRecording: (target) => recordedObservations.readProject(target),
    selectRecordedFile: (request) => recordedObservations.selectFile(request),
    openRecordedViewer: (target, caller, format) =>
      viewerHost.openRecorded(target, caller, {
        ...(format ? { format } : {}),
        ...(caller.surface === 'electron' ? { desktopParent: 'file:' as const } : {})
      }),
    openViewer: (target, caller, permissions) =>
      viewerHost.open(target, caller, {
        ...permissions,
        ...(caller.surface === 'electron' ? { desktopParent: 'file:' as const } : {})
      })
  })
  external.projectRecordings = createBrowserRecordingExternalPort({
    assertOpen,
    host: viewerHost,
    viewers: observationViewers,
    reader: recordedObservations
  })
  const replayReader: ReplayReaderApi = {
    sessions: {
      loadOne: ({ projectId, sessionId }) => sessions.readSessionSnapshot(projectId, sessionId)
    },
    notebook: {
      runIndex: ({ projectId, sessionId }) =>
        managedFiles.notebookRepository.readSessionRunIndex(projectId!, sessionId),
      getReference: (request) => notebook.getSessionReference(request),
      state: (request) => notebook.state(request)
    },
    artifacts: {
      getLineage: (request) => managedFiles.artifactProvenanceRepository.getLineage(request)
    },
    reviewer: {
      getForSession: async (request) => {
        const owner = sessionAuthority.reviewerCommandOwnerRef.current
        if (!owner) throw new Error('Review records are unavailable.')
        return owner.getForSession(request)
      }
    }
  }
  const observationAssociations = createObservationAssociationReader({
    reader: replayReader,
    read: (target) => recordedObservations.read(target),
    authorize: authorizeObservationScope,
    importedIdentity: async (target, resource, source) => {
      if (!source.runId || !resource.checksum || resource.size === undefined) return undefined
      const current = await sessions.readSessionSnapshot(target.projectId, target.sessionId)
      const currentOrigin = current?.packageOrigin ?? current?.forkOrigin
      if (!currentOrigin) return undefined
      // Reuse the existing exact-Version/content-bound receipt admission, not artifact names,
      // timestamps, or caller-provided maps. The complete import map remains in Main.
      await sessionPackages.sessionPackageService.readArtifactSourceVersionMapping(
        { projectId: target.projectId, sessionId: target.sessionId },
        {
          artifactId: target.artifactId,
          versionId: target.versionId,
          checksum: resource.checksum,
          sizeBytes: resource.size
        }
      )
      const origin = await sessionPackages.sessionPackageService.readOrigin({
        projectId: target.projectId,
        sessionId: target.sessionId
      })
      return importedObservationIdentity(target, source, currentOrigin, origin)
    }
  })
  const researchReplayService = new ResearchReplayService({
    reader: replayReader,
    observationBindings: observationAssociations.resolve,
    recordings: recordedObservations,
    immutable: managedFiles.immutableInputAuthority,
    authorize: authorizeObservationScope,
    readRun: ({ projectId, sessionId }, runId) =>
      managedFiles.notebookRepository.readSessionRun(projectId, sessionId, runId)
  })
  const researchReplayHost = new ResearchReplayHttpHost(
    researchReplayService,
    createReplayViewerAssetReader()
  )
  external.replays = createResearchReplayExternalPort(researchReplayHost, assertOpen)
  let draining: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    held = true
    resumePending = false
    draining ??= (async () => {
      const results = await Promise.allSettled([
        researchDemos.stopScope(),
        operations.quiesce(),
        environments.quiesce()
      ])
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
    await browserRecordings.close()
    closed = true
    await quiesce()
    await researchDemos.close()
    await operations.close()
    await environments.close()
    await observationMedia.close()
    await observationRecorder.close()
    recordingObserver.close()
    await observationViewers.close()
    viewerHost.close()
    researchReplayHost.close()
    observation.close()
    projectViews.close()
    observationDesktop.close()
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
    researchRuns,
    readObservationBindings: observationAssociations.read,
    researchDemos,
    external,
    internal,
    environments,
    operations,
    runtimeSessions,
    observationViewers,
    projectViews,
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
      await researchDemos.recover()
    },
    stopSession: (projectId, sessionId) => {
      let completion = stoppingSessions.get(sessionId)
      if (!completion) {
        completion = Promise.resolve()
          .then(async () => {
            await researchDemos.stopScope({ projectId, sessionId })
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
            await researchDemos.stopScope({ projectId })
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
