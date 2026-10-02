import { isDeepStrictEqual } from 'node:util'
import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  type PersistedMessageBranch
} from '../../shared/conversation-graph'
import {
  applySessionConversationCommands,
  type SessionConversationCommand
} from '../../shared/session-conversation-command'
import {
  materializeSessionConversationGraph,
  isPreparedSessionRun,
  sanitizeSession,
  latestOutcomePrompt,
  type PersistedChatSession
} from '../../shared/session-persistence'

type Preparation = {
  sessionId: string
  projectId: string
  promptMessageId: string
  mode: 'new' | 'resume' | 'rearm'
  admissionIds: Set<string>
  ownedState: Map<(typeof stateFields)[number], unknown>
  expected?: PersistedChatSession
  originalBranch?: PersistedMessageBranch
  returnBranchId?: string
  createdPrompt: boolean
  branchIds: Set<string>
  closed: boolean
  rollbackCommandId?: string
  // Aborts when the renderer that issued prepare-prompt navigates, crashes or closes.
  caller?: AbortSignal
}

// A receipt whose caller is gone can never receive its rollback-prompt or reach admission.
const isLive = (receipt: Preparation): boolean => !receipt.closed && !receipt.caller?.aborted

const changedBranch = (): Error =>
  new Error('Conversation Branch changed before the user Message was admitted.')
const stateFields = [
  'status',
  'error',
  'errorReportable',
  'resumeRecovery',
  'activeRun',
  'pendingHistoryReplay',
  'branchContextResetRequired'
] as const

const sameValue = (left: unknown, right: unknown): boolean => {
  // Optional undefined properties disappear in the JSON codec; they are not a changed identity.
  const normalize = (value: unknown): unknown =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  return isDeepStrictEqual(normalize(left), normalize(right))
}

const sameBranch = (
  left: PersistedMessageBranch,
  right: PersistedMessageBranch | undefined
): boolean => {
  if (!right) return false
  // Graph materialization advances the active Branch timestamp on ordinary projection saves.
  // Compare its identity and edges; that incidental timestamp is not concurrent history.
  const { updatedAt: _leftTime, ...leftIdentity } = left
  const { updatedAt: _rightTime, ...rightIdentity } = right
  void _leftTime
  void _rightTime
  return sameValue(leftIdentity, rightIdentity)
}

const hasNewAdmission = (receipt: Preparation, session: PersistedChatSession): boolean => {
  return (
    session.runtimeSessionAdmissions?.some(
      ({ promptMessageId, executionId }) =>
        promptMessageId === receipt.promptMessageId && !receipt.admissionIds.has(executionId)
    ) === true
  )
}

const acknowledge = (
  session: PersistedChatSession,
  command: SessionConversationCommand
): PersistedChatSession => ({
  ...session,
  runtimeConversationCommandIds: [
    ...new Set([...(session.runtimeConversationCommandIds ?? []), command.id])
  ].slice(-256),
  updatedAt: Math.max(session.updatedAt, command.timestamp)
})

// Main retains the baseline before a named preparation, never a renderer-supplied rollback image.
// Receipts are process-local authority for undoing only unadmitted optimistic graph commands.
export class SessionPromptPreparationOwner {
  private readonly preparations = new Map<string, Preparation>()
  private readonly watchedCallers = new WeakSet<AbortSignal>()

  ownsPreparation(session: PersistedChatSession): boolean {
    const marker = session.promptPreparation
    const receipt = marker && this.preparations.get(marker.id)
    return Boolean(
      receipt &&
      isLive(receipt) &&
      receipt.projectId === session.projectId &&
      receipt.sessionId === session.id
    )
  }

  hasUnadmittedRun(session: PersistedChatSession): boolean {
    return (
      isPreparedSessionRun(session) ||
      [...this.preparations.values()].some(
        (receipt) =>
          isLive(receipt) &&
          receipt.sessionId === session.id &&
          receipt.projectId === session.projectId &&
          session.activeRun?.promptMessageId === receipt.promptMessageId &&
          !hasNewAdmission(receipt, session)
      )
    )
  }

  observe(session: PersistedChatSession): void {
    for (const [id, receipt] of this.preparations) {
      if (
        receipt.projectId === session.projectId &&
        receipt.sessionId === session.id &&
        (hasNewAdmission(receipt, session) ||
          (receipt.caller?.aborted && session.promptPreparation?.id !== id) ||
          (receipt.rollbackCommandId &&
            session.runtimeConversationCommandIds?.includes(receipt.rollbackCommandId)))
      )
        this.close(receipt)
    }
  }

  private close(receipt: Preparation): void {
    receipt.closed = true
    receipt.expected = undefined
    receipt.ownedState.clear()
    receipt.originalBranch = undefined
    receipt.caller = undefined
  }

  // Reports each Session still holding an open receipt of `caller` once that caller goes away.
  watchCaller(
    caller: AbortSignal,
    release: (scope: { projectId: string; sessionId: string }) => void
  ): void {
    if (this.watchedCallers.has(caller)) return
    this.watchedCallers.add(caller)
    const report = (): void => {
      for (const scope of this.scopesOwnedBy(caller)) release(scope)
    }
    if (caller.aborted) report()
    else caller.addEventListener('abort', report, { once: true })
  }

  private scopesOwnedBy(caller: AbortSignal): { projectId: string; sessionId: string }[] {
    const scopes = new Map<string, { projectId: string; sessionId: string }>()
    for (const { closed, caller: owner, projectId, sessionId } of this.preparations.values()) {
      if (!closed && owner === caller)
        scopes.set(`${projectId}\u0000${sessionId}`, { projectId, sessionId })
    }
    return [...scopes.values()]
  }

  // The marker belongs to an unadmitted receipt whose issuing renderer is gone.
  isAbandoned(session: PersistedChatSession): boolean {
    const marker = session.promptPreparation
    const receipt = marker && this.preparations.get(marker.id)
    return Boolean(
      receipt &&
      !receipt.closed &&
      receipt.caller?.aborted &&
      receipt.projectId === session.projectId &&
      receipt.sessionId === session.id &&
      !hasNewAdmission(receipt, session)
    )
  }

  forget(projectId: string, sessionId?: string): void {
    for (const [id, receipt] of this.preparations) {
      if (
        receipt.projectId === projectId &&
        (sessionId === undefined || receipt.sessionId === sessionId)
      )
        this.preparations.delete(id)
    }
  }

  apply(
    authority: PersistedChatSession,
    commands: readonly SessionConversationCommand[],
    caller?: AbortSignal
  ): PersistedChatSession {
    let result = materializeSessionConversationGraph(authority) as PersistedChatSession
    for (const command of commands) {
      if (result.runtimeConversationCommandIds?.includes(command.id)) continue
      if (command.kind === 'prepare-prompt') {
        // One durable witness must own the whole preparation until admission or rollback.
        // Another window must not replace it before the first window appends its prompt.
        if (result.promptPreparation && result.promptPreparation.id !== command.id)
          throw changedBranch()
        const previous = this.preparations.get(command.id)
        if (previous) {
          if (
            previous.sessionId !== result.id ||
            previous.projectId !== result.projectId ||
            previous.promptMessageId !== command.promptMessageId ||
            previous.mode !== command.mode ||
            previous.closed
          )
            throw changedBranch()
        } else {
          const prompt = result.conversationGraph!.messages.find(
            ({ id }) => id === command.promptMessageId
          )
          if (
            result.activeRun ||
            (command.mode === 'new' ? prompt !== undefined : prompt?.role !== 'user')
          )
            throw changedBranch()
          if (
            command.mode === 'resume' &&
            result.resumeRecovery?.promptMessageId !== command.promptMessageId
          )
            throw new Error('Resume no longer matches the interrupted turn.')
          for (const [id, receipt] of this.preparations) {
            if (
              receipt.sessionId === result.id &&
              receipt.projectId === result.projectId &&
              (!isLive(receipt) || hasNewAdmission(receipt, result))
            )
              this.preparations.delete(id)
          }
          if (caller?.aborted) throw new Error('Caller lease is no longer current.')
          this.preparations.set(command.id, {
            sessionId: result.id,
            projectId: result.projectId,
            promptMessageId: command.promptMessageId,
            mode: command.mode,
            admissionIds: new Set(
              result.runtimeSessionAdmissions?.map(({ executionId }) => executionId)
            ),
            ownedState: new Map(),
            createdPrompt: false,
            expected: structuredClone(result),
            branchIds: new Set(),
            closed: false,
            caller
          })
        }
        const previousState = {
          status: result.status,
          error: result.error,
          errorReportable: result.errorReportable,
          resumeRecovery: result.resumeRecovery
        }
        const noticePrompt = latestOutcomePrompt(result)
        result = acknowledge(
          {
            ...result,
            promptPreparation: {
              id: command.id,
              projectId: result.projectId,
              sessionId: result.id,
              promptMessageId: command.promptMessageId,
              mode: command.mode,
              preparedAt: command.timestamp,
              previousState: structuredClone(previousState),
              expectedState: structuredClone(previousState),
              noticeBaseline: {
                messageBranchId: result.conversationGraph!.frames.find(
                  ({ id }) => id === result.conversationGraph!.activeFrameId
                )!.activeBranchId,
                ...(noticePrompt ? { promptMessageId: noticePrompt.id } : {}),
                state: structuredClone(previousState)
              }
            }
          },
          command
        )
        continue
      }
      const receipt = command.preparationId
        ? this.preparations.get(command.preparationId)
        : undefined
      if (
        command.preparationId &&
        (!receipt || receipt.sessionId !== result.id || receipt.projectId !== result.projectId)
      )
        throw changedBranch()
      if (command.kind === 'rollback-prompt') {
        receipt!.rollbackCommandId = command.id
        result = acknowledge(this.rollback(result, receipt!), command)
        if (result.promptPreparation?.id === command.preparationId) delete result.promptPreparation
        continue
      }
      if (receipt) {
        if (
          result.promptPreparation?.id !== command.preparationId ||
          !isLive(receipt) ||
          receipt.rollbackCommandId ||
          hasNewAdmission(receipt, result)
        )
          throw changedBranch()
        if (
          command.kind === 'append-user' &&
          (receipt.mode !== 'new' || command.message.id !== receipt.promptMessageId)
        )
          throw changedBranch()
        if (
          (command.kind === 'start-run' || command.kind === 'resume-run') &&
          command.run.promptMessageId !== receipt.promptMessageId
        )
          throw changedBranch()
        if (
          !['append-user', 'fork-message', 'start-run', 'resume-run'].includes(command.kind) ||
          (command.kind === 'fork-message' &&
            (receipt.mode !== 'new' ||
              (receipt.branchIds.size > 0 && !receipt.branchIds.has(command.branchId))))
        )
          throw changedBranch()
      }
      if (
        receipt &&
        command.kind === 'append-user' &&
        result.conversationGraph!.messages.some(({ id }) => id === receipt.promptMessageId)
      )
        throw changedBranch()
      const next = applySessionConversationCommands(result, [command])
      if (receipt) {
        // Persistence drops recovery pointers outside the selected Branch. Own that change too,
        // using the authority immediately before this command rather than the prepare snapshot.
        const normalized = sanitizeSession(next, {
          preserveRuntimeState: true,
          preserveLegacyUploadPaths: true
        })
        if (!normalized) throw changedBranch()
        for (const key of stateFields) Object.assign(next, { [key]: normalized[key] })
        if (
          command.kind === 'fork-message' &&
          !result.conversationGraph!.branches.some(({ id }) => id === command.branchId)
        ) {
          receipt.branchIds.add(command.branchId)
          receipt.returnBranchId = result.conversationGraph!.frames.find(
            ({ id }) => id === result.conversationGraph!.rootFrameId
          )!.activeBranchId
        }
        if (command.kind === 'append-user') {
          receipt.createdPrompt = true
          receipt.originalBranch = structuredClone(
            result.conversationGraph!.branches.find(({ id }) => id === command.branchId)!
          )
        }
        for (const key of stateFields) {
          if (receipt.ownedState.has(key) && !sameValue(result[key], receipt.expected?.[key]))
            receipt.ownedState.delete(key)
          if (!sameValue(result[key], next[key]) && !receipt.ownedState.has(key))
            receipt.ownedState.set(key, structuredClone(result[key]))
        }
        const marker = next.promptPreparation
        if (marker && marker.id === command.preparationId) {
          const previousState =
            command.kind === 'start-run' || command.kind === 'resume-run'
              ? {
                  status: result.status,
                  error: result.error,
                  errorReportable: result.errorReportable,
                  resumeRecovery: result.resumeRecovery
                }
              : marker.previousState
          next.promptPreparation = {
            ...marker,
            previousState: structuredClone(previousState),
            ...(command.kind === 'start-run' || command.kind === 'resume-run'
              ? { runStartedAt: command.run.startedAt }
              : {}),
            expectedState: {
              status: next.status,
              error: next.error,
              errorReportable: next.errorReportable,
              resumeRecovery: structuredClone(next.resumeRecovery)
            }
          }
        }
        receipt.expected = structuredClone(next)
      }
      result = next
    }
    return result
  }

  private rollback(session: PersistedChatSession, receipt: Preparation): PersistedChatSession {
    if (receipt.closed) return session
    if (hasNewAdmission(receipt, session)) {
      this.close(receipt)
      return session
    }
    const graph = session.conversationGraph!
    const expected = receipt.expected!.conversationGraph!
    const newPrompt =
      receipt.createdPrompt && receipt.mode === 'new' ? receipt.promptMessageId : undefined
    const node = graph.messages.find(({ id }) => id === newPrompt)
    if (
      node &&
      !sameValue(
        node,
        expected.messages.find(({ id }) => id === newPrompt)
      )
    )
      throw changedBranch()
    if (
      newPrompt &&
      (graph.messages.some(
        (message) =>
          message.parentMessageId === newPrompt ||
          message.supersedesMessageId === newPrompt ||
          message.responseToMessageId === newPrompt
      ) ||
        graph.frames.some(({ originMessageId }) => originMessageId === newPrompt) ||
        graph.branches.some(
          ({ id, forkMessageId, supersededMessageId }) =>
            !receipt.branchIds.has(id) &&
            (forkMessageId === newPrompt || supersededMessageId === newPrompt)
        ) ||
        graph.activities.some(({ promptMessageId }) => promptMessageId === newPrompt) ||
        graph.activityGroups.some(({ promptMessageId }) => promptMessageId === newPrompt))
    )
      throw changedBranch()
    for (const branchId of receipt.branchIds) {
      const branch = graph.branches.find(({ id }) => id === branchId)
      if (
        branch &&
        (!sameBranch(
          branch,
          expected.branches.find(({ id }) => id === branchId)
        ) ||
          graph.branches.some(({ parentBranchId }) => parentBranchId === branchId) ||
          graph.messages.some(
            (message) => message.introducedOnBranchId === branchId && message.id !== newPrompt
          ) ||
          graph.activities.some(({ messageBranchId }) => messageBranchId === branchId) ||
          graph.activityGroups.some(({ messageBranchId }) => messageBranchId === branchId))
      )
        throw changedBranch()
    }
    if (session.activeRun && !sameValue(session.activeRun, receipt.expected!.activeRun))
      throw changedBranch()
    const nextGraph = {
      ...graph,
      messages: graph.messages.filter(({ id }) => id !== newPrompt),
      branches: graph.branches
        .filter(({ id }) => !receipt.branchIds.has(id))
        .map((branch) => {
          if (!newPrompt || branch.headMessageId !== newPrompt) return branch
          const old = receipt.originalBranch?.id === branch.id ? receipt.originalBranch : undefined
          if (
            !old ||
            !sameBranch(
              branch,
              expected.branches.find(({ id }) => id === branch.id)
            )
          )
            throw changedBranch()
          return { ...branch, headMessageId: old.headMessageId, updatedAt: old.updatedAt }
        }),
      frames: graph.frames.map((frame) => {
        if (!receipt.branchIds.has(frame.activeBranchId)) return frame
        if (frame.id !== graph.rootFrameId || !receipt.returnBranchId) throw changedBranch()
        return { ...frame, activeBranchId: receipt.returnBranchId }
      })
    }
    const result: PersistedChatSession = {
      ...session,
      conversationGraph: nextGraph,
      messages: resolveActiveConversationMessages(nextGraph).map(projectConversationMessage),
      ...resolveActiveConversationActivities(nextGraph)
    }
    for (const [key, previous] of receipt.ownedState) {
      if (sameValue(session[key], receipt.expected![key]))
        Object.assign(result, { [key]: previous })
    }
    return result
  }
}
