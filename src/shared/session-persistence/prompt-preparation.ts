import type { PersistedChatSession, PersistedPromptPreparation } from './session'
import { asNumber, asString, isRecord } from './primitives'
import { resolveMessageBranchPath } from '../conversation-graph'
import { isTurnAnchor } from './turn-anchor'

// A display baseline cannot borrow a turn from another Branch. Old files lack this optional
// evidence and keep the previousState fallback; invalid display data never changes run ownership.
export const resolvePreparationNoticeBaseline = (
  session: PersistedChatSession
): PersistedPromptPreparation['noticeBaseline'] => {
  const preparation = session.promptPreparation
  const baseline = preparation?.noticeBaseline
  const graph = session.conversationGraph
  if (
    !baseline ||
    !graph ||
    preparation?.sessionId !== session.id ||
    preparation.projectId !== session.projectId
  )
    return undefined
  const activeBranchId = graph.frames.find(({ id }) => id === graph.activeFrameId)?.activeBranchId
  const branch = graph.branches.find(({ id }) => id === activeBranchId)
  if (
    branch?.id !== baseline.messageBranchId &&
    !(branch?.parentBranchId === baseline.messageBranchId && branch.supersededMessageId)
  )
    return undefined
  const latest = resolveMessageBranchPath(graph, baseline.messageBranchId).findLast(
    (message) =>
      isTurnAnchor(message) &&
      !(
        preparation.mode === 'new' &&
        message.id === preparation.promptMessageId &&
        message.id !== baseline.promptMessageId
      )
  )
  return latest?.id === baseline.promptMessageId ? baseline : undefined
}

export const isPreparedSessionRun = (session: PersistedChatSession): boolean => {
  const preparation = session.promptPreparation
  return (
    preparation !== undefined &&
    preparation.projectId === session.projectId &&
    preparation.sessionId === session.id &&
    preparation.runStartedAt !== undefined &&
    session.activeRun?.promptMessageId === preparation.promptMessageId &&
    session.activeRun.startedAt === preparation.runStartedAt
  )
}

type PreparationState = PersistedPromptPreparation['previousState']
type PreparationResumeRecovery = NonNullable<PreparationState['resumeRecovery']>

const PREPARATION_STATUSES: readonly string[] = [
  'idle',
  'running',
  'error',
  'waiting-permission',
  'waiting-for-user',
  'waiting-plan-approval'
]

// Rebuilds the state from known fields, so unknown fields from a newer writer are stripped. An
// unknown kind/cause is not an invalid marker: it normalizes to "no recovery", exactly like the
// Session-level resumeRecovery decoder, so expectedState keeps comparing equal to the decoded
// Session. An unknown status stays invalid because rolling back to a guessed status could erase
// a state this version cannot represent.
const readResumeRecovery = (
  recovery: unknown
): { valid: boolean; value?: PreparationResumeRecovery } => {
  if (recovery === undefined) return { valid: true }
  if (!isRecord(recovery)) return { valid: false }
  if (
    recovery.kind !== 'resume-required' ||
    (recovery.cause !== 'cancelled' &&
      recovery.cause !== 'app-restart' &&
      recovery.cause !== 'connection-lost')
  )
    return { valid: true }
  if (
    recovery.promptMessageId !== undefined &&
    !(
      Boolean(asString(recovery.promptMessageId)) &&
      (recovery.promptMessageId as string).length <= 256
    )
  )
    return { valid: false }
  return {
    valid: true,
    value: {
      kind: 'resume-required',
      cause: recovery.cause,
      ...(recovery.promptMessageId === undefined
        ? {}
        : { promptMessageId: recovery.promptMessageId as string })
    }
  }
}

const readPreparationState = (value: unknown): PreparationState | undefined => {
  if (
    !isRecord(value) ||
    !PREPARATION_STATUSES.includes(value.status as string) ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.errorReportable !== undefined && typeof value.errorReportable !== 'boolean')
  )
    return undefined
  const recovery = readResumeRecovery(value.resumeRecovery)
  if (!recovery.valid) return undefined
  return {
    status: value.status as PreparationState['status'],
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.errorReportable === undefined
      ? {}
      : { errorReportable: value.errorReportable as boolean }),
    ...(recovery.value === undefined ? {} : { resumeRecovery: recovery.value })
  }
}

// Builds a fresh object from known fields only: unknown fields from a newer writer are stripped
// rather than discarding the marker, while ownership and activeRun cross-checks stay strict.
export const sanitizePromptPreparation = (
  value: unknown,
  session: PersistedChatSession
): PersistedPromptPreparation | undefined => {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const promptMessageId = asString(value.promptMessageId)
  const preparedAt = asNumber(value.preparedAt)
  const runStartedAt = value.runStartedAt === undefined ? undefined : asNumber(value.runStartedAt)
  const previousState = readPreparationState(value.previousState)
  const expectedState = readPreparationState(value.expectedState)
  if (
    !id ||
    id.length > 256 ||
    !promptMessageId ||
    promptMessageId.length > 256 ||
    value.projectId !== session.projectId ||
    value.sessionId !== session.id ||
    !['new', 'resume', 'rearm'].includes(value.mode as string) ||
    preparedAt === undefined ||
    preparedAt < 0 ||
    (value.runStartedAt !== undefined && (runStartedAt === undefined || runStartedAt < 0)) ||
    !previousState ||
    !expectedState
  )
    return undefined
  const preparation: PersistedPromptPreparation = {
    id,
    projectId: session.projectId,
    sessionId: session.id,
    promptMessageId,
    mode: value.mode as PersistedPromptPreparation['mode'],
    preparedAt,
    ...(runStartedAt === undefined ? {} : { runStartedAt }),
    expectedState,
    previousState
  }
  // Display-only evidence: an invalid baseline is omitted without invalidating the marker.
  const baseline = value.noticeBaseline
  const baselineState = isRecord(baseline) ? readPreparationState(baseline.state) : undefined
  if (
    isRecord(baseline) &&
    baselineState &&
    asString(baseline.messageBranchId) &&
    (baseline.messageBranchId as string).length <= 256 &&
    (baseline.promptMessageId === undefined ||
      (asString(baseline.promptMessageId) && (baseline.promptMessageId as string).length <= 256))
  ) {
    preparation.noticeBaseline = {
      messageBranchId: baseline.messageBranchId as string,
      ...(baseline.promptMessageId === undefined
        ? {}
        : { promptMessageId: baseline.promptMessageId as string }),
      state: baselineState
    }
  }
  // A stale preparation cannot mask a different admitted run, even one reusing the same prompt.
  if (session.activeRun && !isPreparedSessionRun({ ...session, promptPreparation: preparation }))
    return undefined
  return preparation
}
