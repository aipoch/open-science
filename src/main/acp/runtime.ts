import type { NetworkApprovalRecordStatus } from '../../shared/sandbox-network-approval'
import {
  registerResourceObservation,
  recordResourceEvent,
  recordResourceSnapshot,
  type ResourceFacts
} from '../resource-diagnostics/recorder'
import type {
  ActiveSession,
  ClientConnection,
  PromptResponse,
  SessionConfigOption
} from '@agentclientprotocol/sdk'
import * as acp from '@agentclientprotocol/sdk'
import { redactSensitiveText } from '@aipoch/diagnostics'
import { createLogger, diagnosticErrorFields, errorLogFields } from '@aipoch/diagnostics/node'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import {
  ACP_APP_CONTINUATION_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpCancelPromptRequest,
  type AcpCompactSessionRequest,
  type AcpConnectRequest,
  type AcpCreateSessionRequest,
  type AcpCreateSessionResponse,
  type AcpDeleteSessionRequest,
  type AcpPermissionResponse,
  type AcpPromptRequest,
  type AcpResumeSessionRequest,
  type AcpRevokePermissionGrantRequest,
  type AcpRuntimeEventInput,
  type AcpRuntimeState,
  type AcpSetPermissionProfileRequest,
  type AcpStateSnapshot,
  type AcpSteerFollowUpRequest,
  type AcpSteerFollowUpResult,
  type ElicitationResponse
} from '../../shared/acp'
import type { AppGeneratedArtifactProducer } from '../../shared/artifact-provenance'
import type { ArtifactFile } from '../../shared/artifacts'
import type { AgentUserChoiceRequest, AgentUserChoiceResult } from '../../shared/elicitation'
import { resolveFileTextBudget } from '../../shared/history-preamble'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type { ResolvedReasoningEffort } from '@aipoch/providers'
import { sanitizeSessionReferences } from '../../shared/session-persistence'
import type { MessageAttribution } from '../../shared/session-message-contract'
import type {
  ActivePlanProjection,
  PlanResponseCommand,
  PlanResponseIdentity
} from '../../shared/session-plan/contract'
import type { AgentFrameworkId } from '../../shared/settings'
import { isCodexSubscriptionProviderId } from '../../shared/settings-runtime'
import { renderAppMcpToolReferences } from '../agent-framework/app-mcp-names'
import { codeBuddyStorageDir } from '../agent-framework/codebuddy'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { opencodeStorageDir } from '../agent-framework/opencode'
import type {
  AgentFramework,
  AgentModelChangeTarget,
  ResolvedAgentBackend
} from '../agent-framework/types'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import { LITERATURE_MCP_SERVER_NAME } from '../literature/mcp-contract'
import type { PlanResponseResult } from '../session-plan/plan-service'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { withDataRootWrite } from '../storage/migration-state'
import {
  AcpAgentConnectionAdapter,
  type AcpAgentConnectionCandidate,
  type AcpAgentConnectionHooks
} from './agent-connection-adapter'
import type { AcpAppContinuationOwner } from './app-continuation-owner'
import { artifactPublicationContinuationText } from './artifact-publication-continuation'
import type { ArtifactTurnOwner } from './artifact-turn-owner'
import type {
  AcpBackendGenerationOwner,
  AcpBackendGenerationView
} from './backend-generation-owner'
import type { AcpConnectionCloseWorkflow } from './connection-close-workflow'
import type { AcpConnectionLifecycleWorkflow } from './connection-lifecycle-workflow'
import type {
  AcpConnectionResourceAttempt,
  AcpConnectionResourceOwner
} from './connection-resource-owner'
import type { AcpConnectionTransitionOwner } from './connection-transition-owner'
import type { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import type { AcpElicitationOwner } from './elicitation-owner'
import type { AcpGenerationActivityOwner } from './generation-activity-owner'
import type { AcpHandoffContinuityOwner } from './handoff-continuity-owner'
import { buildLiteratureReferencePrompt } from './literature-reference-prompt'
import type { AcpModelChangeWorkflow } from './model-change-workflow'
import {
  AcpNativeFollowUpWorkflow,
  finalizeNativeFollowUpPreparedContent,
  type NativeFollowUpPreparedContent
} from './native-follow-up-workflow'
import { type AppPermissionRequest, type RestoredPermissionContinuation } from './permission-broker'
import type { AcpPermissionContext } from './permission-context'
import { HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import { requestPlanReviewProviderStop } from './plan-review-provider-stop'
import { markNotebookExecutionIntent } from '../notebook/execution-intent'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import type { AcpPromptTurnWorkflow } from './prompt-turn-workflow'
import type { AcpProviderPromptExecutor } from './provider-prompt-executor'
import type { AcpProviderSessionCreator } from './provider-session-creator'
import type {
  AcpProviderSessionResumer,
  AcpSessionWriterTransfer
} from './provider-session-resumer'
import { RepeatedToolFailureGuard } from './repeated-tool-failure-guard'
import type {
  ReviewerSessionDisposition,
  ReviewerSessionOwner,
  ReviewerSessionRequest,
  ReviewerSessionResult
} from './reviewer-session-owner'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeArtifactOptions, AcpRuntimeOptions } from './runtime-contract'
import { composeAcpRuntimeContinuations } from './runtime-continuation-composition'
import {
  PERMISSION_DENIED_CONTINUATION_TEXT,
  type AcpPermissionContinuationWorkflow
} from './permission-continuation-workflow'
import type { AcpQuestionContinuationWorkflow } from './question-continuation-workflow'
import { composeAcpRuntimeLifecycleOwners } from './runtime-lifecycle-composition'
import {
  composeAcpRuntimePlanWorkflow,
  composeAcpRuntimePlanContinuations,
  type AcpRuntimePlanWorkflow,
  type AcpSessionPlanCall
} from './runtime-plan-composition'
import { composeAcpRuntimePromptOwners } from './runtime-prompt-composition'
import { composeAcpRuntimeProviderSessionOwners } from './runtime-provider-session-composition'
import type { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import type { AcpSessionCapabilityOwner } from './session-capability-owner'
import type { AcpSessionConfigurator } from './session-configurator'
import type { AcpSessionDeletionWorkflow } from './session-deletion-workflow'
import type { AcpSessionEnvironmentPolicy } from './session-environment-policy'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpPlanContinuationWorkflow } from './plan-continuation-workflow'
import { buildSessionReferencePrompt } from './session-reference-prompt'
import type { AcpSessionRegistry } from './session-registry'
import type { AcpSessionReplacementWorkflow } from './session-replacement-workflow'
import type {
  AcpSessionUpdateProjector,
  AcpToolFailureDiagnostic
} from './session-update-projector'
import {
  codeBuddySkillRuntimeRoot,
  followUpPromptText,
  type AcpTurnSkillOwner
} from './turn-skill-owner'
export type { AcpRuntimeCallbacks } from './runtime-contract'

// Converts unknown thrown values into user-visible error text. Total AND always returns a string: a
// hostile message getter or a throwing String() coercion (e.g. a Proxy-wrapped Error) must not escape,
// and a non-string message (object/bigint/Symbol/undefined) must be coerced — this text flows into the
// state snapshot and event payloads that get structured-cloned to the renderer, where a raw Symbol or
// throwing value would break the broadcast.
const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const log = createLogger('acp')

const literatureLog = createLogger('literature-reading-context')

const AGENT_STDERR_REPORT_WINDOW_MS = 1000
const MAX_RAW_AGENT_STDERR_SAMPLE_BYTES = 4096
const CODEX_TRANSPORT_SIGNAL_SAMPLE_CHARACTERS = 512
// Support-only opt-in. Raw agent stderr can contain research data, local paths, and tool output.
const RAW_AGENT_STDERR_ENV = 'OPEN_SCIENCE_AGENT_STDERR'

// Preserve the renderer's existing suppression for the two exact informational diagnostics Codex
// emits during successful turns. Evaluate each adapter-delivered stderr block independently, as the
// pre-aggregation event path did; any additional content makes the whole window actionable.
const isNonActionableCodexStderr = (text: string): boolean => {
  const withoutSkillBudgetNotice = text.replace(
    /Warning:\s*Skill descriptions were shortened to fit the 2% skills context budget\.\s*Codex can still see every skill, but some descriptions are shorter\.\s*Disable unused skills or plugins to leave more room for the rest\.\s*/gi,
    ''
  )
  const withoutTransportFallback = withoutSkillBudgetNotice.replace(
    /Warning:\s*Falling\s*back\s*from\s*WebSockets\s*to\s*HTTPS\s*transport\.\s*request\s*timed\s*out\s*/gi,
    ''
  )

  return withoutTransportFallback.trim().length === 0
}

const hasCodexWebSocketFallback = (text: string): boolean =>
  /Warning:\s*Falling\s*back\s*from\s*WebSockets\s*to\s*HTTPS\s*transport\.\s*request\s*timed\s*out\s*/i.test(
    text
  )

type AgentStderrWindow = {
  process: ChildProcessWithoutNullStreams
  framework: AgentFrameworkId
  epoch: number
  startedAt: number
  chunkCount: number
  byteCount: number
  rawSample: string
  rawSampleBytes: number
  rawSampleTruncated: boolean
  sessionId?: string
  interactionSequence?: number
  sessionAttributionConsistent: boolean
  nonActionableCodexOnly: boolean
  codexTransportSignalSample: string
  codexWebSocketFallbackObserved: boolean
  eventEligible: boolean
  timer?: ReturnType<typeof setTimeout>
}

// Logs an error without ever throwing back into the caller. Used on failure paths where a throwing
// logger (or a hostile payload) must never mask the original error being handled/re-thrown.
const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

// ACP Session facade. Connection publication and physical teardown live behind their epoch owner;
// Runtime retains protocol startup, Session/Permission/Notebook cleanup, and status/event projection.
class AcpRuntime {
  private readonly snapshotOwner: AcpRuntimeSnapshotOwner
  private readonly connectionAdapter: AcpAgentConnectionAdapter
  private readonly connectionResources: AcpConnectionResourceOwner
  private readonly connectionTransitions: AcpConnectionTransitionOwner
  private readonly generationActivity: AcpGenerationActivityOwner
  // Stable app identities, provider aliases, publication order, selection, and startup/delete
  // arbitration share one owner. The runtime retains only protocol/resource orchestration.
  private readonly sessionRegistry: AcpSessionRegistry
  private readonly sessionEfforts = new WeakMap<ActiveSession, ResolvedReasoningEffort>()
  // App-owned MCP construction, routing aliases, and bearer lease ownership are kept behind one
  // explicit role policy. Connection/process lifetime remains with the connection resource owner.
  private readonly sessionInteractions: AcpSessionInteractionOwner
  readonly hasPendingSideChatInteraction: (sessionId: string) => boolean
  private readonly elicitationOwner: AcpElicitationOwner
  private readonly appContinuations: AcpAppContinuationOwner
  private readonly durableContinuationContext: AcpRuntimeSessionOwners['durableContinuationContext']
  private readonly sandboxNetworkApprovalOwner: AcpRuntimeSessionOwners['sandboxNetworkApprovalOwner']
  private readonly permissionContinuations: AcpPermissionContinuationWorkflow
  private readonly questionContinuations: AcpQuestionContinuationWorkflow
  private readonly permissionWaitOwner: AcpRuntimeSessionOwners['permissionWaitOwner']
  private readonly planContinuations: AcpPlanContinuationWorkflow
  // Incomplete lines belong to the process stream, not the one-second reporting window.
  private readonly agentStderrTails = new WeakMap<
    ChildProcessWithoutNullStreams,
    {
      text: string
      discarding: boolean
      window: AgentStderrWindow
    }
  >()
  private readonly agentStderrWindows = new Map<ChildProcessWithoutNullStreams, AgentStderrWindow>()
  // Ephemeral Reviewer identity, isolation, permission, and resource state lives behind one owner.
  private readonly reviewerSessions: ReviewerSessionOwner
  private readonly turnSkills: AcpTurnSkillOwner
  private readonly handoffContinuity: AcpHandoffContinuityOwner
  private readonly permissionContext: AcpPermissionContext
  private readonly clientInteractions: AcpRuntimeSessionOwners['clientInteractions']
  private readonly publication: AcpRuntimePublicationOwner
  private readonly sessionEnvironment: AcpSessionEnvironmentPolicy
  private readonly spawnAgent: (() => ChildProcessWithoutNullStreams) | undefined
  private readonly backendGeneration: AcpBackendGenerationOwner
  private readonly sessionConfigurator: AcpSessionConfigurator
  private readonly sessionCapabilities: AcpSessionCapabilityOwner
  private readonly sessionUpdateProjector: AcpSessionUpdateProjector
  private readonly providerPromptExecutor: AcpProviderPromptExecutor
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly artifactTurns: ArtifactTurnOwner | undefined
  private readonly sessionPlanWorkflow: AcpRuntimePlanWorkflow
  private readonly contextCompactionWorkflow: AcpContextCompactionWorkflow
  private readonly promptTurnWorkflow: AcpPromptTurnWorkflow
  private readonly promptContent: AcpPromptContentOwner
  private readonly nativeFollowUp: AcpNativeFollowUpWorkflow
  private readonly connectionClose: AcpConnectionCloseWorkflow
  private readonly connectionLifecycle: AcpConnectionLifecycleWorkflow
  private readonly modelChanges: AcpModelChangeWorkflow
  private readonly providerSessionCreator: AcpProviderSessionCreator
  private readonly providerSessionResumer: AcpProviderSessionResumer
  private readonly sessionReplacement: AcpSessionReplacementWorkflow
  private readonly sessionDeletion: AcpSessionDeletionWorkflow
  private readonly permissionProfileChanges = new Map<
    string,
    { revision: number; tail: Promise<void> }
  >()
  private cancellationTeardown: Promise<AcpStateSnapshot> | undefined
  private readonly repeatedToolFailureGuard = new RepeatedToolFailureGuard()
  private readonly resourceRuntimeId: string

  // Wires runtime dependencies and forwards permission prompts into the event stream.
  constructor(
    private readonly options: AcpRuntimeOptions,
    base: AcpRuntimeBaseOwners,
    session: AcpRuntimeSessionOwners
  ) {
    this.spawnAgent = options.spawnAgent
    this.resourceRuntimeId = base.resourceRuntimeId
    this.artifactOptions = options.artifacts
    this.snapshotOwner = base.snapshotOwner
    this.connectionAdapter = base.connectionAdapter
    this.connectionResources = base.connectionResources
    this.backendGeneration = base.backendGeneration
    this.providerPromptExecutor = base.providerPromptExecutor
    this.sessionInteractions = base.sessionInteractions
    this.artifactTurns = base.artifactTurns
    this.handoffContinuity = base.handoffContinuity
    this.generationActivity = base.generationActivity
    this.connectionTransitions = base.connectionTransitions
    this.turnSkills = base.turnSkills
    this.sessionConfigurator = base.sessionConfigurator
    this.sessionCapabilities = base.sessionCapabilities
    this.sessionRegistry = session.sessionRegistry
    this.sessionEnvironment = session.sessionEnvironment
    this.publication = session.publication
    this.permissionContext = session.permissionContext
    this.clientInteractions = session.clientInteractions
    this.elicitationOwner = session.elicitationOwner
    this.hasPendingSideChatInteraction = (sessionId) =>
      this.permissionContext.hasPendingForSession(sessionId) ||
      this.elicitationOwner
        .getPendingRequests()
        .some((request) => request.sessionId === sessionId) ||
      base.planInteractions.hasPendingApproval(sessionId) ||
      options.hasPendingCredentialRequest?.(sessionId) === true

    this.durableContinuationContext = session.durableContinuationContext
    this.sandboxNetworkApprovalOwner = session.sandboxNetworkApprovalOwner
    this.permissionWaitOwner = session.permissionWaitOwner
    const continuations = composeAcpRuntimeContinuations(options, base, session, {
      schedule: (sessionId) => this.schedulePendingAppContinuation(sessionId),
      sendPermission: (request, permission, onProviderDispatched) =>
        this.sendDurableAppContinuation(request, {
          permissionContinuation: permission,
          onProviderDispatched
        })
    })
    this.permissionContinuations = continuations.permissions
    this.questionContinuations = continuations.questions
    const planContinuations = composeAcpRuntimePlanContinuations(options, session, {
      scheduleContinuation: (sessionId) => this.schedulePendingAppContinuation(sessionId),
      send: (request, delivery, onProviderDispatched) =>
        this.sendDurableAppContinuation(request, {
          promptAttemptId: delivery?.commandId,
          planDelivery: delivery,
          onProviderDispatched
        }),
      projection: (projectId, sessionId) =>
        this.sessionPlanWorkflow.projection(projectId, sessionId)
    })
    this.planContinuations = planContinuations.workflow
    this.appContinuations = session.appContinuations
    this.reviewerSessions = session.reviewerSessions
    this.sessionUpdateProjector = session.sessionUpdateProjector
    this.sessionPlanWorkflow = composeAcpRuntimePlanWorkflow(options, base, session, {
      deliveries: planContinuations.deliveries,
      pauseProvider: (sessionId, sequence) => {
        const connection = this.connection
        const provider = this.activeSessionFor(sessionId)
        return requestPlanReviewProviderStop({
          ...(connection && provider
            ? {
                notify: () =>
                  connection.agent.notify(acp.methods.agent.session.cancel, {
                    sessionId: provider.sessionId
                  })
              }
            : {}),
          isCurrent: () => this.sessionInteractions.current(sessionId)?.sequence === sequence,
          onUnconfirmed: (reason) => {
            this.pushEvent({
              kind: 'error',
              level: 'error',
              sessionId,
              title: 'Could not pause the Agent for Plan review',
              text:
                reason === 'unavailable'
                  ? 'The Provider connection is unavailable. The Plan remains pending.'
                  : reason === 'notification-failed'
                    ? 'The Provider stop request could not be delivered. The connection will close; the Plan remains pending.'
                    : 'Provider stop was not confirmed. The connection will close; the Plan remains pending.'
            })
            void this.disconnect()
          }
        })
      }
    })
    const prompt = composeAcpRuntimePromptOwners(options, base, session, {
      refreshNotebookConnection: (input) =>
        this.providerSessionResumer.refreshNotebookConnection(input),
      onProviderPromptAccepted: (sessionId) => {
        this.durableContinuationContext.clearContextReset(sessionId)
      },
      plan: this.sessionPlanWorkflow.prompt,
      reload: {
        prepareContinuationReplay: async (request) => {
          // Approved Claude replay already owns the prior task and committed switch result. A
          // generic transcript fallback would reintroduce the old provider's cancellation denial.
          if (this.handoffContinuity.peekClaudeReplay(request.sessionId)) return {}
          const promptMessageId = request.provenanceContext?.promptMessageId
          if (!promptMessageId) {
            throw new Error('App continuation history requires its originating Message.')
          }
          const continuation = await this.durableContinuationContext.prepare({
            projectId: this.resolveSessionProjectId(request.sessionId),
            sessionId: request.sessionId,
            promptMessageId,
            forceReplay: true
          })
          return continuation.historyReplay
        },
        disconnect: () => this.disconnect(false),
        resume: (request, retainStartup) =>
          this.resumeSession(request, undefined, () => {
            const token = Symbol('reloaded-prompt-startup')
            const startupGeneration = this.connectionGeneration
            const logProtection = (phase: 'acquired' | 'released', reason?: string): void => {
              try {
                log.info('prompt reload startup protection', {
                  runtimeId: this.resourceRuntimeId,
                  sessionId: request.sessionId,
                  startupGeneration,
                  ...this.diagnosticContext(),
                  phase,
                  ...(reason ? { reason } : {}),
                  ...this.generationActivity.diagnosticSnapshot(),
                  ...this.connectionTransitions.diagnosticSnapshot()
                })
              } catch {
                // Diagnostics must not interrupt protection ownership or mask the prompt outcome.
              }
            }
            this.generationActivity.acquireStartup(token)
            retainStartup((reason) => {
              this.generationActivity.releaseStartup(token)
              logProtection('released', reason)
            })
            logProtection('acquired')
          })
      },
      artifactPublicationPrompt: (sessionId, files) => {
        if (this.appContinuations.has(sessionId)) return undefined
        const tool = renderAppMcpToolReferences(
          this.backendGeneration.current.framework.id,
          'write_artifact_file'
        )
        return artifactPublicationContinuationText(files, tool)
      },
      onPromptEnded: (sessionId, turnToken) => this.nativeFollowUp.releaseTurn(sessionId, turnToken)
    })
    this.contextCompactionWorkflow = prompt.contextCompactionWorkflow
    this.promptTurnWorkflow = prompt.promptTurnWorkflow
    this.promptContent = base.promptContentOwner
    this.nativeFollowUp = new AcpNativeFollowUpWorkflow({
      connection: () => this.connection,
      capabilities: () => this.connectionResources.capabilities,
      frameworkId: () => this.framework.id,
      openCodeUsageApi: () => this.backendGeneration.openCodeUsageApi(),
      activeProviderSessionId: (sessionId) => this.activeSessionFor(sessionId)?.sessionId,
      hasLivePrompt: (sessionId) => this.sessionInteractions.current(sessionId)?.kind === 'prompt',
      hasPendingPermission: (sessionId) => this.permissionContext.hasPendingForSession(sessionId),
      hasPendingSideChatInteraction: this.hasPendingSideChatInteraction,
      livePrompt: (sessionId) => {
        const current = this.sessionInteractions.current(sessionId)
        return current?.kind === 'prompt'
          ? {
              turnToken: current.turnToken,
              signal: current.signal,
              ...(current.promptMessageId ? { promptMessageId: current.promptMessageId } : {})
            }
          : undefined
      },
      sessionCwd: (sessionId) => this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd,
      prepareFollowUp: (request) => this.prepareNativeFollowUpContent(request),
      ...(this.options.notebook?.prepareTurnInputs
        ? { prepareTurnInputs: this.options.notebook.prepareTurnInputs }
        : {}),
      publishUserMessage: ({ sessionId, messageId, text, uploads, parts }) => {
        // Native injection clarifies the currently running dispatch. It never mints another
        // Notebook grant, including when its original intent has already been refused.
        const intent = base.sessionCapabilities.notebookExecutionIntentFor(sessionId)
        if (intent)
          options.notebook?.rememberExecutionIntent?.(
            { projectId: this.sessionEnvironment.projectId(sessionId), sessionId },
            messageId,
            intent
          )
        this.publication.pushEvent({
          kind: 'message',
          level: 'info',
          sessionId,
          messageId,
          role: 'user',
          text,
          ...(uploads && uploads.length > 0 ? { uploads: [...uploads] } : {}),
          ...(parts && parts.length > 0 ? { parts: [...parts] } : {})
        })
      }
    })
    const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, {
      connect: (request) => this.connect(request),
      disconnect: (emitClosedStatus) => this.disconnect(emitClosedStatus),
      releasePromptTurns: prompt.releasePromptTurns,
      clearPromptResources: () => this.nativeFollowUp.clear(),
      openAgentConnection: (attempt, onFrameworkResolved) =>
        this.openAgentConnection(attempt, onFrameworkResolved)
    })
    this.modelChanges = lifecycle.modelChanges
    this.connectionClose = lifecycle.connectionClose
    this.connectionLifecycle = lifecycle.connectionLifecycle
    const providerSessions = composeAcpRuntimeProviderSessionOwners(
      options,
      base,
      session,
      lifecycle,
      {
        clearUserChoiceProvenanceForSession: (sessionId) =>
          this.questionContinuations.clearSession(sessionId),
        releasePromptResourcesForSession: (sessionId) =>
          this.nativeFollowUp.releaseSession(sessionId)
      }
    )
    this.providerSessionCreator = providerSessions.providerSessionCreator
    this.providerSessionResumer = providerSessions.providerSessionResumer
    this.sessionReplacement = providerSessions.sessionReplacement
    this.sessionDeletion = providerSessions.sessionDeletion
    session.bindToolFailureObserver((failure) => this.handleToolFailure(failure))
    registerResourceObservation(this, this.resourceRuntimeId)
  }

  resourceDiagnosticSnapshot(): ResourceFacts {
    const sessions = this.sessionRegistry.entries(true)
    const interactions = this.sessionInteractions.snapshot()
    return {
      epoch: this.connectionResources.epoch,
      framework: this.framework.id,
      status: this.snapshotOwner.status,
      ...this.generationActivity.diagnosticSnapshot(),
      ...this.connectionTransitions.diagnosticSnapshot(),
      sessions: sessions.slice(0, 256).map(({ appSessionId, attachment, aggregate }) => ({
        sessionId: appSessionId,
        providerSessionId: attachment?.providerSessionId,
        generation: attachment?.generation,
        projectId: aggregate.snapshot().projectId
      })),
      interactions: interactions.slice(0, 256).map(({ sessionId, kind }) => {
        const scope = this.sessionInteractions.current(sessionId)
        const provenance = scope?.kind === 'prompt' ? scope.provenanceContext : undefined
        return {
          sessionId,
          kind,
          sequence: scope?.sequence,
          turnId: scope?.kind === 'prompt' ? scope.turnToken : undefined,
          frameId: provenance?.agentFrameId ?? provenance?.rootFrameId,
          activeBranchId: provenance?.messageBranchId
        }
      }),
      inFlight: this.getInFlightSessionIds().slice(0, 256),
      truncated: sessions.length > 256 || interactions.length > 256
    }
  }

  private handleToolFailure(failure: AcpToolFailureDiagnostic): void {
    const interaction = this.sessionInteractions.current(failure.sessionId)
    if (interaction?.kind !== 'prompt' || interaction.signal.aborted) return
    if (
      !this.repeatedToolFailureGuard.observe({
        interactionSequence: interaction.sequence,
        reason: failure.reason,
        sessionId: failure.sessionId,
        tool: failure.tool,
        toolCallId: failure.toolCallId
      })
    ) {
      return
    }

    log.warn('stopping prompt after repeated MCP input validation failures', {
      sessionId: failure.sessionId,
      tool: failure.tool
    })
    void this.cancelPrompt({ sessionId: failure.sessionId }).catch((error) => {
      this.repeatedToolFailureGuard.clearSession(failure.sessionId)
      safeLogError('repeated MCP input validation cancellation failed', errorLogFields(error))
    })
  }

  private get backend(): AcpBackendGenerationView {
    return this.backendGeneration.current
  }

  private get framework(): AgentFramework {
    return this.backend.framework
  }

  private get connection(): ClientConnection | undefined {
    return this.connectionResources.connection
  }

  get cleanupConfirmed(): boolean {
    return this.connectionResources.cleanupConfirmed
  }

  private get reconnectBarrier(): Promise<void> | undefined {
    return this.connectionTransitions.barrier
  }

  private get connectionGeneration(): number {
    return this.connectionResources.epoch
  }

  private activeSessionFor(appSessionId: string): ActiveSession | undefined {
    return this.sessionRegistry.lookup(appSessionId)?.attachment?.session
  }

  private activeSessionEntries(): Array<readonly [string, ActiveSession]> {
    return this.sessionRegistry
      .entries(true)
      .flatMap(({ appSessionId, attachment }) =>
        attachment ? [[appSessionId, attachment.session] as const] : []
      )
  }

  private activeSessionIds(): string[] {
    return this.activeSessionEntries().map(([appSessionId]) => appSessionId)
  }

  // Boundary-safe context for session-creation and process-spawn diagnostics. Keep this list explicit:
  // workspace paths, request/provider payloads, model research content, and credentials do not belong
  // in these lifecycle records.
  private diagnosticContext(
    framework: AgentFramework['id'] = this.framework.id,
    generation = this.connectionGeneration
  ): { framework: AgentFramework['id']; generation: number; status: AcpStateSnapshot['status'] } {
    return { framework, generation, status: this.snapshotOwner.status }
  }

  // Returns an immutable renderer-facing view of connection and session state.
  getSnapshot(): AcpStateSnapshot {
    return this.publication.getSnapshot()
  }

  getState(): AcpRuntimeState {
    return this.publication.getState()
  }

  captureBackend(): AcpBackendGenerationView {
    return this.backend
  }

  beginProviderTurnObservation(input: {
    providerSessionId: string
    cwd: string
  }): ReturnType<AcpProviderPromptExecutor['beginObservation']> {
    return this.providerPromptExecutor.beginObservation({
      ...input,
      frameworkId: this.framework.id
    })
  }

  captureSessionModel(
    sessionId: string
  ): Readonly<{ backend: AcpBackendGenerationView; appliedModel?: string }> | undefined {
    const record = this.sessionRegistry.lookup(sessionId)
    if (!record?.attachment) return undefined
    const aggregate = record.aggregate.snapshot()
    const effort = this.sessionEfforts.get(record.attachment.session)
    let backend = this.backend
    if (effort !== undefined) {
      const session = { ...backend.session }
      if (effort === 'default') delete session.effort
      else session.effort = effort
      backend = Object.freeze({ ...backend, session: Object.freeze(session) })
    }
    return Object.freeze({
      backend,
      ...(aggregate.appliedModel ? { appliedModel: aggregate.appliedModel } : {})
    })
  }

  getPermissionPrompts(sessionId: string): 'none' | undefined {
    const interaction = this.sessionInteractions.current(sessionId)
    return interaction?.kind === 'prompt' ? interaction.permissionPrompts : undefined
  }

  callSessionPlan(input: AcpSessionPlanCall): Promise<unknown> {
    return this.sessionPlanWorkflow.call(input)
  }

  getSessionPlanProjection(
    projectId: string,
    sessionId: string
  ): Promise<ActivePlanProjection | null> {
    return this.sessionPlanWorkflow.projection(projectId, sessionId)
  }

  discardUnavailableSessionPlan(input: PlanResponseIdentity): Promise<{ revision: number }> {
    return this.sessionPlanWorkflow.discardUnavailable(input)
  }

  async respondSessionPlan(input: PlanResponseCommand): Promise<PlanResponseResult> {
    const result = await this.sessionPlanWorkflow.respond(input)
    if (result.deliveryCommandId) this.planContinuations.schedule(input.projectId, input.sessionId)
    const response = { ...result }
    Reflect.deleteProperty(response, 'deliveryCommandId')
    return response
  }

  // Lists sessions with an in-flight prompt, for the pre-migration active-session warning.
  getActivePromptSessions(): { projectId: string; sessionId: string }[] {
    return this.getInFlightSessionIds().map((sessionId) => ({
      projectId: this.resolveSessionProjectId(sessionId),
      sessionId
    }))
  }

  // Durable human decisions survive quit; closing their provider RPC must not cancel the card.
  getQuitBlockingPromptSessions(): { projectId: string; sessionId: string }[] {
    const durableQuestionSessions = new Set(
      this.elicitationOwner
        .getPendingRequests()
        .filter((request) => request.durable)
        .map((request) => request.sessionId)
    )
    return this.getInFlightSessionIds()
      .filter(
        (sessionId) =>
          !this.permissionContext.hasDurablePendingForSession(sessionId) &&
          !durableQuestionSessions.has(sessionId)
      )
      .map((sessionId) => ({
        projectId: this.resolveSessionProjectId(sessionId),
        sessionId
      }))
  }

  hasLiveSession(projectId: string, sessionId: string): boolean {
    return (
      this.activeSessionFor(sessionId) !== undefined &&
      this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectId === projectId
    )
  }

  sessionMemorySignal(sessionId: string): AbortSignal | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.memorySignal()
  }

  isSessionMemoryEnabled(sessionId: string): boolean {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().memoryEnabled ?? false
  }

  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    const aggregate = this.sessionRegistry.lookup(sessionId)?.aggregate
    if (!aggregate) throw new Error(`ACP session not found: ${sessionId}`)
    aggregate.setMemoryEnabled(enabled)
    this.emitState()
  }

  liveSessionProjectId(sessionId: string): string | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectId
  }

  isSessionReferenceAllowed(sessionId: string, referencedSessionId: string): boolean {
    return this.sessionInteractions.isSessionReferenceAllowed(sessionId, referencedSessionId)
  }

  // Handoff adapters select their framework without reaching into session ownership maps. The
  // framework recorded here is the one that provisioned this logical session, including after a
  // coordinator generation rotation.
  isSessionUsingFramework(sessionId: string, frameworkId: AgentFrameworkId): boolean {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId === frameworkId
  }

  captureHandoffSessionResume(
    sessionId: string
  ): (specialistId: string | undefined) => Promise<void> {
    const entry = this.sessionRegistry.lookup(sessionId)
    const snapshot = entry?.aggregate.snapshot()
    if (!entry?.attachment || !snapshot?.cwd) {
      throw new Error(`ACP session not found: ${sessionId}`)
    }
    const providerSessionId = entry.attachment.providerSessionId
    return (specialistId) =>
      this.withOperationLease(async () => {
        const current = this.sessionRegistry.lookup(sessionId)
        if (current?.aggregate !== entry.aggregate) {
          throw new Error('The approved handoff Session was superseded.')
        }
        if (current.attachment) return
        current.aggregate.setSpecialistId(specialistId)
        current.aggregate.setSpecialistPrefix(undefined)
        // Forced Specialist Skills are unloaded when the old prompt ends. Reattach the same provider
        // history only after that teardown, using the newly approved scope and the captured affinity.
        const resumed = await this.providerSessionResumer.reconfigure({
          sessionId,
          providerSessionId,
          cwd: snapshot.cwd!,
          projectId: snapshot.projectId,
          previousFrameworkId: snapshot.frameworkId,
          previousBackendId: snapshot.backendId,
          permissionProfile: snapshot.permissionProfile?.selectedProfile,
          memoryEnabled: snapshot.memoryEnabled,
          specialistId
        })
        if (resumed.contextReset)
          throw new Error('The approved handoff provider history could not be restored.')
      })
  }

  prepareClaudeCodeHandoffReplay(input: ClaudeCodeReplayInput): void {
    this.handoffContinuity.stageClaudeReplay(input)
  }

  discardClaudeCodeHandoffReplay(sessionId: string): void {
    this.handoffContinuity.discardClaudeReplay(sessionId)
  }

  createClaudeCodeContinuationRequest(input: {
    sessionId: string
    switchReadBack: ApprovedSwitchReadBack
  }): AcpPromptRequest {
    return this.handoffContinuity.createClaudeContinuation(input)
  }

  authorizeApprovedHandoffContinuation(
    sessionId: string,
    promptMessageId: string,
    executionId: string,
    isCurrent: () => boolean
  ): number | undefined {
    return this.options.runtimeSessions?.authorizeApprovedHandoffContinuation(
      sessionId,
      promptMessageId,
      executionId,
      isCurrent
    )
  }

  async reportApprovedHandoffFailure(
    sessionId: string,
    promptMessageId: string,
    executionId: string,
    isCurrent: () => boolean,
    originalStartedAt?: number
  ): Promise<void> {
    const event = {
      id: this.publication.nextEventId(),
      timestamp: Date.now(),
      kind: 'error' as const,
      level: 'error' as const,
      sessionId,
      promptMessageId,
      promptExecutionId: executionId,
      title: 'Specialist handoff failed',
      text: 'The approved specialist could not continue the current task.'
    }
    if (this.options.runtimeSessions && originalStartedAt !== undefined) {
      await this.options.runtimeSessions.commitApprovedHandoffFailure(
        event,
        (published) => {
          this.pushEvent(published)
        },
        isCurrent,
        originalStartedAt
      )
    } else if (!this.options.runtimeSessions && isCurrent()) {
      this.pushEvent(event)
    }
  }

  private getInFlightSessionIds(): string[] {
    const interactions = this.sessionInteractions.snapshot()
    return Array.from(
      new Set([
        ...interactions.filter(({ kind }) => kind === 'prompt').map(({ sessionId }) => sessionId),
        ...interactions
          .filter(({ kind }) => kind === 'compaction')
          .map(({ sessionId }) => sessionId),
        ...this.appContinuations.sessionIds()
      ])
    )
  }

  // Accepts a model selection without interrupting a live generation. The picker may keep changing
  // while work is active; one pending slot deliberately makes the latest selection win. New runtime
  // operations wait on the barrier, while the operation that was already admitted finishes against
  // the old model.
  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    return this.modelChanges.apply(target)
  }

  // Live-applies a reasoning-effort change to every open session when the generation is idle. A
  // prompt or background activity keeps its admitted model/effort immutable; returning false lets
  // the settings workflow defer the new persisted effort through its reconnect path. The same
  // fallback covers frameworks that carry effort only in baked spawn config and genuine live-update
  // failures. On success the generation view tracks the new level, so sessions created later in this
  // process inherit it; the persisted setting covers the next respawn.
  async applyReasoningEffortChange(effort: ResolvedReasoningEffort): Promise<boolean> {
    if (!this.modelChanges.barrier && this.generationActivity.blocksLiveEffortChange()) return false
    return this.modelChanges.applyReasoningEffort(effort)
  }

  // Starts a fresh agent process connection and initializes protocol capabilities.
  async connect(request: AcpConnectRequest = {}): Promise<AcpStateSnapshot> {
    return this.withOperationLease(() => this.connectionLifecycle.connect(request))
  }

  // Creates a protocol session, injects artifact tooling, and uses the returned id as the app session id.
  async createSession(
    request: AcpCreateSessionRequest = {},
    beforePublish?: () => void
  ): Promise<AcpCreateSessionResponse> {
    return this.withOperationLease(() => this.providerSessionCreator.create(request, beforePublish))
  }

  getSessionReasoningEffort(sessionId: string): ResolvedReasoningEffort | undefined {
    const session = this.activeSessionFor(sessionId)
    return session ? this.sessionEfforts.get(session) : undefined
  }

  async applySessionReasoningEffortChange(
    sessionId: string,
    effort: ResolvedReasoningEffort
  ): Promise<boolean> {
    return this.withOperationLease(async () => {
      const record = this.sessionRegistry.lookup(sessionId)
      const session = record?.attachment?.session
      const connection = this.connection
      if (!session || !connection || this.sessionInteractions.current(sessionId)) return false
      const assertCurrent = (): void => {
        this.assertCurrentConnectedConnection(connection)
        if (this.activeSessionFor(sessionId) !== session)
          throw new Error('ACP session startup was superseded.')
      }
      const facts = await this.sessionConfigurator.applyLiveEffort({
        backend: this.backend,
        connection,
        effort,
        sessions: [
          {
            session,
            configOptions:
              (record.aggregate.snapshot().configOptions as
                readonly SessionConfigOption[] | undefined) ??
              (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
                .newSessionResponse?.configOptions,
            assertCurrent
          }
        ]
      })
      assertCurrent()
      if (facts.reconnectRequired) return false
      this.sessionEfforts.set(session, effort)
      return true
    })
  }

  // Reattaches a persisted protocol session after an app restart so later prompts can stream.
  async resumeSession(
    request: AcpResumeSessionRequest,
    writerTransfer?: AcpSessionWriterTransfer,
    onSessionReady?: () => void
  ): Promise<AcpCreateSessionResponse> {
    const resume = async (
      isCurrent: () => boolean = () => true
    ): Promise<AcpCreateSessionResponse> => {
      const resumed = await this.providerSessionResumer.resume(
        request,
        writerTransfer,
        isCurrent,
        onSessionReady
      )
      const session = this.activeSessionFor(request.sessionId)
      if (session) await this.options.authorizedDirectories?.initialize(session)
      if (resumed.contextReset) {
        this.durableContinuationContext.markContextReset(request.sessionId)
      }
      this.planContinuations.schedule(
        this.sessionEnvironment.projectId(request.sessionId),
        request.sessionId
      )
      // Attachment persistence can fail after adoption. Retrying that same attachment must still
      // replay history until a prompt actually consumes the fresh provider context.
      return this.durableContinuationContext.requiresReplay(request.sessionId)
        ? { ...resumed, contextReset: true }
        : resumed
    }
    return this.withOperationLease(() =>
      this.activeSessionFor(request.sessionId)
        ? this.enqueuePermissionChange(request.sessionId, (state, revision) =>
            resume(() => state.revision === revision)
          )
        : resume()
    )
  }

  captureSessionResumeCleanup(response: AcpCreateSessionResponse): () => Promise<void> {
    return this.sessionDeletion.captureResumeCleanup(response.sessionId, response.providerSessionId)
  }

  hasPendingSessionWriterRelease(sessionId: string): boolean {
    return this.providerSessionResumer.hasPendingWriterRelease(sessionId)
  }

  async releaseSessionForTransfer(sessionId: string): Promise<string | undefined> {
    return this.withOperationLease(async () => {
      if (this.sessionInteractions.current(sessionId)) {
        throw new Error('Cannot transfer a Session while the Agent is running.')
      }
      const providerSessionId = await this.providerSessionResumer.releaseForTransfer(sessionId)
      if (providerSessionId) this.sessionCapabilities.revokeSession(sessionId)
      return providerSessionId
    })
  }

  async enableLiteratureContext(sessionId: string): Promise<void> {
    if (!this.options.literature) return
    this.sessionCapabilities.enableLiterature(sessionId)
    if (
      this.sessionCapabilities.mcpServerNamesFor(sessionId).includes(LITERATURE_MCP_SERVER_NAME)
    ) {
      return
    }
    const snapshot = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot()
    if (!snapshot || !this.activeSessionFor(sessionId)) {
      literatureLog.info('Literature MCP mount deferred until provider Session creation', {
        sessionId
      })
      return
    }
    if (this.sessionInteractions.current(sessionId)) {
      throw new Error('Cannot prepare Literature tools while the Agent is running.')
    }
    try {
      await this.withOperationLease(() =>
        this.providerSessionResumer.reconfigure({
          sessionId,
          cwd: snapshot.cwd ?? this.options.defaultCwd,
          projectId: snapshot.projectId,
          memoryEnabled: snapshot.memoryEnabled,
          ...(snapshot.permissionProfile?.selectedProfile
            ? { permissionProfile: snapshot.permissionProfile.selectedProfile }
            : {})
        })
      )
      literatureLog.info('Literature MCP mounted with compatible provider resume', {
        sessionId,
        framework: this.framework.id,
        replayedHistory: false
      })
    } catch (error) {
      this.sessionCapabilities.rollbackLiteratureEnable(sessionId)
      literatureLog.warn('Literature MCP mount failed', {
        sessionId,
        ...errorLogFields(error)
      })
      throw error
    }
  }

  async disableLiteratureContext(sessionId: string): Promise<void> {
    if (!this.options.literature || !this.sessionCapabilities.disableLiterature(sessionId)) return
    if (
      !this.sessionCapabilities.mcpServerNamesFor(sessionId).includes(LITERATURE_MCP_SERVER_NAME)
    ) {
      return
    }
    const snapshot = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot()
    if (!snapshot || !this.activeSessionFor(sessionId)) return
    if (this.sessionInteractions.current(sessionId)) {
      literatureLog.info('Literature MCP unmount deferred until the Agent is idle', { sessionId })
      return
    }
    try {
      await this.withOperationLease(() =>
        this.providerSessionResumer.reconfigure({
          sessionId,
          cwd: snapshot.cwd ?? this.options.defaultCwd,
          projectId: snapshot.projectId,
          memoryEnabled: snapshot.memoryEnabled,
          ...(snapshot.permissionProfile?.selectedProfile
            ? { permissionProfile: snapshot.permissionProfile.selectedProfile }
            : {})
        })
      )
      literatureLog.info('Literature MCP disabled with compatible provider resume', {
        sessionId,
        framework: this.framework.id,
        replayedHistory: false
      })
    } catch (error) {
      literatureLog.warn('Literature MCP disable failed; message context remains authoritative', {
        sessionId,
        ...errorLogFields(error)
      })
      throw error
    }
  }

  // Forcibly drops the agent-side context for a session whose accumulated history can no longer be sent
  // — chiefly when inlined media pushed the request past the provider's size limit and the backend's own
  // compaction fails with `media_unstrippable`. Disposes the current agent session and adopts a brand-new
  // one under the SAME app id, resetting the per-session inline-image budget so a replayed text-only
  // transcript starts clean. Returns contextReset so the caller replays a bounded transcript into the
  // next prompt (the app-level equivalent of compaction, which — unlike the backend's — drops all media).
  async resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    return this.withOperationLease(() => this.sessionReplacement.reset(request))
  }

  // Hot-switches the specialist bound to a live session. Updates the per-session skills and identity
  // maps so the next prompt reflects the new specialist. For Claude (identity baked into session
  // _meta at creation) the agent session is replaced via a context reset so the new identity append
  // takes effect immediately; Codex refreshes its scoped MCP loader through compatible resume,
  // while OpenCode updates its turn prefix. Both preserve history. Returns `contextReset` for replay
  // into the next prompt (only true for Claude, whose fresh session starts with no provider context).
  async switchSpecialist(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }> {
    return this.withOperationLease(() =>
      this.sessionReplacement.switchSpecialist(sessionId, specialistId)
    )
  }

  // The completion-gate adapter uses this public runtime fact to claim only the framework it owns.
  // A session keeps its original framework while a different active backend is prepared elsewhere.
  getSessionFramework(sessionId: string): AgentFrameworkId | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId
  }

  // Invokes the framework's own context compaction command on the attached agent session. The
  // command is an internal control turn: fresh usage updates are retained, while its command
  // echo/status output is not projected into the user's conversation.
  async compactSession(request: AcpCompactSessionRequest): Promise<PromptResponse> {
    return this.withOperationLease(() => this.contextCompactionWorkflow.compact(request))
  }

  hasFullAccess(sessionId: string): boolean {
    return this.permissionContext.hasFullAccess(sessionId)
  }

  subscribeFullAccess(sessionId: string, listener: (allowed: boolean) => void): () => void {
    return this.permissionContext.subscribeFullAccess(sessionId, listener)
  }

  // Serializes changes per Session and coalesces queued requests so only the latest selection can
  // commit or release a pending provider request. The operation lease covers time spent in the queue.
  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot> {
    return this.withOperationLease(() => this.enqueuePermissionProfileChange(request))
  }

  private enqueuePermissionProfileChange(
    request: AcpSetPermissionProfileRequest
  ): Promise<AcpStateSnapshot> {
    const attachment = this.sessionRegistry.lookup(request.sessionId)?.attachment
    const connection = this.connection
    return this.enqueuePermissionChange(request.sessionId, async (state, revision) => {
      try {
        return await this.setPermissionProfileOperation(request, state, revision)
      } catch (error) {
        const entry = this.sessionRegistry.lookup(request.sessionId)
        const profile = entry?.aggregate.snapshot().permissionProfile
        if (
          state.revision === revision &&
          this.connection === connection &&
          attachment &&
          entry?.attachment === attachment &&
          profile
        ) {
          this.permissionContext.setLivePermissionProfile(request.sessionId, {
            ...profile,
            availableModeIds: [...profile.availableModeIds]
          })
        }
        throw error
      }
    })
  }

  private enqueuePermissionChange<Result>(
    sessionId: string,
    work: (state: { revision: number }, revision: number) => Promise<Result>
  ): Promise<Result> {
    const state = this.permissionProfileChanges.get(sessionId) ?? {
      revision: 0,
      tail: Promise.resolve()
    }
    const revision = ++state.revision
    // Revoke before queueing: an earlier provider mode request may never settle.
    this.permissionContext.invalidatePermissionProfile(sessionId)
    const operation = state.tail.then(() => work(state, revision))
    state.tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.permissionProfileChanges.set(sessionId, state)
    void state.tail.then(() => {
      if (this.permissionProfileChanges.get(sessionId) === state && state.revision === revision) {
        this.permissionProfileChanges.delete(sessionId)
      }
    })

    return operation
  }

  private async setPermissionProfileOperation(
    request: AcpSetPermissionProfileRequest,
    state: { revision: number },
    revision: number
  ): Promise<AcpStateSnapshot> {
    if (state.revision !== revision) return this.getSnapshot()

    const session = this.activeSessionFor(request.sessionId)

    if (!session) throw new Error(`ACP session not found: ${request.sessionId}`)
    if (this.sessionInteractions.current(request.sessionId)?.kind === 'compaction') {
      throw new Error('Permission profile cannot be changed while the Agent is compacting.')
    }

    const connection = this.connection
    if (!connection) throw new Error('ACP connection is not available.')
    const backend = this.backend
    const aggregate = this.sessionRegistry.lookup(request.sessionId)?.aggregate
    const previousPermissionProfile = aggregate?.snapshot().permissionProfile
    const requestedPermissionProfile = backend.framework.mapPermissionProfile(
      request.profile,
      session.modes
    ).state
    const isCurrent = (): boolean =>
      state.revision === revision &&
      this.connection === connection &&
      this.activeSessionFor(request.sessionId) === session

    if (request.profile === 'ask') {
      this.options.web?.cancelSession?.(request.sessionId)
    }
    // Make the requested posture authoritative before the provider mode request can yield. A
    // downgrade from Full must affect broker decisions immediately, even while setMode is in flight.
    this.permissionContext.beginPermissionProfileTransition(
      request.sessionId,
      requestedPermissionProfile,
      isCurrent
    )

    let permissionProfile
    try {
      permissionProfile = await this.sessionConfigurator.configurePermissionProfile(
        {
          backend,
          connection,
          session,
          permissionProfile: request.profile
        },
        true
      )
    } catch (error) {
      if (previousPermissionProfile && isCurrent()) {
        this.permissionContext.setLivePermissionProfile(
          request.sessionId,
          {
            ...previousPermissionProfile,
            availableModeIds: [...previousPermissionProfile.availableModeIds]
          },
          isCurrent
        )
      }
      throw error
    }
    if (state.revision !== revision) return this.getSnapshot()
    if (this.activeSessionFor(request.sessionId) !== session) {
      throw new Error('ACP session startup was superseded.')
    }
    this.assertCurrentConnectedConnection(connection)
    await this.permissionContext.applyPermissionProfile(
      request.sessionId,
      permissionProfile,
      () => state.revision === revision
    )
    if (state.revision !== revision) return this.getSnapshot()
    if (this.activeSessionFor(request.sessionId) !== session) {
      throw new Error('ACP session startup was superseded.')
    }
    this.assertCurrentConnectedConnection(connection)
    this.sessionRegistry
      .lookup(request.sessionId)
      ?.aggregate.setPermissionProfile(structuredClone(permissionProfile))
    this.permissionContext.setLivePermissionProfile(request.sessionId, permissionProfile)
    this.emitState()

    return this.getSnapshot()
  }

  // Revokes an app-owned session grant so the next matching tool call prompts again.
  async revokePermissionGrant(request: AcpRevokePermissionGrantRequest): Promise<AcpStateSnapshot> {
    if (
      request.categoryKey === 'builtin:web_search' ||
      request.categoryKey === 'builtin:web_fetch'
    ) {
      this.options.web?.cancelSession?.(request.sessionId)
    }
    await this.permissionContext.revokeGrant(request.sessionId, request.categoryKey)
    this.emitState()

    return this.getSnapshot()
  }

  // Tears down every local session route and closes the underlying agent process.
  async disconnect(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    for (const sessionId of this.activeSessionIds()) this.options.web?.cancelSession?.(sessionId)
    const epoch = this.connectionResources.epoch
    recordResourceSnapshot(this.resourceRuntimeId, this, 'teardown-started')
    this.planContinuations.clearRetries()
    try {
      return await this.connectionClose.disconnect(emitClosedStatus)
    } finally {
      this.planContinuations.clearRetries()
      recordResourceEvent('teardown-ended', { runtimeId: this.resourceRuntimeId, epoch })
    }
  }

  // Synchronously terminates the agent child for app shutdown. Electron's `will-quit` cannot await, so
  // this does only the synchronous work of signalling the child to exit — an agent left running after
  // the app is gone would be an orphaned process still holding its network connection open. The OS
  // reclaims the remaining connection/session state as the process exits.
  shutdown(): void {
    this.planContinuations.clearRetries()
    this.connectionClose.shutdown()
  }

  // Awaitable quit/relaunch teardown. Latches shuttingDown FIRST so a connect that is mid-spawn when
  // quit lands self-aborts and kills its freshly-spawned child (see the lifecycle workflow). Unlike shutdown(),
  // this can be awaited, so a caller that follows it with app.exit(0) is guaranteed no orphaned agent
  // remains — assigned, connecting, or mid-spawn. Returns { reaped } so the caller can tell a clean
  // teardown from a degraded one (taskkill fallback left grandchildren) before committing to app.exit.
  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    this.planContinuations.clearRetries()
    try {
      return await this.connectionClose.shutdownForQuit()
    } finally {
      this.planContinuations.clearRetries()
    }
  }

  // Teardown for the pre-update-install gate. Reaps the current agent tree (so the NSIS installer can
  // delete files the agent held) but, unlike shutdownForQuit, does NOT latch shuttingDown: a refused
  // install (degraded or timed-out teardown) must leave the runtime able to lazily reconnect. Crucially
  // it does not rely on a latch to catch a connect racing inside provider spawn either — this teardown
  // can itself be abandoned by its caller (runBounded) once the budget elapses, and a latch set here
  // would then never clear, wedging every future connect. Instead disconnect() bumps the connection
  // generation, and the lifecycle workflow reaps any freshly-spawned child whose generation is now stale,
  // independent of shuttingDown. Awaiting the in-flight connect here only sharpens the returned reaped
  // signal (so a degraded reap makes the caller refuse the install); if that await is abandoned on
  // timeout the caller refuses on !completed and the stale-generation self-reap still collects the child.
  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    this.planContinuations.clearRetries()
    try {
      return await this.connectionClose.shutdownForUpdateGate()
    } finally {
      this.planContinuations.clearRetries()
    }
  }

  // Retires this framework generation without interrupting active turns or background workflows. The
  // coordinator stops routing new work here immediately; teardown waits for every prompt and lease.
  async requestRetirement(): Promise<void> {
    await this.connectionClose.requestRetirement()
  }

  // Retain a bounded idle connection briefly; expiry releases physical resources.
  // Active workflows defer release; subsequent cold turns use ordinary Session resume.
  requestIdleRelease(): void {
    recordResourceSnapshot(this.resourceRuntimeId, this, 'idle-release-requested')
    if (this.snapshotOwner.status === 'connected') this.connectionTransitions.requestIdleRelease()
  }

  // Applies an active-provider change without interrupting the user. The agent bakes its provider env in
  // at spawn, so a new provider needs a reconnect — but if a prompt is running we defer the reconnect
  // until the session goes idle. Because every provider shares one config dir, the reconnect resumes the
  // conversation on the new provider with full context. Called when the active provider changes.
  async requestProviderReconnect(): Promise<void> {
    await this.connectionClose.requestProviderReconnect()
  }

  // Holds this generation across a multi-step background workflow, including gaps with no live session.
  async withActivity<T>(
    _options: AcpRuntimeActivityOptions,
    work: (runtime: AcpRuntimeActivity) => Promise<T>
  ): Promise<T> {
    return this.generationActivity.withActivity(async () => {
      try {
        return await work(this)
      } finally {
        this.requestIdleRelease()
      }
    })
  }

  // Coordinator admission precedes Runtime prompt startup. Protect that gap from idle release
  // without blocking provider reconnect, whose barrier the admitted prompt may need to await.
  withPromptAdmission<T>(work: () => Promise<T>): Promise<T> {
    return this.generationActivity.withOperation(work)
  }

  private withOperationLease<T>(work: () => Promise<T>): Promise<T> {
    const barrier = this.modelChanges.barrier ?? this.reconnectBarrier
    if (barrier) {
      return barrier.then(() => this.withOperationLease(work))
    }
    return this.generationActivity.withOperation(work)
  }

  private openAgentConnection(
    identity: AcpConnectionResourceAttempt,
    onFrameworkResolved: (framework: AgentFramework['id']) => void
  ): Promise<AcpAgentConnectionCandidate> {
    const hooks: AcpAgentConnectionHooks = {
      toolLess: this.sessionEnvironment.role() === 'restricted-inference',
      createElicitation: (params) => this.clientInteractions.createElicitation(params),
      requestPermission: (params) => this.clientInteractions.requestPermission(params),
      observeSessionUpdate: (notification) => {
        this.providerSessionResumer.observeProgress(notification.sessionId)
        this.permissionContext.observeProviderUpdate(notification)
      },
      observeClaudeSdkMessage: (params) => this.observeClaudeSdkMessage(params),
      filesystem: {
        resolveSessionCwd: (sessionId) => this.resolveSessionCwd(sessionId),
        protectedReadRoots: () => this.protectedReadRoots(),
        listGrantedRoots: () => this.options.grantedRoots?.list?.() ?? Promise.resolve([])
      },
      onBackendResolved: (framework) => {
        onFrameworkResolved(framework)
        if (!this.spawnAgent) {
          // Keep spawn configuration and provider identifiers out of diagnostics.
          log.info('agent backend resolved', this.diagnosticContext(framework))
        }
      },
      onProcessSpawned: (framework) => {
        if (!this.spawnAgent) log.info('agent process spawned', this.diagnosticContext(framework))
      },
      onBackendPublished: (backend) => {
        this.sessionUpdateProjector.beginGeneration(
          backend.adapter.codexHome ? join(backend.adapter.codexHome, 'skills') : undefined
        )
      },
      onProcessTreeReaped: (reaped) => {
        this.connectionClose.recordProcessTreeReaped(reaped)
      },
      markProcessExitExpected: (process) => this.connectionClose.markExpected(process),
      onProcessStderr: (text, context) => this.handleAgentProcessStderr(text, context),
      onProcessStderrEnd: (context) => {
        const tail = this.agentStderrTails.get(context.process)
        if (tail?.text || (tail?.discarding && this.agentStderrWindows.has(context.process))) {
          this.handleAgentProcessStderr('', context, true)
        }
        this.agentStderrTails.delete(context.process)
        this.flushAgentProcessStderr(context.process)
      },
      onProcessError: (error, context) => this.handleAgentProcessError(error, context),
      onProcessExit: (code, signal, context) => this.handleAgentProcessExit(code, signal, context),
      onConnectionClosed: () => this.connectionClose.handleUnexpectedClose(),
      reportCleanupFailure: (stage, error, framework, epoch) => {
        safeLogError(`unattached ACP ${stage} cleanup failed`, {
          ...diagnosticErrorFields(error),
          ...this.diagnosticContext(framework, epoch)
        })
      }
    }

    return this.connectionAdapter.open(
      {
        epoch: identity.epoch,
        resourceRuntimeId: this.resourceRuntimeId,
        resourceExitExpected: (child) => {
          const disposition = this.processEventDisposition(child, identity.epoch)
          return disposition === 'stale' ? undefined : disposition === 'expected'
        },
        resolveBackend: async () => {
          let grantedLocalRoots: readonly Pick<GrantedLocalRoot, 'path' | 'access'>[] = []
          try {
            grantedLocalRoots = (await this.options.grantedRoots?.list?.()) ?? []
          } catch (error) {
            log.warn('granted local roots unavailable for backend context', errorLogFields(error))
          }
          const backend: ResolvedAgentBackend | undefined = this.options.resolveBackend
            ? await this.options.resolveBackend({
                forcedSkillIds: [...this.turnSkills.backendPreparation().forcedSkillIds],
                ...(this.turnSkills.backendPreparation().skillWhitelist
                  ? { skillWhitelist: [...this.turnSkills.backendPreparation().skillWhitelist!] }
                  : {}),
                systemPromptAppends: [
                  ...(await this.sessionEnvironment.backendSystemPromptAppends())
                ],
                grantedLocalRoots
              })
            : this.spawnAgent
              ? { framework: this.framework, executablePath: '', env: {} }
              : undefined
          if (!backend) throw new Error('ACP agent spawn configuration is not available.')
          return backend
        },
        prepareBackend: (backend) => this.backendGeneration.prepare(identity, backend),
        isCurrent: () => identity.epoch === this.connectionGeneration,
        isShuttingDown: () => this.connectionResources.isShuttingDown,
        cleanupUnattached: (resource, onFailure) =>
          this.connectionResources.cleanupUnattached(resource, onFailure),
        ...(this.spawnAgent ? { spawnAgent: this.spawnAgent } : {}),
        ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
        ...(this.options.registerOpenCodeStoreRelease
          ? { registerOpenCodeStoreRelease: this.options.registerOpenCodeStoreRelease }
          : {})
      },
      hooks
    )
  }

  // Side-band follow-up into the live prompt. Does not open a second prompt interaction.
  async steerFollowUp(
    request: AcpSteerFollowUpRequest,
    isCurrent: () => boolean = () => true
  ): Promise<AcpSteerFollowUpResult> {
    return this.withOperationLease(() =>
      withDataRootWrite(() => this.nativeFollowUp.steerFollowUp(request, isCurrent))
    )
  }

  async steerSideChatAdvisory(
    request: AcpSteerFollowUpRequest
  ): ReturnType<AcpNativeFollowUpWorkflow['steerSideChatAdvisory']> {
    return this.withOperationLease(() =>
      withDataRootWrite(() => this.nativeFollowUp.steerSideChatAdvisory(request))
    )
  }

  private async prepareNativeFollowUpContent(
    request: AcpSteerFollowUpRequest
  ): Promise<NativeFollowUpPreparedContent> {
    const referencedSessions = sanitizeSessionReferences(request.parts)
    this.sessionInteractions.authorizeSessionReferences(
      request.sessionId,
      referencedSessions.map((reference) => reference.sessionId)
    )
    const livePrompt = this.sessionInteractions.current(request.sessionId)
    const presented = await this.turnSkills.presentFollowUp({
      diagnosticContext: {
        sessionId: request.sessionId,
        frameworkId: this.framework.id,
        modelRoute: this.backendGeneration.current.modelRoute
      },
      frameworkId: this.framework.id,
      text: request.text,
      selectedSkillIds: request.forcedSkillIds ?? [],
      role: this.sessionEnvironment.role(),
      specialistId: this.sessionRegistry.lookup(request.sessionId)?.aggregate.snapshot()
        .specialistId,
      codexHome: this.backendGeneration.current.adapter.codexHome,
      ...(this.framework.id === 'codebuddy'
        ? {
            codebuddy: {
              root: codeBuddySkillRuntimeRoot(this.backendGeneration.current.session.options),
              shellRuntime: this.sessionCapabilities.shellRuntimeBindingFor(request.sessionId),
              selectorAvailable: this.connectionResources.bridgeSkillsAvailable,
              selectSkills: async (text, catalog, signal, observeUsage) =>
                (await this.connectionResources.selectBridgeSkills(
                  text,
                  catalog,
                  signal,
                  observeUsage
                )) ?? [],
              ...(livePrompt?.kind === 'prompt' ? { signal: livePrompt.signal } : {})
            }
          }
        : {})
    })
    const supportsImageInput = this.backendGeneration.current.context.supportsImageInput
    const imageCompatibility = this.options.imageInputCompatibility
    const prepared = await this.promptContent.prepare({
      appSessionId: request.sessionId,
      projectId: this.liveSessionProjectId(request.sessionId) ?? '',
      connectionGeneration: this.connectionGeneration,
      text: [
        buildSessionReferencePrompt(referencedSessions),
        buildLiteratureReferencePrompt(request.parts),
        followUpPromptText(presented)
      ]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n'),
      historyImages: [],
      historyUploads: [],
      currentUploads: request.attachments ?? [],
      references: request.referencedArtifacts ?? [],
      codexSkillInputs: presented.codexSkillInputs,
      skillImportEnabled: false,
      imageCompatibilityRelay: supportsImageInput === false && imageCompatibility !== undefined,
      fileTextBudget: resolveFileTextBudget(this.backendGeneration.current.context.window)
    })
    return finalizeNativeFollowUpPreparedContent({
      content: prepared.content,
      ...(prepared.turnInputs ? { turnInputs: prepared.turnInputs } : {}),
      projectId: this.liveSessionProjectId(request.sessionId) ?? '',
      sessionId: request.sessionId,
      ...(livePrompt?.kind === 'prompt' && livePrompt.promptMessageId
        ? { livePromptMessageId: livePrompt.promptMessageId }
        : {}),
      supportsImageInput,
      ...(prepared.imageSources ? { imageSources: prepared.imageSources } : {}),
      historyImageCount: prepared.historyImageCount,
      ...(livePrompt?.kind === 'prompt' ? { signal: livePrompt.signal } : {}),
      ...(imageCompatibility ? { imageCompatibility } : {}),
      close: prepared.close
    })
  }

  // Main's Task adapter calls this synchronously under TaskRunner's Session reservation. An
  // automation prompt can inherit its root authority, but can never clear a previous refusal.
  captureNotebookTaskIntent(request: AcpPromptRequest): AcpPromptRequest {
    const notebook = this.options.notebook
    if (!notebook) return request
    const scope = {
      projectId: this.sessionEnvironment.projectId(request.sessionId),
      sessionId: request.sessionId,
      messageBranchId: request.provenanceContext?.messageBranchId,
      promptMessageId: request.provenanceContext?.promptMessageId
    }
    const origin = request.provenanceContext?.promptMessageId
    let intent = origin ? notebook.resolveExecutionIntent?.(scope, origin) : undefined
    intent ??= (
      notebook.currentExecutionIntent
        ? notebook.currentExecutionIntent(scope)
        : this.sessionCapabilities.notebookExecutionIntentFor(request.sessionId)
    )?.forDescendant(request.provenanceContext)
    if (!intent && origin && notebook.createExecutionIntent) {
      // TaskRunner has accepted this exact first root under its Session reservation. Generic
      // resume, application prompts and later roots cannot replace an existing refused context.
      intent = notebook.createExecutionIntent(scope)
      intent.prepareUserExecution()
    }
    if (!intent)
      throw new Error(
        'Notebook Task execution context is unavailable. Execution was not started; repair the runtime before starting a new Task.'
      )
    markNotebookExecutionIntent(request, intent)
    if (origin) notebook.rememberExecutionIntent?.(scope, origin, intent)
    return request
  }

  // Sends one prompt turn to the targeted session and streams updates until stop.
  async sendPrompt(
    request: AcpPromptRequest,
    promptAttemptId?: string,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>,
    runtimeReviewOwner: 'task' | 'renderer' = 'renderer'
  ): Promise<PromptResponse> {
    if (
      request.referencedArtifacts?.some(
        (reference) =>
          'pdfReadingPosition' in reference && reference.pdfReadingPosition !== undefined
      )
    ) {
      await this.enableLiteratureContext(request.sessionId)
    }
    return this.withOperationLease(() =>
      this.runPromptTurn(
        request,
        {
          kind: 'user',
          ...(promptAttemptId === undefined ? {} : { promptAttemptId }),
          runtimeReviewOwner
        },
        onPromptAdmitted
      )
    )
  }

  async sendApplicationPrompt(
    request: AcpPromptRequest,
    attribution: MessageAttribution,
    options?: {
      promptAttemptId?: string
      beforeSessionWrite?: () => Promise<void>
      // Runs under prompt ownership, before prompt events, Artifact opening or provider dispatch.
      // Throwing rejects this application turn without emitting a user-visible prompt.
      onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
    }
  ): Promise<PromptResponse> {
    return this.withOperationLease(() =>
      this.runPromptTurn(
        request,
        {
          kind: 'application',
          attribution,
          beforeSessionWrite: options?.beforeSessionWrite,
          ...(options?.promptAttemptId === undefined
            ? {}
            : { promptAttemptId: options.promptAttemptId })
        },
        options?.onPromptAdmitted
      )
    )
  }

  // App-owned continuations participate in the same prompt ownership, cancellation, provenance, and
  // accounting lifecycle as user turns. Their synthesized control text is provider input, however,
  // and must never be projected into the transcript as a second user-authored message.
  sendAppContinuation(
    request: AcpPromptRequest,
    promptAttemptId?: string,
    planDelivery?: Readonly<{ projectId: string; commandId: string }>,
    delegatedMessageId?: string,
    permissionContinuation?: RestoredPermissionContinuation,
    onProviderDispatched?: () => void
  ): Promise<PromptResponse> {
    return this.sendDurableAppContinuation(request, {
      promptAttemptId,
      planDelivery,
      delegatedMessageId,
      permissionContinuation,
      onProviderDispatched
    })
  }

  private async sendDurableAppContinuation(
    request: AcpPromptRequest,
    options: {
      promptAttemptId?: string
      planDelivery?: Readonly<{ projectId: string; commandId: string }>
      delegatedMessageId?: string
      permissionContinuation?: RestoredPermissionContinuation
      onProviderDispatched?: () => void
    }
  ): Promise<PromptResponse> {
    const {
      promptAttemptId,
      planDelivery,
      delegatedMessageId,
      permissionContinuation,
      onProviderDispatched
    } = options
    // A parked continuation itself blocks reconnect. Enter the generation directly so it can finish
    // before that barrier is released instead of waiting on the barrier it intentionally holds.
    return this.generationActivity.withOperation(() =>
      this.runPromptTurn(
        request,
        {
          kind: 'app-continuation',
          onProviderDispatched,
          ...(promptAttemptId === undefined ? {} : { promptAttemptId }),
          ...(planDelivery ? { planDelivery } : {}),
          ...(delegatedMessageId ? { delegatedMessageId } : {})
        },
        permissionContinuation
          ? async () => this.permissionContinuations.admit(request, permissionContinuation)
          : undefined
      )
    )
  }

  private runPromptTurn(
    request: AcpPromptRequest,
    intent:
      | Readonly<{
          kind: 'user'
          promptAttemptId?: string
          runtimeReviewOwner?: 'task' | 'renderer'
        }>
      | Readonly<{
          kind: 'application'
          attribution: MessageAttribution
          beforeSessionWrite?: () => Promise<void>
          promptAttemptId?: string
        }>
      | Readonly<{
          kind: 'app-continuation'
          promptAttemptId?: string
          planDelivery?: Readonly<{ projectId: string; commandId: string }>
          delegatedMessageId?: string
          onProviderDispatched?: () => void
        }>,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): Promise<PromptResponse> {
    return withDataRootWrite(async () => {
      let response: PromptResponse | undefined
      const assertWriterAvailable = (): void => {
        if (this.hasPendingSessionWriterRelease(request.sessionId)) {
          throw new Error(
            'Cannot send a prompt while its writer release is pending. Resume the Session first.'
          )
        }
      }
      try {
        assertWriterAvailable()
        response = await this.promptTurnWorkflow.run(request, intent, async () => {
          // Preflight can yield before interaction ownership prevents a new writer release.
          assertWriterAvailable()
          return onPromptAdmitted?.()
        })
        return response
      } finally {
        this.repeatedToolFailureGuard.clearSession(request.sessionId)
        this.schedulePendingAppContinuation(request.sessionId, response?.stopReason)
      }
    })
  }

  // Requests cancellation without clearing in-flight state before the agent stops.
  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    this.options.web?.cancelSession?.(request.sessionId)
    // A timed-out cancellation may already be closing the shared connection. Wait before taking
    // any early permission/continuation path so every caller observes the same teardown boundary.
    const pendingCancellationTeardown = this.cancellationTeardown
    if (pendingCancellationTeardown) await pendingCancellationTeardown.catch(() => undefined)
    const cancelPromptRequest = this.promptTurnWorkflow.captureCancellation(request.sessionId)
    const connection = this.connection
    const activeSession = this.activeSessionFor(request.sessionId)
    const cancelPlanInteraction = this.sessionPlanWorkflow.capturePromptCancellation(
      request.sessionId
    )
    const interactionInFlight =
      this.sessionInteractions.has(request.sessionId) || !!cancelPromptRequest
    const durablePermission = this.permissionContinuations.requestCancellation(request.sessionId)
    const continuationWasPending = this.appContinuations.get(request.sessionId) !== undefined
    const cancelledContinuation = this.appContinuations.delete(request.sessionId)

    if (continuationWasPending && cancelledContinuation && !interactionInFlight) {
      await this.permissionContinuations.settleCancelled(request.sessionId)
      this.emitState()
      return this.getSnapshot()
    }

    if (!interactionInFlight && !durablePermission) {
      try {
        await this.sandboxNetworkApprovalOwner.cancel(
          this.sessionEnvironment.projectId(request.sessionId),
          request.sessionId
        )
        const permissionRequestId = await this.permissionWaitOwner.cancelPendingSession(
          request.sessionId
        )
        if (permissionRequestId) {
          this.durableContinuationContext.clearContextReset(request.sessionId)
          this.permissionContext.clearRestoredDecision(request.sessionId)
          this.pushEvent({
            kind: 'permission',
            level: 'info',
            sessionId: request.sessionId,
            permissionRequestId,
            title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
            text: 'cancelled'
          })
          this.emitState()
          return this.getSnapshot()
        }
      } catch (error) {
        this.pushEvent({
          kind: 'system',
          level: 'error',
          sessionId: request.sessionId,
          title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
          text: errorMessage(error)
        })
        this.emitState()
        return this.getSnapshot()
      }
    }

    let cancellationAccepted = false
    let teardownAfterCancellationTimeout: Promise<AcpStateSnapshot> | undefined
    const onAccepted = (): void => {
      cancellationAccepted = true
      cancelPromptRequest?.()
      cancelPlanInteraction()
      this.cancelPermissionFlowForSession(request.sessionId)
      this.pushEvent({
        kind: 'system',
        level: 'warning',
        sessionId: request.sessionId,
        title: 'Prompt cancellation requested'
      })
      this.emitState()
    }
    if (connection && activeSession) {
      try {
        await this.sessionInteractions.cancelPrompt({
          sessionId: request.sessionId,
          notify: () =>
            connection.agent.notify(acp.methods.agent.session.cancel, {
              sessionId: activeSession.sessionId
            }),
          onAccepted,
          onTimeout: () => {
            this.pushEvent({
              // This is a teardown diagnostic; disconnect owns the resumable turn terminal.
              kind: 'system',
              level: 'error',
              sessionId: request.sessionId,
              title: 'Prompt cancellation timed out',
              text: 'Cancellation was not confirmed before the deadline. The agent connection is being closed; process termination is not yet confirmed.'
            })
            teardownAfterCancellationTimeout = this.disconnect()
            this.cancellationTeardown = teardownAfterCancellationTimeout
            const clearCancellationTeardown = (): void => {
              if (this.cancellationTeardown === teardownAfterCancellationTimeout) {
                this.cancellationTeardown = undefined
              }
            }
            void teardownAfterCancellationTimeout.then(
              clearCancellationTeardown,
              clearCancellationTeardown
            )
            void teardownAfterCancellationTimeout.catch(() => undefined)
          }
        })
      } catch (error) {
        await (teardownAfterCancellationTimeout ?? this.cancellationTeardown)?.catch(
          () => undefined
        )
        throw error
      }
      await this.cancellationTeardown?.catch(() => undefined)
    } else if (cancelPromptRequest) {
      onAccepted()
    }
    if (cancellationAccepted) {
      await this.sandboxNetworkApprovalOwner.cancel(
        this.sessionEnvironment.projectId(request.sessionId),
        request.sessionId
      )
      await this.permissionContinuations.settleCancelled(request.sessionId)
      this.emitState()
    }

    return this.getSnapshot()
  }

  // Closes the agent-side session when supported, then removes local routing state.
  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    this.planContinuations.clearRetry(request.sessionId)
    this.sessionPlanWorkflow.sessionDeleted(request.sessionId)
    try {
      const result = await this.sessionDeletion.delete(request.sessionId)
      return result
    } finally {
      this.planContinuations.clearRetry(request.sessionId)
    }
  }

  // Resolves or cancels one pending permission request from the renderer.
  async respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot> {
    const permissionRequest = this.permissionContext
      .getPendingRequests()
      .find((request) => request.requestId === response.requestId)
    if (!permissionRequest && response.restored) {
      if (
        await this.sandboxNetworkApprovalOwner.respondRestored(
          response,
          this.sessionEnvironment.projectId(response.restored.sessionId)
        )
      ) {
        this.emitState()
        return this.getSnapshot()
      }
      return this.permissionContinuations.respond(response)
    }
    const selectedOption = permissionRequest?.options.find(
      (option) => option.optionId === response.optionId
    )
    const interaction = permissionRequest
      ? this.sessionInteractions.current(permissionRequest.sessionId)
      : undefined
    const promptInteraction = interaction?.kind === 'prompt' ? interaction : undefined
    const continueAfterProviderCancellation = Boolean(
      permissionRequest &&
      !permissionRequest.appOwned &&
      promptInteraction &&
      this.getSessionFramework(permissionRequest.sessionId) === 'claude-code' &&
      !response.cancelled &&
      selectedOption?.kind.toLowerCase().startsWith('reject_')
    )
    if (permissionRequest && promptInteraction && continueAfterProviderCancellation) {
      const referencedSessions = this.handoffContinuity.copyReferencedSessions(
        permissionRequest.sessionId
      )
      this.appContinuations.set(permissionRequest.sessionId, {
        condition: 'provider-cancelled',
        request: {
          sessionId: permissionRequest.sessionId,
          text: PERMISSION_DENIED_CONTINUATION_TEXT,
          ...(promptInteraction.permissionPrompts
            ? { permissionPrompts: promptInteraction.permissionPrompts }
            : {}),
          ...(promptInteraction.memoryEnabled !== undefined
            ? { memoryEnabled: promptInteraction.memoryEnabled }
            : {}),
          suppressUserMessage: true,
          ...(promptInteraction.promptMessageId
            ? { provenanceContext: { promptMessageId: promptInteraction.promptMessageId } }
            : {}),
          ...(referencedSessions?.length ? { referencedSessions } : {})
        }
      })
    }

    try {
      const handled = await this.permissionContext.respondToPermission(
        response,
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      if (!handled && permissionRequest && continueAfterProviderCancellation) {
        this.appContinuations.delete(permissionRequest.sessionId)
      }
      this.pushEvent({
        kind: 'permission',
        level: handled ? 'info' : 'warning',
        permissionRequestId: response.requestId,
        title: handled ? 'Permission response sent' : 'Permission request not found',
        text: response.cancelled ? 'cancelled' : response.optionId
      })
    } catch (error) {
      if (permissionRequest && continueAfterProviderCancellation) {
        this.appContinuations.delete(permissionRequest.sessionId)
      }
      this.pushEvent({
        kind: 'permission',
        level: 'error',
        permissionRequestId: response.requestId,
        title: 'Permission approval could not be saved',
        text: error instanceof Error ? error.message : 'The tool call was cancelled.'
      })
      this.emitState()
      throw error
    }
    this.emitState()

    return this.getSnapshot()
  }

  respondToElicitation(
    response: ElicitationResponse,
    continuePrepared = false
  ): Promise<AcpStateSnapshot> {
    return this.questionContinuations.respond(response, continuePrepared)
  }

  requestUserInput(input: AgentUserChoiceRequest): Promise<AgentUserChoiceResult> {
    return this.questionContinuations.requestUserInput(input)
  }

  private schedulePendingAppContinuation(sessionId: string, stopReason?: string): void {
    const pending = this.appContinuations.get(sessionId)
    if (!pending) return
    if (pending.condition === 'provider-cancelled' && stopReason !== 'cancelled') {
      this.appContinuations.delete(sessionId)
      this.emitState()
      return
    }
    queueMicrotask(() => {
      void this.flushPendingAppContinuation(sessionId)
    })
  }

  private async flushPendingAppContinuation(sessionId: string): Promise<void> {
    const pending = this.appContinuations.get(sessionId)
    if (!pending || this.sessionInteractions.current(sessionId)) return
    const continuation = this.appContinuations.takeAndActivate(sessionId)
    if (!continuation) return
    let prepared = false
    let providerDispatched = false
    let stopReason: PromptResponse['stopReason'] | undefined
    let error: unknown
    try {
      const request = continuation.beforeSend
        ? await continuation.beforeSend()
        : continuation.request
      if (!request) return
      prepared = true
      const onProviderDispatched = (): void => {
        providerDispatched = true
      }
      const response = await (continuation.send
        ? continuation.send(request, onProviderDispatched)
        : this.sendDurableAppContinuation(request, { onProviderDispatched }))
      stopReason = response.stopReason
    } catch (cause) {
      error = cause
      this.pushEvent({
        kind: 'error',
        level: 'error',
        sessionId,
        ...(continuation.request.provenanceContext ?? {}),
        title: ACP_APP_CONTINUATION_FAILED_EVENT_TITLE,
        text: errorMessage(cause)
      })
      this.emitState()
    } finally {
      if (continuation.settle) {
        let code: unknown
        try {
          code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        } catch {
          // An opaque provider error cannot establish retry eligibility or block settlement.
          code = undefined
        }
        await continuation.settle({
          phase: providerDispatched ? 'dispatched' : prepared ? 'not-dispatched' : 'not-prepared',
          stopReason,
          error,
          retryable:
            !providerDispatched &&
            typeof code === 'string' &&
            ['EAGAIN', 'EBUSY', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)
        })
      }
      this.appContinuations.complete(sessionId)
      this.emitState()
    }
  }

  // App-owned privileged actions (such as Specialist handoff) share the provider permission card
  // and broker lifecycle. The caller supplies only a redacted renderer payload; this runtime owns
  // request parking, cancellation, and response validation.
  async requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
    signal?: AbortSignal
  }): Promise<boolean> {
    return this.permissionContext.requestAppApproval(input)
  }

  networkApprovalRecordStatus(
    projectId: string,
    sessionId: string,
    recordId: string
  ): Promise<NetworkApprovalRecordStatus | undefined> {
    return this.sandboxNetworkApprovalOwner.recordStatus(projectId, sessionId, recordId)
  }

  async requestAppPermission(input: AppPermissionRequest): Promise<string | undefined> {
    if (input.networkApproval) {
      const scope = this.sessionInteractions.current(input.sessionId)
      if (
        scope?.kind !== 'prompt' ||
        scope.permissionPrompts === 'none' ||
        this.sessionInteractions.isCancellationAccepted(scope)
      )
        return undefined
      if (this.sessionEnvironment.projectId(input.sessionId) !== input.networkApproval.projectId)
        return undefined
      return this.sandboxNetworkApprovalOwner.request(
        input,
        scope.promptMessageId,
        (request) => this.permissionContext.requestAppPermission(request),
        () =>
          !input.signal?.aborted &&
          this.sessionInteractions.current(input.sessionId) === scope &&
          !this.sessionInteractions.isCancellationAccepted(scope)
      )
    }
    return this.permissionContext.requestAppPermission(input)
  }

  // Lazily initializes the process connection before session creation.
  private async ensureConnected(cwd: string): Promise<ClientConnection> {
    return this.connectionLifecycle.ensureConnected(cwd)
  }

  private observeClaudeSdkMessage(params: Record<string, unknown>): void {
    if (typeof params.sessionId === 'string') {
      this.providerSessionResumer.observeProgress(params.sessionId)
    }
    this.providerPromptExecutor.observeProviderMessage(params)
  }

  // Looks up the workspace root bound to a session for filesystem operations.
  private resolveSessionCwd(sessionId: string): string {
    const sessionCwd = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd

    if (!this.activeSessionFor(sessionId) || !sessionCwd) {
      throw new Error(`Unknown ACP session: ${sessionId}`)
    }

    return sessionCwd
  }

  // App-owned directories the agent's Read tool must never read: framework config dirs hold
  // materialized skills plus provider/auth configuration whose contents must not be surfaced.
  private protectedReadRoots(): string[] {
    const additional = this.options.additionalProtectedReadRoots ?? []
    if (!this.artifactOptions) return [...additional]

    const root = this.artifactOptions.configRoot

    return [
      ...additional,
      getAppClaudeConfigDir(root),
      opencodeStorageDir(root),
      codexStorageDir(root),
      codexSubscriptionStorageDir(root),
      codeBuddyStorageDir(root)
    ]
  }

  // Resolves the artifact/notebook storage project for a session, defaulting to the runtime constant.
  private resolveSessionProjectId(sessionId: string): string {
    return this.sessionEnvironment.projectId(sessionId)
  }

  // Writes an inline file into the in-flight turn's pending artifact run so it attaches to the resulting
  // message and surfaces to the renderer like any generated artifact. Used by app-side connector tools
  // (e.g. molecule preview). Throws when no assistant turn is active (e.g. a user-run notebook cell).
  async writeArtifactForCurrentRun(
    sessionId: string,
    input: {
      filename: string
      content: string
      encoding?: import('../../shared/artifacts').ArtifactWriteEncoding
      mimeType?: string
      producer?: AppGeneratedArtifactProducer
    }
  ): Promise<ArtifactFile> {
    if (!this.artifactTurns) {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    const execution = this.sessionInteractions.current(sessionId)
    if (!execution || execution.kind !== 'prompt') {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    const artifact = this.artifactTurns.handleForExecution(execution.turnToken)
    if (this.artifactTurns.snapshot(artifact).phase !== 'open') {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    return this.artifactTurns.write(artifact, input)
  }

  private cancelPermissionFlowForSession(sessionId: string): void {
    this.permissionContext.cancelForSession(sessionId)
    this.questionContinuations.clearSession(sessionId)
    this.elicitationOwner.cancelForSession(sessionId)
    this.appContinuations.delete(sessionId)
  }

  private processEventDisposition(
    process: ChildProcessWithoutNullStreams,
    epoch: number
  ): ReturnType<AcpConnectionResourceOwner['processEventDisposition']> {
    if (this.connectionClose.isExpected(process)) return 'expected'
    return this.connectionResources.processEventDisposition(process, epoch)
  }

  // Projects adapter-bound process diagnostics while retaining epoch classification and event state.
  private handleAgentProcessStderr(
    text: string,
    context: Parameters<AcpAgentConnectionHooks['onProcessStderr']>[1],
    ended = false
  ): void {
    if (!text && !ended) return

    const disposition = this.processEventDisposition(context.process, context.epoch)
    const inFlight = disposition === 'current' ? this.getInFlightSessionIds() : []
    const sessionId = inFlight.length === 1 ? inFlight[0] : undefined
    const interactionSequence = sessionId
      ? this.sessionInteractions.current(sessionId)?.sequence
      : undefined
    const existing = this.agentStderrWindows.get(context.process)
    if (existing) {
      existing.chunkCount += ended ? 0 : 1
      existing.byteCount += Buffer.byteLength(text, 'utf8')
      existing.eventEligible &&= disposition === 'current'
      existing.nonActionableCodexOnly &&=
        context.framework === 'codex' && isNonActionableCodexStderr(text)
      if (
        existing.sessionId !== sessionId ||
        existing.interactionSequence !== interactionSequence
      ) {
        existing.sessionId = undefined
        existing.interactionSequence = undefined
        existing.sessionAttributionConsistent = false
      }
      this.appendAgentStderrSample(existing, text, ended)
      this.observeCodexTransportSignal(existing, text)
      if (!existing.timer) {
        existing.timer = setTimeout(
          () => this.flushAgentProcessStderr(context.process),
          AGENT_STDERR_REPORT_WINDOW_MS
        )
        existing.timer.unref?.()
      }
      return
    }

    const timer = setTimeout(
      () => this.flushAgentProcessStderr(context.process),
      AGENT_STDERR_REPORT_WINDOW_MS
    )
    timer.unref?.()
    const window: AgentStderrWindow = {
      process: context.process,
      framework: context.framework,
      epoch: context.epoch,
      startedAt: Date.now(),
      chunkCount: ended ? 0 : 1,
      byteCount: Buffer.byteLength(text, 'utf8'),
      rawSample: '',
      rawSampleBytes: 0,
      rawSampleTruncated: false,
      sessionId,
      interactionSequence,
      sessionAttributionConsistent: true,
      nonActionableCodexOnly: context.framework === 'codex' && isNonActionableCodexStderr(text),
      codexTransportSignalSample: '',
      codexWebSocketFallbackObserved: false,
      eventEligible: disposition === 'current',
      timer
    }
    this.appendAgentStderrSample(window, text, ended)
    this.observeCodexTransportSignal(window, text)
    this.agentStderrWindows.set(context.process, window)
  }

  // Codex diagnostics can cross Node stderr chunk boundaries. Retain only a short ephemeral suffix
  // for this exact operational signal; it is never logged or persisted as user-visible output.
  private observeCodexTransportSignal(window: AgentStderrWindow, text: string): void {
    if (window.framework !== 'codex' || window.codexWebSocketFallbackObserved) return
    window.codexTransportSignalSample = `${window.codexTransportSignalSample}${text}`.slice(
      -CODEX_TRANSPORT_SIGNAL_SAMPLE_CHARACTERS
    )
    if (!hasCodexWebSocketFallback(window.codexTransportSignalSample)) return
    window.codexWebSocketFallbackObserved = true
    window.nonActionableCodexOnly = isNonActionableCodexStderr(window.codexTransportSignalSample)
    if (
      !window.eventEligible ||
      this.processEventDisposition(window.process, window.epoch) !== 'current' ||
      this.backend.providerId === undefined ||
      !isCodexSubscriptionProviderId(this.backend.providerId)
    ) {
      return
    }
    try {
      this.options.callbacks?.onCodexWebSocketFallback?.()
    } catch (error) {
      safeLogError('Codex WebSocket fallback observation failed', errorLogFields(error))
    }
  }

  private includeRawAgentStderr(): boolean {
    return process.env[RAW_AGENT_STDERR_ENV]?.trim().toLowerCase() === 'raw'
  }

  private appendAgentStderrSample(window: AgentStderrWindow, text: string, ended: boolean): void {
    if (!this.includeRawAgentStderr()) {
      this.agentStderrTails.delete(window.process)
      return
    }
    const tail = this.agentStderrTails.get(window.process) ?? {
      text: '',
      discarding: false,
      window
    }
    if (tail.window !== window && (tail.text || tail.discarding)) {
      // A line crossing reporting windows must not acquire a later prompt's attribution.
      window.sessionAttributionConsistent = false
    }
    tail.window = window
    let offset = 0
    do {
      const newline = text.indexOf('\n', offset)
      const end = newline < 0 ? text.length : newline + 1
      const part = text.slice(offset, end)
      if (!tail.discarding) {
        if (
          Buffer.byteLength(tail.text, 'utf8') + Buffer.byteLength(part, 'utf8') >
          MAX_RAW_AGENT_STDERR_SAMPLE_BYTES
        ) {
          tail.text = ''
          tail.discarding = true
        } else {
          tail.text += part
        }
      }
      if (tail.discarding) window.rawSampleTruncated = true
      if (newline >= 0 || ended) {
        if (!tail.discarding) {
          const safe = redactSensitiveText(tail.text)
          const bytes = Buffer.byteLength(safe, 'utf8')
          if (window.rawSampleBytes + bytes <= MAX_RAW_AGENT_STDERR_SAMPLE_BYTES) {
            window.rawSample += safe
            window.rawSampleBytes += bytes
          } else {
            window.rawSampleTruncated = true
          }
        }
        tail.text = ''
        tail.discarding = false
      }
      offset = end
      if (newline < 0) break
    } while (offset < text.length)
    this.agentStderrTails.set(window.process, tail)
  }

  private flushAgentProcessStderr(process: ChildProcessWithoutNullStreams): void {
    const window = this.agentStderrWindows.get(process)
    if (!window) return
    clearTimeout(window.timer)
    window.timer = undefined
    // Keep the original counters and attribution until a bounded raw line is complete.
    // With no more data there is no repeating timer; stream end/close finalizes the window.
    const tail = this.agentStderrTails.get(process)
    if (this.includeRawAgentStderr() && tail?.text && !tail.discarding) return
    this.agentStderrWindows.delete(process)

    const windowMs = Math.max(1, Date.now() - window.startedAt)
    const includeRaw = this.includeRawAgentStderr() && window.rawSample.length > 0
    const chunkLabel = window.chunkCount === 1 ? 'chunk' : 'chunks'
    const summary = `Agent process stderr: ${window.chunkCount} ${chunkLabel}, ${window.byteCount} bytes; ${includeRaw ? 'bounded raw sample follows' : 'raw output omitted'}.`
    const rawSuffix = window.rawSampleTruncated ? '\n…[truncated]' : ''
    log.warn('agent stderr summary', {
      errorCategory: 'process-stderr',
      framework: window.framework,
      status: this.snapshotOwner.status,
      sessionCount: this.activeSessionIds().length,
      chunkCount: window.chunkCount,
      byteCount: window.byteCount,
      windowMs,
      chunksPerSecond: Number(((window.chunkCount * 1000) / windowMs).toFixed(1)),
      ...(this.includeRawAgentStderr()
        ? { rawSample: window.rawSample, rawSampleTruncated: window.rawSampleTruncated }
        : {})
    })

    if (
      !window.eventEligible ||
      this.processEventDisposition(window.process, window.epoch) !== 'current'
    ) {
      return
    }
    if (window.nonActionableCodexOnly) return

    const inFlight = this.getInFlightSessionIds()
    const currentSessionId = inFlight.length === 1 ? inFlight[0] : undefined
    const currentInteractionSequence = currentSessionId
      ? this.sessionInteractions.current(currentSessionId)?.sequence
      : undefined
    const sessionId =
      window.sessionAttributionConsistent &&
      window.sessionId === currentSessionId &&
      window.interactionSequence === currentInteractionSequence
        ? window.sessionId
        : undefined
    this.pushEvent({
      kind: 'system',
      level: 'warning',
      sessionId,
      title: 'agent',
      text: includeRaw ? `${summary}\n${window.rawSample}${rawSuffix}` : `${summary}${rawSuffix}`
    })
  }

  private handleAgentProcessError(
    error: unknown,
    context: Parameters<AcpAgentConnectionHooks['onProcessError']>[1]
  ): void {
    log.error('agent process error event', {
      ...diagnosticErrorFields(error),
      ...this.diagnosticContext(context.framework, context.epoch)
    })

    if (this.processEventDisposition(context.process, context.epoch) !== 'current') return

    this.snapshotOwner.updateError(errorMessage(error))
    this.pushEvent({
      kind: 'error',
      level: 'error',
      title: 'Agent process error',
      text: this.snapshotOwner.error
    })
    this.setStatus('error')
  }

  private handleAgentProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    context: Parameters<AcpAgentConnectionHooks['onProcessExit']>[2]
  ): void {
    this.flushAgentProcessStderr(context.process)
    const processDisposition = this.processEventDisposition(context.process, context.epoch)
    log.info('agent process exit', {
      code,
      signal,
      framework: context.framework,
      status: this.snapshotOwner.status,
      expected: processDisposition === 'expected',
      sessionCount: this.activeSessionIds().length,
      pid: context.pid
    })

    if (processDisposition !== 'current') return

    if (this.snapshotOwner.status === 'connected' || this.snapshotOwner.status === 'connecting') {
      this.pushEvent({
        kind: 'system',
        level: code === 0 ? 'info' : 'warning',
        title: 'Agent process exited',
        text: signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      })
    }
  }

  // Updates connection status and broadcasts the new snapshot.
  private setStatus(status: AcpStateSnapshot['status']): void {
    this.snapshotOwner.transitionStatus(status)
    this.emitState()
  }

  // Adds a bounded event entry and notifies all renderer listeners.
  private pushEvent(event: AcpRuntimeEventInput, onAppended?: () => void): void {
    this.publication.pushEvent(event, onAppended)
  }

  // Broadcasts the latest runtime snapshot if a listener is registered.
  private emitState(): void {
    this.publication.emitState()
  }

  // Creates an ephemeral reviewer ACP session using the existing agent connection. The reviewer
  // session is isolated from primary session registry state, does not
  // appear in the snapshot, and callers are responsible for disposing it. This allows background
  // review to run in parallel with the main session without affecting the main state machine.
  async buildReviewerSession(request: ReviewerSessionRequest): Promise<ReviewerSessionResult> {
    return this.withOperationLease(() =>
      this.reviewerSessions.create(request, {
        configureModel: async (connection, session) => {
          const backend = this.backendGeneration.current
          if (backend.modelRoute === 'codebuddy-subscription')
            await this.sessionConfigurator.applyModel({ backend, connection, session })
        },
        ensureConnected: (cwd) => this.ensureConnected(cwd)
      })
    )
  }

  private assertCurrentConnectedConnection(connection: ClientConnection): void {
    if (this.connection !== connection || this.snapshotOwner.status !== 'connected') {
      throw new Error('ACP session startup was superseded.')
    }
  }

  // Disposes an ephemeral reviewer session and unregisters it from the auto-approve set. Safe to call
  // even if the session was never registered (e.g. it failed before start). Returns the gate rejection
  // count plus whether a bridged reviewer request actually hit its trusted session scope. The reads and
  // clears are atomic here so callers need no capture-before-dispose ordering.
  disposeReviewerSession(
    session: import('@agentclientprotocol/sdk').ActiveSession
  ): ReviewerSessionDisposition {
    return this.reviewerSessions.dispose(session)
  }
}

export type { ReviewerSessionDisposition } from './reviewer-session-owner'
export { AcpRuntime }
export type { AcpRuntimeOptions }
