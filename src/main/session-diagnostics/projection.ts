import { diagnosticText, projectDiagnosticError, type DiagnosticTextOptions } from './detail'

/** Diagnostic projections keep only known evidence fields and bounded redacted error text. */
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)
const numbers =
  'endedAt askedAt acceptedAt uncertainAt dispatchStartedAt sequence laneSequence queuedAt callIndex version schemaVersion number revision createdAt updatedAt completedAt failedAt startedAt archivedAt sortIndex index inputTokens cacheTokens cachedReadTokens cachedWriteTokens outputTokens turnCount contextUsedTokens contextWindowSize terminalExitCode computeConcurrencyLimit round maxRounds respondedAt'.split(
    ' '
  )
const identities =
  'initiatingTurnMessageId terminalMessageId profileId targetFrameId targetAttemptId rootPromptMessageId rootOriginMessageId callerRootMessageId rootBranchId replyToMessageId retryOfMessageId dispatchEpoch executionId promptRuntimeSegmentId sourceMessageId requestId callId backendId agentBackendId providerId providerSessionId id projectId agentFrameId parentFrameId originMessageId activeBranchId linkedReviewId parentBranchId forkMessageId forkActivityId supersededMessageId headMessageId introducedOnBranchId parentMessageId revisionRootMessageId supersedesMessageId runtimeSegmentId activityGroupId promptMessageId executionInvocationId messageBranchId streamId responseToMessageId sourceInvocationId rootFrameId activeFrameId taskRunCommitId causeReviewId deliveryKey sessionId messageId toolInvocationId rootMessageId originSessionId originFrameId sourceFrameId sourceAttemptId sourceRuntimeSegmentId sourceMessageBranchId continuationAttemptId specialistId'.split(
    ' '
  )
const states: Record<string, readonly string[]> = {
  status: [
    'waiting-for-user',
    'waiting-permission',
    'waiting-plan-approval',
    'complete',
    'streaming',
    'idle',
    'running',
    'completed',
    'cancelled',
    'error',
    'pending',
    'in_progress',
    'failed',
    'interrupted',
    'waiting',
    'stopped',
    'queued',
    'succeeded',
    'disabled',
    'superseded',
    'accepted',
    'uncertain',
    'confirmed'
  ],
  role: ['user', 'agent', 'assistant', 'system', 'tool'],
  kind: [
    'main',
    'specialist',
    'info',
    'question',
    'tool',
    'root',
    'reviewer',
    'delegate',
    'compatibility',
    'resume-required',
    'all',
    'before-message',
    'application',
    'side-chat',
    'compute-job-completion',
    'agent-user-choice'
  ],
  cause: ['app-restart', 'cancelled', 'connection-lost'],
  originBindingState: ['root', 'validated', 'legacy-unavailable'],
  toolDisposition: ['declined', 'permission-closed'],
  agentFrameworkId: ['claude-code', 'opencode', 'codex', 'codebuddy'],
  frameworkId: ['claude-code', 'opencode', 'codex', 'codebuddy'],
  reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  runtimeTranscriptOwner: ['main'],
  delegationPolicy: ['allow', 'deny'],
  turnIntent: ['plan-first', 'save-as-skill'],
  feature: ['reviewer', 'compute', 'background-results'],
  purpose: ['correction', 'job-completion-analysis', 'agent-result-delivery'],
  direction: ['to-main', 'to_child', 'to_parent'],
  disposition: ['message', 'continued'],
  cancellationReason: ['main_agent_stop', 'session_stop', 'runtime_interrupted'],
  evidence: ['provider_prompt_accepted', 'provider_prompt_completed'],
  resolution: ['pending', 'acknowledged'],
  state: ['pending', 'answered', 'declined', 'cancelled'],
  sessionDetailsSource: ['fallback', 'generated', 'manual'],
  permissionProfile: ['ask', 'auto', 'full'],
  owner: ['task', 'renderer']
}
function fields(value: unknown, options: DiagnosticTextOptions): ObjectValue {
  const source = object(value)
  const result: ObjectValue = {}
  for (const key of numbers)
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) result[key] = source[key]
  for (const key of identities)
    if (identifier(source[key])) result[key] = diagnosticText(source[key], options, 200)
  for (const [key, allowed] of Object.entries(states))
    if (allowed.includes(source[key] as string)) result[key] = source[key]
  for (const key of [
    'interrupted',
    'turnUsageUnavailable',
    'structuredOutputEvidenceInvalid',
    'usageUnavailable',
    'autoReviewEnabled',
    'memoryEnabled',
    'specialistBindingPending',
    'errorReportable',
    'branchContextResetRequired',
    'continuationPending'
  ])
    if (typeof source[key] === 'boolean') result[key] = source[key]
  for (const key of [
    'runtimeSegmentIds',
    'eventIds',
    'artifactIds',
    'activityIds',
    'findingIds',
    'jobIds',
    'deliveryIds',
    'runtimeConversationCommandIds',
    'artifactErrorEventIds',
    'messageBranchAncestry',
    'messageAncestry'
  ])
    if (Array.isArray(source[key]))
      result[key] = source[key]
        .filter(identifier)
        .slice(-1000)
        .map((value) => diagnosticText(value, options, 200))
  for (const key of ['providerToolName', 'toolKind'])
    if (identifier(source[key])) result[key] = diagnosticText(source[key], options, 200)
  for (const key of ['error', 'failure']) {
    if (source[key] !== undefined) {
      const error = projectDiagnosticError(source[key], options)
      if (error) result[key] = error
    }
  }
  // Model routing identifiers are protocol metadata, never arbitrary configuration objects.
  for (const key of ['model', 'agentModel'])
    if (
      typeof source[key] === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(source[key]) &&
      !source[key].includes('://') &&
      !source[key].includes('..')
    )
      result[key] = diagnosticText(source[key] as string, options, 200)
  return result
}
export function projectDiagnosticSession(
  value: unknown,
  options: DiagnosticTextOptions = {}
): ObjectValue {
  const envelope = object(value)
  const session = object(envelope.session ?? value)
  const arrayCounts: Record<string, { source: number; retained: number; omitted: number }> = {}
  const count = (path: string, source: number, retained: number): void => {
    const previous = arrayCounts[path] ?? { source: 0, retained: 0, omitted: 0 }
    arrayCounts[path] = {
      source: previous.source + source,
      retained: previous.retained + retained,
      omitted: previous.omitted + source - retained
    }
  }
  const projectFields = (value: unknown, depth = 0): ObjectValue => {
    const projected = fields(value, options)
    const source = object(value)
    for (const key of [
      'runtimeSegmentIds',
      'eventIds',
      'artifactIds',
      'activityIds',
      'findingIds',
      'jobIds',
      'deliveryIds',
      'runtimeConversationCommandIds',
      'artifactErrorEventIds',
      'messageBranchAncestry',
      'messageAncestry'
    ]) {
      if (Array.isArray(source[key]))
        count(`identifierArrays.${key}`, source[key].length, (projected[key] as unknown[]).length)
    }
    if (depth < 4)
      for (const key of [
        'receipt',
        'resolvedAgent',
        'executionModel',
        'attribution',
        'continuation',
        'agentTarget',
        'usageOrigin',
        'presentation',
        'relayedFrom',
        'delegatedCallerSource',
        'elicitation',
        'durable',
        'provenanceContext',
        'runtimeTranscriptReviewOwner'
      ]) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          const nested = projectFields(source[key], depth + 1)
          if (Object.keys(nested).length) projected[key] = nested
        }
      }
    return projected
  }
  const list = (value: unknown, path: string, messages = false): ObjectValue[] => {
    if (!Array.isArray(value)) return []
    const retained = value.slice(-1000)
    count(path, value.length, retained.length)
    return retained.map((entry) => {
      const source = object(entry)
      const projected = projectFields(source)
      if (path === 'runtimeContext.delegatedWork.records' && Array.isArray(source.attempts))
        projected.attempts = list(source.attempts, `${path}.attempts`)
      if (messages) {
        if (source.turnUsage) projected.turnUsage = projectFields(source.turnUsage)
        if (Array.isArray(source.modelCallUsage))
          projected.modelCallUsage = list(source.modelCallUsage, `${path}.modelCallUsage`)
      }
      return projected
    })
  }
  const result = projectFields(session)
  for (const key of [
    'activeRun',
    'runtimeTranscriptLastRun',
    'resumeRecovery',
    'pendingHistoryReplay',
    'branchSource',
    'sessionDetailsGeneration',
    'agentConfiguration',
    'runtimeTranscriptReviewOwner',
    'contextUsage'
  ])
    if (session[key]) result[key] = projectFields(session[key])
  for (const key of ['messages', 'activities', 'activityGroups', 'runtimeSessionAdmissions'])
    if (Array.isArray(session[key])) result[key] = list(session[key], key, key === 'messages')
  if (session.sessionDetailsGeneration && object(session.sessionDetailsGeneration).usage)
    object(result.sessionDetailsGeneration).usage = projectFields(
      object(session.sessionDetailsGeneration).usage
    )
  if (session.conversationGraph) {
    const graph = object(session.conversationGraph)
    const projected = projectFields(graph)
    for (const key of [
      'frames',
      'branches',
      'messages',
      'activities',
      'activityGroups',
      'runtimeSegments'
    ])
      if (Array.isArray(graph[key]))
        projected[key] = list(graph[key], `conversationGraph.${key}`, key === 'messages')
    result.conversationGraph = projected
  }
  const runtimeContext = object(session.runtimeContext)
  if (runtimeContext.delegatedWork) {
    const delegated = object(runtimeContext.delegatedWork)
    const projected: ObjectValue = {}
    for (const key of ['records', 'messageCommands', 'questionRequests'])
      if (Array.isArray(delegated[key]))
        projected[key] = list(delegated[key], `runtimeContext.delegatedWork.${key}`)
    result.runtimeContext = {
      ...projectFields(runtimeContext),
      delegatedWork: projected
    }
  }
  return {
    format: 'diagnostic-session-projection',
    ...(typeof envelope.version === 'number' ? { version: envelope.version } : {}),
    session: result,
    arrayCounts,
    truncated: Object.values(arrayCounts).some((count) => count.omitted > 0),
    omissionPolicy:
      'Conversation content, titles, tool inputs/outputs, paths, credentials and unknown fields omitted. Known error text is bounded and redacted; arrays retain at most the latest 1000 entries.'
  }
}
const diagnosticStringFields = [
  'operation',
  'phase',
  'cpuIntervalPhase',
  'outcome',
  'mode',
  'status',
  'delayKind',
  'operationDelayKind',
  'errorCategory',
  'reason'
] as const

export function projectDiagnosticLog(
  value: unknown,
  options: DiagnosticTextOptions = {}
): ObjectValue {
  const source = object(value)
  const result: ObjectValue = {}
  if (typeof source.t === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(source.t))
    result.t = source.t
  if (['debug', 'info', 'warn', 'error'].includes(source.level as string))
    result.level = source.level
  if (typeof source.scope === 'string') result.scope = diagnosticText(source.scope, options, 160)
  for (const key of ['runId', 'correlationId'])
    if (identifier(source[key])) result[key] = diagnosticText(source[key], options, 200)
  if (typeof source.msg === 'string') result.event = diagnosticText(source.msg, options, 2_000)
  const data = object(source.data)
  const diagnostic = fields(data, options)
  for (const key of diagnosticStringFields)
    if (typeof data[key] === 'string') diagnostic[key] = diagnosticText(data[key], options, 1_000)
  if (data.authorityStatus === 'missing' || data.authorityStatus === 'unreadable')
    diagnostic.authorityStatus = data.authorityStatus
  for (const key of ['hydrationAvailable', 'startupCleanupEligible', 'metadataComplete'])
    if (typeof data[key] === 'boolean') diagnostic[key] = data[key]
  for (const key of ['sessionId', 'messageId', 'operationId', 'requestId', 'cachedProjectId'])
    if (identifier(data[key])) diagnostic[key] = diagnosticText(data[key], options, 200)
  for (const key of [
    'unresponsiveDurationMs',
    'durationMs',
    'elapsedMs',
    'attempt',
    'attemptCount',
    'exitCode',
    'httpStatus',
    'retryCount',
    'phaseDurationMs',
    'cpuUserMs',
    'cpuSystemMs',
    'cpuTotalMs',
    'phaseCpuUserMs',
    'phaseCpuSystemMs',
    'phaseCpuTotalMs',
    'phaseWaitMs',
    'waitMs',
    'sessionCount',
    'warningCount',
    'droppedRecords',
    'repairedTailBytes',
    'projectDirectoryCount',
    'sessionFileCount',
    'sessionBytes'
  ])
    if (typeof data[key] === 'number' && Number.isFinite(data[key])) diagnostic[key] = data[key]
  if (typeof data.wasUnresponsive === 'boolean') diagnostic.wasUnresponsive = data.wasUnresponsive
  const error = object(data.error)
  for (const [key, candidate] of [
    ['code', data.code ?? error.code],
    ['errorCode', data.errorCode]
  ] as const)
    if (typeof candidate === 'number' && Number.isFinite(candidate)) diagnostic[key] = candidate
    else if (
      typeof candidate === 'string' &&
      /^(?:E[A-Z0-9_]{1,40}|SQLITE_[A-Z_]+|[A-Z][A-Z0-9_]{1,60})$/.test(candidate)
    )
      diagnostic[key] = diagnosticText(candidate, options, 64)
  // Existing operation owners use `details: errorLogFields(error)` rather than
  // `error`. This is a known container, not a recursive search through payloads.
  if (data.details !== undefined) {
    const details = projectDiagnosticError(data.details, options)
    if (details) diagnostic.details = details
  }
  if (
    data.error !== undefined ||
    data.message !== undefined ||
    data.stack !== undefined ||
    data.cause !== undefined ||
    data.errno !== undefined ||
    data.code !== undefined
  ) {
    const projectedError = projectDiagnosticError(
      data.error && typeof data.error === 'object' ? data.error : data,
      options
    )
    if (projectedError) diagnostic.error = projectedError
  }
  if (Object.keys(diagnostic).length) result.diagnostics = diagnostic
  return result
}
