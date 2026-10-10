import { runtimeMetadata } from '../runtime-metadata'
import { join } from 'node:path'
import type { AcpSessionAgentTarget } from '../../shared/acp'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { withApprovedHandoffOutcome } from '../acp/approved-handoff-outcome'
import { ArtifactCodeReconstructionRunner } from '../acp/artifact-code-reconstruction-runner'
import { createCodexCompletionGateRuntime } from '../acp/codex-completion-handoff'
import { createAcpCreateSessionWorkflow } from '../acp/create-session-workflow'
import { createAcpHandlerWorkflows } from '../acp/handler-workflows'
import { createOpenCodeImmediateHandoffRuntime } from '../acp/opencode-immediate-handoff'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type SessionAgentTargetResolver } from '../acp/session-agent-target'
import { createAcpTaskAgentPort } from '../acp/task-agent-port'
import { createProductionAppHandoffRuntime } from '../agents/app-handoff-runtime'
import { createClaudeCodeCompletionGateRuntime } from '../agents/claude-code-handoff'
import { withApprovedSpecialistBinding } from '../agents/production-completion-handoff'
import {
  CompletionGateCoordinator,
  CompletionGateRuntimeRegistry,
  createCompletionGatedControlToolInterceptor
} from '../agents/completion-gate'
import { installCompletionGateDiagnostics } from '../agents/completion-gate-diagnostics'
import { registerCompletionHandoffIpcHandlers } from '../agents/completion-handoff-ipc'
import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository
} from '../agents/completion-handoff-lifecycle'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArchiveCoordinator } from '../archive/coordinator'
import { ArtifactCodeReconstructionService } from '../artifacts/code-reconstruction'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { TaskNotificationService } from '../notifications/task-notifications'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import { type SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import { createPersistedClaudeReplayPreparer } from '../session-persistence/claude-replay'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { clearUnanchoredAttachmentRecovery } from '../session-persistence/runtime-attachment-recovery'
import { SettingsService } from '../settings/service'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { SpecialistService } from '../specialist/service'
import { SessionBindingService } from '../specialist/session-binding'
import { SessionSpecialistReconfiguration } from '../specialist/session-reconfiguration'
import { resolveConfigRoot } from '../storage-root'
import type { TaskAgentPort } from '../tasks/task-runner'

export async function composeAgentCompletion({
  notebookService,
  specialistService,
  declareElectronAdapter,
  modules
}: {
  notebookService: NotebookRuntimeService
  specialistService: SpecialistService
  declareElectronAdapter: (name: string, install: () => void) => void
  modules: ApplicationModuleBuilder
}): Promise<{
  completionGateRuntimeRegistry: CompletionGateRuntimeRegistry
  completionHandoffLifecycle: CompletionHandoffLifecycle
  completionGateCoordinator: CompletionGateCoordinator
}> {
  // Compose the interceptor before ACP because Notebook construction precedes runtime construction.
  // Startup registers the complete production adapter below before any IPC surface becomes callable.
  const completionGateRuntimeRegistry = new CompletionGateRuntimeRegistry()
  const completionHandoffLifecycle = new CompletionHandoffLifecycle(
    new FileCompletionHandoffRepository(join(resolveConfigRoot(), 'specialist-handoffs')),
    completionGateRuntimeRegistry,
    Date.now,
    (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE_CHANGED, event),
    async ({ targetName }) => {
      if (targetName === null) return undefined
      const profile = await specialistService.resolveRunnableByName(targetName)
      return { specialistId: profile.id, revision: profile.revision }
    }
  )
  declareElectronAdapter('completion-handoff', () =>
    registerCompletionHandoffIpcHandlers(completionHandoffLifecycle)
  )
  const completionGateCoordinator = new CompletionGateCoordinator(
    completionGateRuntimeRegistry,
    completionHandoffLifecycle
  )
  await modules.add({ completionGateCoordinator }, ({ completionGateCoordinator: coordinator }) => {
    let disposeDiagnostics: (() => void) | undefined
    return {
      name: 'completion-handoff-diagnostics',
      capability: undefined,
      start: () => {
        disposeDiagnostics = installCompletionGateDiagnostics(coordinator, {
          log: createLogger('completion-handoff'),
          broadcast: (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE, event)
        })
      },
      dispose: () => disposeDiagnostics?.()
    }
  })
  // The delivery callback is intentionally a no-op: the Notebook runtime itself returns a normal
  // disposition to the existing repl_execute caller. Captured dispositions never return that value.
  notebookService.setControlCompletionInterceptor(
    createCompletionGatedControlToolInterceptor(completionGateCoordinator, async () => undefined)
  )
  return { completionGateRuntimeRegistry, completionHandoffLifecycle, completionGateCoordinator }
}

export async function composeAgentWorkflows({
  settingsService,
  resolveSessionAgentTarget,
  resolveDefaultSessionAgentTarget,
  sessionRepository,
  recordAuxiliaryUsage,
  artifactProvenanceRepository,
  configRoot,
  permissionGrantRegistry,
  sessionPersistenceCoordinator,
  archiveCoordinator,
  specialistService,
  sessionBindingService,
  sessionSpecialistReconfiguration,
  completionGateRuntimeRegistry,
  completionHandoffLifecycle,
  taskNotifications,
  delegatedWorkRef,
  delegatedWork,
  runtime,
  sideChatRuntime,
  modules
}: {
  settingsService: SettingsService
  resolveSessionAgentTarget: SessionAgentTargetResolver
  resolveDefaultSessionAgentTarget: () => Promise<AcpSessionAgentTarget>
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  recordAuxiliaryUsage: (record: SessionAuxiliaryTurnUsageRecord) => Promise<void>
  artifactProvenanceRepository: ArtifactProvenanceRepository
  configRoot: ReturnType<typeof resolveConfigRoot>
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    'prepareRuntimeResume' | 'sessionProjectId' | 'mutateRuntimeSession'
  >
  archiveCoordinator: ArchiveCoordinator
  specialistService: SpecialistService
  sessionBindingService: SessionBindingService
  sessionSpecialistReconfiguration: SessionSpecialistReconfiguration
  completionGateRuntimeRegistry: CompletionGateRuntimeRegistry
  completionHandoffLifecycle: CompletionHandoffLifecycle
  taskNotifications: TaskNotificationService
  delegatedWorkRef: {
    current?: ReturnType<typeof createProductionDelegatedWorkComposition>
  }
  delegatedWork: ReturnType<typeof createProductionDelegatedWorkComposition>
  runtime: ReturnType<typeof createAcpRuntime>
  sideChatRuntime: SideChatRuntimeOwner
  modules: ApplicationModuleBuilder
}): Promise<{
  codeReconstruction: ArtifactCodeReconstructionService
  acpHandlerWorkflows: ReturnType<typeof createAcpHandlerWorkflows>
  taskAgent: TaskAgentPort
}> {
  // Archive availability is checked at the final admission point, rather than trusting renderer
  // visibility, so an archived Project/Session cannot restart work through another surface.
  runtime.setPromptAdmissionGuard(async (sessionId) => {
    await archiveCoordinator.assertSessionAvailableById(sessionId)
    await sessionSpecialistReconfiguration.assertUserPromptReady(sessionId)
    if (!(await completionHandoffLifecycle.canStartUserPrompt(sessionId))) {
      throw new Error('The approved Specialist handoff must finish or be cancelled before sending.')
    }
  })
  runtime.setPromptDispatchAdmissionGuard((sessionId, dispatch, requireAvailable) =>
    archiveCoordinator.withSessionDeletionAdmissionById(sessionId, dispatch, requireAvailable)
  )
  const codeReconstructionLog = createLogger('artifacts:code-reconstruction')
  const codeReconstructionRunner = await modules.add(
    {
      appVersion: runtimeMetadata().version,
      configRoot,
      captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context),
      recordUsage: recordAuxiliaryUsage
    } satisfies ConstructorParameters<typeof ArtifactCodeReconstructionRunner>[0],
    (options) => {
      const runner = new ArtifactCodeReconstructionRunner(options)
      return {
        name: 'artifact-code-reconstruction-runner',
        capability: runner,
        dispose: () => runner.shutdown()
      }
    }
  )
  void codeReconstructionRunner
    .sweepStaleProfiles()
    .catch((error) =>
      codeReconstructionLog.error(
        'stale reconstruction profile cleanup failed',
        diagnosticErrorFields(error)
      )
    )
  const codeReconstruction = new ArtifactCodeReconstructionService({
    provenance: artifactProvenanceRepository,
    runner: codeReconstructionRunner
  })
  const createSessionWorkflow = createAcpCreateSessionWorkflow(runtime, {
    withProjectAvailable: (projectId, operation) =>
      archiveCoordinator.withProjectAvailable(projectId, operation)
  })
  const acpHandlerWorkflows = createAcpHandlerWorkflows(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator,
    {
      loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
      prepareRuntimeResume: (projectId, sessionId) =>
        sessionPersistenceCoordinator.prepareRuntimeResume(projectId, sessionId),
      completeRuntimeAttachment: async (projectId, sessionId) => {
        const current = await sessionRepository.loadSession(projectId, sessionId)
        if (!current || clearUnanchoredAttachmentRecovery(current) === current) return
        await sessionPersistenceCoordinator.mutateRuntimeSession(
          { projectId, sessionId },
          clearUnanchoredAttachmentRecovery
        )
      }
    },
    (sessionId) => {
      if (sideChatRuntime.hasForParent(sessionId)) {
        throw new Error('Close Side chat before saving this conversation as a Skill.')
      }
    }
  )
  const taskAgent = createAcpTaskAgentPort(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator,
    resolveSessionAgentTarget,
    resolveDefaultSessionAgentTarget
  )
  const registerHandoff = (adapter: Parameters<typeof withApprovedHandoffOutcome>[1]): void => {
    completionGateRuntimeRegistry.register(
      withApprovedHandoffOutcome(
        runtime,
        withApprovedSpecialistBinding(adapter, {
          getSpecialistBinding: (sessionId) => sessionBindingService.getBinding(sessionId),
          getSpecialist: (specialistId) => specialistService.resolveRunnableById(specialistId)
        })
      )
    )
  }
  {
    // Framework-specific adapters declare their own session selector. The registry resolves those
    // selectors before its generic fallback, so registration order cannot route a Codex/OpenCode
    // completion through the wrong continuation path.
    registerHandoff(
      createCodexCompletionGateRuntime({
        runtime: {
          isSessionUsingFramework: (sessionId, frameworkId) =>
            runtime.isSessionUsingFramework(sessionId, frameworkId),
          cancelPrompt: async (request) => {
            await runtime.stopPromptForHandoff(request.sessionId)
            return runtime.getState()
          },
          waitForPromptRelease: (sessionId) => runtime.waitForPromptRelease(sessionId),
          switchSpecialist: (sessionId, specialistId) =>
            sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
          continueApprovedHandoff: (sessionId, text) =>
            runtime.continueApprovedHandoff(sessionId, text)
        },
        resolveApprovedSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId)
      })
    )
    registerHandoff(
      createOpenCodeImmediateHandoffRuntime({
        runtime: {
          getSessionFramework: (sessionId) => runtime.getSessionFramework(sessionId),
          capturePromptForHandoff: (sessionId) => runtime.capturePromptForHandoff(sessionId),
          cancelPrompt: async (request) => {
            await runtime.stopPromptForHandoff(request.sessionId)
            return runtime.getState()
          },
          waitForPromptOwnershipRelease: (sessionId) =>
            runtime.waitForPromptOwnershipRelease(sessionId),
          switchSpecialist: (sessionId, specialistId) =>
            sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
          startContinuation: (request) => runtime.startContinuation(request)
        },
        resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
        reportHandoffFailure: async () => undefined
      })
    )
    registerHandoff(
      createProductionAppHandoffRuntime({
        runtime: {
          cancelPrompt: async (request) => {
            await runtime.stopPromptForHandoff(request.sessionId)
            return runtime.getState()
          },
          waitForPromptOwnershipRelease: (sessionId) =>
            runtime.waitForPromptOwnershipRelease(sessionId),
          switchSpecialist: (sessionId, specialistId) =>
            sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
          sendAppContinuation: (request) => runtime.sendAppContinuation(request)
        },
        sessionBinding: sessionBindingService
      })
    )
  }
  // Claude's Specialist identity is baked into agent session creation. Its selector joins the Codex
  // and OpenCode selectors above; the generic runtime remains fallback-only.
  registerHandoff(
    createClaudeCodeCompletionGateRuntime({
      sessionFramework: (sessionId) => runtime.getSessionFramework(sessionId),
      cancelPrompt: async (request) => {
        await runtime.stopPromptForHandoff(request.sessionId)
        return runtime.getState()
      },
      waitForPromptOwnershipRelease: (sessionId) =>
        runtime.waitForPromptOwnershipRelease(sessionId),
      resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
      resolveSwitchReadBack: async (sessionId, targetName) => {
        const specialistId = sessionBindingService.getBinding(sessionId)
        const revision = specialistId
          ? (await specialistService.resolveRunnableById(specialistId)).revision
          : undefined
        return {
          status: 'approved',
          operation: 'switch',
          binding: {
            sessionId,
            specialistId,
            targetName,
            ...(revision === undefined ? {} : { revision })
          }
        }
      },
      prepareReplayContext: createPersistedClaudeReplayPreparer({
        repository: sessionRepository,
        coordinator: sessionPersistenceCoordinator,
        prepareReplay: (input) => runtime.prepareClaudeCodeHandoffReplay(input)
      }),
      discardReplayContext: async (sessionId) => runtime.discardClaudeCodeHandoffReplay(sessionId),
      switchSpecialist: (sessionId, specialistId) =>
        sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
      createContinuationRequest: (input) => runtime.createClaudeCodeContinuationRequest(input),
      sendAppContinuation: (request) => runtime.sendAppContinuation(request)
    })
  )
  void completionHandoffLifecycle.recover().catch((error: unknown) => {
    createLogger('completion-handoff').error(
      'failed to recover approved handoffs',
      errorLogFields(error)
    )
  })
  delegatedWorkRef.current = delegatedWork
  permissionGrantRegistry.subscribe(() => runtime.notifyPermissionGrantsChanged())
  return { codeReconstruction, acpHandlerWorkflows, taskAgent }
}
