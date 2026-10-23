import { randomUUID } from 'node:crypto'
import type { CondaRuntimeSubsetPlan } from '@aipoch/environment/contracts'
import { validateReproductionContext, validateReproductionDiskSpace } from './preflight'
import type { OutputComparisonPolicy, OutputComparisonReport } from './comparison-contracts'
import { compareReproducedContent } from './output-comparison'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import type {
  ArtifactReproducibilityCheckLog,
  ArtifactReproducibilityReceiptComparison
} from './evidence'
import type {
  ArtifactProvenanceGraphEntity,
  ArtifactProvenanceGraph,
  ArtifactReproducibilityRecipeFile,
  ArtifactReproducibilityEnvironmentRequirement,
  ArtifactReproducibilityRecipeStep,
  ReproductionSnapshot,
  ProvenanceNotebookRun,
  WorkflowCapture,
  WorkflowPlan
} from './evidence'
import type { NotebookHelperModuleEvidence } from './evidence'
import type {
  ReproductionEvidence,
  ReproductionFileIO,
  CreateReproductionRuntime,
  NotebookReproductionEnvironmentProgress,
  NotebookReproductionEnvironmentOutput,
  NotebookReproductionRuntime,
  NotebookReproductionRestoredEnvironment,
  NotebookReproductionStep
} from './ports'
import { limitUtf8 } from './text'
import {
  CHILD_UNCONFIRMED,
  isChildUnconfirmedError,
  parseNotebookEnvironmentLock,
  deriveCondaRuntimeSubsetPlan,
  condaRuntimeSubsetPlanMatchesLock
} from '@aipoch/environment'
import { redactRuntimeDiagnosticText } from '@aipoch/diagnostics/node'
import { notebookHelperEvidenceKey } from './helper-identity'
import { createReproductionRecipes } from './recipe'
import { sha256 } from './canonical'
import { MAX_REPRODUCIBILITY_OUTPUT_BYTES, readReproducibilityOutputFile } from './output-files'
import { createWorkflowSlices } from './workflow-slice'

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
  stateComparison?: ArtifactReproducibilityReceiptComparison['stateComparison']
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
  | { type: 'attempt-completed'; matched: boolean; verification?: WorkflowPlan['verification'] }

type ArtifactReproducibilityExecutionResult = {
  matched: boolean
  completedStepIds: string[]
  comparisons: ArtifactReproducibilityOutputComparison[]
  environmentLocks?: NotebookReproductionRestoredEnvironment[]
}

type ExecuteArtifactReproducibilityInput = {
  execution: ReproductionSnapshot
  frontierId: string
  evidence: ReproductionEvidence
  signal?: AbortSignal
  onEvent?: (event: ArtifactReproducibilityExecutionEvent) => void
  retainOutput?: (bytes: Buffer) => Promise<boolean>
  comparisonPolicy?: OutputComparisonPolicy
}

type ExecuteArtifactReproducibilityDependencies = {
  createAttemptRoot?: () => Promise<string>
  createRuntime: CreateReproductionRuntime
  // Host binds implementation bytes, platform, architecture and storage identity.
  // Absent on legacy/custom hosts: preserve the original single-attempt behavior.
  runtimeSubsetContextChecksum?: string
  // Durable candidates are hints, never certificates. Every load is checked against
  // the original lock and replayed in a fresh runtime before it can be saved again.
  loadRuntimeSubsetCandidate?: (
    scopeChecksum: string,
    sourceLockChecksum: string
  ) => Promise<unknown>
  saveRuntimeSubsetCandidate?: (candidate: CondaRuntimeSubsetPlan) => Promise<void>
  // Returning a previous disk hint after a clean cancellation does not certify
  // this attempt. Explicit new seeds have no previous hint to return.
  restoreCancelledRuntimeSubsetCandidate?: () => Promise<void>
}

type ExecuteWorkflowSliceInput = Omit<
  ExecuteArtifactReproducibilityInput,
  'execution' | 'frontierId'
> & {
  capture: WorkflowCapture
  plan: WorkflowPlan
}
type WorkflowExecutionResult = Omit<ArtifactReproducibilityExecutionResult, 'matched'> & {
  captureId: string
  planId: string
  executionOnlyTargetRunIds: string[]
} & (
    | { verification: 'file-comparison' | 'state-comparison'; matched: boolean }
    | { verification: 'execution-only'; matched?: never }
  )
type PreparedExecutionPlan = {
  graph: ArtifactProvenanceGraph
  crossingFiles: ArtifactReproducibilityRecipeFile[]
  steps: ArtifactReproducibilityRecipeStep[]
  environmentRequirements: ArtifactReproducibilityEnvironmentRequirement[]
  verification?: WorkflowPlan['verification']
  stageRestoreRunIds?: string[]
  stageSupplementNames?: Record<string, string[]>
  stateComparisonRunIds?: string[]
  runtimeSubset?: { scopeChecksum: string; plan?: CondaRuntimeSubsetPlan }
  packageContext?: NonNullable<
    Parameters<NotebookReproductionRuntime['execute']>[0]['stageRestore']
  >['packageContext']
}

const createExecutionOwner = (options: {
  recipes: ReturnType<typeof createReproductionRecipes>
  fileIO: ReproductionFileIO
  inputPath?: (filename: string, checksum: string) => string
}): {
  executeArtifactReproducibility: (
    input: ExecuteArtifactReproducibilityInput,
    dependencies: ExecuteArtifactReproducibilityDependencies
  ) => Promise<ArtifactReproducibilityExecutionResult>
  executeWorkflowSlice: (
    input: ExecuteWorkflowSliceInput,
    dependencies: ExecuteArtifactReproducibilityDependencies
  ) => Promise<WorkflowExecutionResult>
} => {
  const {
    artifactReproducibilityRecipeMatchesSnapshot,
    prepareArtifactReproducibilityExecutionPlan
  } = options.recipes
  const { copyFile: copyFileWithinBudget, digestFile: digestFileWithinBudget } = options.fileIO
  const REPRODUCIBILITY_LOG_ENTRY_LIMIT_BYTES = 16 * 1024
  // A certificate covers only this immutable run/input/output/implementation scope.
  // Durable hints still require fresh conformance after restarting the owner.
  const runtimeSubsets = new Map<string, CondaRuntimeSubsetPlan>()
  const observedCandidates = new WeakMap<
    ArtifactReproducibilityExecutionResult,
    CondaRuntimeSubsetPlan
  >()

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
    const matching = runs.filter(
      (run) => run.runId === step.runId && run.runIndex === step.runIndex
    )
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
    files: ArtifactReproducibilityRecipeFile[],
    graphEntities: ArtifactProvenanceGraphEntity[],
    evidence: ReproductionEvidence,
    sessionRoot: string,
    dataRoot: string,
    signal?: AbortSignal
  ): Promise<number> => {
    const destinations = new Set<string>()
    for (const file of files) {
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
      const source = evidence.resolveFile(file.contentStorageKey)
      const sourceMetadata = await lstat(source).catch(() => undefined)
      if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink()) {
        throw new Error(`Reproducibility frozen file is not immutable: ${file.entityId}`)
      }
      const digest = await copyFileWithinBudget(source, destination, file.sizeBytes, signal)
      if (digest.sizeBytes !== file.sizeBytes || digest.checksum !== file.checksum) {
        throw new Error(`Materialized reproducibility input changed: ${file.entityId}`)
      }
    }
    return files.length
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
    dependencies: ExecuteArtifactReproducibilityDependencies
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
      input.evidence,
      input.signal
    )
    return executePreparedPlan(
      input,
      {
        graph,
        crossingFiles: plan.frontier.crossingFiles,
        steps: plan.steps,
        environmentRequirements: plan.environmentRequirements
      },
      dependencies
    )
  }

  const executeWorkflowSlice = async (
    input: ExecuteWorkflowSliceInput,
    dependencies: ExecuteArtifactReproducibilityDependencies
  ): Promise<WorkflowExecutionResult> => {
    if (!options.inputPath) throw new Error('Workflow input path resolver is unavailable.')
    // Clone before asynchronous validation so callers cannot change an admitted plan or source.
    const capture = structuredClone(input.capture)
    const plan = structuredClone(input.plan)
    await createWorkflowSlices({
      inputPath: options.inputPath,
      fileIO: options.fileIO
    }).prepareWorkflowSlice(capture, plan, input.evidence, input.signal)
    const preparedInput = {
      ...input,
      execution: {
        runs: capture.runs,
        inputFiles: capture.inputFiles,
        helperModules: capture.helperModules,
        helperEvidenceStatus: capture.helperEvidenceStatus
      }
    }
    const prepared: PreparedExecutionPlan = {
      graph: capture.graph,
      crossingFiles: plan.crossingFiles,
      steps: plan.steps,
      environmentRequirements: plan.environmentRequirements,
      verification: plan.verification,
      stageRestoreRunIds: plan.stageRestoreRunIds,
      stageSupplementNames: plan.stageSupplementNames,
      stateComparisonRunIds: plan.stateComparisonRunIds
    }
    const singleStep = plan.steps.length === 1 ? plan.steps[0] : undefined
    const singleRun =
      singleStep?.kind === 'notebook-run'
        ? capture.runs.find((run) => run.runId === singleStep.runId)
        : undefined
    // Continuous selections keep one environment and their exact attached context.
    // File-only independent steps may test an explicit cold package projection;
    // its scientific state AND every expected output must still match the original.
    const canConform =
      /^[a-f0-9]{64}$/u.test(dependencies.runtimeSubsetContextChecksum ?? '') &&
      plan.selection.independent &&
      singleStep?.kind === 'notebook-run' &&
      singleStep.kernelKind === 'r' &&
      plan.environmentRequirements.length === 1 &&
      plan.stageRestoreRunIds?.length === 1 &&
      plan.stageRestoreRunIds[0] === singleStep.runId &&
      plan.stateComparisonRunIds?.includes(singleStep.runId) &&
      singleRun?.stageCheckpoint?.state === 'available' &&
      singleRun.stageCheckpoint.environmentProof !== undefined
    let loadedCandidateValid = false
    if (canConform && singleRun?.stageCheckpoint?.state === 'available') {
      const scopeChecksum = sha256(
        JSON.stringify([
          'runtime-subset-conformance-1',
          dependencies.runtimeSubsetContextChecksum,
          capture,
          plan
        ])
      )
      prepared.runtimeSubset = { scopeChecksum }
      const basePackages = [
        'jsonlite',
        'stats',
        'graphics',
        'grDevices',
        'utils',
        'datasets',
        'methods',
        'base'
      ]
      const bindings = singleRun.executionContext?.rPackages
      if (
        singleRun.stageCheckpoint.inputNames.length === 0 &&
        bindings?.complete &&
        JSON.stringify(bindings.before) !== JSON.stringify(basePackages)
      ) {
        prepared.packageContext = {
          schemaVersion: 1,
          sourcePackages: [...bindings.before],
          targetPackages: basePackages
        }
      }
      const cached = runtimeSubsets.get(scopeChecksum)
      if (cached) prepared.runtimeSubset.plan = structuredClone(cached)
      const lockChecksum = plan.environmentRequirements[0].lockChecksum
      if (lockChecksum && dependencies.loadRuntimeSubsetCandidate) {
        try {
          const hint = await dependencies.loadRuntimeSubsetCandidate(scopeChecksum, lockChecksum)
          const bytes = await input.evidence.readEnvironmentLock(lockChecksum, input.signal)
          input.signal?.throwIfAborted()
          const lock =
            bytes && sha256(bytes) === lockChecksum
              ? parseNotebookEnvironmentLock(bytes)
              : undefined
          if (
            lock &&
            condaRuntimeSubsetPlanMatchesLock(hint, lock) &&
            hint.sourceLockChecksum === lockChecksum &&
            hint.scopeChecksum === scopeChecksum
          ) {
            const candidate = deriveCondaRuntimeSubsetPlan(
              lock,
              lockChecksum,
              scopeChecksum,
              hint.archiveNames
            )
            loadedCandidateValid = candidate !== undefined
            if (
              candidate &&
              (!cached || candidate.archiveNames.length < cached.archiveNames.length)
            )
              prepared.runtimeSubset.plan = candidate
          }
        } catch {
          // Cache IO cannot grant authority or prevent the ordinary replay.
          input.signal?.throwIfAborted()
        }
      }
    }
    let result: ArtifactReproducibilityExecutionResult
    let acceptedSubset: CondaRuntimeSubsetPlan | undefined
    const rejectOptimization = (): void => {
      input.onEvent?.({
        type: 'step-output',
        entries: [
          {
            source: 'notebook',
            stepId: singleStep!.stepId,
            runIndex: singleStep!.runIndex,
            kernelKind: 'r',
            stream: 'stderr',
            text: 'Runtime subset was not accepted; using the verified dependency-closure replay.\n'
          }
        ]
      })
    }
    const mayFallback = (error: unknown): boolean =>
      !input.signal?.aborted &&
      !isChildUnconfirmedError(error) &&
      !(error instanceof ReproducibilityCleanupError)
    try {
      result = await executePreparedPlan(preparedInput, prepared, dependencies)
      if (result.matched && prepared.runtimeSubset?.plan)
        acceptedSubset = prepared.runtimeSubset.plan
    } catch (error) {
      if (
        loadedCandidateValid &&
        input.signal?.aborted &&
        !isChildUnconfirmedError(error) &&
        !(error instanceof ReproducibilityCleanupError)
      ) {
        try {
          await dependencies.restoreCancelledRuntimeSubsetCandidate?.()
        } catch {
          // Preserve the original cancellation; cache IO never starts a replay.
        }
      }
      if (prepared.runtimeSubset) runtimeSubsets.delete(prepared.runtimeSubset.scopeChecksum)
      if (
        !prepared.runtimeSubset ||
        (!prepared.runtimeSubset.plan && !prepared.packageContext) ||
        !mayFallback(error)
      )
        throw error
      rejectOptimization()
      prepared.runtimeSubset = undefined
      prepared.packageContext = undefined
      result = await executePreparedPlan(preparedInput, prepared, dependencies)
    }
    if (
      prepared.runtimeSubset &&
      !prepared.runtimeSubset.plan &&
      prepared.packageContext &&
      !result.matched
    ) {
      rejectOptimization()
      prepared.runtimeSubset = undefined
      prepared.packageContext = undefined
      result = await executePreparedPlan(preparedInput, prepared, dependencies)
    }
    const candidate = observedCandidates.get(result)
    if (prepared.runtimeSubset && !prepared.runtimeSubset.plan && result.matched && candidate) {
      // executePreparedPlan has confirmed reaping AND removed its whole workspace.
      // The candidate gets a new prefix, new files and a new kernel, never an in-place retry.
      prepared.runtimeSubset.plan = candidate
      const reference = result
      try {
        result = await executePreparedPlan(preparedInput, prepared, dependencies)
      } catch (error) {
        if (!mayFallback(error)) throw error
        rejectOptimization()
        result = reference
      }
      input.signal?.throwIfAborted()
      if (result !== reference && result.matched) {
        acceptedSubset = candidate
        runtimeSubsets.delete(candidate.scopeChecksum)
        runtimeSubsets.set(candidate.scopeChecksum, structuredClone(candidate))
        if (runtimeSubsets.size > 64) runtimeSubsets.delete(runtimeSubsets.keys().next().value!)
      } else {
        if (result !== reference) rejectOptimization()
        result = reference
      }
    } else if (prepared.runtimeSubset?.plan && !result.matched) {
      runtimeSubsets.delete(prepared.runtimeSubset.scopeChecksum)
      rejectOptimization()
      prepared.runtimeSubset = undefined
      prepared.packageContext = undefined
      result = await executePreparedPlan(preparedInput, prepared, dependencies)
    }
    input.signal?.throwIfAborted()
    if (acceptedSubset && result.matched) {
      // executePreparedPlan returns only after confirmed teardown and cleanup.
      const accepted = structuredClone(acceptedSubset)
      runtimeSubsets.set(accepted.scopeChecksum, accepted)
      if (runtimeSubsets.size > 64) runtimeSubsets.delete(runtimeSubsets.keys().next().value!)
      try {
        await dependencies.saveRuntimeSubsetCandidate?.(accepted)
      } catch {
        input.signal?.throwIfAborted()
      }
      input.signal?.throwIfAborted()
    }
    const { matched, ...details } = result
    const identity = {
      captureId: capture.captureId,
      planId: plan.planId,
      executionOnlyTargetRunIds: [...plan.executionOnlyTargetRunIds]
    }
    return plan.verification === 'execution-only'
      ? { ...details, ...identity, verification: 'execution-only' }
      : { ...details, ...identity, verification: plan.verification, matched }
  }

  const executePreparedPlan = async (
    input: Omit<ExecuteArtifactReproducibilityInput, 'frontierId'>,
    plan: PreparedExecutionPlan,
    dependencies: ExecuteArtifactReproducibilityDependencies
  ): Promise<ArtifactReproducibilityExecutionResult> => {
    const graph = plan.graph
    const createAttemptRoot =
      dependencies.createAttemptRoot ??
      (() => mkdtemp(join(tmpdir(), 'open-science-reproduction-')))
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
        totalComparisons:
          plan.steps.reduce(
            (total, step) =>
              total + (step.kind === 'notebook-run' ? step.outputEntityIds.length : 0),
            0
          ) + (plan.stateComparisonRunIds?.length ?? 0)
      })
      const materialized = await materializeInputs(
        plan.crossingFiles,
        graph.entities,
        input.evidence,
        workspaceRoot,
        dataRoot,
        input.signal
      )
      input.onEvent?.({ type: 'inputs-materialized', count: materialized })
      const statePaths = new Map<string, { inputPath: string; expectedOutputPath: string }>()
      for (const runId of plan.stateComparisonRunIds ?? []) {
        const run = input.execution.runs.find((candidate) => candidate.runId === runId)
        if (run?.stageCheckpoint?.state !== 'available')
          throw new Error('Missing R stage checkpoint.')
        const directory = join(workspaceRoot, '.r-stage-checkpoints', sha256(runId))
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const paths = {
          inputPath: join(directory, 'input.rds'),
          expectedOutputPath: join(directory, 'output.rds')
        }
        for (const [file, destination] of [
          [run.stageCheckpoint.input, paths.inputPath],
          [run.stageCheckpoint.output, paths.expectedOutputPath]
        ] as const) {
          const actual = await options.fileIO.copyFile(
            input.evidence.resolveFile(file.storageKey),
            destination,
            file.sizeBytes,
            input.signal
          )
          if (actual.sizeBytes !== file.sizeBytes || actual.checksum !== file.checksum)
            throw new Error('Materialized R stage checkpoint checksum mismatch.')
        }
        statePaths.set(runId, paths)
      }
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Reproduction cancelled.')
      runtime = await dependencies.createRuntime({
        requirements: plan.environmentRequirements,
        ...(plan.runtimeSubset ? { runtimeSubset: plan.runtimeSubset } : {}),
        selectedRuns: plan.steps.map((rawStep) => {
          const step = notebookStep(rawStep)
          const run = runForStep(step, input.execution.runs)
          return {
            step,
            source: run.script,
            executionContext: run.executionContext,
            ...(statePaths.has(run.runId) ? { stageCheckpoint: run.stageCheckpoint } : {})
          }
        }),
        attemptRoot,
        signal: input.signal,
        onEnvironmentProgress: (event) =>
          input.onEvent?.({ type: 'environment-progress', ...event }),
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
          ...(statePaths.has(run.runId)
            ? plan.stageRestoreRunIds?.includes(run.runId)
              ? {
                  stageRestore: {
                    ...statePaths.get(run.runId)!,
                    ...(plan.packageContext ? { packageContext: plan.packageContext } : {}),
                    ...(plan.runtimeSubset ? { observeRuntimeFootprint: true as const } : {})
                  }
                }
              : plan.stageSupplementNames?.[run.runId]
                ? {
                    stageSupplement: {
                      ...statePaths.get(run.runId)!,
                      names: plan.stageSupplementNames[run.runId]!
                    }
                  }
                : { stageExpectedOutputPath: statePaths.get(run.runId)!.expectedOutputPath }
            : {}),
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
        if (statePaths.has(run.runId)) {
          if (!result.stageComparison || result.stageComparison.outcome === 'unavailable')
            throw new Error(`R stage output comparison unavailable: ${run.runId}`)
          if (
            plan.packageContext &&
            (JSON.stringify(result.stageComparison.packageContext) !==
              JSON.stringify(plan.packageContext) ||
              !['equal', 'different'].includes(result.stageComparison.scientificOutcome ?? '') ||
              (result.stageComparison.outcome === 'equal' &&
                result.stageComparison.scientificOutcome !== 'equal'))
          )
            throw new Error(`R stage package context projection was not verified: ${run.runId}`)
          const checkpoint = run.stageCheckpoint!
          if (checkpoint.state !== 'available') throw new Error('R stage checkpoint changed.')
          const comparison: ArtifactReproducibilityOutputComparison = {
            stepId: step.stepId,
            entityId: `r-state:${run.runId}`,
            relativePath: `R state (${run.runId})`,
            expectedChecksum: checkpoint.output.checksum,
            expectedSizeBytes: checkpoint.output.sizeBytes,
            stateComparison: {
              outcome: result.stageComparison.outcome,
              ...(result.stageComparison.packageContext
                ? {
                    scientificOutcome: result.stageComparison.scientificOutcome,
                    packageContext: structuredClone(result.stageComparison.packageContext)
                  }
                : {})
            },
            status: result.stageComparison.outcome === 'equal' ? 'matched' : 'different',
            ...(result.stageComparison.outcome === 'different'
              ? { reason: 'checksum-mismatch' as const }
              : {})
          }
          comparisons.push(comparison)
          input.onEvent?.({ type: 'output-compared', comparison })
        }
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
                  input.evidence.resolveFile(entity.contentStorageKey)
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
      input.onEvent?.({
        type: 'attempt-completed',
        matched,
        ...(plan.verification ? { verification: plan.verification } : {})
      })
      result = {
        matched,
        completedStepIds,
        comparisons,
        ...(runtime.environmentLocks
          ? { environmentLocks: runtime.environmentLocks.map((lock) => ({ ...lock })) }
          : {})
      }
      if (matched && plan.runtimeSubset) {
        const candidate = await runtime.proposeRuntimeSubset?.()
        if (
          plan.runtimeSubset.plan &&
          (!candidate ||
            candidate.scopeChecksum !== plan.runtimeSubset.scopeChecksum ||
            candidate.sourceLockChecksum !== plan.runtimeSubset.plan.sourceLockChecksum ||
            candidate.archiveNames.some(
              (name) => !plan.runtimeSubset!.plan!.archiveNames.includes(name)
            ))
        )
          throw new Error('Runtime subset native loading could not be verified.')
        if (
          !plan.runtimeSubset.plan &&
          candidate &&
          candidate.scopeChecksum === plan.runtimeSubset.scopeChecksum &&
          candidate.sourceLockChecksum === plan.environmentRequirements[0]?.lockChecksum
        ) {
          observedCandidates.set(result, candidate)
        }
      }
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
    input.signal?.throwIfAborted()
    if (executionError !== undefined) throw executionError
    if (!result) throw new Error('Reproducibility execution did not produce a result.')
    return result
  }

  return { executeArtifactReproducibility, executeWorkflowSlice }
}

export const createReproductionExecutor = (options: {
  recipes: ReturnType<typeof createReproductionRecipes>
  fileIO: ReproductionFileIO
}): ((
  input: ExecuteArtifactReproducibilityInput,
  dependencies: ExecuteArtifactReproducibilityDependencies
) => Promise<ArtifactReproducibilityExecutionResult>) =>
  createExecutionOwner(options).executeArtifactReproducibility

export const createWorkflowSliceExecutor = (options: {
  inputPath: (filename: string, checksum: string) => string
  fileIO: ReproductionFileIO
}): ((
  input: ExecuteWorkflowSliceInput,
  dependencies: ExecuteArtifactReproducibilityDependencies
) => Promise<WorkflowExecutionResult>) =>
  createExecutionOwner({ ...options, recipes: createReproductionRecipes(options) })
    .executeWorkflowSlice
export type {
  ArtifactReproducibilityExecutionEvent,
  ArtifactReproducibilityExecutionResult,
  ArtifactReproducibilityOutputComparison,
  ExecuteArtifactReproducibilityDependencies,
  ExecuteArtifactReproducibilityInput,
  ExecuteWorkflowSliceInput,
  WorkflowExecutionResult
}
