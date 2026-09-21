/** Diagnostic projections deliberately omit content; they never attempt text redaction. */
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)
const numbers =
  'queuedAt callIndex version schemaVersion number revision createdAt updatedAt completedAt failedAt startedAt archivedAt sortIndex index inputTokens cacheTokens cachedReadTokens cachedWriteTokens outputTokens turnCount contextUsedTokens contextWindowSize terminalExitCode computeConcurrencyLimit'.split(
    ' '
  )
const identities =
  'executionId promptRuntimeSegmentId sourceMessageId requestId callId backendId agentBackendId providerId providerSessionId id projectId agentFrameId parentFrameId originMessageId activeBranchId linkedReviewId parentBranchId forkMessageId forkActivityId supersededMessageId headMessageId introducedOnBranchId parentMessageId revisionRootMessageId supersedesMessageId runtimeSegmentId activityGroupId promptMessageId executionInvocationId messageBranchId streamId responseToMessageId sourceInvocationId rootFrameId activeFrameId taskRunCommitId'.split(
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
    'superseded'
  ],
  role: ['user', 'agent', 'assistant', 'system', 'tool'],
  kind: [
    'tool',
    'root',
    'reviewer',
    'delegate',
    'compatibility',
    'resume-required',
    'all',
    'before-message'
  ],
  cause: ['app-restart', 'cancelled', 'connection-lost'],
  originBindingState: ['root', 'validated', 'legacy-unavailable'],
  toolDisposition: ['declined', 'permission-closed'],
  agentFrameworkId: ['claude-code', 'opencode', 'codex', 'codebuddy'],
  frameworkId: ['claude-code', 'opencode', 'codex', 'codebuddy'],
  reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  runtimeTranscriptOwner: ['main'],
  delegationPolicy: ['allow', 'deny'],
  turnIntent: ['plan-first', 'save-as-skill']
}
function fields(value: unknown): ObjectValue {
  const source = object(value)
  const result: ObjectValue = {}
  for (const key of numbers)
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) result[key] = source[key]
  for (const key of identities) if (identifier(source[key])) result[key] = source[key]
  for (const [key, allowed] of Object.entries(states))
    if (allowed.includes(source[key] as string)) result[key] = source[key]
  for (const key of [
    'interrupted',
    'turnUsageUnavailable',
    'structuredOutputEvidenceInvalid',
    'usageUnavailable',
    'autoReviewEnabled',
    'memoryEnabled',
    'specialistBindingPending'
  ])
    if (typeof source[key] === 'boolean') result[key] = source[key]
  for (const key of ['eventIds', 'artifactIds', 'activityIds'])
    if (Array.isArray(source[key])) result[key] = source[key].filter(identifier).slice(-1000)
  // Model routing identifiers are protocol metadata, never arbitrary configuration objects.
  for (const key of ['model', 'agentModel'])
    if (
      typeof source[key] === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(source[key]) &&
      !source[key].includes('://') &&
      !source[key].includes('..')
    )
      result[key] = source[key]
  return result
}
export function projectDiagnosticSession(value: unknown): ObjectValue {
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
  const projectFields = (value: unknown): ObjectValue => {
    const projected = fields(value)
    const source = object(value)
    for (const key of ['eventIds', 'artifactIds', 'activityIds']) {
      if (Array.isArray(source[key]))
        count(`identifierArrays.${key}`, source[key].length, (projected[key] as unknown[]).length)
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
    'agentConfiguration'
  ])
    if (session[key]) result[key] = projectFields(session[key])
  for (const key of ['messages', 'activities', 'activityGroups'])
    if (Array.isArray(session[key])) result[key] = list(session[key], key, key === 'messages')
  if (Array.isArray(session.runtimeSessionAdmissions))
    result.runtimeSessionAdmissions = list(
      session.runtimeSessionAdmissions,
      'runtimeSessionAdmissions'
    )
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
  return {
    format: 'diagnostic-session-projection',
    ...(typeof envelope.version === 'number' ? { version: envelope.version } : {}),
    session: result,
    arrayCounts,
    truncated: Object.values(arrayCounts).some((count) => count.omitted > 0),
    omissionPolicy:
      'Content, paths, credentials, arbitrary text and unknown fields omitted; arrays retain at most the latest 1000 entries.'
  }
}
const diagnosticScopes = new Set([
  'session',
  'session-persistence',
  'session-package',
  'session-deletion',
  'session-details',
  'acp',
  'main',
  'bootstrap',
  'renderer',
  'ipc',
  'window',
  'renderer-broadcast',
  'compute:agent',
  'compute-cancellation',
  'compute',
  'database',
  'background-results',
  'project-files'
])
const diagnosticEvents = new Set([
  'app starting',
  'operation started',
  'operation phase',
  'operation completed',
  'operation cancelled',
  'operation failed',
  'database startup blocked',
  'renderer process gone',
  'child process gone',
  'renderer became unresponsive',
  'renderer became responsive',
  'renderer preload failed',
  'Session deletion project identity conflict',
  'Session runtime deletion failed',
  'Session persistence deletion failed',
  'Session runtime remained attached after deletion',
  'Session result delivery fence failed',
  'Session details generation completed',
  'set session effort failed',
  'set session model failed',
  'session model applied',
  'session effort applied',
  'permission profile applied',
  'native follow-up refused',
  'native follow-up resource cleanup failed',
  'native follow-up notebook materialization failed'
])
// Finite app-owned vocabulary from diagnostics/operation and session hydration owners.
const operationPhases = [
  'operation-start',
  'load-authority',
  'authority-loaded',
  'recover-delegation',
  'recover-session',
  'reconcile-unread-sessions',
  'reconcile-permission-grants',
  'reconcile-derived-state',
  'reconcile-provisional-managed-workspaces',
  'load-bootstrap-modules',
  'crash-reporting',
  'electron-ready',
  'load-startup-shell-modules',
  'prepare-shell',
  'database-and-application-modules',
  'load-application-modules',
  'application-modules-loaded',
  'compose-runtime',
  'register-application-ipc',
  'compose-desktop-surfaces',
  'compose-remote-access',
  'startup-shell-timeout',
  'single-instance-lock',
  'prepare-runtime',
  'install-lifecycle'
]
const operationFields: Record<string, readonly string[]> = {
  operation: ['application-startup', 'session-hydration', 'delegation-recovery'],
  phase: operationPhases,
  cpuIntervalPhase: operationPhases,
  outcome: ['started', 'completed', 'cancelled', 'failed'],
  mode: ['read-only', 'reconcile'],
  status: ['ready', 'degraded', 'failed'],
  delayKind: ['cpu', 'io-or-wait', 'mixed'],
  operationDelayKind: ['cpu', 'io-or-wait', 'mixed'],
  errorCategory: [
    'null',
    'undefined',
    'string',
    'number',
    'boolean',
    'bigint',
    'symbol',
    'request',
    'not-found',
    'permission',
    'timeout',
    'network',
    'system',
    'aborted',
    'aggregate',
    'error',
    'range',
    'reference',
    'syntax',
    'type',
    'uri',
    'object',
    'unknown'
  ]
}
export function projectDiagnosticLog(value: unknown): ObjectValue {
  const source = object(value)
  const result: ObjectValue = {}
  if (typeof source.t === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(source.t))
    result.t = source.t
  if (['debug', 'info', 'warn', 'error'].includes(source.level as string))
    result.level = source.level
  if (typeof source.scope === 'string' && diagnosticScopes.has(source.scope))
    result.scope = source.scope
  for (const key of ['runId', 'correlationId'])
    if (identifier(source[key])) result[key] = source[key]
  if (typeof source.msg === 'string' && diagnosticEvents.has(source.msg)) result.event = source.msg
  const data = object(source.data)
  const diagnostic = fields(data)
  for (const [key, allowed] of Object.entries(operationFields))
    if (allowed.includes(data[key] as string)) diagnostic[key] = data[key]
  for (const key of ['hydrationAvailable', 'startupCleanupEligible'])
    if (typeof data[key] === 'boolean') diagnostic[key] = data[key]
  for (const key of ['sessionId', 'messageId', 'operationId', 'requestId'])
    if (identifier(data[key])) diagnostic[key] = data[key]
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
    'projectDirectoryCount',
    'sessionFileCount',
    'sessionBytes'
  ])
    if (typeof data[key] === 'number' && Number.isFinite(data[key])) diagnostic[key] = data[key]
  if (typeof data.wasUnresponsive === 'boolean') diagnostic.wasUnresponsive = data.wasUnresponsive
  if (
    [
      'clean-exit',
      'abnormal-exit',
      'killed',
      'crashed',
      'oom',
      'launch-failed',
      'integrity-failure'
    ].includes(data.reason as string)
  )
    diagnostic.reason = data.reason
  const error = object(data.error)
  for (const [key, candidate] of [
    ['code', data.code ?? error.code],
    ['errorCode', data.errorCode]
  ] as const)
    if (
      typeof candidate === 'string' &&
      /^(?:E[A-Z0-9_]{1,40}|SQLITE_[A-Z_]+|[A-Z][A-Z0-9_]{1,60})$/.test(candidate)
    )
      diagnostic[key] = candidate
  if (Object.keys(diagnostic).length) result.diagnostics = diagnostic
  return result
}
