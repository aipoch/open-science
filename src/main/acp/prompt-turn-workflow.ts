import type { ActiveSession, PromptResponse } from '@agentclientprotocol/sdk'

import type { AcpPromptRequest } from '../../shared/acp'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import { createLogger, errorLogFields } from '../logger'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'
import type { AcpSessionRegistry } from './session-registry'
import type { AcpTurnSkillOwner, TurnSkillHandle } from './turn-skill-owner'

const log = createLogger('acp-prompt-turn-workflow')

type AcpPromptTurnMode =
  | Readonly<{ kind: 'user'; promptAttemptId?: string }>
  | Readonly<{ kind: 'app-continuation'; promptAttemptId?: string }>

type AcpPromptTurnPlanContext = Readonly<{
  authorized?: ActivePlanProjection
  protectedPending?: ActivePlanProjection
}>

type AcpActivatedPromptTurn = Readonly<{
  request: AcpPromptRequest
  mode: AcpPromptTurnMode
  session: ActiveSession
  interaction: AcpPromptSessionInteractionScope
  skill: TurnSkillHandle
  plan: AcpPromptTurnPlanContext
}>

type AcpPromptTurnWorkflowOptions = Readonly<{
  registry: Pick<AcpSessionRegistry, 'lookup' | 'select'>
  interactions: Pick<
    AcpSessionInteractionOwner,
    'activatePrompt' | 'current' | 'release' | 'reservePrompt'
  >
  skills: Pick<AcpTurnSkillOwner, 'authorize'>
  currentCwd: () => string
  resolveProjectName: (sessionId: string) => string
  preflightPlan: (
    request: AcpPromptRequest
  ) => AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext>
  admitPlan: (
    request: AcpPromptRequest,
    interaction: AcpPromptSessionInteractionScope,
    plan: AcpPromptTurnPlanContext
  ) => AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext>
  disconnectForReload: () => Promise<unknown>
  resumeAfterReload: (input: {
    sessionId: string
    cwd: string
    projectName: string
    permissionProfile: PermissionProfileId
  }) => Promise<{ contextReset?: boolean }>
  recordAdmittedPrompt: (request: AcpPromptRequest) => void
  onPromptStarted: (sessionId: string, turnToken: string, promptAttemptId?: string) => void
  emitState: () => void
  continueTurn: (turn: AcpActivatedPromptTurn) => Promise<PromptResponse>
}>

class AcpPromptTurnWorkflow {
  constructor(private readonly options: AcpPromptTurnWorkflowOptions) {}

  async run(request: AcpPromptRequest, mode: AcpPromptTurnMode): Promise<PromptResponse> {
    let activeSession = this.activeSession(request.sessionId)
    if (!activeSession) throw new Error(`ACP session not found: ${request.sessionId}`)
    this.assertSessionIdle(request.sessionId)

    const planPreflight = this.options.preflightPlan(request)
    let plan = planPreflight instanceof Promise ? await planPreflight : planPreflight
    let reservation = this.reserve(request)
    let skill: TurnSkillHandle
    try {
      const authorization = this.options.skills.authorize({
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
        const projectName = this.options.resolveProjectName(request.sessionId)
        await this.options.disconnectForReload()
        const resumed = await this.options.resumeAfterReload({
          sessionId: request.sessionId,
          cwd: snapshot?.cwd ?? this.options.currentCwd(),
          projectName,
          permissionProfile:
            snapshot?.permissionProfile?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE
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
    try {
      interaction = this.options.interactions.activatePrompt(reservation)
      const admittedPlan = this.options.admitPlan(request, interaction, plan)
      plan = admittedPlan instanceof Promise ? await admittedPlan : admittedPlan
      this.options.registry.select(request.sessionId)
      this.options.recordAdmittedPrompt(request)
    } catch (error) {
      skill.close(rejectedSkillOutcome)
      this.options.interactions.release(interaction ?? reservation)
      throw error
    }

    try {
      this.options.onPromptStarted(request.sessionId, interaction.turnToken, mode.promptAttemptId)
    } catch (error) {
      try {
        log.error('prompt-start callback failed', errorLogFields(error))
      } catch {
        // Diagnostics must not replace the admitted prompt.
      }
    }
    this.options.emitState()
    log.info('prompt start', {
      sessionId: request.sessionId,
      textLength: request.text?.length ?? 0
    })
    return this.options.continueTurn({
      request,
      mode,
      session: activeSession,
      interaction,
      skill,
      plan
    })
  }

  private activeSession(sessionId: string): ActiveSession | undefined {
    return this.options.registry.lookup(sessionId)?.attachment?.session
  }

  private assertSessionIdle(sessionId: string): void {
    if (this.options.interactions.current(sessionId)) {
      throw new Error('An ACP prompt is already running for this session')
    }
  }

  private reserve(request: AcpPromptRequest): AcpPromptSessionInteractionScope {
    return this.options.interactions.reservePrompt({
      sessionId: request.sessionId,
      kind: 'prompt',
      promptMessageId: request.provenanceContext?.promptMessageId,
      turnToken: request.continuation?.originatingTurnToken
    })
  }
}

export { AcpPromptTurnWorkflow }
export type {
  AcpActivatedPromptTurn,
  AcpPromptTurnMode,
  AcpPromptTurnPlanContext,
  AcpPromptTurnWorkflowOptions
}
