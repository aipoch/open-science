import type { PromptResponse } from '@agentclientprotocol/sdk'
import {
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpPermissionResponse,
  type AcpPromptRequest,
  type AcpStateSnapshot
} from '../../shared/acp'
import type { AcpAppContinuationOwner, AcpContinuationOutcome } from './app-continuation-owner'
import type { AcpDurableContinuationContextOwner } from './durable-continuation-context-owner'
import {
  taskPermissionOptions,
  type RestoredPermissionContinuation,
  type TaskPermissionDecision
} from './permission-broker'
import type { AcpPermissionContext } from './permission-context'
import { restorableTaskPermission, type AcpPermissionWaitOwner } from './permission-wait-owner'
import type { AcpRuntimeCallbacks } from './runtime-contract'
import type { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'

type PermissionContinuationDependencies = Readonly<{
  hasActiveSession: (sessionId: string) => boolean
  projectId: (sessionId: string) => string
  wait: Pick<
    AcpPermissionWaitOwner,
    | 'resolveRestored'
    | 'beginContinuation'
    | 'rearmContinuation'
    | 'clearAfterContinuation'
    | 'cancelContinuation'
  >
  permission: Pick<AcpPermissionContext, 'prepareRestoredDecision' | 'clearRestoredDecision'>
  context: Pick<AcpDurableContinuationContextOwner, 'prepare' | 'clearContextReset'>
  interactions: Pick<AcpSessionInteractionOwner, 'current' | 'isCancellationAccepted'>
  continuations: Pick<AcpAppContinuationOwner, 'set'>
  publication: Pick<AcpRuntimePublicationOwner, 'getSnapshot' | 'pushEvent' | 'emitState'>
  onPermissionSettled?: AcpRuntimeCallbacks['onPermissionSettled']
  send: (
    request: AcpPromptRequest,
    permission: RestoredPermissionContinuation,
    onProviderDispatched: () => void
  ) => Promise<PromptResponse>
  schedule: (sessionId: string) => void
}>

export type TaskRestoredPermissionDecision = TaskPermissionDecision & {
  branchId: string
  promptMessageId: string
}

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}
const PERMISSION_DENIED_CONTINUATION_TEXT =
  'The user explicitly denied this operation. You do not have authorization to perform it. ' +
  'Do not retry or approximate the denied operation with a different command, tool, or route, ' +
  'and do not request permission for it again in this turn. Continue only with independent work ' +
  'that is already permitted. If the denied operation is required, explain the boundary and wait ' +
  'for the user to explicitly change their decision in a new message.'

const PERMISSION_CANCELLED_CONTINUATION_TEXT =
  'The pending permission interaction was cancelled without granting authorization. Do not ' +
  'execute or retry the parked tool call unless the user explicitly approves it later. Continue ' +
  'only with independent work that is already permitted, or explain what cannot be completed.'

// This registry owns identity/lifetime, not the existing shared handoff flag protocol.
// Broker and wait-owner writes must retain this exact object identity through successor commit.
class AcpPermissionContinuationWorkflow {
  private readonly continuations = new Map<string, RestoredPermissionContinuation>()
  constructor(private readonly deps: PermissionContinuationDependencies) {}

  async respond(
    response: AcpPermissionResponse,
    task?: TaskRestoredPermissionDecision
  ): Promise<AcpStateSnapshot> {
    const restored = response.restored!
    const activeSession = this.deps.hasActiveSession(restored.sessionId)
    if (!activeSession) throw new Error(`ACP session not found: ${restored.sessionId}`)
    const projectId = this.deps.projectId(restored.sessionId)
    const decision = await this.deps.wait.resolveRestored(response, projectId, restored.sessionId)
    if (
      task &&
      !taskPermissionOptions(decision.permission.request).some(
        ({ optionId }) => optionId === response.optionId
      )
    ) {
      throw new Error('Task responses must use a current one-shot permission option.')
    }
    const continuation = await this.deps.context.prepare({
      projectId,
      sessionId: restored.sessionId,
      promptMessageId: decision.permission.originatingPromptMessageId,
      replayIfContextReset: true
    })
    const durablePermissionContinuations = this.continuations
    if (durablePermissionContinuations.has(restored.sessionId)) {
      throw new Error('The restored permission request is already being continued.')
    }
    const permissionContinuation: RestoredPermissionContinuation = {
      projectId,
      sessionId: restored.sessionId,
      requestId: response.requestId,
      promptMessageId: decision.permission.originatingPromptMessageId,
      fingerprint: decision.permission.fingerprint,
      ...(task ? { taskResponse: true as const } : {}),
      released: false,
      handoffStarted: false,
      handedOff: false
    }
    durablePermissionContinuations.set(restored.sessionId, permissionContinuation)
    let continuationBegan = false
    try {
      // Persist the consumed/non-replayable marker before starting provider work. A process loss or
      // grant failure must never leave a reusable approval without consuming its authority first.
      const prepareDecision = async (): Promise<boolean> => {
        await this.deps.wait.beginContinuation(
          projectId,
          restored.sessionId,
          response.requestId,
          task &&
            ((session) => {
              const current = restorableTaskPermission(session, task.promptMessageId)
              if (
                !current ||
                current.activity.messageBranchId !== task.branchId ||
                current.permission.request.requestId !== response.requestId ||
                current.permission.fingerprint !== decision.permission.fingerprint ||
                !taskPermissionOptions(current.permission.request).some(
                  ({ optionId }) => optionId === response.optionId
                )
              ) {
                throw new Error(
                  'The restored permission is no longer current on this Message Branch.'
                )
              }
              task.assertCurrent()
            })
        )
        continuationBegan = true
        if (task) await task.record('unconfirmed')
        await this.deps.permission.prepareRestoredDecision(
          decision.permission,
          decision.option,
          projectId,
          permissionContinuation
        )
        return true
      }
      if (task) {
        if (!(await task.commit(prepareDecision)))
          throw new Error('This Task permission was already answered.')
      } else {
        await prepareDecision()
      }
    } catch (error) {
      this.deps.permission.clearRestoredDecision(restored.sessionId, permissionContinuation)
      if (continuationBegan) {
        try {
          await this.deps.wait.rearmContinuation(projectId, restored.sessionId, response.requestId)
          this.deps.publication.pushEvent({
            kind: 'permission',
            level: 'info',
            sessionId: restored.sessionId,
            permissionRequestId: response.requestId,
            title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
          })
        } catch (rearmError) {
          this.deps.publication.pushEvent({
            kind: 'permission',
            level: 'error',
            sessionId: restored.sessionId,
            permissionRequestId: response.requestId,
            title: ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
            text: errorMessage(rearmError)
          })
        }
        this.deps.publication.emitState()
      }
      if (durablePermissionContinuations.get(restored.sessionId) === permissionContinuation)
        durablePermissionContinuations.delete(restored.sessionId)
      throw error
    }

    const scope = decision.option?.scope
    const text = task
      ? decision.denied
        ? PERMISSION_CANCELLED_CONTINUATION_TEXT
        : 'The pending tool permission was approved once for this task. Retry only the exact parked tool call. Do not broaden the approval.'
      : response.cancelled
        ? PERMISSION_CANCELLED_CONTINUATION_TEXT
        : decision.denied
          ? PERMISSION_DENIED_CONTINUATION_TEXT
          : `The user approved the pending tool permission${scope ? ` for ${scope}` : ''}. Retry only ` +
            'the exact parked tool call and continue the current task. Do not broaden or reinterpret the approval.'
    this.deps.continuations.set(restored.sessionId, {
      condition: 'always',
      send: (request, onProviderDispatched) =>
        this.deps.send(request, permissionContinuation, onProviderDispatched),
      settle: (outcome) =>
        this.settlePermissionContinuation(restored.sessionId, permissionContinuation, outcome),
      request: {
        sessionId: restored.sessionId,
        text,
        memoryEnabled: continuation.memoryEnabled,
        suppressUserMessage: true,
        provenanceContext: continuation.provenanceContext,
        ...(continuation.referencedSessions?.length
          ? { referencedSessions: continuation.referencedSessions }
          : {}),
        ...(continuation.parts?.length ? { parts: continuation.parts } : {}),
        ...(continuation.historyReplay?.historyPreamble
          ? { historyPreamble: continuation.historyReplay.historyPreamble }
          : {}),
        ...(continuation.historyReplay?.historyAttachments.length
          ? { historyAttachments: continuation.historyReplay.historyAttachments }
          : {}),
        ...(continuation.historyReplay?.historyImages.length
          ? { historyImages: continuation.historyReplay.historyImages }
          : {})
      }
    })
    this.deps.schedule(restored.sessionId)
    const settlementState = response.cancelled
      ? 'cancelled'
      : decision.denied
        ? 'rejected'
        : 'resolved'
    this.deps.onPermissionSettled?.(response.requestId, settlementState)
    if (settlementState !== 'resolved') {
      this.deps.publication.pushEvent({
        kind: 'tool',
        level: 'info',
        sessionId: restored.sessionId,
        promptMessageId: decision.permission.originatingPromptMessageId,
        toolCallId: decision.permission.request.toolCallId,
        title: decision.permission.request.title,
        providerToolName:
          decision.permission.request.providerToolName ?? decision.permission.request.mcpIdentity,
        rawInput: decision.permission.request.rawInput,
        status: settlementState === 'rejected' ? 'completed' : 'in_progress',
        toolDisposition: settlementState === 'rejected' ? 'declined' : 'permission-closed'
      })
    }
    this.deps.publication.pushEvent({
      kind: 'permission',
      level: 'info',
      sessionId: restored.sessionId,
      permissionRequestId: response.requestId,
      promptMessageId: decision.permission.originatingPromptMessageId,
      title: 'Restored permission response accepted',
      text: response.cancelled ? 'cancelled' : response.optionId
    })
    this.deps.publication.emitState()
    return this.deps.publication.getSnapshot()
  }

  private async settlePermissionContinuation(
    sessionId: string,
    durablePermission: RestoredPermissionContinuation,
    outcome: AcpContinuationOutcome
  ): Promise<void> {
    const ownsPermission =
      durablePermission !== undefined && this.continuations?.get(sessionId) === durablePermission
    if (ownsPermission) this.deps.permission.clearRestoredDecision(sessionId, durablePermission)
    if (ownsPermission && durablePermission.cancellationRequested) {
      await this.settleCancelled(sessionId)
    } else if (
      ownsPermission &&
      (outcome.stopReason !== undefined ||
        durablePermission.released ||
        durablePermission.handoffStarted)
    ) {
      this.deps.context.clearContextReset(sessionId)
      try {
        const cleared = await this.deps.wait.clearAfterContinuation(
          durablePermission.projectId,
          sessionId,
          durablePermission.requestId
        )
        if (cleared) {
          this.deps.publication.pushEvent({
            kind: 'permission',
            level: 'info',
            sessionId,
            permissionRequestId: durablePermission.requestId,
            title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
            text: 'completed'
          })
        }
      } catch (error) {
        this.deps.publication.pushEvent({
          kind: 'permission',
          level: 'error',
          sessionId,
          permissionRequestId: durablePermission.requestId,
          title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
          text: errorMessage(error)
        })
      } finally {
        if (this.continuations?.get(sessionId) === durablePermission)
          this.continuations.delete(sessionId)
      }
    } else if (ownsPermission) {
      try {
        // A retry is safe only after durable authority returns from consumed to pending. If this
        // write fails, retain `continuing` as a fail-closed tombstone and do not expose the card.
        await this.deps.wait.rearmContinuation(
          durablePermission.projectId,
          sessionId,
          durablePermission.requestId
        )
        this.deps.publication.pushEvent({
          kind: 'permission',
          level: 'info',
          sessionId,
          permissionRequestId: durablePermission.requestId,
          title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
        })
      } catch (error) {
        this.deps.publication.pushEvent({
          kind: 'permission',
          level: 'error',
          sessionId,
          permissionRequestId: durablePermission.requestId,
          title: ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
          text: errorMessage(error)
        })
      } finally {
        if (this.continuations?.get(sessionId) === durablePermission)
          this.continuations.delete(sessionId)
      }
    }
  }

  async settleCancelled(sessionId: string): Promise<void> {
    const durablePermission = this.continuations?.get(sessionId)
    if (!durablePermission) return
    try {
      await this.deps.wait.cancelContinuation(
        durablePermission.projectId,
        sessionId,
        durablePermission.requestId
      )
    } catch (error) {
      this.deps.publication.pushEvent({
        kind: 'permission',
        level: 'error',
        sessionId,
        permissionRequestId: durablePermission.requestId,
        title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
        text: errorMessage(error)
      })
      return
    }
    if (this.continuations?.get(sessionId) !== durablePermission) return
    this.continuations.delete(sessionId)
    this.deps.context.clearContextReset(sessionId)
    this.deps.permission.clearRestoredDecision(sessionId, durablePermission)
    this.deps.publication.pushEvent({
      kind: 'permission',
      level: 'info',
      sessionId,
      permissionRequestId: durablePermission.requestId,
      title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
      text: 'cancelled'
    })
  }

  admit(
    request: AcpPromptRequest,
    permissionContinuation: RestoredPermissionContinuation
  ): AcpPromptRequest['provenanceContext'] {
    const interaction = this.deps.interactions.current(request.sessionId)
    if (
      !interaction ||
      interaction.kind !== 'prompt' ||
      this.continuations?.get(request.sessionId) !== permissionContinuation
    )
      throw new Error('The restored permission continuation is no longer active.')
    permissionContinuation.interactionSequence = interaction.sequence
    permissionContinuation.agentFrameId = request.provenanceContext?.agentFrameId
    permissionContinuation.messageBranchId = request.provenanceContext?.messageBranchId
    permissionContinuation.isCurrent = () =>
      this.continuations?.get(request.sessionId) === permissionContinuation &&
      this.deps.interactions.current(request.sessionId)?.sequence === interaction.sequence &&
      !this.deps.interactions.isCancellationAccepted(interaction) &&
      !permissionContinuation.cancellationRequested
    return request.provenanceContext
  }

  current(sessionId: string): RestoredPermissionContinuation | undefined {
    return this.continuations.get(sessionId)
  }
  requestCancellation(sessionId: string): RestoredPermissionContinuation | undefined {
    const continuation = this.current(sessionId)
    if (continuation) continuation.cancellationRequested = true
    return continuation
  }
}
export { AcpPermissionContinuationWorkflow, PERMISSION_DENIED_CONTINUATION_TEXT }
export type { PermissionContinuationDependencies }
