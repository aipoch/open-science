import { randomUUID } from 'node:crypto'
import {
  validateReproductionContext,
  validateReproductionDiskSpace
} from './reproduction-preflight'
import type { OutputComparisonPolicy, OutputComparisonReport } from '../../shared/output-comparison'
import { compareReproducedContent } from './output-comparison'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import type {
  ArtifactReproducibilityCheckLog,
  ArtifactReproducibilityReceiptComparison
} from '../../shared/artifact-reproducibility'
import type {
  ArtifactProvenanceGraphEntity,
  ArtifactReproducibilityRecipe,
  ArtifactReproducibilityRecipeStep,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import type { NotebookHelperModuleEvidence } from '../../shared/notebook'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import {
  createNotebookReproductionRuntime,
  type NotebookReproductionEnvironmentProgress,
  type NotebookReproductionEnvironmentOutput,
  type NotebookReproductionRuntime,
  type NotebookReproductionStep
} from '../notebook/reproduction-runtime'
import type { NotebookProcessSandbox } from '../notebook/process-sandbox'
import { limitUtf8 } from '../notebook/content-limits'
import { CHILD_UNCONFIRMED, isChildUnconfirmedError } from '../notebook/provisioner-runtime'
import { redactRuntimeDiagnosticText } from '../notebook/runtime-diagnostics'
import { notebookHelperEvidenceKey } from '../notebook/helper-evidence'
import {
  artifactReproducibilityRecipeMatchesSnapshot,
  prepareArtifactReproducibilityExecutionPlan
} from './artifact-reproducibility-recipe'
import { resolveStorageKey } from './provenance-storage'
import { sha256 } from './provenance-canonical'
import {
  MAX_REPRODUCIBILITY_OUTPUT_BYTES,
  readReproducibilityOutputFile
} from './artifact-reproducibility-outputs'

export class ReproducibilityCleanupError extends AggregateError {
  constructor(errors: unknown[], attemptRoot: string) {
    const details = errors.map((error) => (error instanceof Error ? error.message : String(error)))
    super(
      errors,
      `${details.join('; ')}. Temporary reproducibility workspace could not be removed: ${attemptRoot}`
    )
  }
}

type ArtifactReproducibilityOutputComparison = {
  contentComparison?: OutputComparisonReport
  contentComparisonUnavailableReason?: ArtifactReproducibilityReceiptComparison['contentComparisonUnavailableReason']
  stepId: string
  entityId: string
  relativePath: string
  expectedChecksum: string
  expectedSizeBytes: number
  actualChecksum?: string
  actualSizeBytes?: number
  outputCaptured?: true
  outputCaptureReason?: 'too-large' | 'storage-limit' | 'unavailable'
  status: 'matched' | 'different'
  reason?: 'missing' | 'not-file' | 'linked' | 'size-mismatch' | 'checksum-mismatch'
}

type ArtifactReproducibilityExecutionEvent =
  | {
      type: 'attempt-started'
      totalEnvironments: number
      totalSteps: number
      totalComparisons: number
    }
  | { type: 'inputs-materialized'; count: number }
  | ({ type: 'environment-progress' } & NotebookReproductionEnvironmentProgress)
  | { type: 'environment-output'; entry: ArtifactReproducibilityCheckLog }
  | { type: 'environments-restored'; count: number }
  | { type: 'step-started'; stepId: string; index: number; total: number }
  | { type: 'step-output'; entries: ArtifactReproducibilityCheckLog[] }
  | { type: 'step-completed'; stepId: string; index: number; total: number }
  | { type: 'output-compared'; comparison: ArtifactReproducibilityOutputComparison }
  | { type: 'attempt-completed'; matched: boolean }

type ArtifactReproducibilityExecutionResult = {
  matched: boolean
  completedStepIds: string[]
  comparisons: ArtifactReproducibilityOutputComparison[]
}

type ExecuteArtifactReproducibilityInput = {
  execution: PersistedArtifactExecutionSnapshot
  frontierId: string
  storageRoot: string
  processSandbox: NotebookProcessSandbox
  signal?: AbortSignal
  onEvent?: (event: ArtifactReproducibilityExecutionEvent) => void
  retainOutput?: (bytes: Buffer) => Promise<boolean>
  comparisonPolicy?: OutputComparisonPolicy
}

type ExecuteArtifactReproducibilityDependencies = {
  createAttemptRoot?: () => Promise<string>
  createRuntime?: (input: {
    requirements: Awaited<
      ReturnType<typeof prepareArtifactReproducibilityExecutionPlan>
    >['environmentRequirements']
    storageRoot: string
    attemptRoot: string
    processSandbox: NotebookProcessSandbox
    signal?: AbortSignal
    projectId: string
    sessionId: string
    onEnvironmentProgress?: (event: NotebookReproductionEnvironmentProgress) => void
    onEnvironmentOutput?: (event: NotebookReproductionEnvironmentOutput) => void
  }) => Promise<NotebookReproductionRuntime>
}

const REPRODUCIBILITY_LOG_ENTRY_LIMIT_BYTES = 16 * 1024

const reproductionLogs = (
  step: NotebookReproductionStep,
  result: Awaited<ReturnType<NotebookReproductionRuntime['execute']>>
): ArtifactReproducibilityCheckLog[] => {
  const stderr =
    result.traceback && !result.stderr.includes(result.traceback)
      ? [result.stderr, result.traceback].filter(Boolean).join('\n')
      : result.stderr
  return (
    [
      ['stdout', result.stdout],
      ['stderr', stderr]
    ] as const
  ).flatMap(([stream, text]) => {
    if (!text) return []
    const limited = limitUtf8(text, REPRODUCIBILITY_LOG_ENTRY_LIMIT_BYTES)
    return [
      {
        source: 'notebook' as const,
        stepId: step.stepId,
        runIndex: step.runIndex,
        kernelKind: step.kernelKind,
        stream,
        text: limited.text,
        ...(limited.truncated || result.truncated ? { truncated: true } : {})
      }
    ]
  })
}

const portablePath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !/^[A-Za-z]:\//u.test(value) &&
  value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')

const workspacePath = (root: string, relativePath: string): string => {
  if (!portablePath(relativePath)) throw new Error(`Unsafe reproduction path: ${relativePath}`)
  const resolvedRoot = resolve(root)
  const candidate = resolve(resolvedRoot, ...relativePath.split('/'))
  const candidateRelative = relative(resolvedRoot, candidate)
  if (
    candidateRelative.length === 0 ||
    candidateRelative === '..' ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative)
  ) {
    throw new Error(`Unsafe reproduction path: ${relativePath}`)
  }
  return candidate
}

const hasLinkedParent = async (root: string, path: string): Promise<boolean> => {
  const relativePath = relative(resolve(root), path)
  let current = resolve(root)
  for (const part of relativePath.split(sep).slice(0, -1)) {
    current = join(current, part)
    const metadata = await lstat(current).catch(() => undefined)
    if (metadata?.isSymbolicLink()) return true
  }
  return false
}

const runForStep = (
  step: NotebookReproductionStep,
  runs: ProvenanceNotebookRun[]
): ProvenanceNotebookRun => {
  const matching = runs.filter((run) => run.runId === step.runId && run.runIndex === step.runIndex)
  if (matching.length !== 1 || sha256(matching[0]!.script) !== step.sourceChecksum) {
    throw new Error(`Reproducibility source identity mismatch: ${step.stepId}`)
  }
  return matching[0]!
}

const helpersForRun = (
  run: ProvenanceNotebookRun,
  helpers: NotebookHelperModuleEvidence[] | undefined
): NotebookHelperModuleEvidence[] => {
  const keys = run.helperModuleKeys ?? []
  if (keys.length === 0) return []
  const byKey = new Map(
    (helpers ?? []).map((helper) => [notebookHelperEvidenceKey(helper), helper])
  )
  const selected = keys.flatMap((key) => {
    const helper = byKey.get(key)
    return helper ? [helper] : []
  })
  if (selected.length !== keys.length) {
    throw new Error(`Reproducibility helper evidence is incomplete: ${run.runId}`)
  }
  return selected
}

const outputEntity = (
  graphEntities: ArtifactProvenanceGraphEntity[],
  entityId: string
): Extract<ArtifactProvenanceGraphEntity, { kind: 'file-generation' }> => {
  const matching = graphEntities.filter(
    (entity): entity is Extract<ArtifactProvenanceGraphEntity, { kind: 'file-generation' }> =>
      entity.entityId === entityId && entity.kind === 'file-generation'
  )
  if (matching.length !== 1 || matching[0]!.pathPortability !== 'relative') {
    throw new Error(`Reproducibility output identity mismatch: ${entityId}`)
  }
  return matching[0]!
}

const compareOutput = async (
  workspaceRoot: string,
  stepId: string,
  entity: Extract<ArtifactProvenanceGraphEntity, { kind: 'file-generation' }>,
  signal?: AbortSignal
): Promise<ArtifactReproducibilityOutputComparison> => {
  signal?.throwIfAborted()
  const base = {
    stepId,
    entityId: entity.entityId,
    relativePath: entity.relativePath,
    expectedChecksum: entity.checksum,
    expectedSizeBytes: entity.sizeBytes
  }
  const path = workspacePath(workspaceRoot, entity.relativePath)
  if (await hasLinkedParent(workspaceRoot, path)) {
    return { ...base, status: 'different', reason: 'linked' }
  }
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata) return { ...base, status: 'different', reason: 'missing' }
  if (metadata.isSymbolicLink() || metadata.nlink > 1) {
    return { ...base, status: 'different', reason: 'linked' }
  }
  if (!metadata.isFile()) return { ...base, status: 'different', reason: 'not-file' }
  if (metadata.size !== entity.sizeBytes) {
    return {
      ...base,
      actualSizeBytes: metadata.size,
      status: 'different',
      reason: 'size-mismatch'
    }
  }
  const digest = await digestFileWithinBudget(path, entity.sizeBytes, signal).catch(() => {
    signal?.throwIfAborted()
    return undefined
  })
  if (!digest || digest.checksum !== entity.checksum) {
    return {
      ...base,
      actualSizeBytes: metadata.size,
      ...(digest ? { actualChecksum: digest.checksum } : {}),
      status: 'different',
      reason: 'checksum-mismatch'
    }
  }
  return {
    ...base,
    actualChecksum: digest.checksum,
    actualSizeBytes: digest.sizeBytes,
    status: 'matched'
  }
}

const materializeInputs = async (
  recipe: ArtifactReproducibilityRecipe,
  graphEntities: ArtifactProvenanceGraphEntity[],
  frontierId: string,
  storageRoot: string,
  sessionRoot: string,
  dataRoot: string,
  signal?: AbortSignal
): Promise<number> => {
  const frontier = recipe.frontiers.find((candidate) => candidate.frontierId === frontierId)
  if (!frontier) throw new Error(`Artifact reproduction frontier is unavailable: ${frontierId}`)
  const destinations = new Set<string>()
  for (const file of frontier.crossingFiles) {
    if (signal?.aborted) throw signal.reason ?? new Error('Reproduction cancelled.')
    const entity = graphEntities.find((candidate) => candidate.entityId === file.entityId)
    if (!entity || entity.kind === 'artifact-version') {
      throw new Error(`Reproducibility crossing file identity mismatch: ${file.entityId}`)
    }
    const destination = workspacePath(
      entity.kind === 'registered-input-generation' ? dataRoot : sessionRoot,
      file.materializationPath
    )
    const destinationKey = process.platform === 'win32' ? destination.toLowerCase() : destination
    if (destinations.has(destinationKey)) {
      throw new Error(
        `Reproducibility materialization path is duplicated: ${file.materializationPath}`
      )
    }
    destinations.add(destinationKey)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const source = resolveStorageKey(storageRoot, file.contentStorageKey)
    const sourceMetadata = await lstat(source).catch(() => undefined)
    if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new Error(`Reproducibility frozen file is not immutable: ${file.entityId}`)
    }
    const digest = await copyFileWithinBudget(source, destination, file.sizeBytes, signal)
    if (digest.sizeBytes !== file.sizeBytes || digest.checksum !== file.checksum) {
      throw new Error(`Materialized reproducibility input changed: ${file.entityId}`)
    }
  }
  return frontier.crossingFiles.length
}

const notebookStep = (step: ArtifactReproducibilityRecipeStep): NotebookReproductionStep => {
  if (step.kind !== 'notebook-run') {
    throw new Error(`Unsupported reproducibility execution step: ${step.stepId}`)
  }
  return step
}

const environmentLog = (
  event: NotebookReproductionEnvironmentOutput
): ArtifactReproducibilityCheckLog | undefined => {
  const sanitized = redactRuntimeDiagnosticText(
    stripVTControlCharacters(event.text).replace(/\r(?!\n)/gu, '\n')
  )
  if (!sanitized) return undefined
  const limited = limitUtf8(sanitized, REPRODUCIBILITY_LOG_ENTRY_LIMIT_BYTES)
  return {
    source: 'environment',
    requirementId: event.requirementId,
    environmentIndex: event.index,
    environmentTotal: event.total,
    kernelKind: event.kernelKind,
    stream: event.stream,
    text: limited.text,
    ...(limited.truncated ? { truncated: true } : {})
  }
}

const executeArtifactReproducibility = async (
  input: ExecuteArtifactReproducibilityInput,
  dependencies: ExecuteArtifactReproducibilityDependencies = {}
): Promise<ArtifactReproducibilityExecutionResult> => {
  if (input.signal?.aborted) throw input.signal.reason ?? new Error('Reproduction cancelled.')
  const recipe = input.execution.reproducibilityRecipe
  const graph = input.execution.provenanceGraph
  if (
    !recipe ||
    !graph ||
    !artifactReproducibilityRecipeMatchesSnapshot(recipe, {
      inputFiles: input.execution.inputFiles,
      runs: input.execution.runs,
      helperModules: input.execution.helperModules,
      helperEvidenceStatus: input.execution.helperEvidenceStatus,
      truncation: input.execution.truncation,
      provenanceGraph: graph
    })
  ) {
    throw new Error('Artifact reproduction recipe does not match its Execution snapshot.')
  }
  validateReproductionContext(input.execution, input.frontierId)
  await validateReproductionDiskSpace(recipe, input.frontierId)
  const plan = await prepareArtifactReproducibilityExecutionPlan(
    recipe,
    input.frontierId,
    input.storageRoot,
    input.signal
  )
  const createAttemptRoot =
    dependencies.createAttemptRoot ?? (() => mkdtemp(join(tmpdir(), 'open-science-reproduction-')))
  const attemptRoot = await createAttemptRoot()
  const markerPath = join(attemptRoot, '.open-science-reproduction-attempt')
  const marker = randomUUID()
  try {
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 })
    if ((await readdir(attemptRoot)).length > 0) {
      throw new Error('Reproducibility attempt root is not empty.')
    }
    await writeFile(markerPath, marker, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    // No ownership marker exists yet: remove only an empty directory, never unknown contents.
    try {
      await rmdir(attemptRoot)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ReproducibilityCleanupError([error, cleanupError], attemptRoot)
      }
    }
    throw error
  }
  const workspaceRoot = join(attemptRoot, 'workspace')
  const dataRoot = join(workspaceRoot, 'data')

  let runtime: NotebookReproductionRuntime | undefined
  let result: ArtifactReproducibilityExecutionResult | undefined
  let executionError: unknown
  try {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 })
    input.onEvent?.({
      type: 'attempt-started',
      totalEnvironments: plan.environmentRequirements.length,
      totalSteps: plan.steps.length,
      totalComparisons: plan.steps.reduce(
        (total, step) => total + (step.kind === 'notebook-run' ? step.outputEntityIds.length : 0),
        0
      )
    })
    const materialized = await materializeInputs(
      recipe,
      graph.entities,
      input.frontierId,
      input.storageRoot,
      workspaceRoot,
      dataRoot,
      input.signal
    )
    input.onEvent?.({ type: 'inputs-materialized', count: materialized })
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('Reproduction cancelled.')
    runtime = await (dependencies.createRuntime ?? createNotebookReproductionRuntime)({
      requirements: plan.environmentRequirements,
      storageRoot: input.storageRoot,
      attemptRoot,
      processSandbox: input.processSandbox,
      signal: input.signal,
      projectId: 'artifact-reproducibility',
      sessionId: `reproduction-${recipe.recipeId.slice(0, 16)}`,
      onEnvironmentProgress: (event) => input.onEvent?.({ type: 'environment-progress', ...event }),
      onEnvironmentOutput: (event) => {
        const entry = environmentLog(event)
        if (entry) input.onEvent?.({ type: 'environment-output', entry })
      }
    })
    input.onEvent?.({
      type: 'environments-restored',
      count: plan.environmentRequirements.length
    })

    const completedStepIds: string[] = []
    const comparisons: ArtifactReproducibilityOutputComparison[] = []
    for (const [index, rawStep] of plan.steps.entries()) {
      const step = notebookStep(rawStep)
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Reproduction cancelled.')
      input.onEvent?.({
        type: 'step-started',
        stepId: step.stepId,
        index,
        total: plan.steps.length
      })
      const run = runForStep(step, input.execution.runs)
      const result = await runtime.execute({
        step,
        source: run.script,
        executionContext: run.executionContext,
        sessionRoot: workspaceRoot,
        kernelEpochId: run.kernelEpochId,
        helperModules: helpersForRun(run, input.execution.helperModules),
        signal: input.signal
      })
      const logEntries = reproductionLogs(step, result)
      if (logEntries.length > 0) input.onEvent?.({ type: 'step-output', entries: logEntries })
      if (result.status !== 'completed') {
        const diagnostic = result.stderr || result.traceback
        throw new Error(
          `Reproducibility step ${step.stepId} ${result.status}` +
            (diagnostic ? `: ${diagnostic}` : '.')
        )
      }
      completedStepIds.push(step.stepId)
      input.onEvent?.({
        type: 'step-completed',
        stepId: step.stepId,
        index,
        total: plan.steps.length
      })
      for (const entityId of step.outputEntityIds) {
        const entity = outputEntity(graph.entities, entityId)
        const comparison = await compareOutput(workspaceRoot, step.stepId, entity, input.signal)
        if (
          (comparison.status === 'different' &&
            ['size-mismatch', 'checksum-mismatch'].includes(comparison.reason ?? '')) ||
          (comparison.status === 'matched' && input.comparisonPolicy?.scientific)
        ) {
          if (!/\.(png|jpe?g|tiff?|csv|tsv)$/iu.test(comparison.relativePath)) {
            comparison.contentComparisonUnavailableReason = 'unsupported-format'
          } else if (
            Math.max(entity.sizeBytes, comparison.actualSizeBytes ?? Infinity) >
            MAX_REPRODUCIBILITY_OUTPUT_BYTES
          ) {
            comparison.contentComparisonUnavailableReason = 'budget-exceeded'
          } else {
            try {
              const expected = await readReproducibilityOutputFile(
                resolveStorageKey(input.storageRoot, entity.contentStorageKey)
              )
              const actualPath = workspacePath(workspaceRoot, comparison.relativePath)
              if (await hasLinkedParent(workspaceRoot, actualPath))
                throw new Error('Linked output.')
              const actual = await readReproducibilityOutputFile(actualPath)
              if (
                expected.length !== entity.sizeBytes ||
                sha256(expected) !== entity.checksum ||
                actual.length !== comparison.actualSizeBytes ||
                (comparison.actualChecksum && sha256(actual) !== comparison.actualChecksum)
              )
                throw new Error('Comparison content identity changed.')
              const { report } = await compareReproducedContent({
                filename: comparison.relativePath,
                expected,
                actual,
                policy: input.comparisonPolicy,
                signal: input.signal
              })
              comparison.actualChecksum = report.actualChecksum
              comparison.contentComparison = report
            } catch {
              input.signal?.throwIfAborted()
              comparison.contentComparisonUnavailableReason = 'comparison-failed'
            }
          }
        }
        if (
          comparison.status === 'different' &&
          input.retainOutput &&
          (comparison.reason === 'size-mismatch' || comparison.reason === 'checksum-mismatch')
        ) {
          if ((comparison.actualSizeBytes ?? Infinity) > MAX_REPRODUCIBILITY_OUTPUT_BYTES) {
            comparison.outputCaptureReason = 'too-large'
          } else {
            try {
              const path = workspacePath(workspaceRoot, comparison.relativePath)
              if (await hasLinkedParent(workspaceRoot, path))
                throw new Error('Linked reproduced output.')
              const bytes = await readReproducibilityOutputFile(path)
              const checksum = sha256(bytes)
              if (
                bytes.length !== comparison.actualSizeBytes ||
                (comparison.actualChecksum && comparison.actualChecksum !== checksum)
              )
                throw new Error('Reproduced output changed after comparison.')
              input.signal?.throwIfAborted()
              if (await input.retainOutput(bytes)) {
                comparison.actualChecksum = checksum
                comparison.outputCaptured = true
              } else comparison.outputCaptureReason = 'storage-limit'
            } catch {
              input.signal?.throwIfAborted()
              comparison.outputCaptureReason = 'unavailable'
            }
          }
        }
        comparisons.push(comparison)
        input.onEvent?.({ type: 'output-compared', comparison })
      }
    }
    const matched =
      comparisons.length > 0 && comparisons.every(({ status }) => status === 'matched')
    input.onEvent?.({ type: 'attempt-completed', matched })
    result = { matched, completedStepIds, comparisons }
  } catch (error) {
    executionError = error
  }

  const shutdown = runtime
    ? await runtime.shutdown().catch(() => ({ reaped: false }))
    : { reaped: true }
  const retainedMarker = await readFile(markerPath, 'utf8').catch(() => undefined)
  if (!shutdown.reaped || retainedMarker !== marker || isChildUnconfirmedError(executionError)) {
    throw new Error(
      `${CHILD_UNCONFIRMED}: Reproducibility kernel teardown could not be confirmed; attempt retained.`
    )
  }
  try {
    // A stopped installer can leave a short-lived Windows sharing violation. Retry filesystem
    // cleanup only; never rerun a package transaction after an ambiguous failure.
    await rm(attemptRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (cleanupError) {
    const errors = executionError === undefined ? [cleanupError] : [executionError, cleanupError]
    throw new ReproducibilityCleanupError(errors, attemptRoot)
  }
  if (executionError !== undefined) throw executionError
  if (!result) throw new Error('Reproducibility execution did not produce a result.')
  return result
}

export { executeArtifactReproducibility }
export type {
  ArtifactReproducibilityExecutionEvent,
  ArtifactReproducibilityExecutionResult,
  ArtifactReproducibilityOutputComparison,
  ExecuteArtifactReproducibilityDependencies,
  ExecuteArtifactReproducibilityInput
}
