// Wire protocol shared between the Node kernel driver and the Python/R exec-loop scripts.
import { validRStageEnvironmentProof } from '@aipoch/reproducibility'
import { notebookExecutionContextSchema } from '@aipoch/reproducibility/execution-context'

import type { NotebookEnvironmentPackage } from '@aipoch/environment/contracts'
import type { NotebookLiveEnvironmentOverlay } from '../../shared/notebook'
import type { NotebookNamespaceVariable } from '../../shared/notebook'

export type KernelLoopFigure = { mime: string; path: string }

export type KernelLoopResponse = {
  stageCheckpointCapture?: import('./session-aggregate').NotebookSessionExecutionResult['stageCheckpointCapture']
  stageComparison?: import('./session-aggregate').NotebookSessionExecutionResult['stageComparison']
  reqId: string
  stdout: string
  stderr: string
  error: string | null
  // True only when this request consumed a process-level interrupt. R uses this acknowledgement to
  // distinguish a cancelled request from a normal response that raced ahead of SIGINT delivery.
  interruptAck?: boolean
  executionStarted?: boolean
  // 1-based source line of the failing statement when the loop can attribute one (R); null otherwise.
  errorLine: number | null
  result: string | null
  cwd: string
  figures: KernelLoopFigure[]
  outputTruncated?: boolean
  environmentOverlay?: NotebookLiveEnvironmentOverlay
  namespace?: {
    variableCount: number
    variablesTruncated: boolean
    variables: NotebookNamespaceVariable[]
  }
}

// Env var the driver sets so a loop script knows where to write captured figure files.
export const KERNEL_FIGURES_DIR_ENV = 'OPEN_SCIENCE_KERNEL_FIGURES_DIR'

const parseEnvironmentPackage = (value: unknown): NotebookEnvironmentPackage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const pkg = value as Record<string, unknown>
  const name = typeof pkg.name === 'string' ? pkg.name.trim() : ''
  const ecosystem = pkg.ecosystem
  const versionStatus = pkg.version_status
  if (
    !name ||
    (ecosystem !== 'python' && ecosystem !== 'r') ||
    (versionStatus !== 'known' && versionStatus !== 'unavailable')
  ) {
    return undefined
  }
  const allowedSources = new Set<NotebookEnvironmentPackage['evidenceSources'][number]>([
    'python-importlib-metadata',
    'python-kernel-modules',
    'r-installed-packages',
    'r-session-info'
  ])
  const evidenceSources = Array.isArray(pkg.evidence_sources)
    ? pkg.evidence_sources.filter(
        (source): source is NotebookEnvironmentPackage['evidenceSources'][number] =>
          typeof source === 'string' &&
          allowedSources.has(source as NotebookEnvironmentPackage['evidenceSources'][number])
      )
    : []
  const loadedState = pkg.loaded_state
  const priority = pkg.priority
  return {
    name,
    ...(typeof pkg.version === 'string' && pkg.version ? { version: pkg.version } : {}),
    versionStatus,
    ecosystem,
    evidenceSources,
    ...(loadedState === 'attached' ||
    loadedState === 'loaded' ||
    loadedState === 'installed-only' ||
    loadedState === 'unknown'
      ? { loadedState }
      : {}),
    ...(typeof pkg.library_rank === 'number' && Number.isInteger(pkg.library_rank)
      ? { libraryRank: pkg.library_rank }
      : {}),
    ...(ecosystem === 'r' &&
    (pkg.library_scope === 'environment' ||
      pkg.library_scope === 'user' ||
      pkg.library_scope === 'system' ||
      pkg.library_scope === 'unknown')
      ? { libraryScope: pkg.library_scope }
      : {}),
    ...(typeof pkg.built_for_runtime === 'string' && pkg.built_for_runtime
      ? { builtForRuntime: pkg.built_for_runtime }
      : {}),
    ...(priority === 'base' || priority === 'recommended' || priority === 'other'
      ? { priority }
      : {})
  }
}

const parseEnvironmentOverlay = (value: unknown): NotebookLiveEnvironmentOverlay | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const environment = value as Record<string, unknown>
  const context = notebookExecutionContextSchema.safeParse(environment.execution_context)
  const packages = Array.isArray(environment.packages)
    ? environment.packages
        .map(parseEnvironmentPackage)
        .filter((pkg): pkg is NotebookEnvironmentPackage => pkg !== undefined)
    : []
  return {
    ...(context.success ? { executionContext: context.data } : {}),
    ...(typeof environment.runtime_version === 'string' && environment.runtime_version
      ? { runtimeVersion: environment.runtime_version }
      : {}),
    packages
  }
}

const parseWireText = (value: Record<string, unknown>, field: string): string | undefined => {
  const plain = value[field]
  if (typeof plain === 'string') return plain
  const encoded = value[`${field}_base64`]
  if (typeof encoded !== 'string') return undefined
  try {
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

const parseNamespaceVariable = (value: unknown): NotebookNamespaceVariable | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const variable = value as Record<string, unknown>
  const name = parseWireText(variable, 'name')
  const type = parseWireText(variable, 'type')
  const preview = parseWireText(variable, 'preview')
  if (!name || type === undefined || preview === undefined) return undefined
  const shape = parseWireText(variable, 'shape')
  return {
    name,
    type,
    ...(typeof variable.size_bytes === 'number' &&
    Number.isSafeInteger(variable.size_bytes) &&
    variable.size_bytes >= 0
      ? { sizeBytes: variable.size_bytes }
      : {}),
    ...(shape ? { shape } : {}),
    preview,
    ...(variable.preview_truncated === true ? { previewTruncated: true } : {}),
    ...(variable.is_private === true ? { private: true } : {})
  }
}

const parseNamespace = (value: unknown): KernelLoopResponse['namespace'] | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const namespace = value as Record<string, unknown>
  const variableCount = namespace.variable_count
  if (!Number.isSafeInteger(variableCount) || (variableCount as number) < 0) return undefined
  return {
    variableCount: variableCount as number,
    variablesTruncated: namespace.variables_truncated === true,
    variables: Array.isArray(namespace.variables)
      ? namespace.variables
          .map(parseNamespaceVariable)
          .filter((variable): variable is NotebookNamespaceVariable => variable !== undefined)
      : []
  }
}

const parseStageCheckpoint = (value: unknown): KernelLoopResponse['stageCheckpointCapture'] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const checkpoint = value as Record<string, unknown>
  if (checkpoint.state === 'unavailable')
    return {
      state: 'unavailable',
      reason:
        typeof checkpoint.reason === 'string' && checkpoint.reason
          ? checkpoint.reason.slice(0, 1024)
          : 'checkpoint-unavailable'
    }
  const validNames = (names: unknown): names is string[] =>
    Array.isArray(names) &&
    names.length <= 4096 &&
    names.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 1024) &&
    new Set(names).size === names.length
  if (
    checkpoint.state !== 'available' ||
    !validNames(checkpoint.input_names) ||
    !validNames(checkpoint.output_names)
  )
    return { state: 'unavailable', reason: 'invalid-checkpoint-response' }
  let environmentProof: import('@aipoch/reproducibility/contracts').RStageCheckpoint['environmentProof']
  if ('environment_proof' in checkpoint) {
    const proof = checkpoint.environment_proof
    if (
      typeof proof !== 'object' ||
      proof === null ||
      Array.isArray(proof) ||
      Object.keys(proof).some((key) => !['schema_version', 'packages'].includes(key))
    )
      return { state: 'unavailable', reason: 'invalid-checkpoint-environment-proof' }
    const wire = proof as Record<string, unknown>
    const candidate = { schemaVersion: wire.schema_version, packages: wire.packages }
    if (!validRStageEnvironmentProof(candidate))
      return { state: 'unavailable', reason: 'invalid-checkpoint-environment-proof' }
    environmentProof = candidate
  }
  return {
    state: 'available',
    inputNames: checkpoint.input_names,
    outputNames: checkpoint.output_names,
    ...(environmentProof ? { environmentProof } : {})
  }
}

const parseStageComparison = (value: unknown): KernelLoopResponse['stageComparison'] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const comparison = value as Record<string, unknown>
  if (!['equal', 'different', 'unavailable'].includes(String(comparison.outcome))) return undefined
  const invalid = (): NonNullable<KernelLoopResponse['stageComparison']> => ({
    outcome: 'unavailable',
    reason: 'invalid-stage-comparison-response'
  })
  const packageNames = (names: unknown): names is string[] =>
    Array.isArray(names) &&
    names.length > 0 &&
    names.length <= 4096 &&
    names.every(
      (name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,127}$/u.test(name)
    ) &&
    new Set(names).size === names.length
  let packageContext: import('../../shared/notebook').NotebookRPackageContext | undefined
  if ('package_context' in comparison) {
    const raw = comparison.package_context
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
    const context = raw as Record<string, unknown>
    if (
      Object.keys(context).length !== 3 ||
      context.schema_version !== 1 ||
      !packageNames(context.source_packages) ||
      !packageNames(context.target_packages) ||
      !['equal', 'different'].includes(String(comparison.scientific_outcome)) ||
      (comparison.outcome === 'equal' && comparison.scientific_outcome !== 'equal')
    )
      return invalid()
    packageContext = {
      schemaVersion: 1,
      sourcePackages: context.source_packages,
      targetPackages: context.target_packages
    }
  } else if ('scientific_outcome' in comparison) return invalid()
  let runtimeFootprint: import('../../shared/notebook').NotebookRStageComparison['runtimeFootprint']
  if ('runtime_footprint' in comparison) {
    const raw = comparison.runtime_footprint
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
    const footprint = raw as Record<string, unknown>
    const packages = { schemaVersion: 1, packages: footprint.packages }
    if (
      Object.keys(footprint).length !== 3 ||
      !Number.isSafeInteger(footprint.process_id) ||
      Number(footprint.process_id) <= 0 ||
      !validRStageEnvironmentProof(packages) ||
      !Array.isArray(footprint.library_paths) ||
      footprint.library_paths.length > 4096 ||
      !footprint.library_paths.every(
        (path) =>
          typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0')
      ) ||
      new Set(footprint.library_paths).size !== footprint.library_paths.length
    )
      return invalid()
    runtimeFootprint = {
      processId: Number(footprint.process_id),
      packages: packages.packages,
      libraryPaths: footprint.library_paths
    }
  }
  return {
    outcome: comparison.outcome as 'equal' | 'different' | 'unavailable',
    ...(typeof comparison.reason === 'string' ? { reason: comparison.reason.slice(0, 1024) } : {}),
    ...(packageContext
      ? {
          packageContext,
          scientificOutcome: comparison.scientific_outcome as 'equal' | 'different'
        }
      : {}),
    ...(runtimeFootprint ? { runtimeFootprint } : {})
  }
}

// Parses one loop stdout line (snake_case wire fields -> camelCase). Returns null when the line is
// not valid JSON or not an object, since loop stdout can contain unrelated noise the driver ignores.
// Missing/invalid fields fall back to safe defaults rather than throwing.
export function parseLoopResponse(line: string): KernelLoopResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const obj = parsed as Record<string, unknown>
  const figures: KernelLoopFigure[] = Array.isArray(obj.figures)
    ? obj.figures
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({ mime: String(f.mime), path: String(f.path) }))
    : []
  const environmentOverlay = parseEnvironmentOverlay(obj.environment)
  const namespace = parseNamespace(obj.namespace)
  const stageCheckpointCapture = parseStageCheckpoint(obj.stage_checkpoint)
  const stageComparison = parseStageComparison(obj.stage_comparison)

  return {
    ...(stageCheckpointCapture ? { stageCheckpointCapture } : {}),
    ...(stageComparison ? { stageComparison } : {}),
    reqId: typeof obj.req_id === 'string' ? obj.req_id : '',
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
    error: typeof obj.error === 'string' ? obj.error : null,
    ...(typeof obj.execution_started === 'boolean'
      ? { executionStarted: obj.execution_started }
      : {}),
    ...(typeof obj.interrupt_ack === 'boolean' ? { interruptAck: obj.interrupt_ack } : {}),
    errorLine:
      typeof obj.error_line === 'number' && Number.isFinite(obj.error_line) ? obj.error_line : null,
    result: typeof obj.result === 'string' ? obj.result : null,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
    figures,
    ...(obj.output_truncated === true ? { outputTruncated: true } : {}),
    ...(environmentOverlay ? { environmentOverlay } : {}),
    ...(namespace ? { namespace } : {})
  }
}

// One JSON line + newline for the Python loop's stdin protocol; key order is stable so the wire
// format is deterministic across runs.
export function framePythonRequest(
  reqId: string,
  code: string,
  controlInvocationId?: string,
  protectedDirs?: readonly string[],
  pythonRandomState?: import('@aipoch/reproducibility/execution-context').NotebookExecutionContext['before']['pythonRandomState'],
  replPublisher?: string
): string {
  return `${JSON.stringify({
    req_id: reqId,
    code,
    ...(controlInvocationId ? { control_invocation_id: controlInvocationId } : {}),
    ...(protectedDirs?.length ? { protected_dirs: protectedDirs } : {}),
    ...(pythonRandomState ? { python_random_state: pythonRandomState } : {}),
    ...(replPublisher ? { repl_publisher: replPublisher } : {})
  })}\n`
}

export function framePythonNamespaceRequest(reqId: string, includePrivate: boolean): string {
  return `${JSON.stringify({
    req_id: reqId,
    operation: 'inspect_namespace',
    include_private: includePrivate
  })}\n`
}

// R length-prefixed frame: a "<reqId> <codeByteLength>\n" header followed by the exact UTF-8 code
// bytes. The byte length (not JS string length) lets the R side read a precise number of bytes for
// multibyte code.
export function frameRRequest(reqId: string, code: string): Buffer {
  return frameRBody(reqId, code)
}

export function frameRStageRequest(
  reqId: string,
  code: string,
  options: Pick<
    import('./session-aggregate').NotebookSessionExecutionRequest,
    'stageCheckpoint' | 'stageRestore' | 'stageSupplement' | 'stageExpectedOutputPath'
  >
): Buffer {
  return frameRBody(
    reqId,
    JSON.stringify({
      code,
      ...(options.stageCheckpoint
        ? {
            stage_checkpoint: {
              input_path: options.stageCheckpoint.inputPath,
              output_path: options.stageCheckpoint.outputPath
            }
          }
        : {}),
      ...(options.stageRestore
        ? {
            stage_restore: {
              input_path: options.stageRestore.inputPath,
              expected_output_path: options.stageRestore.expectedOutputPath,
              ...(options.stageRestore.packageContext
                ? {
                    package_context: {
                      schema_version: options.stageRestore.packageContext.schemaVersion,
                      source_packages: options.stageRestore.packageContext.sourcePackages,
                      target_packages: options.stageRestore.packageContext.targetPackages
                    }
                  }
                : {}),
              ...(options.stageRestore.observeRuntimeFootprint === true
                ? { observe_runtime_footprint: true }
                : {})
            }
          }
        : {}),
      ...(options.stageSupplement
        ? {
            stage_supplement: {
              input_path: options.stageSupplement.inputPath,
              expected_output_path: options.stageSupplement.expectedOutputPath,
              names: options.stageSupplement.names
            }
          }
        : {}),
      ...(options.stageExpectedOutputPath
        ? { stage_expected_output_path: options.stageExpectedOutputPath }
        : {})
    }),
    'execute_stage'
  )
}

const frameRBody = (reqId: string, body: string, operation?: string): Buffer => {
  const bodyBuf = Buffer.from(body, 'utf8')
  const header = Buffer.from(
    `${reqId} ${bodyBuf.byteLength}${operation ? ` ${operation}` : ''}\n`,
    'utf8'
  )
  return Buffer.concat([header, bodyBuf])
}

export function frameRNamespaceRequest(reqId: string, includePrivate: boolean): Buffer {
  return frameRBody(reqId, includePrivate ? 'private' : '', 'inspect_namespace')
}

// Trusted fixed interrupt checkpoint; it carries no user source or executable payload.
export function frameRInterruptProbeRequest(reqId: string): Buffer {
  return frameRBody(reqId, '', 'interrupt_probe')
}
