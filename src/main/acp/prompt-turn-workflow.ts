import type { ActiveSession, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'

import type { AcpPromptRequest } from '../../shared/acp'
import type { MessageAttribution } from '../../shared/session-persistence'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { formatPlanProtectedContext } from '../../shared/session-plan/contract'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import type { AgentFramework } from '../agent-framework'
import { createLogger, errorLogFields } from '../logger'
import { PLAN_FIRST_TURN_PROMPT_REMINDER } from '../session-plan/guidance'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import type {
  ContextUsageTracker,
  ContextWindowTurnHandle,
  SessionEstimateInput
} from './context-usage-tracker'
import type { AcpPermissionContext } from './permission-context'
import {
  AcpPromptOutcomeFinalizer,
  type AcpPromptFinalizationHandles,
  type AcpPromptFinalizationOutcome
} from './prompt-outcome-finalizer'
import type { AcpPromptPreparationOwner, PreparedPromptHandle } from './prompt-preparation-owner'
import type { AcpProviderPromptExecutor, ProviderPromptOutcome } from './provider-prompt-executor'
import type { AcpProviderPromptSerializationOwner } from './provider-prompt-serialization-owner'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'
import type { AcpSessionToolingAvailability } from './session-presentation-policy'
import type { SessionCapabilityPolicy } from './session-capability-owner'
import type { AcpSessionRegistry } from './session-registry'
import type { AcpTurnSkillOwner, TurnSkillHandle } from './turn-skill-owner'

const log = createLogger('acp-prompt-turn-workflow')

type AcpPromptTurnMode =
  | Readonly<{ kind: 'user'; promptAttemptId?: string }>
  | Readonly<{
      kind: 'application'
      attribution: MessageAttribution
      promptAttemptId?: string
    }>
  | Readonly<{
      kind: 'app-continuation'
      promptAttemptId?: string
      planDelivery?: Readonly<{ projectId: string; commandId: string }>
    }>

type AcpPromptTurnPlanContext = Readonly<{
  active?: ActivePlanProjection
  protectedPending?: ActivePlanProjection
  protectedRejected?: ActivePlanProjection
}>

type AcpActivatedPromptTurn = Readonly<{
  request: AcpPromptRequest
  connectionGeneration: number
  mode: AcpPromptTurnMode
  session: ActiveSession
  interaction: AcpPromptSessionInteractionScope
  skill: TurnSkillHandle
  plan: AcpPromptTurnPlanContext
}>

type AcpPromptTurnEnvironment = Readonly<{
  connectionGeneration?: () => number
  backend: () => AcpBackendGenerationView
  tooling: () => AcpSessionToolingAvailability
  role?: () => SessionCapabilityPolicy['role']
  bridgeSkillsAvailable: () => boolean
  skillImportEnabled: () => boolean
  contextEstimateInput: (sessionId: string) => SessionEstimateInput
  selectedContextWindow: (sessionId: string) => number | undefined
  resolveComputeExecutionTargetIds?: (sessionId: string) => readonly string[]
  emitSkillActivities: (
    sessionId: string,
    promptTurn: number,
    inputs: ReadonlyArray<{ name: string }>,
    status: 'in_progress' | 'completed' | 'failed'
  ) => void
  onSkillImportAttachmentEligible?: (sessionId: string, turnToken: string, uri: string) => void
  onProviderPromptAccepted?: (sessionId: string, promptAttemptId?: string) => void
  sideChatRelays?: Readonly<{
    claim: (parentSessionId: string) =>
      | Readonly<{
          historyPreamble: string
          commit: (promptMessageId?: string) => void | Promise<void>
          restore: () => void
        }>
      | undefined
  }>
  routeNotification: (notification: SessionNotification, sessionId: string) => void
  diagnosticContext: () => Record<string, unknown>
  pushUserMessage: (input: {
    sessionId: string
    promptMessageId?: string
    text: string
    attribution?: MessageAttribution
  }) => void
  beforePromptDispatch?: (input: {
    appSessionId: string
    framework: AgentFramework
    providerSessionId: string
    cwd: string
    skillRuntimeAllowlist?: readonly string[]
  }) => Promise<void>
}>

type AcpPromptTurnArtifacts = Readonly<{
  open: (
    sessionId: string,
    executionId: string,
    provenance: AcpPromptRequest['provenanceContext']
  ) => Promise<ArtifactTurnHandle | undefined>
  promptMessageIdFor: (artifact: ArtifactTurnHandle | undefined) => string | undefined
  publish: (
    sessionId: string,
    artifact: ArtifactTurnHandle | undefined,
    onPublished: () => void
  ) => Promise<void>
  dispose: (artifact: ArtifactTurnHandle | undefined) => Promise<void>
}>

type AcpPromptTurnPlanWorkflow = Readonly<{
  preflight: (
    request: AcpPromptRequest,
    mode: AcpPromptTurnMode
  ) => AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext>
  admit: (
    request: AcpPromptRequest,
    interaction: AcpPromptSessionInteractionScope,
    plan: AcpPromptTurnPlanContext
  ) => AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext>
  providerAccepted: (sessionId: string, mode: AcpPromptTurnMode) => void | Promise<void>
  beforeRelease: (sessionId: string, interaction: AcpPromptSessionInteractionScope) => void
  afterRelease: (sessionId: string) => Promise<void>
}>

type AcpPromptTurnFinalization = Readonly<{
  errorMessage: AcpPromptFinalizationHandles['errorMessage']
  errorKind: AcpPromptFinalizationHandles['errorKind']
  pushEvent: AcpPromptFinalizationHandles['pushEvent']
  onPromptEnded: (sessionId: string, turnToken: string) => void
  generationActivityChanged: () => void
  autoCompact: (
    sessionId: string,
    session: ActiveSession,
    interaction: AcpPromptSessionInteractionScope
  ) => Promise<unknown>
  compactIfIdle: (sessionId: string) => Promise<unknown>
  preemptCompaction: (sessionId: string) => Promise<void> | undefined
}>

type AcpPromptTurnWorkflowOptions = Readonly<{
  registry: Pick<AcpSessionRegistry, 'lookup' | 'select'>
  interactions: Pick<
    AcpSessionInteractionOwner,
    | 'activatePrompt'
    | 'cancellationCheckpoint'
    | 'captureTerminal'
    | 'current'
    | 'release'
    | 'reservePrompt'
    | 'settle'
    | 'updatePromptProvenance'
  >
  skills: Pick<AcpTurnSkillOwner, 'authorize'>
  preparation: Pick<AcpPromptPreparationOwner, 'prepare'>
  executor: Pick<AcpProviderPromptExecutor, 'execute'>
  serialization: Pick<AcpProviderPromptSerializationOwner, 'run'>
  contextUsage: Pick<ContextUsageTracker, 'reconcileUsed'>
  providerReconnectPending: () => boolean
  finalizer: Pick<AcpPromptOutcomeFinalizer, 'finalize'>
  permission: Pick<AcpPermissionContext, 'clearCorrelationsForSession'>
  environment: AcpPromptTurnEnvironment
  artifacts: AcpPromptTurnArtifacts
  plan: AcpPromptTurnPlanWorkflow
  finalization: AcpPromptTurnFinalization
  currentCwd: () => string
  resolveProjectId: (sessionId: string) => string
  disconnectForReload: () => Promise<unknown>
  resumeAfterReload: (input: {
    sessionId: string
    cwd: string
    projectId: string
    permissionProfile: PermissionProfileId
  }) => Promise<{ contextReset?: boolean }>
  recordAdmittedPrompt: (request: AcpPromptRequest) => void
  onPromptStarted: (sessionId: string, turnToken: string, promptAttemptId?: string) => void
  emitState: () => void
}>

class AcpPromptTurnWorkflow {
  constructor(private readonly options: AcpPromptTurnWorkflowOptions) {}

  async run(
    request: AcpPromptRequest,
    mode: AcpPromptTurnMode,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): Promise<PromptResponse> {
    let activeSession = this.activeSession(request.sessionId)
    if (!activeSession) throw new Error(`ACP session not found: ${request.sessionId}`)
    this.assertSessionIdle(request.sessionId)

    let reservation = this.reserve(request)
    let plan: AcpPromptTurnPlanContext
    let skill: TurnSkillHandle
    try {
      const preemption = this.options.finalization.preemptCompaction(request.sessionId)
      if (preemption) await preemption
      const planPreflight = this.options.plan.preflight(request, mode)
      plan = planPreflight instanceof Promise ? await planPreflight : planPreflight
      const authorization = this.options.skills.authorize({
        role: this.options.environment.role?.(),
        specialistId: this.options.registry.lookup(request.sessionId)?.aggregate.snapshot()
          .specialistId,
        selectedSkillIds: request.forcedSkillIds,
        signal: reservation.signal
      })
      skill = authorization instanceof Promise ? await authorization : authorization
    } catch (error) {
      this.options.interactions.release(reservation)
      throw error
    }
    const rejectedSkillOutcome =
      skill.reloadDecision.kind === 'reload' ? 'reload-restored' : 'failed'

    try {
      if (skill.reloadDecision.kind === 'reload') {
        this.assertSessionIdle(request.sessionId)
        const snapshot = this.options.registry.lookup(request.sessionId)?.aggregate.snapshot()
        const projectId = this.options.resolveProjectId(request.sessionId)
        await this.options.disconnectForReload()
        const resumed = await this.options.resumeAfterReload({
          sessionId: request.sessionId,
          cwd: snapshot?.cwd ?? this.options.currentCwd(),
          projectId,
          permissionProfile:
            snapshot?.permissionProfile?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE,
          ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {})
        })
        if (resumed.contextReset) {
          request.historyPreamble = request.resumeFallback?.historyPreamble
          request.historyAttachments = request.resumeFallback?.historyAttachments
          request.historyImages = request.resumeFallback?.historyImages
          request.contextReset = true
        }
        activeSession = this.activeSession(request.sessionId)
        if (!activeSession) {
          throw new Error(`ACP session not found after force-load: ${request.sessionId}`)
        }
        reservation = this.reserve(request)
      }
    } catch (error) {
      skill.close('reload-restored')
      this.options.interactions.release(reservation)
      throw error
    }

    if (this.options.interactions.current(request.sessionId)) {
      skill.close(rejectedSkillOutcome)
      this.options.interactions.release(reservation)
      throw new Error('An ACP prompt is already running for this session')
    }
    activeSession = this.activeSession(request.sessionId)
    if (!activeSession) {
      skill.close(rejectedSkillOutcome)
      this.options.interactions.release(reservation)
      throw new Error(`ACP session not found: ${request.sessionId}`)
    }

    let interaction: AcpPromptSessionInteractionScope | undefined
    let admittedRequest = request
    try {
      interaction = this.options.interactions.activatePrompt(reservation)
      const admittedPlan = this.options.plan.admit(request, interaction, plan)
      plan = admittedPlan instanceof Promise ? await admittedPlan : admittedPlan
      // Admission-dependent state may commit only while this interaction owns the Session. A
      // rejected commit releases ownership below without publishing prompt start or dispatching.
      const admittedProvenanceContext = await onPromptAdmitted?.()
      if (admittedProvenanceContext) {
        this.options.interactions.updatePromptProvenance(interaction, admittedProvenanceContext)
        admittedRequest = { ...request, provenanceContext: admittedProvenanceContext }
      }
      this.options.registry.select(admittedRequest.sessionId)
      this.options.recordAdmittedPrompt(admittedRequest)
    } catch (error) {
      skill.close(rejectedSkillOutcome)
      this.options.interactions.release(interaction ?? reservation)
      throw error
    }

    this.safeCallback('prompt-start callback failed', () =>
      this.options.onPromptStarted(request.sessionId, interaction.turnToken, mode.promptAttemptId)
    )
    this.options.emitState()
    log.info('prompt start', {
      sessionId: request.sessionId,
      textLength: request.text?.length ?? 0
    })
    return this.executeTurn({
      request: admittedRequest,
      connectionGeneration: this.options.environment.connectionGeneration?.() ?? 0,
      mode,
      session: activeSession,
      interaction,
      skill,
      plan
    })
  }

  private async executeTurn(turn: AcpActivatedPromptTurn): Promise<PromptResponse> {
    const { request, session, interaction, skill } = turn
    const {
      artifacts,
      environment: env,
      executor,
      finalization,
      finalizer,
      interactions,
      plan,
      permission,
      preparation,
      registry
    } = this.options
    const sessionId = request.sessionId
    const promptTurn = interaction.sequence
    const turnToken = interaction.turnToken
    const eventIdentity = interaction.promptMessageId
      ? { promptMessageId: interaction.promptMessageId }
      : {}
    let artifact: ArtifactTurnHandle | undefined
    let prepared: PreparedPromptHandle | undefined
    let context: ContextWindowTurnHandle | undefined
    let skillInputs: Array<{ name: string; path: string }> = []
    let skillStarted = false
    let skillFinalized = false
    let userMessageEmitted = false
    let sideChatRelay: ReturnType<NonNullable<typeof env.sideChatRelays>['claim']>
    let sideChatRelaySettled = false
    const emitUserMessage = (): void => {
      if (
        (turn.mode.kind !== 'user' && turn.mode.kind !== 'application') ||
        request.continuation ||
        request.suppressUserMessage ||
        userMessageEmitted
      )
        return
      userMessageEmitted = true
      env.pushUserMessage({
        sessionId,
        ...eventIdentity,
        text: request.text,
        ...(turn.mode.kind === 'application' ? { attribution: turn.mode.attribution } : {})
      })
    }
    const execute = async (): Promise<ProviderPromptOutcome> => {
      artifact = await artifacts.open(sessionId, turnToken, request.provenanceContext)
      if ((await this.checkpoint(interaction)) === 'cancelled') {
        return Object.freeze({ kind: 'not-dispatched' })
      }
      if (turn.mode.kind === 'user' && !request.continuation && !request.suppressUserMessage) {
        sideChatRelay = env.sideChatRelays?.claim(sessionId)
      }
      const preparationRequest = sideChatRelay
        ? {
            ...request,
            historyPreamble: [request.historyPreamble, sideChatRelay.historyPreamble]
              .filter((value): value is string => Boolean(value))
              .join('\n\n')
          }
        : request
      const snapshot = registry.lookup(sessionId)?.aggregate.snapshot()
      const backend = env.backend()
      const planContext =
        turn.plan.active ?? turn.plan.protectedPending ?? turn.plan.protectedRejected
      prepared = await preparation.prepare({
        request: preparationRequest,
        connectionGeneration: turn.connectionGeneration,
        backend,
        tooling: env.tooling(),
        role: env.role?.(),
        specialistPrefix: snapshot?.specialistPrefix,
        sessionSetupPromptPrefix: snapshot?.sessionSetupPromptPrefix,
        projectId: this.options.resolveProjectId(sessionId),
        fallbackPromptMessageId: artifacts.promptMessageIdFor(artifact),
        bridgeSkillsAvailable: env.bridgeSkillsAvailable(),
        skillImportEnabled: env.skillImportEnabled(),
        skillImportTurnToken: turnToken,
        turnSkill: skill,
        selectedComputeHostIds: env.resolveComputeExecutionTargetIds?.(sessionId) ?? [],
        ...(planContext ? { protectedContext: formatPlanProtectedContext(planContext) } : {}),
        ...(request.turnIntent === 'plan-first'
          ? { turnPromptReminders: [PLAN_FIRST_TURN_PROMPT_REMINDER] }
          : {}),
        signal: interaction.signal,
        isCurrent: () => this.isCurrent(turn),
        cancellationCheckpoint: () => this.checkpoint(interaction),
        contextEstimateInput: env.contextEstimateInput(sessionId),
        selectedContextWindow: env.selectedContextWindow(sessionId),
        ...(env.onSkillImportAttachmentEligible
          ? {
              onSkillImportAttachmentEligible: (uri: string) =>
                this.safeCallback('skill import attachment callback failed', () =>
                  env.onSkillImportAttachmentEligible?.(sessionId, turnToken, uri)
                )
            }
          : {})
      })
      if (prepared.status === 'cancelled') return Object.freeze({ kind: 'not-dispatched' })
      const readyPrepared = prepared
      skillInputs = [...readyPrepared.skillActivityInputs]
      context = readyPrepared.transferContextTurn()
      emitUserMessage()
      if (skillInputs.length > 0) {
        env.emitSkillActivities(sessionId, promptTurn, skillInputs, 'in_progress')
        skillStarted = true
      }
      const promptSnapshot = registry.lookup(sessionId)?.aggregate.snapshot()
      const promptBackend = env.backend()
      const framework = promptBackend.framework
      const cwd = promptSnapshot?.cwd ?? this.options.currentCwd()
      const executeProviderTurn = (): Promise<ProviderPromptOutcome> =>
        executor.execute({
          session,
          content: readyPrepared.content,
          cwd,
          frameworkId: promptSnapshot?.frameworkId ?? framework.id,
          ...(readyPrepared.preDispatchModelCalls
            ? { preDispatchModelCalls: readyPrepared.preDispatchModelCalls }
            : {}),
          isCurrent: () => this.isCurrent(turn),
          beforeDispatch: async () => {
            if ((await this.checkpoint(interaction)) === 'cancelled') return 'cancelled'
            await env.beforePromptDispatch?.({
              appSessionId: sessionId,
              framework,
              providerSessionId: session.sessionId,
              cwd,
              ...(readyPrepared.skillRuntimeAllowlist
                ? { skillRuntimeAllowlist: readyPrepared.skillRuntimeAllowlist }
                : {})
            })
            if (request.historyPreamble) {
              log.info('session transcript replay dispatched', {
                sessionId,
                historyTextLength: request.historyPreamble.length,
                historyAttachmentCount: request.historyAttachments?.length ?? 0,
                historyImageCount: request.historyImages?.length ?? 0,
                ...env.diagnosticContext()
              })
            }
            return 'active'
          },
          captureStop: () => interactions.captureTerminal(interaction, 'stop'),
          onAccepted: async () => {
            await plan.providerAccepted(sessionId, turn.mode)
            if (sideChatRelay && !sideChatRelaySettled) {
              sideChatRelaySettled = true
              try {
                await sideChatRelay.commit(request.provenanceContext?.promptMessageId)
              } catch (error) {
                log.warn('side chat advisory persistence failed after provider admission', {
                  sessionId,
                  ...errorLogFields(error)
                })
              }
            }
            this.safeCallback('provider-prompt-accepted callback failed', () =>
              env.onProviderPromptAccepted?.(sessionId, turn.mode.promptAttemptId)
            )
            if (skillStarted && !skillFinalized) {
              env.emitSkillActivities(sessionId, promptTurn, skillInputs, 'completed')
              skillFinalized = true
            }
          },
          // Application turns are app-authored prompts, but their provider output is still the
          // Session's authoritative assistant turn. Route it through the normal event projection so
          // the response, tools, stop metadata, and durable transcript all settle. Dropping these
          // notifications left Reviewer Corrections with only the [Auditor] prompt persisted, so the
          // fix loop could never observe the completed correction and refused its scoped re-review.
          routeNotification: (notification) => env.routeNotification(notification, sessionId),
          reportBestEffortFailure: (stage, error) =>
            log.warn('provider prompt observation failed', {
              sessionId,
              stage,
              ...errorLogFields(error)
            })
        })

      return this.options.serialization.run(framework, executeProviderTurn)
    }
    let outcome: AcpPromptFinalizationOutcome
    try {
      outcome = await execute()
    } catch (error) {
      outcome = Object.freeze({ kind: 'failed', error })
    }
    if (sideChatRelay && !sideChatRelaySettled) {
      sideChatRelaySettled = true
      sideChatRelay.restore()
    }
    const model = env.backend().session.model
    return finalizer.finalize(
      {
        sessionId,
        ...eventIdentity,
        interaction,
        interactions,
        permission,
        ...(prepared ? { prepared } : {}),
        ...(context ? { context } : {}),
        skill,
        ...(model ? { model } : {}),
        emitUserMessage,
        emitArtifact: (onPublished) => artifacts.publish(sessionId, artifact, onPublished),
        disposeArtifact: () => artifacts.dispose(artifact),
        failPendingSkillActivities: () => {
          if (!skillStarted || skillFinalized) return
          env.emitSkillActivities(sessionId, promptTurn, skillInputs, 'failed')
          skillFinalized = true
        },
        recordContextUsed: (used) => {
          if (
            this.options.providerReconnectPending() ||
            interactions.current(sessionId) !== interaction
          ) {
            return false
          }
          const reconciled = this.options.contextUsage.reconcileUsed(sessionId, used)
          if (reconciled) this.options.emitState()
          return reconciled
        },
        errorMessage: finalization.errorMessage,
        errorKind: finalization.errorKind,
        pushEvent: finalization.pushEvent,
        emitState: this.options.emitState,
        onPromptEnded: () => finalization.onPromptEnded(sessionId, turnToken),
        generationActivityChanged: finalization.generationActivityChanged,
        autoCompactIfNeeded: () => finalization.autoCompact(sessionId, session, interaction),
        beforeInteractionRelease: () => plan.beforeRelease(sessionId, interaction),
        afterInteractionRelease: async () => {
          await plan.afterRelease(sessionId)
          void finalization.compactIfIdle(sessionId)
        }
      },
      outcome
    )
  }

  private activeSession(sessionId: string): ActiveSession | undefined {
    return this.options.registry.lookup(sessionId)?.attachment?.session
  }

  private assertSessionIdle(sessionId: string): void {
    const current = this.options.interactions.current(sessionId)
    if (!current) return
    if (current.kind === 'prompt') {
      throw new Error('An ACP prompt is already running for this session')
    }
  }

  private reserve(request: AcpPromptRequest): AcpPromptSessionInteractionScope {
    return this.options.interactions.reservePrompt({
      sessionId: request.sessionId,
      kind: 'prompt',
      promptMessageId: request.provenanceContext?.promptMessageId,
      provenanceContext: request.provenanceContext,
      ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {}),
      turnToken: request.continuation?.originatingTurnToken,
      ...(request.referencedSessions?.length
        ? {
            referencedSessionIds: request.referencedSessions.map((reference) => reference.sessionId)
          }
        : {})
    })
  }

  private checkpoint(
    interaction: AcpPromptSessionInteractionScope
  ): Promise<'active' | 'cancelled'> {
    return this.options.interactions.cancellationCheckpoint(interaction)
  }

  private isCurrent(turn: AcpActivatedPromptTurn): boolean {
    return (
      this.options.interactions.current(turn.request.sessionId) === turn.interaction &&
      this.activeSession(turn.request.sessionId) === turn.session
    )
  }

  private safeCallback(message: string, action: () => void): void {
    try {
      action()
    } catch (error) {
      try {
        log.error(message, errorLogFields(error))
      } catch {
        // Diagnostics must not replace the prompt lifecycle.
      }
    }
  }
}

export { AcpPromptTurnWorkflow }
export type {
  AcpPromptTurnMode,
  AcpPromptTurnPlanContext,
  AcpPromptTurnPlanWorkflow,
  AcpPromptTurnWorkflowOptions
}
