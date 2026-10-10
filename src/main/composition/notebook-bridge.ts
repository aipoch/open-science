import { runtimeMetadata } from '../runtime-metadata'
import { bindNotebookApprovals } from './notebook-approvals'
import { ReviewRepository } from '../reviewer/repository'
import { readLinkedSession } from '../notebook/host-session-reading'
import { SessionReplayRepository } from '../session-replay/repository'
import { NotebookRunRepository } from '../notebook/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveEffectiveSpecialistSkills } from '../../shared/specialist'
import { ImageInputCompatibilityOwner } from '../acp/image-input-compatibility-owner'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import { createAcpRuntime } from '../acp/runtime-composition'
import { VisionEvidenceRepository } from '../acp/vision-evidence-repository'
import { AgentsService } from '../agents/agents-service'
import { CompletionGateCoordinator } from '../agents/completion-gate'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { AgentComputeService } from '../compute/agent-compute-service'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { createLogger, diagnosticErrorFields } from '../logger'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { MemoryService } from '../memory/service'
import {
  createNotebookApplicationModule,
  createNotebookLocalRpcModule
} from '../notebook/application'
import { HostArtifactsService } from '../notebook/host-artifacts-service'
import { HostFramesService } from '../notebook/host-frames-service'
import { HostLineageService } from '../notebook/host-lineage-service'
import { HostModelService } from '../notebook/host-model-service'
import { HostSessionsService } from '../notebook/host-sessions-service'
import { HostViewImageService } from '../notebook/host-view-image-service'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { createManagedFileIndexRepository } from '../project-files/repository'
import { createDefaultProjectRepository } from '../projects/ipc'
import { type SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { SettingsService } from '../settings/service'
import { HostSkillsService, type HostSkillsCatalog } from '../skills/host-skills-service'
import { SpecialistService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { TagService } from '../tags/service'
import { WslSetupOwner } from '../wsl/wsl-setup-owner'
import { WslSetupSessionOwner } from '../wsl/wsl-setup-session-owner'
import { openWslSetupPowerShellTerminal } from '../wsl/wsl-setup-terminal'
import { wsl2BashPreviewStatus } from '../wsl/wsl2-preview-gate'

export async function composeNotebookBridge({
  wslSetupSessions,
  wslSetup,
  settingsService,
  managedFileVersionService,
  runtimeRef,
  requestSkillCatalogRefresh,
  sessionRepository,
  recordAuxiliaryUsage,
  projectRepository,
  immutableInputAuthority,
  artifactProvenanceRepository,
  configRoot,
  projectFilesRepository,
  notebookInputRegistry,
  sessionPersistenceCoordinator,
  visionEvidenceRepository,
  notebookService,
  notebookLocalRpc,
  managedExecution,
  specialistService,
  memoryService,
  removeResourceTags,
  completionGateCoordinator,
  connectorService,
  conversationSkillImporter,
  agentComputeService,
  agentsService,
  notebookRpcServerRef,
  delegatedWork,
  modules,
  composition
}: {
  wslSetupSessions: WslSetupSessionOwner
  wslSetup: WslSetupOwner
  settingsService: SettingsService
  managedFileVersionService: ManagedFileVersionService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  requestSkillCatalogRefresh: () => void
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  recordAuxiliaryUsage: (record: SessionAuxiliaryTurnUsageRecord) => Promise<void>
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  immutableInputAuthority: ImmutableInputAuthority
  artifactProvenanceRepository: ArtifactProvenanceRepository
  configRoot: ReturnType<typeof resolveConfigRoot>
  projectFilesRepository: ReturnType<typeof createManagedFileIndexRepository>
  notebookInputRegistry: NotebookInputRegistry
  sessionPersistenceCoordinator: Pick<SessionPersistenceCommands, 'runSessionMutation'>
  visionEvidenceRepository: VisionEvidenceRepository
  notebookService: NotebookRuntimeService
  notebookLocalRpc: ReturnType<typeof createNotebookApplicationModule>['capability']['localRpc']
  managedExecution?: import('../notebook/managed-execution-port').ManagedExecutionPort
  specialistService: SpecialistService
  memoryService: MemoryService
  removeResourceTags: (resources: Parameters<TagService['removeResources']>[0]) => Promise<void>
  completionGateCoordinator: CompletionGateCoordinator
  connectorService: import('../connectors/service').ConnectorService
  conversationSkillImporter: import('../skills/conversation-import').ConversationSkillImporter
  agentComputeService: AgentComputeService
  agentsService: AgentsService
  notebookRpcServerRef: { current?: NotebookLocalRpcServer }
  delegatedWork: ReturnType<typeof createProductionDelegatedWorkComposition>
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<{
  notebookRpcServer: NotebookLocalRpcServer
  imageInputCompatibility: ImageInputCompatibilityOwner
}> {
  const hostSkillsCatalog: HostSkillsCatalog = {
    list: () => settingsService.listHostSkills(),
    withSkillRead: (id, read) => settingsService.withHostSkillRead(id, read),
    publishPersonalDirectory: (name, sourcePath, overwrite) =>
      settingsService.publishHostSkill(name, sourcePath, overwrite),
    deletePublished: async (id) => {
      await settingsService.deleteSkill({ id })
      await removeResourceTags([{ resourceType: 'catalog.skill', resourceId: id }])
    }
  }
  let readingRoot = resolveDataRoot()
  let readingRuns = new NotebookRunRepository(readingRoot)
  const sessionReadingRuns = (): NotebookRunRepository => {
    const root = resolveDataRoot()
    if (root !== readingRoot) {
      readingRoot = root
      readingRuns = new NotebookRunRepository(root)
    }
    return readingRuns
  }
  const hostSkillsService = new HostSkillsService({
    storageRoot: configRoot,
    catalog: hostSkillsCatalog,
    approveDelete: async (payload, session) => {
      const runtime = runtimeRef.current
      if (!session.sessionId || !runtime) return false
      return runtime.requestAppApproval({
        sessionId: session.sessionId,
        title: `Delete ${payload.name}?`,
        rawInput: { skillApproval: { kind: 'delete', ...payload } }
      })
    },
    onPublishedSkillsChanged: requestSkillCatalogRefresh
  })
  const hostLlmLog = createLogger('notebook:host-llm')
  const hostModelService = new HostModelService({
    captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
    captureSessionModel: (sessionId) => runtimeRef.current?.captureSessionModel(sessionId),
    captureModelCatalog: async () => {
      const settings = await settingsService.getSettingsView()
      return {
        providers: settings.providers,
        claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId
      }
    },
    runner: new RestrictedInferenceRunner({
      appVersion: runtimeMetadata().version,
      configRoot,
      profileNamespace: 'host-llm',
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context)
    }),
    recordUsage: recordAuxiliaryUsage
  })
  const hostViewImageService = new HostViewImageService({
    catalog: projectFilesRepository,
    managedFileVersions: managedFileVersionService,
    captureBackend: (sessionId) => {
      const backend = runtimeRef.current?.captureSessionBackend(sessionId)
      return backend
        ? {
            frameworkId: backend.framework.id,
            backendId: backend.backendId,
            modelRoute: backend.modelRoute,
            model: backend.context.model ?? backend.session.model,
            supportsImageInput: backend.context.supportsImageInput,
            generationToken: backend
          }
        : undefined
    }
  })
  const resolveHostReferencedSession = async (
    context: { sessionId: string },
    referencedSessionId: string
  ): Promise<{ projectId: string } | undefined> => {
    if (!runtimeRef.current?.isSessionReferenceAllowed(context.sessionId, referencedSessionId)) {
      return undefined
    }
    const summary = (await sessionRepository.loadSessionSummaries()).find(
      (candidate) => candidate.id === referencedSessionId && candidate.archivedAt === undefined
    )
    if (!summary) return undefined
    const project = await projectRepository.get(summary.projectId)
    return project && project.archivedAt === undefined
      ? { projectId: summary.projectId }
      : undefined
  }
  bindNotebookApprovals(notebookService, () => runtimeRef.current)
  const notebookRpcServer = await modules.add(
    new NotebookLocalRpcServer(notebookLocalRpc, {
      managedExecution,
      // The Notebook REPL runs in a process sandbox whose only TCP egress is the approval gateway.
      // Keep its privileged Host SDK channel on an explicitly shared local socket instead.
      transport: 'pipe',
      onSessionReleased: (sessionId) => completionGateCoordinator.releaseSession(sessionId),
      isHostSkillsAvailable: (sessionId) =>
        runtimeRef.current?.getSessionFramework(sessionId) !== 'codebuddy',
      resolveSpecialistSkillIds: async (specialistId) => {
        const profile = await specialistService.resolveRunnableById(specialistId)
        if (!profile.enabled) return []
        const effective = resolveEffectiveSpecialistSkills(
          profile,
          await settingsService.listSpecialistSkillCatalog()
        )
        return effective.kind === 'specialist' ? [...new Set(effective.skillIds)] : []
      },
      connectorService,
      computeService: agentComputeService,
      memoryService,
      // The Memory service checks the global gate inside its own queue.
      isMemoryEnabledForSession: (sessionId) =>
        runtimeRef.current?.isSessionMemoryEnabled(sessionId) ?? false,
      sessionMemorySignal: (sessionId) => runtimeRef.current?.sessionMemorySignal(sessionId),
      skillImporter: conversationSkillImporter,
      planService: {
        call: (input) => {
          const runtime = runtimeRef.current
          if (!runtime) return Promise.reject(new Error('ACP runtime is not available.'))
          return runtime.callSessionPlan(input)
        }
      },
      requestUserInput: (request) => {
        const runtime = runtimeRef.current
        if (!runtime) throw new Error('ACP runtime is not initialized.')
        return runtime.requestUserInput(request)
      },
      artifactProvenance: {
        saveVersion: (request, sourceScope, signal, onMetadataBytes) =>
          artifactProvenanceRepository.saveVersion(request, sourceScope, signal, onMetadataBytes),
        reserveWrite: (request) => artifactProvenanceRepository.reserveWrite(request),
        releaseWriteReservation: (request) =>
          artifactProvenanceRepository.releaseWriteReservation(request),
        releaseRunWriteReservations: (request) =>
          artifactProvenanceRepository.releaseRunWriteReservations(request),
        releaseAllWriteReservations: () =>
          artifactProvenanceRepository.releaseAllWriteReservations(),
        createVersion: (request, signal) =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () => artifactProvenanceRepository.createVersion(request, signal)
          ),
        replayVersion: (request) =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () => artifactProvenanceRepository.replayVersion(request)
          )
      },
      hostArtifacts: new HostArtifactsService(projectFilesRepository, immutableInputAuthority),
      delegationInputCatalog: projectFilesRepository,
      hostLineage: new HostLineageService({
        catalog: projectFilesRepository,
        provenance: artifactProvenanceRepository
      }),
      hostFrames: new HostFramesService(
        {
          readProject: (projectId) =>
            sessionRepository.loadProjectWithDiagnostics(projectId, { mode: 'read-only' }),
          readSession: (projectId, sessionId) =>
            sessionRepository.loadSessionWithDiagnostics(projectId, sessionId, {
              mode: 'read-only'
            })
        },
        resolveHostReferencedSession
      ),
      hostSessions: new HostSessionsService(
        {
          readProject: (projectId) =>
            sessionRepository.loadProjectWithDiagnostics(projectId, { mode: 'read-only' }),
          readSession: (projectId, sessionId) =>
            sessionRepository.loadSessionWithDiagnostics(projectId, sessionId, {
              mode: 'read-only'
            })
        },
        { getSnapshot: () => runtimeRef.current?.getSnapshot() },
        resolveHostReferencedSession,
        (sessionId, options, context) =>
          readLinkedSession(
            {
              contexts: new SessionReplayRepository(() => getProjectDbClient(configRoot)),
              readSession: async (projectId, sourceId) => {
                const result = await sessionRepository.loadSessionWithDiagnostics(
                  projectId,
                  sourceId,
                  { mode: 'read-only' }
                )
                return result.status === 'found' ? result.session : undefined
              },
              readFiles: async (projectId, sourceId) =>
                (await projectFilesRepository.readHostArtifactCatalog({ projectId })).filter(
                  (file) => file.sessionId === sourceId
                ),
              readFile: async (file) => {
                if (
                  !/^text\/|^application\/(json|xml|javascript)/.test(file.contentType ?? '') &&
                  !/\.(txt|md|csv|tsv|json|py|r|js|ts|html|xml|yaml|yml)$/i.test(file.filename)
                ) {
                  return JSON.stringify({
                    name: file.filename,
                    versionId: file.versionId,
                    contentType: file.contentType,
                    size: file.sizeBytes,
                    note:
                      file.projectId === context.projectId
                        ? 'Binary content; these are metadata, not image pixels. If the response includes viewImage, pass it to host.viewImage to inspect this exact version.'
                        : 'Binary content; these are metadata, not image pixels. This file belongs to another Project and cannot be viewed by host.viewImage here. Use the source preview or ask the user to attach the image; do not infer its contents.'
                  })
                }
                if (file.sizeBytes > 8 * 1024 * 1024)
                  throw new Error('This text file exceeds the Session reader limit of 8 MiB.')
                const lease = await managedFileVersionService.openVersion(
                  { source: file.source, projectId: file.projectId, fileId: file.sourceFileId },
                  file.versionId
                )
                try {
                  const bytes = await lease.readRange(0, lease.size)
                  await lease.verifyUnchanged()
                  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
                } finally {
                  await lease.close()
                }
              },
              readReviews: (projectId, sourceId) =>
                new ReviewRepository(() =>
                  getProjectDbClient(configRoot)
                ).getReviewsForProjectSession(projectId, sourceId),
              readRunIndex: (projectId, sourceId) =>
                sessionReadingRuns().readSessionRunIndex(projectId, sourceId),
              readRun: (projectId, sourceId, runId) =>
                sessionReadingRuns().readSessionRun(projectId, sourceId, runId),
              readRuns: (projectId, sourceId) =>
                sessionReadingRuns().readSessionRuns(projectId, sourceId)
            },
            context,
            sessionId,
            options
          )
      ),
      inputRegistry: notebookInputRegistry,
      agentsService,
      delegatedWorkService: delegatedWork.host,
      skillsService: hostSkillsService,
      hostModel: hostModelService,
      hostViewImage: hostViewImageService,
      wslSetup,
      wslSetupSessions,
      wslSetupPreviewAvailable: () => wsl2BashPreviewStatus().available,
      openWslSetupPowerShellTerminal
    }),
    createNotebookLocalRpcModule
  )
  // Reverse module disposal cancels active inference before the RPC server waits for its handlers.
  await modules.add(hostModelService, (service) => ({
    name: 'host-model-service',
    capability: service,
    dispose: () => service.shutdown()
  }))
  void hostModelService
    .sweepStaleProfiles()
    .catch((error) =>
      hostLlmLog.error('stale host.llm profile cleanup failed', diagnosticErrorFields(error))
    )
  const visionInferenceRunner = new RestrictedInferenceRunner({
    appVersion: runtimeMetadata().version,
    configRoot,
    profileNamespace: 'vision-evidence',
    resolveTarget: (target, context) =>
      settingsService.resolveExplicitAgentBackend(target, context),
    allowNativeCodexSubscription: true
  })
  void visionInferenceRunner
    .sweepStaleProfiles()
    .catch((error) =>
      hostLlmLog.error('stale Vision model profile cleanup failed', diagnosticErrorFields(error))
    )
  const imageInputCompatibility = await modules.add(
    new ImageInputCompatibilityOwner({
      captureTarget: () => settingsService.admitVisionModel(),
      runner: visionInferenceRunner,
      evidenceRepository: visionEvidenceRepository,
      recordUsage: recordAuxiliaryUsage
    }),
    (owner) => ({
      name: 'image-input-compatibility',
      capability: owner,
      dispose: () => {
        owner.clear()
        return visionInferenceRunner.shutdown()
      }
    })
  )
  notebookRpcServerRef.current = notebookRpcServer
  composition.phase('notebook-rpc')
  // Register ownership before ACP construction. Reverse disposal therefore drains ACP + Notebook
  // through the coordinator first, then releases the local bridge without creating a second runtime
  // shutdown owner; rollback also closes a server started during partial composition.
  // The RPC server needs the runtime service to dispatch to, and the runtime service needs the RPC
  // server's (lazily-started) connection for host.mcp() env injection — wire the second half here to
  // avoid a construction cycle.
  notebookService.setMcpRpcConnectionResolver(
    ({ sessionId, projectId, agentFrameId, attemptId, executionCwd }) =>
      notebookRpcServer.issueControlConnection(
        sessionId,
        projectId,
        agentFrameId,
        attemptId ? { role: 'delegate', attemptId } : { role: 'main' },
        executionCwd
      )
  )
  return { notebookRpcServer, imageInputCompatibility }
}
