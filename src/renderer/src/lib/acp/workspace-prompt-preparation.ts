import { i18next } from '../../i18n'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { discardPreparedSessionConversationIntents } from '../../stores/session-conversation-intents'
import { toPersistedSession, useSessionStore } from '../../stores/session-store'
import { saveSessionInOrder } from '../session-persistence/session-persistence'

export type WorkspacePromptPreparation = {
  id: string
  sessionId: string
  promptMessageId: string
  authority: PersistedChatSession
  previousAdmissionIds: ReadonlySet<string>
}

export const ownsWorkspacePromptPreparation = (
  preparation: WorkspacePromptPreparation
): boolean => {
  const session = useSessionStore.getState().sessions.find(({ id }) => id === preparation.sessionId)
  const marker = session?.promptPreparation
  // Main consumes this durable witness at admission. Later run failures belong to Main's
  // outcome, not to preparation compensation; a same-millisecond rearm gets a different ID.
  return (
    marker?.id === preparation.id &&
    marker.sessionId === preparation.sessionId &&
    marker.projectId === session?.projectId &&
    marker.projectId === preparation.authority.projectId &&
    marker.promptMessageId === preparation.promptMessageId &&
    session?.activeRun?.promptMessageId === preparation.promptMessageId
  )
}

export const prepareWorkspacePrompt = async (
  session: PersistedChatSession,
  promptMessageId: string,
  mode: 'new' | 'resume' | 'rearm'
): Promise<WorkspacePromptPreparation> => {
  // Main holds one witness per Session. A new preparation built over a retained one could never
  // release it, so its exact rollback is replayed first and the fresh live snapshot is used.
  const retained = await retryPendingWorkspacePromptRollback(session.id)
  if (retained.failure !== undefined) throw new Error(retained.failure)
  const liveSource = retained.rolledBack
    ? useSessionStore.getState().sessions.find(({ id }) => id === session.id)
    : undefined
  if (liveSource) session = toPersistedSession(liveSource)
  const id = `prompt-preparation-${crypto.randomUUID()}`
  const authority = await saveSessionInOrder(session, undefined, undefined, {
    conversationCommands: [
      { kind: 'prepare-prompt', id, timestamp: Date.now(), promptMessageId, mode }
    ]
  })
  const source = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === session.id)
  if (source)
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: authority,
      mode: 'runtime-transcript-authority'
    })
  return {
    id,
    sessionId: session.id,
    promptMessageId,
    authority,
    previousAdmissionIds: new Set(
      authority.runtimeSessionAdmissions?.map(({ executionId }) => executionId)
    )
  }
}

export const rollbackWorkspacePrompt = async (
  preparation: WorkspacePromptPreparation
): Promise<boolean> => {
  discardPreparedSessionConversationIntents(preparation.sessionId, preparation.id)
  const source = useSessionStore.getState().sessions.find(({ id }) => id === preparation.sessionId)
  const authority = await saveSessionInOrder(
    source ? toPersistedSession(source) : preparation.authority,
    undefined,
    undefined,
    {
      conversationCommands: [
        {
          kind: 'rollback-prompt',
          id: `prompt-rollback-${crypto.randomUUID()}`,
          timestamp: Date.now(),
          preparationId: preparation.id
        }
      ]
    }
  )
  const admitted =
    authority.runtimeSessionAdmissions?.some(
      ({ promptMessageId, executionId }) =>
        promptMessageId === preparation.promptMessageId &&
        !preparation.previousAdmissionIds.has(executionId)
    ) === true
  if (source)
    useSessionStore.getState().applyDurableSessionProjection({
      source,
      session: authority,
      mode: 'prompt-rollback-authority'
    })
  return !admitted
}

// A rollback whose write failed leaves Main's preparation marker and the renderer's optimistic
// prompt in place. Retaining that exact preparation lets the next user action replay only its
// conditional rollback; nothing outside the preparation is ever touched. Main allows one marker
// per Session, so one record per Session is sufficient.
const failedPromptRollbacks = new Map<
  string,
  { preparation: WorkspacePromptPreparation; failure: string }
>()

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const resetWorkspacePromptRollbacksForTests = (): void => failedPromptRollbacks.clear()

export const hasPendingWorkspacePromptRollback = (sessionId: string): boolean =>
  failedPromptRollbacks.has(sessionId)

export const describeWorkspacePromptRollbackFailure = (
  original: string | undefined,
  rollbackFailure: string
): string => {
  const rollback = i18next.t(
    'The unsent message could not be rolled back ({{failure}}). Send again or stop the run to retry.',
    { failure: rollbackFailure }
  )
  return original ? `${original}\n\n${rollback}` : rollback
}

// Rolls back one preparation. A failed write is retained for retry and returned instead of thrown,
// so the caller's original failure can still be reported alongside it.
export const attemptWorkspacePromptRollback = async (
  preparation: WorkspacePromptPreparation
): Promise<{ rolledBack: boolean; failure?: string }> => {
  try {
    const rolledBack = await rollbackWorkspacePrompt(preparation)
    if (failedPromptRollbacks.get(preparation.sessionId)?.preparation.id === preparation.id) {
      failedPromptRollbacks.delete(preparation.sessionId)
    }
    return { rolledBack }
  } catch (error) {
    const failure = errorText(error)
    const retained = failedPromptRollbacks.get(preparation.sessionId)
    if (!retained || retained.preparation.id === preparation.id) {
      failedPromptRollbacks.set(preparation.sessionId, { preparation, failure })
    }
    return { rolledBack: false, failure }
  }
}

// Replays a retained rollback before any new preparation. `rolledBack` is true only when a retained
// preparation was actually undone; `failure` is a user-visible message when the Session still
// cannot be released. A Session that no longer exists drops its stale record.
export const retryPendingWorkspacePromptRollback = async (
  sessionId: string
): Promise<{ rolledBack: boolean; failure?: string }> => {
  const preparation = failedPromptRollbacks.get(sessionId)?.preparation
  if (!preparation) return { rolledBack: false }
  if (!useSessionStore.getState().sessions.some(({ id }) => id === sessionId)) {
    failedPromptRollbacks.delete(sessionId)
    return { rolledBack: false }
  }
  const result = await attemptWorkspacePromptRollback(preparation)
  return result.failure === undefined
    ? { rolledBack: result.rolledBack }
    : {
        rolledBack: false,
        failure: describeWorkspacePromptRollbackFailure(undefined, result.failure)
      }
}
