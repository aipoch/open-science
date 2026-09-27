import type {
  DelegatedWorkAttemptStatus,
  DelegatedWorkCancellationReason,
  DelegatedWorkResolvedAgent,
  ResolvedSubagentModelSnapshot,
  DelegatedWorkRecord,
  DelegatedWorkAttemptRecord
} from '../session-runtime-context'
import {
  isRecord,
  hasOnlyFields,
  asString,
  asNumber,
  AGENT_FRAMEWORK_IDS,
  asStringArray
} from './primitives'
import type { ResolvedReasoningEffort } from '../reasoning-effort'
import type { AgentFrameworkId } from '../settings'

const DELEGATED_WORK_ATTEMPT_STATUSES = new Set<DelegatedWorkAttemptStatus>([
  'running',
  'completed',
  'cancelled',
  'error'
])

const DELEGATED_WORK_CANCELLATION_REASONS = new Set<DelegatedWorkCancellationReason>([
  'main_agent_stop',
  'session_stop',
  'runtime_interrupted'
])

const sanitizeDelegatedWorkResolvedAgent = (
  value: unknown
): DelegatedWorkResolvedAgent | undefined => {
  if (!isRecord(value)) return undefined
  if (value.kind === 'main' && hasOnlyFields(value, ['kind'])) return { kind: 'main' }
  if (value.kind !== 'specialist') return undefined
  if (!hasOnlyFields(value, ['kind', 'profileId', 'revision', 'displayName'])) return undefined
  const profileId = asString(value.profileId)
  const revision = asNumber(value.revision)
  const displayName = asString(value.displayName)
  if (
    !profileId ||
    revision === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !displayName
  ) {
    return undefined
  }
  return { kind: 'specialist', profileId, revision, displayName }
}

const SUBAGENT_MODEL_ROUTES = new Set<ResolvedSubagentModelSnapshot['modelRoute']>([
  'claude-anthropic',
  'opencode-anthropic',
  'opencode-openai',
  'codebuddy-openai',
  'codex-responses',
  'codex-responses-compatibility',
  'codex-bridge'
])

const SUBAGENT_REASONING_EFFORTS = new Set<ResolvedReasoningEffort>([
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

const sanitizeResolvedSubagentModelSnapshot = (
  value: unknown
): ResolvedSubagentModelSnapshot | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'frameworkId',
      'providerId',
      'backendId',
      'modelRoute',
      'model',
      'reasoningEffort'
    ])
  )
    return undefined
  const frameworkId = asString(value.frameworkId) as AgentFrameworkId | undefined
  const providerId = asString(value.providerId)
  const backendId = asString(value.backendId)
  const modelRoute = asString(value.modelRoute) as
    ResolvedSubagentModelSnapshot['modelRoute'] | undefined
  const model = asString(value.model)
  const reasoningEffort = asString(value.reasoningEffort) as ResolvedReasoningEffort | undefined
  if (
    !frameworkId ||
    !AGENT_FRAMEWORK_IDS.has(frameworkId) ||
    !providerId ||
    !backendId ||
    !modelRoute ||
    !SUBAGENT_MODEL_ROUTES.has(modelRoute) ||
    !model ||
    !reasoningEffort ||
    !SUBAGENT_REASONING_EFFORTS.has(reasoningEffort)
  )
    return undefined
  return { frameworkId, providerId, backendId, modelRoute, model, reasoningEffort }
}

export const sanitizeDelegatedWorkRecords = (value: unknown): DelegatedWorkRecord[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const frameIds = new Set<string>()
  const attemptIds = new Set<string>()
  const records: DelegatedWorkRecord[] = []
  for (const rawRecord of value) {
    if (
      !isRecord(rawRecord) ||
      !hasOnlyFields(rawRecord, ['agentFrameId', 'attempts']) ||
      !Array.isArray(rawRecord.attempts) ||
      rawRecord.attempts.length === 0
    ) {
      return undefined
    }
    const agentFrameId = asString(rawRecord.agentFrameId)
    if (!agentFrameId || frameIds.has(agentFrameId)) return undefined
    frameIds.add(agentFrameId)
    const attempts: DelegatedWorkAttemptRecord[] = []
    let runningCount = 0
    for (const rawAttempt of rawRecord.attempts) {
      if (
        !isRecord(rawAttempt) ||
        !hasOnlyFields(rawAttempt, [
          'id',
          'initiatingTurnMessageId',
          'status',
          'resolvedAgent',
          'executionModel',
          'runtimeSegmentIds',
          'startedAt',
          'endedAt',
          'terminalMessageId',
          'cancellationReason',
          'error'
        ])
      ) {
        return undefined
      }
      const id = asString(rawAttempt.id)
      const initiatingTurnMessageId =
        rawAttempt.initiatingTurnMessageId === undefined
          ? undefined
          : asString(rawAttempt.initiatingTurnMessageId)
      const status = asString(rawAttempt.status) as DelegatedWorkAttemptStatus | undefined
      const resolvedAgent = sanitizeDelegatedWorkResolvedAgent(rawAttempt.resolvedAgent)
      const executionModel =
        rawAttempt.executionModel === undefined
          ? undefined
          : sanitizeResolvedSubagentModelSnapshot(rawAttempt.executionModel)
      const startedAt = asNumber(rawAttempt.startedAt)
      const runtimeSegmentIds = asStringArray(rawAttempt.runtimeSegmentIds)
      if (
        !id ||
        (rawAttempt.initiatingTurnMessageId !== undefined && !initiatingTurnMessageId) ||
        attemptIds.has(id) ||
        !status ||
        !DELEGATED_WORK_ATTEMPT_STATUSES.has(status) ||
        !resolvedAgent ||
        (rawAttempt.executionModel !== undefined && !executionModel) ||
        startedAt === undefined ||
        startedAt < 0 ||
        !Array.isArray(rawAttempt.runtimeSegmentIds) ||
        runtimeSegmentIds.length !== rawAttempt.runtimeSegmentIds.length ||
        new Set(runtimeSegmentIds).size !== runtimeSegmentIds.length
      ) {
        return undefined
      }
      attemptIds.add(id)
      const endedAt = rawAttempt.endedAt === undefined ? undefined : asNumber(rawAttempt.endedAt)
      const terminalMessageId =
        rawAttempt.terminalMessageId === undefined
          ? undefined
          : asString(rawAttempt.terminalMessageId)
      const cancellationReason =
        rawAttempt.cancellationReason === undefined
          ? undefined
          : (asString(rawAttempt.cancellationReason) as DelegatedWorkCancellationReason | undefined)
      let error: { code: string; message: string } | undefined
      if (rawAttempt.error !== undefined) {
        if (!isRecord(rawAttempt.error) || !hasOnlyFields(rawAttempt.error, ['code', 'message'])) {
          return undefined
        }
        const code = asString(rawAttempt.error.code)
        const message = asString(rawAttempt.error.message)
        if (!code || !message) return undefined
        error = { code, message }
      }
      if (status === 'running') {
        runningCount += 1
        if (
          endedAt !== undefined ||
          terminalMessageId !== undefined ||
          cancellationReason !== undefined ||
          error !== undefined
        ) {
          return undefined
        }
      } else if (endedAt === undefined || endedAt < startedAt) {
        return undefined
      }
      if (status === 'completed' && terminalMessageId === undefined) return undefined
      if (
        (status === 'cancelled') !== (cancellationReason !== undefined) ||
        (cancellationReason && !DELEGATED_WORK_CANCELLATION_REASONS.has(cancellationReason)) ||
        (status === 'error') !== (error !== undefined)
      ) {
        return undefined
      }
      attempts.push({
        id,
        ...(initiatingTurnMessageId ? { initiatingTurnMessageId } : {}),
        status,
        resolvedAgent,
        ...(executionModel ? { executionModel } : {}),
        runtimeSegmentIds,
        startedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(terminalMessageId ? { terminalMessageId } : {}),
        ...(cancellationReason ? { cancellationReason } : {}),
        ...(error ? { error } : {})
      })
    }
    if (runningCount > 1 || (runningCount === 1 && attempts.at(-1)?.status !== 'running')) {
      return undefined
    }
    records.push({ agentFrameId, attempts })
  }
  return records
}
