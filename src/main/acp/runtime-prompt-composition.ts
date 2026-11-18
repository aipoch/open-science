import * as acp from '@agentclientprotocol/sdk'
import { recordResourceEvent } from '../resource-diagnostics/recorder'
import { randomUUID } from 'node:crypto'

import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import type { AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'
import type { AgentFramework } from '../agent-framework/types'
import type { NotebookWorkingFile } from './artifact-publication-continuation'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import { AcpPromptPreparationOwner } from './prompt-preparation-owner'
import {
  AcpPromptTurnWorkflow,
  type AcpPromptTurnPlanWorkflow,
  type AcpPromptTurnWorkflowOptions
} from './prompt-turn-workflow'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeOptions } from './runtime-contract'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import {
  NotebookExecutionIntent,
  markNotebookExecutionIntent,
  notebookExecutionIntent,
  notebookUserOperation
} from '../notebook/execution-intent'
import type { AcpProviderSessionResumer } from './provider-session-resumer'
import { shellRuntimeAgentContract } from '../notebook/shell-runtime'
import { requestPlanReviewProviderStop } from './plan-review-provider-stop'

type AcpRuntimePromptReloadHost = Readonly<{
  prepareContinuationReplay: AcpPromptTurnWorkflowOptions['prepareContinuationReplay']
  disconnect: AcpPromptTurnWorkflowOptions['disconnectForReload']
  resume: AcpPromptTurnWorkflowOptions['resumeAfterReload']
}>

type AcpRuntimePromptHost = Readonly<{
  refreshNotebookConnection?: AcpProviderSessionResumer['refreshNotebookConnection']
  plan: AcpPromptTurnPlanWorkflow
  reload: AcpRuntimePromptReloadHost
  onPromptEnded?: (sessionId: string, turnToken: string) => void
  onProviderPromptAccepted?: (sessionId: string) => void
  artifactPublicationPrompt?: (
    sessionId: string,
    files: readonly NotebookWorkingFile[]
  ) => string | undefined
}>

const log = createLogger('acp')

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const acpErrorKind = (error: unknown): string | undefined => {
  try {
    const data = (error as { data?: unknown } | null)?.data
    const kind = (data as { errorKind?: unknown } | null | undefined)?.errorKind
    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Prompt projection and the original provider outcome take precedence over diagnostics.
  }
}

// Composes the complete Prompt workflow around authoritative Base and Session owners. The host is
// limited to Plan application policy and public reload re-entry; constructors never invoke it.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimePromptOwners = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners,
  host: AcpRuntimePromptHost
) => {
  const callbacks = options.callbacks ?? {}
  // Persisted skill activities outlive the runtime's prompt sequence.
  const skillActivityNamespace = randomUUID()
  // Connection teardown may release an interaction before its finalizer unwinds. Keep callback
  // ownership separate from terminal outcomes so every published start has exactly one end.
  const startedPromptTurns = new Map<string, string>()
  const endPromptTurn = (sessionId: string, turnToken: string): void => {
    if (startedPromptTurns.get(turnToken) !== sessionId) return
    startedPromptTurns.delete(turnToken)
    recordResourceEvent('prompt-ended', {
      runtimeId: base.resourceRuntimeId,
      sessionId,
      turnId: turnToken
    })
    for (const cleanup of [
      () => session.sessionUpdateProjector.clearAssistantOutput(sessionId),
      () => host.onPromptEnded?.(sessionId, turnToken),
      () => callbacks.onPromptEnded?.(sessionId, turnToken)
    ]) {
      try {
        cleanup()
      } catch (error) {
        safeLogError('prompt-end callback failed', error)
      }
    }
  }
  const releasePromptTurns = (): void => {
    for (const [turnToken, sessionId] of [...startedPromptTurns])
      endPromptTurn(sessionId, turnToken)
  }
  const activeSession = (sessionId: string) =>
    session.sessionRegistry.lookup(sessionId)?.attachment?.session
  const currentFramework = () => base.backendGeneration.current.framework
  const projectId = (sessionId: string): string => session.sessionEnvironment.projectId(sessionId)
  const emitState = (): void => session.publication.emitState()
  const diagnosticContext = () => ({
    framework: currentFramework().id,
    generation: base.connectionResources.epoch,
    status: base.snapshotOwner.status
  })
  const emitSkillActivities = (
    sessionId: string,
    promptTurn: number,
    inputs: ReadonlyArray<{ name: string }>,
    status: 'in_progress' | 'completed' | 'failed'
  ): void => {
    for (const [index, { name }] of inputs.entries()) {
      session.publication.pushEvent({
        kind: 'tool',
        level: status === 'failed' ? 'error' : 'info',
        sessionId,
        toolCallId: `open-science-skill-${skillActivityNamespace}-${promptTurn}-${index}`,
        providerToolName: 'skill',
        title: `Loaded skill: ${name}`,
        status
      })
    }
  }
  const openArtifact = async (
    sessionId: string,
    executionId: string,
    provenanceContext: AcpPromptRequest['provenanceContext']
  ): Promise<ArtifactTurnHandle | undefined> => {
    if (!base.artifactTurns) return undefined
    return base.artifactTurns.openRootExecution({
      executionId,
      workspaceCwd: session.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd,
      appSessionId: sessionId,
      artifactStorageSessionId:
        base.sessionCapabilities.artifactRoutingIdFor(sessionId) ?? sessionId,
      projectId: projectId(sessionId),
      agentName: currentFramework().displayName,
      provenanceContext
    })
  }
  const publishArtifact = async (
    sessionId: string,
    artifact: ArtifactTurnHandle | undefined,
    onPublished?: () => void
  ): Promise<void> => {
    if (!artifact || !base.artifactTurns) return
    const executionId = base.artifactTurns.snapshot(artifact).executionId
    if (!executionId) throw new Error('Artifact publication has no runtime execution owner.')
    const publication = await base.artifactTurns.finalize(artifact)
    if (!publication) return
    const committed = options.runtimeSessions
      ? await options.runtimeSessions.publish({
          appSessionId: publication.appSessionId,
          artifactClaimId: publication.artifactClaimId,
          runId: publication.runId,
          promptMessageId: publication.promptMessageId,
          artifacts: publication.artifacts,
          executionId
        })
      : undefined
    session.publication.pushEvent(
      {
        kind: 'artifact',
        level: 'info',
        sessionId,
        title: 'Generated files',
        runId: publication.runId,
        promptMessageId: publication.promptMessageId,
        artifactSessionId: publication.artifactStorageSessionId,
        artifactClaimId: publication.artifactClaimId,
        artifacts: committed?.artifacts ?? publication.artifacts,
        ...(committed ? { messageId: committed.messageId, publicationOwner: 'main' as const } : {})
      },
      onPublished
    )
  }
  const disposeArtifact = async (artifact: ArtifactTurnHandle | undefined): Promise<void> => {
    if (artifact) await base.artifactTurns?.dispose(artifact)
  }

  const promptPreparation = new AcpPromptPreparationOwner({
    shellRuntimeBindingFor: (sessionId) =>
      base.sessionCapabilities.shellRuntimeBindingFor(sessionId),
    classifySkills: options.classifySkills,
    classifyReadingRoute: options.classifyReadingRoute,
    promptContent: base.promptContentOwner,
    classificationImages: base.classificationImageLoader,
    imageInputCompatibility: options.imageInputCompatibility,
    presentation: base.sessionPresentationPolicy,
    contextUsage: base.contextUsageTracker,
    selectBridgeSkills: async (text, catalog, signal, observeUsage) =>
      (await base.connectionResources.selectBridgeSkills(text, catalog, signal, observeUsage)) ??
      [],
    authorizeReferencedUploads: options.skillImport?.authorizeReferencedUploads,
    memory: options.memory,
    prepareSessionReading: options.prepareSessionReading,
    isMemoryEnabledForSession: (sessionId) =>
      session.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().memoryEnabled ?? false,
    ...(options.notebook
      ? {
          notebook: {
            peekHandoffContext: options.notebook.peekHandoffContext,
            isReplNamespaceUnavailable: options.notebook.isReplNamespaceUnavailable,
            registerTurnInputs: options.notebook.registerTurnInputs
          }
        }
      : {}),
    emitState
  })
  const beforeFrameworkPromptDispatch = async (input: {
    appSessionId: string
    framework: AgentFramework
    providerSessionId: string
    cwd: string
    skillRuntimeAllowlist?: readonly string[]
    request?: AcpPromptRequest
    signal?: AbortSignal
    assertCurrent?: () => void
  }): Promise<void> => {
    session.sessionUpdateProjector.clearAssistantOutput(input.appSessionId)
    const intent = input.request && notebookExecutionIntent(input.request)
    // A distinct Provider dispatch has its own credential even when it inherits the same stopped
    // intent. A late callback from its predecessor must never stop a newer explanatory branch.
    if (intent) {
      let refresh:
        | Awaited<ReturnType<typeof base.sessionCapabilities.prepareNotebookConnectionRefresh>>
        | undefined
      try {
        refresh = await base.sessionCapabilities.prepareNotebookConnectionRefresh({
          appSessionId: input.appSessionId,
          projectId: projectId(input.appSessionId),
          cwd: input.cwd,
          executionIntent: intent
        })
        const assertCurrent = (): void => {
          input.signal?.throwIfAborted()
          input.assertCurrent?.()
          if (input.request) notebookUserOperation(input.request)?.assertCurrent()
        }
        assertCurrent()
        if (!host.refreshNotebookConnection)
          throw new Error('Notebook provider refresh is unavailable.')
        const shellRuntime = base.sessionCapabilities.shellRuntimeBindingFor(input.appSessionId)
        await host.refreshNotebookConnection({
          sessionId: input.appSessionId,
          cwd: input.cwd,
          mcpServers: refresh.mcpServers,
          skillRuntimeAllowlist: input.skillRuntimeAllowlist,
          ...(shellRuntime
            ? { shellRuntimeAgentContract: shellRuntimeAgentContract(shellRuntime) }
            : {}),
          signal: input.signal,
          assertCurrent
        })
        assertCurrent()
        refresh.commit()
      } catch (error) {
        // A cancelled/failed preparation must not leave an executable current intent for a
        // later generic reconnect. Retired credentials are never restored.
        intent.abandonUserExecution()
        refresh?.release()
        throw error
      }
      return
    }
    if (!input.framework.beforePromptDispatch) return
    const connection = base.connectionResources.connection
    if (!connection) throw new Error('ACP connection is not available.')
    const { codeBuddySharedSite } = base.backendGeneration.current.adapter
    await input.framework.beforePromptDispatch({
      ...(codeBuddySharedSite && { codeBuddySharedSite }),
      connection,
      providerSessionId: input.providerSessionId,
      cwd: input.cwd,
      mcpServers: base.sessionCapabilities.mcpServersFor(input.appSessionId),
      ...(input.skillRuntimeAllowlist ? { skillRuntimeAllowlist: input.skillRuntimeAllowlist } : {})
    })
  }
  const contextCompactionWorkflow = new AcpContextCompactionWorkflow({
    sessions: { activeSession, currentFramework },
    interactions: base.sessionInteractions,
    context: base.contextUsageTracker,
    promptContent: base.promptContentOwner,
    contextEstimateInput: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).estimateInput,
    selectedContextWindow: (sessionId) =>
      session.contextUsagePolicy.resolve(sessionId).selectedWindow,
    routeHiddenNotification: (notification, sessionId) =>
      session.sessionUpdateProjector.route(notification, {
        appSessionId: sessionId,
        visible: false,
        emitState: () => {
          try {
            emitState()
          } catch (error) {
            safeLogError('compaction state callback failed', error)
          }
        }
      }),
    pushEvent: (event) => session.publication.pushEvent(event),
    emitState,
    errorMessage,
    beforePromptDispatch: async ({ appSessionId, session: active }) => {
      const framework = currentFramework()
      await beforeFrameworkPromptDispatch({
        appSessionId,
        framework,
        providerSessionId: active.sessionId,
        cwd:
          session.sessionRegistry.lookup(appSessionId)?.aggregate.snapshot().cwd ??
          base.snapshotOwner.cwd,
        skillRuntimeAllowlist: []
      })
    },
    serialization: base.providerPromptSerialization,
    usage: {
      begin: (input) => base.providerPromptExecutor.beginObservation(input),
      cwd: (sessionId) =>
        session.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd ??
        base.snapshotOwner.cwd,
      model: () =>
        base.backendGeneration.current.context.model ??
        base.backendGeneration.current.session.model,
      record: async ({ sessionId, eventId, frameworkId, model, completedAtMs, facts }) => {
        if (!options.auxiliaryUsage) return
        const projectId = await options.auxiliaryUsage.projectIdForSession(sessionId)
        if (!projectId) return
        await options.auxiliaryUsage!.record({
          projectId,
          sessionId,
          eventId,
          source: 'context-compaction',
          frameworkId,
          ...(base.backendGeneration.current.providerId
            ? { providerId: base.backendGeneration.current.providerId }
            : {}),
          model,
          completedAtMs,
          usage: {
            ...facts.turnUsage!,
            ...(facts.modelTurnCount === undefined ? {} : { turnCount: facts.modelTurnCount })
          }
        })
      }
    },
    cancelCompaction: async (sessionId) => {
      const connection = base.connectionResources.connection
      const active = activeSession(sessionId)
      if (!connection || !active) {
        throw new Error(`ACP session not found: ${sessionId}`)
      }
      await connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: active.sessionId
      })
    }
  })
  const promptTurnWorkflow = new AcpPromptTurnWorkflow({
    schedules: options.schedules,
    registry: session.sessionRegistry,
    interactions: base.sessionInteractions,
    skills: base.turnSkills,
    preparation: promptPreparation,
    executor: base.providerPromptExecutor,
    serialization: base.providerPromptSerialization,
    contextUsage: base.contextUsageTracker,
    providerReconnectPending: () => base.connectionTransitions.providerReconnectPending,
    finalizer: base.promptOutcomeFinalizer,
    permission: session.permissionContext,
    environment: {
      authorizedDirectories: options.authorizedDirectories,
      connectionGeneration: () => base.connectionResources.epoch,
      backend: () => base.backendGeneration.current,
      tooling: () => session.sessionEnvironment.toolingAvailability(),
      role: () => session.sessionEnvironment.role(),
      bridgeSkillsAvailable: () => base.connectionResources.bridgeSkillsAvailable,
      skillImportEnabled: () => base.sessionCapabilities.isSkillImportEnabled(),
      contextEstimateInput: (sessionId) =>
        session.contextUsagePolicy.resolve(sessionId).estimateInput,
      selectedContextWindow: (sessionId) =>
        session.contextUsagePolicy.resolve(sessionId).selectedWindow,
      ...(options.resolveComputeExecutionTargetIds
        ? { resolveComputeExecutionTargetIds: options.resolveComputeExecutionTargetIds }
        : {}),
      emitSkillActivities,
      onSkillImportAttachmentEligible: callbacks.onSkillImportAttachmentEligible,
      onProviderPromptAccepted: (sessionId, promptAttemptId) => {
        // session/new alone may not create a resumable Claude transcript. Keep approved replay
        // through pre-prompt Skill reconnects, then retire it once the provider accepts a prompt.
        base.handoffContinuity.commitClaudeReplay(sessionId)
        host.onProviderPromptAccepted?.(sessionId)
        callbacks.onProviderPromptAccepted?.(sessionId, promptAttemptId)
      },
      ...(options.runtimeSessions
        ? {
            onRuntimeSessionProviderAccepted: async (
              sessionId: string,
              promptMessageId: string
            ) => {
              await options.runtimeSessions!.consumeReplay(sessionId, promptMessageId)
            }
          }
        : {}),
      sideChatRelays: options.sideChatRelays,
      routeNotification: (notification, sessionId) =>
        session.sessionUpdateProjector.route(notification, { appSessionId: sessionId }),
      artifactPublicationPrompt: host.artifactPublicationPrompt,
      diagnosticContext,
      pushUserMessage: ({ sessionId, promptMessageId, text, attribution }) =>
        session.publication.pushEvent({
          kind: 'message',
          level: 'info',
          sessionId,
          // App-routed prompts (for example an Auditor correction) do not already exist in the
          // renderer store. Reuse the provenance id so the durable graph and Artifact claim share
          // one Prompt owner instead of inventing two identities for the same turn.
          ...(promptMessageId ? { promptMessageId, messageId: promptMessageId } : {}),
          role: 'user',
          ...(attribution ? { attribution } : {}),
          text
        }),
      beforePromptDispatch: beforeFrameworkPromptDispatch,
      prepareNotebookIntent: (request, mode) => {
        const notebook = options.notebook
        if (!notebook) return
        const scope = {
          projectId: projectId(request.sessionId),
          sessionId: request.sessionId,
          messageBranchId: request.provenanceContext?.messageBranchId,
          promptMessageId: request.provenanceContext?.promptMessageId
        }
        const current = notebook.currentExecutionIntent
          ? notebook.currentExecutionIntent(scope)
          : base.sessionCapabilities.notebookExecutionIntentFor(request.sessionId)
        // Lightweight runtime adapters without a Notebook authority port keep their existing
        // presentation-only contract. Production root and child capabilities always carry one.
        if (!notebook.createExecutionIntent && !current && !notebookExecutionIntent(request)) return
        const operation = notebookUserOperation(request)
        let intent = notebookExecutionIntent(request)
        const humanTurn =
          mode.kind === 'user' &&
          mode.runtimeReviewOwner !== 'task' &&
          !request.continuation &&
          !request.suppressUserMessage
        if (humanTurn && operation && notebook.createExecutionIntent) {
          operation.assertCurrent()
          if (operation.projectId && operation.projectId !== scope.projectId)
            throw new Error('Notebook continuation does not belong to this Project.')
          if (
            operation.refusalId &&
            (current?.refusalId !== operation.refusalId ||
              current.scope.messageBranchId !== scope.messageBranchId)
          )
            throw new Error('The Notebook refusal changed. Refresh it before continuing execution.')
          // Ordinary chat may explain a refusal; only the purpose-owned human command creates
          // another executable context after rejection.
          if (current?.refusalId && !operation.refusalId) intent = current
          else {
            intent = notebook.createExecutionIntent(scope)
            intent.prepareUserExecution(operation.refusalId ? operation.assertCurrent : undefined)
          }
        } else if (!intent) {
          const origin =
            request.provenanceContext?.originMessageId ?? request.provenanceContext?.promptMessageId
          intent = origin ? notebook.resolveExecutionIntent?.(scope, origin) : undefined
          if (
            !intent &&
            mode.kind === 'application' &&
            mode.attribution.feature === 'schedule' &&
            !request.provenanceContext?.originMessageId &&
            request.provenanceContext?.promptMessageId
          ) {
            // A trusted scheduled wake keeps the Session's existing execution context, including
            // refusals. Its first context remains pending until the ordinary prompt preparation.
            intent = current?.forDescendant(request.provenanceContext)
            if (!intent && notebook.createExecutionIntent) {
              intent = notebook.createExecutionIntent(scope)
              intent.prepareUserExecution()
            }
          }
        }
        if (!intent) {
          intent = new NotebookExecutionIntent(scope)
          intent.block('originating-execution-context-unavailable')
        }
        markNotebookExecutionIntent(request, intent)
        const promptId = request.provenanceContext?.promptMessageId
        if (promptId) notebook.rememberExecutionIntent?.(scope, promptId, intent)
      },
      observeNotebookExecutionLoop: ({
        appSessionId,
        providerSessionId,
        request,
        signal,
        assertCurrent
      }) => {
        const intent = notebookExecutionIntent(request)
        const credential = base.sessionCapabilities.notebookCredentialFor(appSessionId)
        const connection = base.connectionResources.connection
        const provider = activeSession(appSessionId)
        if (!intent || !credential || !connection || provider?.sessionId !== providerSessionId)
          return () => undefined
        const isCurrent = (): boolean => {
          if (
            signal.aborted ||
            base.connectionResources.connection !== connection ||
            activeSession(appSessionId) !== provider
          )
            return false
          try {
            assertCurrent()
            return base.sessionCapabilities.notebookCredentialFor(appSessionId) === credential
          } catch {
            return false
          }
        }
        let stopObservation: (() => void) | undefined
        const release = intent.observeViolations(credential, () => {
          if (!isCurrent()) return
          log.warn('Notebook Agent repeated a stopped execution', {
            sessionId: appSessionId,
            providerSessionId
          })
          stopObservation = requestPlanReviewProviderStop({
            notify: () =>
              connection.agent.notify(acp.methods.agent.session.cancel, {
                sessionId: providerSessionId
              }),
            isCurrent,
            onUnconfirmed: (reason) => {
              session.publication.pushEvent({
                kind: 'system',
                level: 'error',
                sessionId: appSessionId,
                title: 'Notebook Agent stop was not confirmed',
                text: `Execution remains blocked (${reason}). Repair the Agent runtime before continuing. Already dispatched Notebook work keeps its original owner.`
              })
            }
          })
        })
        const onUserCancellation = (): void => release.acceptUserCancellation()
        signal.addEventListener('abort', onUserCancellation, { once: true })
        return () => {
          release()
          stopObservation?.()
          // The logical interaction can still be draining already dispatched Notebook work.
          // Its real user cancellation remains effective after the Provider has stopped.
        }
      }
    },
    artifacts: {
      open: openArtifact,
      promptMessageIdFor: (artifact) =>
        artifact ? base.artifactTurns?.snapshot(artifact).promptMessageId : undefined,
      publish: publishArtifact,
      dispose: disposeArtifact,
      sealForPublication: async (artifact) =>
        (await base.artifactTurns!.finalize(artifact)) ? 'ready' : 'empty'
    },
    plan: host.plan,
    finalization: {
      errorMessage,
      errorKind: acpErrorKind,
      pushEvent: (event) => {
        if ((event.kind === 'stop' || event.kind === 'error') && event.sessionId) {
          session.sessionUpdateProjector.finishAssistantOutput(event.sessionId)
        }
        session.publication.pushEvent(event)
      },
      ...(options.runtimeSessions
        ? {
            commitTerminal: async (event) => {
              if (event.sessionId)
                session.sessionUpdateProjector.finishAssistantOutput(event.sessionId)
              const durableEvent = {
                ...event,
                id: session.publication.nextEventId(),
                timestamp: event.timestamp ?? Date.now(),
                level: event.level ?? 'info'
              } as AcpRuntimeEvent
              await options.runtimeSessions!.commitTerminal(durableEvent, (published) =>
                session.publication.pushEvent(published)
              )
            },
            retryTerminalCommits: (sessionId: string) =>
              options.runtimeSessions!.retryTerminalCommits(sessionId)
          }
        : {}),
      onPromptEnded: endPromptTurn,
      generationActivityChanged: base.notifyGenerationActivityChanged,
      autoCompact: (sessionId, active, interaction) =>
        contextCompactionWorkflow.compactAutomatic({
          sessionId,
          session: active,
          interaction
        }),
      compactIfIdle: (sessionId) => contextCompactionWorkflow.compactIfIdle(sessionId),
      preemptCompaction: (sessionId) => contextCompactionWorkflow.preemptForPrompt(sessionId)
    },
    currentCwd: () => base.snapshotOwner.cwd,
    resolveProjectId: projectId,
    prepareContinuationReplay: host.reload.prepareContinuationReplay,
    disconnectForReload: host.reload.disconnect,
    resumeAfterReload: host.reload.resume,
    recordAdmittedPrompt: (request) => base.handoffContinuity.recordAdmittedPrompt(request),
    ...(options.runtimeSessions
      ? {
          beginRuntimeSessionTurn: async (
            request,
            executionId,
            reviewOwner,
            planDeliveryCommandId,
            delegatedMessageId,
            applicationPrompt,
            approvedHandoffContinuation,
            continuationAdmission
          ) => {
            const provenance = request.provenanceContext
            if (
              !provenance?.agentFrameId ||
              !provenance.messageBranchId ||
              !provenance.runtimeSegmentId
            ) {
              throw new Error('Runtime Session admission requires a durable conversation path.')
            }
            const aggregate = session.sessionRegistry
              .lookup(request.sessionId)
              ?.aggregate.snapshot()
            const backend = base.backendGeneration.current
            await options.runtimeSessions!.begin(
              {
                projectId: projectId(request.sessionId),
                sessionId: request.sessionId,
                promptMessageId: provenance.promptMessageId,
                agentFrameId: provenance.agentFrameId,
                messageBranchId: provenance.messageBranchId,
                runtimeSegmentId: provenance.runtimeSegmentId,
                executionId
              },
              {
                ...(aggregate?.providerSessionId
                  ? { providerSessionId: aggregate.providerSessionId }
                  : {}),
                ...(backend.providerContinuityToken
                  ? { providerContinuityToken: backend.providerContinuityToken }
                  : {}),
                agentFrameworkId: backend.framework.id,
                ...(backend.backendId ? { agentBackendId: backend.backendId } : {}),
                ...(backend.session.model ? { agentModel: backend.session.model } : {}),
                reviewOwner,
                ...(planDeliveryCommandId ? { planDeliveryCommandId } : {}),
                ...(delegatedMessageId ? { delegatedMessageId } : {}),
                ...(applicationPrompt ? { applicationPrompt } : {}),
                ...(approvedHandoffContinuation ? { approvedHandoffContinuation } : {})
              },
              continuationAdmission
            )
          },
          assertRuntimeSessionAdmissionAvailable: (sessionId: string) =>
            options.runtimeSessions!.assertAdmissionAvailable(sessionId),
          waitForRuntimeSessionTerminalWrites: (sessionId: string, signal: AbortSignal) =>
            options.runtimeSessions!.waitForTerminalWrites(sessionId, signal)
        }
      : {}),
    onPromptStarted: (sessionId, turnToken, promptAttemptId) => {
      startedPromptTurns.set(turnToken, sessionId)
      const scope = base.sessionInteractions.current(sessionId)
      const provenance = scope?.kind === 'prompt' ? scope.provenanceContext : undefined
      recordResourceEvent('prompt-started', {
        runtimeId: base.resourceRuntimeId,
        epoch: base.connectionResources.epoch,
        sessionId,
        turnId: turnToken,
        frameId: provenance?.agentFrameId ?? provenance?.rootFrameId,
        activeBranchId: provenance?.messageBranchId
      })
      callbacks.onPromptStarted?.(sessionId, turnToken, promptAttemptId)
    },
    emitState
  })

  return Object.freeze({ contextCompactionWorkflow, promptTurnWorkflow, releasePromptTurns })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimePromptOwners = ReturnType<typeof composeAcpRuntimePromptOwners>

export { composeAcpRuntimePromptOwners }
export type { AcpRuntimePromptHost, AcpRuntimePromptOwners }
