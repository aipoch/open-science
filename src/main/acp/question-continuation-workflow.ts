import { randomUUID } from 'node:crypto'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { AcpPromptRequest, AcpStateSnapshot, ElicitationResponse } from '../../shared/acp'
import {
  AGENT_USER_CHOICE_REQUEST_CONTRACT,
  sanitizeAgentUserChoiceRequest,
  type AgentTurnProvenanceContext,
  type AgentUserChoiceRequest,
  type AgentUserChoiceResult,
  type ElicitationField,
  type PendingElicitationRequest,
  type TaskQuestionReceipt
} from '../../shared/elicitation'
import {
  agentUserChoiceOutcomes,
  USER_CHOICE_SKIP_GUIDANCE,
  type AcpElicitationOwner
} from './elicitation-owner'
import type { AcpAppContinuation, AcpAppContinuationOwner } from './app-continuation-owner'
import type { AcpDurableContinuationContextOwner } from './durable-continuation-context-owner'
import type { AcpRuntimeOptions } from './runtime-contract'
import type { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import { withTaskPromptOwner, type TaskContinuationTracker } from '../../shared/task-continuation'

type QuestionContinuationDependencies = Readonly<{
  hasActiveSession: (sessionId: string) => boolean
  projectId: (sessionId: string) => string
  persistedProjectId?: NonNullable<
    AcpRuntimeOptions['permissionWait']
  >['sessions']['sessionProjectId']
  permissionPrompts: (sessionId: string) => 'none' | undefined
  copyReferencedSessions: (sessionId: string) => AcpPromptRequest['referencedSessions']
  runtimeSessions?: Pick<
    NonNullable<AcpRuntimeOptions['runtimeSessions']>,
    'flush' | 'assertAdmissionAvailable'
  >
  interactions: Pick<AcpSessionInteractionOwner, 'current' | 'has'>
  elicitation: Pick<
    AcpElicitationOwner,
    | 'getPendingRequests'
    | 'listTaskQuestions'
    | 'respond'
    | 'restoreDetached'
    | 'appendDetached'
    | 'requestDetached'
  >
  context: Pick<
    AcpDurableContinuationContextOwner,
    'prepareElicitation' | 'rearmElicitation' | 'clearContextReset'
  >
  continuations: Pick<AcpAppContinuationOwner, 'set' | 'delete'>
  publication: Pick<AcpRuntimePublicationOwner, 'getSnapshot' | 'pushEvent' | 'emitState'>
  schedule: (sessionId: string) => void
}>

type TaskQuestionOwnerResponse = Readonly<{
  projectId: string
  originalRunId?: string
  request: PendingElicitationRequest
  action: 'accept' | 'decline'
  answers: ElicitationResponse['answers']
  waitsForProvider: boolean
  receipt: TaskQuestionReceipt
  assertCurrent: NonNullable<
    Parameters<AcpDurableContinuationContextOwner['prepareElicitation']>[0]['taskResponse']
  >['assertCurrent']
  assertLive: (
    request: PendingElicitationRequest | undefined,
    provenance: AgentTurnProvenanceContext | undefined
  ) => void
}>

type TaskQuestionSend = (
  request: AcpPromptRequest,
  attemptId: string,
  onProviderDispatched: () => void
) => Promise<PromptResponse>
const log = createLogger('acp')
const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}
class AcpQuestionContinuationWorkflow {
  private readonly userChoiceProvenanceContexts = new Map<
    string,
    Readonly<{
      sessionId: string
      provenanceContext?: NonNullable<AcpPromptRequest['provenanceContext']>
      memoryEnabled?: boolean
      referencedSessions?: AcpPromptRequest['referencedSessions']
    }>
  >()
  constructor(private readonly deps: QuestionContinuationDependencies) {}
  async respondToTask(
    input: TaskQuestionOwnerResponse,
    send?: TaskQuestionSend,
    trackSend?: TaskContinuationTracker
  ): Promise<void> {
    const { request, action, answers, receipt } = input
    const response = { requestId: request.requestId, action, answers }
    if (input.waitsForProvider) {
      const live = this.deps.elicitation
        .listTaskQuestions(request.sessionId)
        .find(
          (question) =>
            question.waitsForProvider &&
            !question.receipt &&
            question.request.requestId === request.requestId
        )
      const turn = this.deps.interactions.current(request.sessionId)
      input.assertLive(live?.request, turn?.kind === 'prompt' ? turn.provenanceContext : undefined)
      this.deps.elicitation.respond(response, receipt)
      this.deps.publication.emitState()
      return
    }
    const prepared = await this.deps.context.prepareElicitation({
      ...response,
      projectId: input.projectId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      replayIfContextReset: true,
      taskResponse: { receipt, assertCurrent: input.assertCurrent }
    })
    if (
      this.deps.elicitation
        .getPendingRequests()
        .some(({ requestId }) => requestId === request.requestId)
    ) {
      this.deps.elicitation.respond(response, receipt)
    }
    this.userChoiceProvenanceContexts.delete(request.requestId)
    const continuation = this.userChoiceContinuation(
      prepared.request,
      response,
      prepared.historyReplay,
      prepared.provenanceContext,
      prepared.memoryEnabled,
      prepared.referencedSessions
    )
    if (continuation) {
      const attemptId = receipt.continuationId
      const sendContinuation: AcpAppContinuation['send'] =
        send && attemptId
          ? (request, onProviderDispatched) => {
              const dispatch = (
                onTrackedDispatch?: () => void,
                taskRunId?: string
              ): Promise<PromptResponse> =>
                send(withTaskPromptOwner(request, taskRunId), attemptId, () => {
                  onProviderDispatched()
                  onTrackedDispatch?.()
                })
              const promptMessageId = request.provenanceContext?.promptMessageId
              if (!trackSend || !promptMessageId) return dispatch()
              return trackSend(
                {
                  kind: 'question',
                  projectId: input.projectId,
                  sessionId: request.sessionId,
                  attemptId,
                  promptMessageId,
                  originalPromptMessageId: promptMessageId,
                  originalRunId: input.originalRunId
                },
                dispatch
              )
            }
          : undefined
      this.scheduleTaskContinuation(continuation, input, sendContinuation)
    }
    this.deps.context.clearContextReset(request.sessionId)
    this.deps.publication.emitState()
  }

  private scheduleTaskContinuation(
    continuation: AcpPromptRequest,
    input: TaskQuestionOwnerResponse,
    send?: AcpAppContinuation['send']
  ): void {
    this.deps.continuations.set(input.request.sessionId, {
      request: continuation,
      condition: 'always',
      send,
      settle: async (outcome) => {
        if (outcome.phase === 'dispatched') return
        const promptMessageId = continuation.provenanceContext?.promptMessageId
        if (!promptMessageId) return
        try {
          await this.deps.context.rearmElicitation({
            projectId: input.projectId,
            sessionId: input.request.sessionId,
            promptMessageId,
            requestId: input.request.requestId,
            toolCallId: input.request.toolCallId,
            recovery: {
              error:
                'The Task could not continue. Query the recorded answer before taking another action.'
            }
          })
        } catch (error) {
          log.warn('Could not publish Task question recovery', {
            sessionId: input.request.sessionId,
            ...diagnosticErrorFields(error)
          })
        }
      }
    })
    this.deps.schedule(input.request.sessionId)
  }
  async respond(
    response: ElicitationResponse,
    continuePrepared = false
  ): Promise<AcpStateSnapshot> {
    if (response.request && response.request.requestId !== response.requestId) {
      throw new Error('Restored structured input request id does not match the response')
    }
    if (
      response.retryContinuation &&
      (!response.request?.durable || response.replacePreviousAnswer)
    ) {
      throw new Error('Invalid question continuation retry.')
    }
    if (response.continuationFailure !== undefined || response.prepareContinuation) {
      const request = response.request
      if (
        (!response.prepareContinuation &&
          (typeof response.continuationFailure !== 'string' ||
            !response.continuationFailure.trim())) ||
        !request?.durable ||
        response.action === 'cancel' ||
        response.replacePreviousAnswer ||
        this.deps.interactions.current(request.sessionId)
      ) {
        throw new Error('Invalid failed question continuation.')
      }
      const projectId =
        (await this.deps.persistedProjectId?.(request.sessionId)) ??
        this.deps.projectId(request.sessionId)
      if (!projectId) throw new Error('Durable continuation Session authority is not available.')
      await this.deps.context.prepareElicitation({
        projectId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        action: response.action,
        answers: response.answers,
        retryContinuation: response.retryContinuation,
        continuePrepared: !response.prepareContinuation && continuePrepared,
        beforeAttachment: !this.deps.hasActiveSession(request.sessionId),
        ...(response.continuationFailure !== undefined
          ? { recovery: { error: response.continuationFailure.slice(0, 4_000) } }
          : {})
      })
      return this.deps.publication.getSnapshot()
    }
    if (
      response.action === 'cancel' &&
      response.request?.durable?.kind === 'agent-user-choice' &&
      !response.replacePreviousAnswer &&
      // A live request must receive its existing cancel response through the elicitation owner.
      !this.deps.elicitation
        .getPendingRequests()
        .some(({ requestId }) => requestId === response.requestId)
    ) {
      const request = response.request
      if (this.deps.interactions.has(request.sessionId)) {
        throw new Error('Wait for the current Agent run to finish before ending this wait.')
      }
      const projectId =
        (await this.deps.persistedProjectId?.(request.sessionId)) ??
        this.deps.projectId(request.sessionId)
      if (!projectId) throw new Error('Durable continuation Session authority is not available.')
      if (request.durable?.promptMessageId) {
        await this.deps.runtimeSessions?.flush(request.sessionId, request.durable.promptMessageId)
      }
      await this.deps.context.prepareElicitation({
        projectId,
        sessionId: request.sessionId,
        requestId: response.requestId,
        toolCallId: request.toolCallId,
        action: 'cancel'
      })
      this.deps.continuations.delete(request.sessionId)
      if (
        this.deps.elicitation
          .getPendingRequests()
          .some(({ requestId }) => requestId === response.requestId)
      ) {
        this.deps.elicitation.respond(response)
      }
      this.userChoiceProvenanceContexts.delete(response.requestId)
      this.deps.publication.emitState()
      return this.deps.publication.getSnapshot()
    }
    let restoredContinuation:
      Awaited<ReturnType<AcpDurableContinuationContextOwner['prepareElicitation']>> | undefined
    if (
      (continuePrepared ||
        response.retryContinuation ||
        !this.deps.elicitation
          .getPendingRequests()
          .some((request) => request.requestId === response.requestId)) &&
      response.request
    ) {
      if (!this.deps.hasActiveSession(response.request.sessionId)) {
        throw new Error(`ACP session not found: ${response.request.sessionId}`)
      }
      restoredContinuation = await this.deps.context.prepareElicitation({
        projectId: this.deps.projectId(response.request.sessionId),
        sessionId: response.request.sessionId,
        requestId: response.request.requestId,
        toolCallId: response.request.toolCallId,
        action: response.action,
        answers: response.answers,
        replacePreviousAnswer: response.replacePreviousAnswer,
        retryContinuation: response.retryContinuation,
        continuePrepared,
        replayIfContextReset: true
      })
      if (
        !continuePrepared &&
        !response.retryContinuation &&
        !this.deps.elicitation.restoreDetached(restoredContinuation.request)
      ) {
        throw new Error('Invalid restored structured input request')
      }
    }

    const livePromptContext = this.userChoiceProvenanceContexts.get(response.requestId)
    const resolution =
      (continuePrepared || response.retryContinuation) && restoredContinuation
        ? {
            request: restoredContinuation.request,
            decision: {
              action: response.action,
              answers: response.answers
            },
            detached: true
          }
        : this.deps.elicitation.respond(response)
    this.userChoiceProvenanceContexts.delete(response.requestId)
    if (resolution.detached) {
      const continuation = this.userChoiceContinuation(
        resolution.request,
        resolution.decision,
        restoredContinuation?.historyReplay,
        restoredContinuation?.provenanceContext ?? livePromptContext?.provenanceContext,
        restoredContinuation?.memoryEnabled ?? livePromptContext?.memoryEnabled,
        restoredContinuation?.referencedSessions ?? livePromptContext?.referencedSessions
      )
      if (continuation) {
        const onUnaccepted = async (error?: unknown, retryable?: boolean): Promise<void> => {
          const promptMessageId = resolution.request.durable?.promptMessageId
          if (!promptMessageId) return
          await this.deps.runtimeSessions?.flush(resolution.request.sessionId, promptMessageId)
          await this.deps.context.rearmElicitation({
            projectId: this.deps.projectId(resolution.request.sessionId),
            sessionId: resolution.request.sessionId,
            promptMessageId,
            requestId: resolution.request.requestId,
            toolCallId: resolution.request.toolCallId,
            recovery: {
              error: error
                ? errorMessage(error)
                : 'The task could not continue. Your response is saved.',
              ...(retryable && !response.retryContinuation ? { retryable: true as const } : {})
            }
          })
        }
        this.deps.continuations.set(resolution.request.sessionId, {
          request: continuation,
          condition: 'always',
          settle: async (outcome) => {
            const sessionId = resolution.request.sessionId
            let recoveryPhase = 'preflight'
            try {
              if (outcome.phase !== 'dispatched') {
                await this.deps.runtimeSessions?.assertAdmissionAvailable(sessionId)
              }
              recoveryPhase = 'rearm'
              await onUnaccepted(outcome.error, outcome.retryable)
            } catch (error) {
              try {
                log.warn('App continuation recovery failed', {
                  sessionId,
                  phase: recoveryPhase,
                  ...diagnosticErrorFields(error)
                })
              } catch (loggingError) {
                void loggingError
              }
              this.deps.publication.pushEvent({
                kind: 'error',
                level: 'error',
                sessionId,
                title: 'Could not restore the unanswered question',
                text: errorMessage(error)
              })
            }
          }
        })
        this.deps.schedule(resolution.request.sessionId)
      }
      this.deps.context.clearContextReset(resolution.request.sessionId)
    }
    return this.deps.publication.getSnapshot()
  }

  async requestUserInput(input: AgentUserChoiceRequest): Promise<AgentUserChoiceResult> {
    const request = sanitizeAgentUserChoiceRequest(input)
    if (!request)
      throw new Error(
        `Invalid user choice request: expected ${AGENT_USER_CHOICE_REQUEST_CONTRACT}.`
      )
    if (!this.deps.hasActiveSession(request.sessionId)) return { action: 'cancelled' }
    if (this.deps.permissionPrompts(request.sessionId) === 'none') return { action: 'cancelled' }

    const pendingChoice = this.deps.elicitation
      .getPendingRequests()
      .find(
        (pending) =>
          pending.sessionId === request.sessionId && pending.durable?.kind === 'agent-user-choice'
      )
    if (pendingChoice) {
      const firstQuestionIndex = pendingChoice.fields.filter((field) =>
        /^question_\d+$/u.test(field.id)
      ).length
      const fields: ElicitationField[] = request.questions.flatMap((question, offset) => {
        const questionIndex = firstQuestionIndex + offset
        return [
          {
            id: `question_${questionIndex}`,
            label: question.header ?? `Question ${questionIndex + 1}`,
            description: question.question,
            kind: question.kind ?? 'single-select',
            options: question.options.map((option) => ({
              value: option.label,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
              ...(option.pros ? { pros: option.pros } : {}),
              ...(option.cons ? { cons: option.cons } : {})
            }))
          },
          {
            id: `question_${questionIndex}_custom`,
            label: 'Other',
            description: 'Type your own answer instead of choosing an option above (optional).',
            kind: 'text' as const
          }
        ]
      })
      const appended = this.deps.elicitation.appendDetached(pendingChoice.requestId, fields)
      if (!appended) return { action: 'cancelled' }
      if (appended.durable?.promptMessageId) {
        await this.deps.runtimeSessions?.flush(request.sessionId, appended.durable.promptMessageId)
      }
      return { action: 'pending' }
    }

    const requestId = randomUUID()
    const promptInteraction = this.deps.interactions.current(request.sessionId)
    const properties = Object.fromEntries(
      request.questions.flatMap((question, questionIndex) => [
        [
          `question_${questionIndex}`,
          {
            ...(question.header ? { title: question.header } : {}),
            description: question.question,
            ...(question.kind === 'multi-select'
              ? {
                  type: 'array',
                  items: {
                    anyOf: question.options.map((option) => ({
                      const: option.label,
                      title: option.label,
                      ...(option.description ? { description: option.description } : {}),
                      ...(option.pros ? { pros: option.pros } : {}),
                      ...(option.cons ? { cons: option.cons } : {})
                    }))
                  }
                }
              : {
                  type: 'string',
                  oneOf: question.options.map((option) => ({
                    const: option.label,
                    title: option.label,
                    ...(option.description ? { description: option.description } : {}),
                    ...(option.pros ? { pros: option.pros } : {}),
                    ...(option.cons ? { cons: option.cons } : {})
                  }))
                })
          }
        ],
        [
          `question_${questionIndex}_custom`,
          {
            type: 'string',
            title: 'Other',
            description: 'Type your own answer instead of choosing an option above (optional).'
          }
        ]
      ])
    )
    const pending = this.deps.elicitation.requestDetached(
      {
        mode: 'form',
        sessionId: request.sessionId,
        toolCallId: `ask-user-question-${randomUUID()}`,
        message: request.questions[0].question,
        requestedSchema: {
          type: 'object',
          properties
        }
      },
      { sessionId: request.sessionId },
      {
        kind: 'agent-user-choice',
        requestId,
        ...(promptInteraction?.kind === 'prompt' && promptInteraction.promptMessageId
          ? { promptMessageId: promptInteraction.promptMessageId }
          : {}),
        ...(promptInteraction?.kind === 'prompt' && promptInteraction.provenanceContext
          ? { provenanceContext: promptInteraction.provenanceContext }
          : {})
      }
    )

    if (!pending) return { action: 'cancelled' }
    // The tool must not acknowledge a durable question while its only copy is in the
    // streaming batch. A restart immediately after the tool returns must retain the card.
    if (pending.durable?.promptMessageId) {
      await this.deps.runtimeSessions?.flush(request.sessionId, pending.durable.promptMessageId)
    }
    const referencedSessions = this.deps.copyReferencedSessions(request.sessionId)
    if (
      promptInteraction?.kind === 'prompt' &&
      (promptInteraction.provenanceContext ||
        promptInteraction.memoryEnabled !== undefined ||
        referencedSessions?.length)
    ) {
      this.userChoiceProvenanceContexts.set(requestId, {
        sessionId: request.sessionId,
        ...(promptInteraction.provenanceContext
          ? { provenanceContext: promptInteraction.provenanceContext }
          : {}),
        ...(promptInteraction.memoryEnabled !== undefined
          ? { memoryEnabled: promptInteraction.memoryEnabled }
          : {}),
        ...(referencedSessions?.length ? { referencedSessions } : {})
      })
    }
    return { action: 'pending' }
  }

  private userChoiceContinuation(
    request: PendingElicitationRequest,
    response: Pick<ElicitationResponse, 'action' | 'answers'>,
    historyReplay?: ElicitationResponse['historyReplay'],
    provenanceContext?: AcpPromptRequest['provenanceContext'],
    memoryEnabled?: boolean,
    referencedSessions?: AcpPromptRequest['referencedSessions']
  ): AcpPromptRequest | undefined {
    if (response.action === 'cancel') return undefined
    const outcomes = agentUserChoiceOutcomes(request, response)
    const results = outcomes
      .map(({ question, status, answer }, index) => {
        const value = Array.isArray(answer) ? JSON.stringify(answer) : String(answer ?? '')
        return `${index + 1}. ${question}\nStatus: ${status}${status === 'answered' ? `\nAnswer: ${value}` : ''}`
      })
      .join('\n\n')
    const text = [
      'The user responded to the pending questions:',
      results,
      'Continue the current task using the provided answers without asking the same questions again.',
      ...(outcomes.some((outcome) => outcome.status === 'skipped')
        ? [USER_CHOICE_SKIP_GUIDANCE]
        : [])
    ].join('\n')
    const continuationProvenance =
      provenanceContext ??
      (request.durable?.promptMessageId
        ? { promptMessageId: request.durable.promptMessageId }
        : undefined)
    return {
      sessionId: request.sessionId,
      text,
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
      suppressUserMessage: true,
      ...(continuationProvenance ? { provenanceContext: continuationProvenance } : {}),
      ...(referencedSessions?.length ? { referencedSessions } : {}),
      ...(historyReplay?.historyPreamble ? { historyPreamble: historyReplay.historyPreamble } : {}),
      ...(historyReplay?.historyAttachments?.length
        ? { historyAttachments: historyReplay.historyAttachments }
        : {}),
      ...(historyReplay?.historyImages?.length
        ? { historyImages: historyReplay.historyImages }
        : {})
    }
  }

  clearSession(sessionId: string): void {
    const provenanceContexts = this.userChoiceProvenanceContexts
    if (!provenanceContexts) return
    for (const [requestId, provenance] of provenanceContexts) {
      if (provenance.sessionId === sessionId) {
        provenanceContexts.delete(requestId)
      }
    }
  }
}
export { AcpQuestionContinuationWorkflow }
export type { QuestionContinuationDependencies, TaskQuestionOwnerResponse }
