import { diagnosticText, type DiagnosticTextOptions } from './detail'
import { redactSensitiveText } from '../../shared/diagnostic-redaction'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export type DiagnosticNotebookScope = {
  projectId: string
  sessionId: string
  frameId?: string
}

export type DiagnosticNotebookCodeCoverage = {
  included: number
  missing: number
  truncated: number
}

const SCRIPT_LIMIT = 16_000
const SCRIPT_TRUNCATION_MARKER = '\n…[execution code truncated]'
const ERROR_TEXT_LIMIT = 16_000
const ERROR_TEXT_TRUNCATION_MARKER = '\n…[middle truncated]\n'

const copyIdentities = (
  source: RecordValue,
  target: RecordValue,
  keys: string[],
  options?: DiagnosticTextOptions
): void => {
  for (const key of keys)
    if (identity(source[key])) target[key] = diagnosticText(source[key], options, 200)
}

const copyNumbers = (source: RecordValue, target: RecordValue, keys: string[]): void => {
  for (const key of keys) if (finiteNumber(source[key])) target[key] = source[key]
}

/** A bounded, content-aware view of one already-persisted Notebook run document. */
export function projectDiagnosticNotebook(
  value: unknown,
  scope: DiagnosticNotebookScope,
  options?: DiagnosticTextOptions,
  includeExecutionCode = false
): RecordValue {
  const source = record(value)
  if (
    !source ||
    (source.projectId ?? source.projectName) !== scope.projectId ||
    source.sessionId !== scope.sessionId
  )
    throw new Error('Notebook document ownership does not match the selected session')

  const result: RecordValue = {
    projectId: diagnosticText(scope.projectId, options, 200),
    sessionId: diagnosticText(scope.sessionId, options, 200),
    ...(scope.frameId ? { frameId: diagnosticText(scope.frameId, options, 200) } : {}),
    sourceScope: scope.frameId ? 'frame' : 'root'
  }
  result.executionCodePolicy = includeExecutionCode
    ? 'Explicitly included; scripts receive best-effort credential redaction and a 16000 UTF-16 character per-run limit. Research content and private paths may remain.'
    : 'Omitted because execution code was not requested.'
  const executionCodeCoverage: DiagnosticNotebookCodeCoverage = {
    included: 0,
    missing: 0,
    truncated: 0
  }
  let truncatedTextFields = 0
  let omittedErrorOutputs = 0
  const limitedText = (text: string, maxChars: number): string => {
    const projected = diagnosticText(text, options, maxChars)
    if (projected.endsWith('…[truncated]')) truncatedTextFields++
    return projected
  }
  const errorText = (text: string): string => {
    const redacted = diagnosticText(text, options, Number.MAX_SAFE_INTEGER)
    if (redacted.length <= ERROR_TEXT_LIMIT) return redacted
    truncatedTextFields++
    const headLength = Math.floor((ERROR_TEXT_LIMIT - ERROR_TEXT_TRUNCATION_MARKER.length) / 2)
    const tailLength = ERROR_TEXT_LIMIT - ERROR_TEXT_TRUNCATION_MARKER.length - headLength
    return `${redacted.slice(0, headLength)}${ERROR_TEXT_TRUNCATION_MARKER}${redacted.slice(-tailLength)}`
  }
  if (finiteNumber(source.version)) result.version = source.version
  if (finiteNumber(source.updatedAt)) result.updatedAt = source.updatedAt
  const kernel = record(source.kernel)
  if (kernel) {
    const projectedKernel: RecordValue = {}
    if (
      typeof kernel.lastKnownStatus === 'string' &&
      ['idle', 'starting', 'running', 'error', 'shutdown', 'restarting', 'terminated'].includes(
        kernel.lastKnownStatus
      )
    )
      projectedKernel.lastKnownStatus = kernel.lastKnownStatus
    if (Array.isArray(kernel.terminatedKernelInstances)) {
      projectedKernel.terminatedKernelInstances = kernel.terminatedKernelInstances
        .slice(0, 20)
        .flatMap((entry) => {
          const instance = record(entry)
          if (!instance || !['python', 'r', 'repl'].includes(String(instance.kind))) return []
          const projected: RecordValue = {
            kind: diagnosticText(instance.kind as string, options, 50)
          }
          if (identity(instance.environment))
            projected.environment = diagnosticText(instance.environment, options, 200)
          return [projected]
        })
      result.terminatedKernelInstanceCounts = {
        source: kernel.terminatedKernelInstances.length,
        retained: (projectedKernel.terminatedKernelInstances as unknown[]).length,
        omitted:
          kernel.terminatedKernelInstances.length -
          (projectedKernel.terminatedKernelInstances as unknown[]).length
      }
    }
    if (Object.keys(projectedKernel).length) result.kernel = projectedKernel
  }

  const runs = Array.isArray(source.runs) ? source.runs : []
  const retained = runs.slice(-100)
  result.runCounts = {
    source: runs.length,
    retained: retained.length,
    omitted: runs.length - retained.length
  }
  result.runs = retained.map((entry) => {
    const run = record(entry)
    if (!run) {
      if (includeExecutionCode) executionCodeCoverage.missing++
      return {
        unavailable: 'invalid-run-record',
        ...(includeExecutionCode ? { scriptStatus: 'missing' } : {})
      }
    }
    const projected: RecordValue = {}
    if (includeExecutionCode) {
      if (typeof run.script !== 'string') {
        projected.scriptStatus = 'missing'
        executionCodeCoverage.missing++
      } else {
        const redacted = redactSensitiveText(run.script)
        if (redacted.length > SCRIPT_LIMIT) {
          projected.script =
            redacted.slice(0, SCRIPT_LIMIT - SCRIPT_TRUNCATION_MARKER.length) +
            SCRIPT_TRUNCATION_MARKER
          projected.scriptStatus = 'truncated'
          executionCodeCoverage.truncated++
        } else {
          projected.script = redacted
          projected.scriptStatus = 'included'
          executionCodeCoverage.included++
        }
      }
    }
    copyIdentities(
      run,
      projected,
      [
        'runId',
        'cellId',
        'submissionIdentity',
        'executionInvocationId',
        'kernelEpochId',
        'runtimeId',
        'rootFrameId',
        'agentFrameId',
        'messageBranchId',
        'runtimeSegmentId',
        'promptMessageId'
      ],
      options
    )
    copyNumbers(run, projected, [
      'admittedAt',
      'cancellationRequestedAt',
      'startedAt',
      'endedAt',
      'executionCount',
      'exitCode'
    ])
    for (const key of [
      'status',
      'kernelKind',
      'source',
      'inputKind',
      'executionMode',
      'interruptionReason',
      'shellErrorCode',
      'shellRuntimeStatus'
    ]) {
      if (typeof run[key] === 'string' && /^[a-z][a-z-]{0,50}$/.test(run[key]))
        projected[key] = diagnosticText(run[key], options, 50)
    }
    if (typeof run.kernelDispatched === 'boolean') projected.kernelDispatched = run.kernelDispatched
    if (typeof run.truncated === 'boolean') projected.truncated = run.truncated
    if (typeof run.cancellationReason === 'string')
      projected.cancellationReason = limitedText(run.cancellationReason, 500)

    const recovery = record(run.recovery)
    if (recovery) {
      const projectedRecovery: RecordValue = {}
      if (recovery.execution === 'not-started' || recovery.execution === 'may-have-run')
        projectedRecovery.execution = recovery.execution
      if (recovery.retryAfter === 'runtime-ready' || recovery.retryAfter === 'cleanup-verified')
        projectedRecovery.retryAfter = recovery.retryAfter
      const recoveryKernel = record(recovery.kernel)
      if (recoveryKernel) {
        const projectedRecoveryKernel: RecordValue = {}
        for (const key of ['kind', 'cause', 'cleanup'])
          if (
            typeof recoveryKernel[key] === 'string' &&
            /^[a-z][a-z-]{0,50}$/.test(recoveryKernel[key])
          )
            projectedRecoveryKernel[key] = diagnosticText(recoveryKernel[key], options, 50)
        if (identity(recoveryKernel.environment))
          projectedRecoveryKernel.environment = diagnosticText(
            recoveryKernel.environment,
            options,
            200
          )
        if (recoveryKernel.exitCode === null || finiteNumber(recoveryKernel.exitCode))
          projectedRecoveryKernel.exitCode = recoveryKernel.exitCode
        if (
          typeof recoveryKernel.signal === 'string' &&
          /^[A-Z0-9]{1,20}$/.test(recoveryKernel.signal)
        )
          projectedRecoveryKernel.signal = diagnosticText(recoveryKernel.signal, options, 20)
        if (Object.keys(projectedRecoveryKernel).length)
          projectedRecovery.kernel = projectedRecoveryKernel
      }
      if (Object.keys(projectedRecovery).length) projected.recovery = projectedRecovery
    }

    const text = record(run.text)
    if (text) {
      const projectedText: RecordValue = {}
      if (typeof text.stderr === 'string' && text.stderr)
        projectedText.stderr = errorText(text.stderr)
      if (typeof text.traceback === 'string' && text.traceback)
        projectedText.traceback = errorText(text.traceback)
      if (Object.keys(projectedText).length) projected.text = projectedText
    }
    if (Array.isArray(run.outputs)) {
      const errors = run.outputs.filter((item) => record(item)?.type === 'error')
      omittedErrorOutputs += Math.max(0, errors.length - 3)
      projected.errorOutputCounts = {
        source: errors.length,
        retained: Math.min(errors.length, 3),
        omitted: Math.max(0, errors.length - 3)
      }
      projected.errorOutputs = errors.slice(-3).map((item) => {
        const output = record(item)!
        const projectedOutput: RecordValue = { type: 'error' }
        if (typeof output.name === 'string') projectedOutput.name = limitedText(output.name, 100)
        if (typeof output.message === 'string') projectedOutput.message = errorText(output.message)
        if (typeof output.traceback === 'string')
          projectedOutput.traceback = errorText(output.traceback)
        if (finiteNumber(output.line)) projectedOutput.line = output.line
        return projectedOutput
      })
    }
    return projected
  })
  result.truncation = {
    omittedRuns: runs.length - retained.length,
    omittedErrorOutputs,
    omittedKernelInstances:
      (result.terminatedKernelInstanceCounts as { omitted?: number } | undefined)?.omitted ?? 0,
    truncatedTextFields
  }
  if (includeExecutionCode) result.executionCodeCoverage = executionCodeCoverage
  return result
}
