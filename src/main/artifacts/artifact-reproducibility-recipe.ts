import { readFile, stat } from 'node:fs/promises'

import type {
  ArtifactProvenanceGraph,
  ArtifactProvenanceGraphEdge,
  ArtifactReproducibilityEnvironmentRequirement,
  ArtifactReproducibilityFrontierPlan,
  ArtifactReproducibilityRecipe,
  ArtifactReproducibilityRecipeBarrier,
  ArtifactReproducibilityRecipeFile,
  ArtifactReproducibilityRecipeStep,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import type { NotebookRunInputFile } from '../../shared/notebook'
import { digestFileWithinBudget } from '../bounded-file-io'
import { parseNotebookEnvironmentLock } from '../notebook/environment-lock'
import { notebookHelperEvidenceKey } from '../notebook/helper-evidence'
import { notebookPromptInputPath } from '../notebook/prompt-input-materialization'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import { projectArtifactReproducibility } from './provenance-reproducibility-projection'
import { resolveStorageKey, storageKey } from './provenance-storage'

const MAX_RECIPE_BYTES = 512 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

const RECIPE_BARRIERS = new Set<ArtifactReproducibilityRecipeBarrier>([
  'target-graph-incomplete',
  'target-graph-conservative',
  'target-source-missing',
  'required-run-missing',
  'required-run-not-completed',
  'required-source-truncated',
  'unsupported-kernel-kind',
  'environment-lock-missing',
  'environment-lock-partial',
  'activity-evidence-not-complete',
  'helper-source-incomplete',
  'execution-evidence-truncated',
  'crossing-entity-unavailable',
  'materialization-path-conflict',
  'absolute-read-remapping-required',
  'absolute-write-not-isolated',
  'advisory-dependency',
  'ambiguous-activity-order',
  'compute-recipe-unavailable',
  'recipe-budget-exceeded'
])

type RecipeDraft = Omit<ArtifactReproducibilityRecipe, 'recipeId'>
type SealArtifactReproducibilityRecipeInput = Pick<
  PersistedArtifactExecutionSnapshot,
  'inputFiles' | 'runs' | 'helperModules' | 'helperEvidenceStatus' | 'truncation'
> & { provenanceGraph: ArtifactProvenanceGraph }
type ArtifactReproducibilityExecutionPlan = {
  frontier: ArtifactReproducibilityFrontierPlan
  steps: ArtifactReproducibilityRecipeStep[]
  environmentRequirements: ArtifactReproducibilityEnvironmentRequirement[]
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const exactFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => {
  const allowed = new Set(fields)
  return Object.keys(value).every((field) => allowed.has(field))
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const portablePath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !/^[A-Za-z]:\//u.test(value) &&
  value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')

const validStorageKey = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')

const uniqueSorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort()

const stepId = (activityId: string): string => `step:${activityId}`

const recipeWithId = (draft: RecipeDraft): ArtifactReproducibilityRecipe => ({
  ...draft,
  recipeId: sha256(canonicalJson(draft as unknown as CanonicalJson))
})

const edgeEntityIds = (
  graph: ArtifactProvenanceGraph,
  activityId: string,
  kind: 'used' | 'generated'
): string[] =>
  uniqueSorted(
    graph.edges.flatMap((edge) =>
      edge.kind === kind && edge.activityId === activityId ? [edge.entityId] : []
    )
  )

const runStep = (
  activity: ArtifactProvenanceGraph['activities'][number],
  run: ProvenanceNotebookRun & { kernelKind: 'python' | 'r' },
  graph: ArtifactProvenanceGraph,
  environmentRequirements: Map<string, ArtifactReproducibilityEnvironmentRequirement>,
  reasons: Set<ArtifactReproducibilityRecipeBarrier>
): ArtifactReproducibilityRecipeStep => {
  if (run.status !== 'completed') reasons.add('required-run-not-completed')
  if (run.scriptTruncated) reasons.add('required-source-truncated')

  const environmentLock = run.environmentLock
  let environmentRequirementId: string | undefined
  if (!environmentLock || environmentLock.state === 'unavailable') {
    reasons.add('environment-lock-missing')
  } else {
    environmentRequirementId = `environment-lock:${environmentLock.lockChecksum}`
    environmentRequirements.set(environmentRequirementId, {
      requirementId: environmentRequirementId,
      kernelKind: run.kernelKind,
      ...(run.environmentName ? { environmentName: run.environmentName } : {}),
      lockChecksum: environmentLock.lockChecksum,
      lockState: environmentLock.state
    })
    if (environmentLock.state === 'partial') reasons.add('environment-lock-partial')
  }

  return {
    kind: 'notebook-run',
    stepId: stepId(activity.activityId),
    activityId: activity.activityId,
    sequence: activity.sequence,
    runId: run.runId,
    runIndex: run.runIndex,
    kernelKind: run.kernelKind,
    sourceChecksum: sha256(run.script),
    ...(environmentRequirementId ? { environmentRequirementId } : {}),
    inputEntityIds: edgeEntityIds(graph, activity.activityId, 'used'),
    outputEntityIds: edgeEntityIds(graph, activity.activityId, 'generated')
  }
}

const materializeEntity = (
  entityId: string,
  graph: ArtifactProvenanceGraph,
  inputFiles: NotebookRunInputFile[]
): { file?: ArtifactReproducibilityRecipeFile; reason?: ArtifactReproducibilityRecipeBarrier } => {
  const entity = graph.entities.find((candidate) => candidate.entityId === entityId)
  if (!entity || entity.kind === 'artifact-version') {
    return { reason: 'crossing-entity-unavailable' }
  }
  if (entity.kind === 'file-generation') {
    if (entity.pathPortability === 'absolute' || !portablePath(entity.relativePath)) {
      return { reason: 'absolute-read-remapping-required' }
    }
    return {
      file: {
        entityId,
        checksum: entity.checksum,
        sizeBytes: entity.sizeBytes,
        contentStorageKey: entity.contentStorageKey,
        materializationPath: entity.relativePath
      }
    }
  }

  const input = inputFiles.find(
    (candidate) =>
      candidate.sourceKind === entity.sourceKind &&
      candidate.inputFileVersionId === entity.inputFileVersionId &&
      candidate.checksum === entity.checksum &&
      candidate.sizeBytes === entity.sizeBytes
  )
  if (!input) return { reason: 'crossing-entity-unavailable' }
  return {
    file: {
      entityId,
      checksum: entity.checksum,
      sizeBytes: entity.sizeBytes,
      contentStorageKey: input.storageKey,
      materializationPath: notebookPromptInputPath(entity.filename, entity.checksum)
    }
  }
}

const barriersForEdges = (
  edges: ArtifactProvenanceGraphEdge[],
  activityIds: Set<string>
): ArtifactReproducibilityRecipeBarrier[] => {
  const reasons = new Set<ArtifactReproducibilityRecipeBarrier>()
  for (const edge of edges) {
    if (!activityIds.has(edge.activityId)) continue
    // Generated entities are output expectations, not dependencies that must be trusted before
    // execution. Their bytes are compared after the isolated run. Advisory inputs and in-memory
    // dependencies remain fail-closed.
    if (edge.kind !== 'generated' && edge.authority !== 'authoritative') {
      reasons.add('advisory-dependency')
    }
    if (edge.kind === 'depends-on') continue
    if (edge.pathPortability !== 'absolute') continue
    reasons.add(
      edge.kind === 'used' ? 'absolute-read-remapping-required' : 'absolute-write-not-isolated'
    )
  }
  return [...reasons]
}

const rootEntityIds = (graph: ArtifactProvenanceGraph, activityIds: Set<string>): string[] => {
  const generated = new Set(
    graph.edges.flatMap((edge) =>
      edge.kind === 'generated' && activityIds.has(edge.activityId) ? [edge.entityId] : []
    )
  )
  return uniqueSorted(
    graph.edges.flatMap((edge) =>
      edge.kind === 'used' && activityIds.has(edge.activityId) && !generated.has(edge.entityId)
        ? [edge.entityId]
        : []
    )
  )
}

const sealArtifactReproducibilityRecipe = (
  input: SealArtifactReproducibilityRecipeInput
): ArtifactReproducibilityRecipe => {
  const { provenanceGraph: graph } = input
  const target = graph.entities.find((entity) => entity.entityId === graph.targetEntityId)
  if (!target || target.kind !== 'artifact-version') {
    throw new Error('Artifact provenance graph has no target Version entity.')
  }
  const graphChecksum = sha256(canonicalJson(graph as unknown as CanonicalJson))
  const publicationActivity = graph.activities.find(
    (activity) =>
      activity.kind === 'artifact-publication' &&
      graph.edges.some(
        (edge) =>
          edge.kind === 'generated' &&
          edge.activityId === activity.activityId &&
          edge.entityId === graph.targetEntityId
      )
  )
  const publicationInput = publicationActivity
    ? graph.edges.find(
        (edge) => edge.kind === 'used' && edge.activityId === publicationActivity.activityId
      )
    : undefined
  const targetSourceEntityId =
    publicationInput?.kind === 'used' ? publicationInput.entityId : undefined
  const globalReasons = new Set<ArtifactReproducibilityRecipeBarrier>()
  if (graph.completeness === 'incomplete') globalReasons.add('target-graph-incomplete')
  if (graph.completeness === 'conservative') globalReasons.add('target-graph-conservative')
  if (!targetSourceEntityId) globalReasons.add('target-source-missing')

  const availableHelperKeys = new Set((input.helperModules ?? []).map(notebookHelperEvidenceKey))
  const runsWithMissingHelpers = new Set(
    input.runs.flatMap((run) =>
      run.helperModuleKeys?.some((key) => !availableHelperKeys.has(key)) ? [run.runId] : []
    )
  )
  if (input.helperEvidenceStatus?.state === 'incomplete' && runsWithMissingHelpers.size === 0) {
    globalReasons.add('helper-source-incomplete')
  }

  const runById = new Map(input.runs.map((run) => [run.runId, run]))
  const environmentRequirements = new Map<string, ArtifactReproducibilityEnvironmentRequirement>()
  const stepReasons = new Map<string, Set<ArtifactReproducibilityRecipeBarrier>>()
  const steps: ArtifactReproducibilityRecipeStep[] = []
  const activities = [...graph.activities].sort(
    (left, right) =>
      left.sequence - right.sequence || left.activityId.localeCompare(right.activityId)
  )
  for (const activity of activities) {
    if (activity.kind === 'artifact-publication') continue
    const reasons = new Set<ArtifactReproducibilityRecipeBarrier>()
    if (activity.evidenceState !== 'available') reasons.add('activity-evidence-not-complete')
    if (runsWithMissingHelpers.has(activity.activityId)) reasons.add('helper-source-incomplete')
    if (activity.kind === 'compute-job') {
      reasons.add('compute-recipe-unavailable')
      steps.push({
        kind: 'compute-job',
        stepId: stepId(activity.activityId),
        activityId: activity.activityId,
        sequence: activity.sequence,
        inputEntityIds: edgeEntityIds(graph, activity.activityId, 'used'),
        outputEntityIds: edgeEntityIds(graph, activity.activityId, 'generated')
      })
    } else {
      const run = runById.get(activity.activityId)
      if (!run) {
        reasons.add('required-run-missing')
      } else if (run.kernelKind !== 'python' && run.kernelKind !== 'r') {
        reasons.add('unsupported-kernel-kind')
      } else {
        steps.push(
          runStep(
            activity,
            { ...run, kernelKind: run.kernelKind },
            graph,
            environmentRequirements,
            reasons
          )
        )
      }
    }
    for (const reason of barriersForEdges(graph.edges, new Set([activity.activityId]))) {
      reasons.add(reason)
    }
    stepReasons.set(activity.activityId, reasons)
  }

  const stepByActivity = new Map(steps.map((step) => [step.activityId, step]))
  const allStepActivityIds = new Set(steps.map((step) => step.activityId))
  const projection = projectArtifactReproducibility(graph, input.runs)
  const frontiers: ArtifactReproducibilityFrontierPlan[] = projection.startFrontiers.map(
    (frontier) => {
      const downstreamGraphActivityIds = new Set(
        frontier.downstreamActivityIds.filter(
          (activityId) =>
            graph.activities.find((activity) => activity.activityId === activityId)?.kind !==
            'artifact-publication'
        )
      )
      const downstreamActivityIds = new Set(
        [...downstreamGraphActivityIds].filter((activityId) => stepByActivity.has(activityId))
      )
      const crossingEntityIds =
        frontier.kind === 'original-inputs'
          ? uniqueSorted([
              ...frontier.crossingEntityIds,
              ...rootEntityIds(graph, allStepActivityIds)
            ])
          : frontier.crossingEntityIds
      const reasons = new Set(globalReasons)
      if (frontier.reasonCodes.includes('absolute-path-boundary')) {
        reasons.add('absolute-read-remapping-required')
      }
      if (frontier.reasonCodes.includes('activity-evidence-not-complete')) {
        reasons.add('activity-evidence-not-complete')
      }
      if (frontier.reasonCodes.includes('advisory-boundary')) {
        reasons.add('advisory-dependency')
      }
      if (frontier.reasonCodes.includes('ambiguous-activity-order')) {
        reasons.add('ambiguous-activity-order')
      }
      for (const activityId of downstreamGraphActivityIds) {
        for (const reason of stepReasons.get(activityId) ?? []) reasons.add(reason)
      }
      for (const reason of barriersForEdges(graph.edges, downstreamGraphActivityIds)) {
        reasons.add(reason)
      }

      const crossingFiles: ArtifactReproducibilityRecipeFile[] = []
      for (const entityId of crossingEntityIds) {
        const materialized = materializeEntity(entityId, graph, input.inputFiles)
        if (materialized.file) crossingFiles.push(materialized.file)
        if (materialized.reason) reasons.add(materialized.reason)
      }
      const pathChecksums = new Map<string, string>()
      for (const file of crossingFiles) {
        const existing = pathChecksums.get(file.materializationPath)
        if (existing && existing !== file.checksum) reasons.add('materialization-path-conflict')
        pathChecksums.set(file.materializationPath, file.checksum)
      }

      return {
        frontierId: frontier.frontierId,
        claimScope: frontier.claimScope,
        ...(frontier.afterActivityId ? { afterActivityId: frontier.afterActivityId } : {}),
        stepIds: steps
          .filter((step) => downstreamActivityIds.has(step.activityId))
          .map((step) => step.stepId),
        crossingFiles: crossingFiles.sort((left, right) =>
          left.materializationPath.localeCompare(right.materializationPath)
        ),
        reasonCodes: uniqueSorted(reasons)
      }
    }
  )

  const ready = frontiers.some((frontier) => frontier.reasonCodes.length === 0)
  const blockedReasons = uniqueSorted(frontiers.flatMap((frontier) => frontier.reasonCodes))
  const draft: RecipeDraft = {
    schemaVersion: 1,
    targetVersionId: target.versionId,
    targetEntityId: target.entityId,
    targetChecksum: target.checksum,
    ...(targetSourceEntityId ? { targetSourceEntityId } : {}),
    graphChecksum,
    steps,
    frontiers,
    environmentRequirements: [...environmentRequirements.values()].sort((left, right) =>
      left.requirementId.localeCompare(right.requirementId)
    ),
    capture: ready
      ? { state: 'sealed', reasonCodes: [] }
      : { state: 'blocked', reasonCodes: blockedReasons }
  }
  const candidate = recipeWithId(draft)
  if (
    Buffer.byteLength(canonicalJson(candidate as unknown as CanonicalJson), 'utf8') <=
    MAX_RECIPE_BYTES
  ) {
    return candidate
  }
  return recipeWithId({
    schemaVersion: 1,
    targetVersionId: target.versionId,
    targetEntityId: target.entityId,
    targetChecksum: target.checksum,
    ...(targetSourceEntityId ? { targetSourceEntityId } : {}),
    graphChecksum,
    steps: [],
    frontiers: [],
    environmentRequirements: [],
    capture: { state: 'blocked', reasonCodes: ['recipe-budget-exceeded'] }
  })
}

const environmentRequirementValue = (value: unknown): boolean => {
  const requirement = recordValue(value)
  return Boolean(
    requirement &&
    exactFields(requirement, [
      'requirementId',
      'kernelKind',
      'environmentName',
      'lockChecksum',
      'lockState'
    ]) &&
    typeof requirement.requirementId === 'string' &&
    (requirement.kernelKind === 'python' || requirement.kernelKind === 'r') &&
    (requirement.environmentName === undefined ||
      typeof requirement.environmentName === 'string') &&
    typeof requirement.lockChecksum === 'string' &&
    SHA256_PATTERN.test(requirement.lockChecksum) &&
    requirement.requirementId === `environment-lock:${requirement.lockChecksum}` &&
    (requirement.lockState === 'available' || requirement.lockState === 'partial')
  )
}

const recipeStepValue = (value: unknown): boolean => {
  const step = recordValue(value)
  if (
    !step ||
    typeof step.stepId !== 'string' ||
    typeof step.activityId !== 'string' ||
    step.stepId !== stepId(step.activityId) ||
    !safeInteger(step.sequence) ||
    !stringArray(step.inputEntityIds) ||
    !stringArray(step.outputEntityIds) ||
    new Set(step.inputEntityIds).size !== step.inputEntityIds.length ||
    new Set(step.outputEntityIds).size !== step.outputEntityIds.length
  ) {
    return false
  }
  if (step.kind === 'compute-job') {
    return exactFields(step, [
      'kind',
      'stepId',
      'activityId',
      'sequence',
      'inputEntityIds',
      'outputEntityIds'
    ])
  }
  return Boolean(
    step.kind === 'notebook-run' &&
    exactFields(step, [
      'kind',
      'stepId',
      'activityId',
      'sequence',
      'runId',
      'runIndex',
      'kernelKind',
      'sourceChecksum',
      'environmentRequirementId',
      'inputEntityIds',
      'outputEntityIds'
    ]) &&
    typeof step.runId === 'string' &&
    step.runId === step.activityId &&
    safeInteger(step.runIndex) &&
    (step.kernelKind === 'python' || step.kernelKind === 'r') &&
    typeof step.sourceChecksum === 'string' &&
    SHA256_PATTERN.test(step.sourceChecksum) &&
    (step.environmentRequirementId === undefined ||
      typeof step.environmentRequirementId === 'string')
  )
}

const recipeFileValue = (value: unknown): boolean => {
  const file = recordValue(value)
  return Boolean(
    file &&
    exactFields(file, [
      'entityId',
      'checksum',
      'sizeBytes',
      'contentStorageKey',
      'materializationPath'
    ]) &&
    typeof file.entityId === 'string' &&
    typeof file.checksum === 'string' &&
    SHA256_PATTERN.test(file.checksum) &&
    safeInteger(file.sizeBytes) &&
    typeof file.contentStorageKey === 'string' &&
    validStorageKey(file.contentStorageKey) &&
    typeof file.materializationPath === 'string' &&
    portablePath(file.materializationPath)
  )
}

const barrierArray = (value: unknown): value is ArtifactReproducibilityRecipeBarrier[] =>
  stringArray(value) &&
  value.every((reason) => RECIPE_BARRIERS.has(reason as ArtifactReproducibilityRecipeBarrier)) &&
  new Set(value).size === value.length

const frontierValue = (value: unknown): boolean => {
  const frontier = recordValue(value)
  return Boolean(
    frontier &&
    exactFields(frontier, [
      'frontierId',
      'claimScope',
      'afterActivityId',
      'stepIds',
      'crossingFiles',
      'reasonCodes'
    ]) &&
    typeof frontier.frontierId === 'string' &&
    (frontier.claimScope === 'end-to-end' || frontier.claimScope === 'downstream-only') &&
    (frontier.afterActivityId === undefined || typeof frontier.afterActivityId === 'string') &&
    stringArray(frontier.stepIds) &&
    new Set(frontier.stepIds).size === frontier.stepIds.length &&
    Array.isArray(frontier.crossingFiles) &&
    frontier.crossingFiles.every(recipeFileValue) &&
    barrierArray(frontier.reasonCodes)
  )
}

const recipeDraft = (recipe: ArtifactReproducibilityRecipe): RecipeDraft => {
  const { recipeId: _recipeId, ...draft } = recipe
  void _recipeId
  return draft
}

const artifactReproducibilityRecipeValue = (
  value: unknown
): value is ArtifactReproducibilityRecipe => {
  const recipe = recordValue(value)
  const capture = recordValue(recipe?.capture)
  if (
    !recipe ||
    !exactFields(recipe, [
      'schemaVersion',
      'recipeId',
      'targetVersionId',
      'targetEntityId',
      'targetChecksum',
      'targetSourceEntityId',
      'graphChecksum',
      'steps',
      'frontiers',
      'environmentRequirements',
      'capture'
    ]) ||
    recipe.schemaVersion !== 1 ||
    typeof recipe.recipeId !== 'string' ||
    !SHA256_PATTERN.test(recipe.recipeId) ||
    typeof recipe.targetVersionId !== 'string' ||
    recipe.targetEntityId !== `artifact-version:${recipe.targetVersionId}` ||
    typeof recipe.targetChecksum !== 'string' ||
    !SHA256_PATTERN.test(recipe.targetChecksum) ||
    (recipe.targetSourceEntityId !== undefined &&
      typeof recipe.targetSourceEntityId !== 'string') ||
    typeof recipe.graphChecksum !== 'string' ||
    !SHA256_PATTERN.test(recipe.graphChecksum) ||
    !Array.isArray(recipe.steps) ||
    !recipe.steps.every(recipeStepValue) ||
    !Array.isArray(recipe.frontiers) ||
    !recipe.frontiers.every(frontierValue) ||
    !Array.isArray(recipe.environmentRequirements) ||
    !recipe.environmentRequirements.every(environmentRequirementValue) ||
    !capture ||
    !exactFields(capture, ['state', 'reasonCodes']) ||
    (capture.state !== 'sealed' && capture.state !== 'blocked') ||
    !barrierArray(capture.reasonCodes)
  ) {
    return false
  }
  const typed = value as ArtifactReproducibilityRecipe
  const stepIds = new Set(typed.steps.map((step) => step.stepId))
  const environmentIds = new Set(
    typed.environmentRequirements.map((requirement) => requirement.requirementId)
  )
  const frozenFileByEntityId = new Map<string, ArtifactReproducibilityRecipeFile>()
  const frozenFileByStorageKey = new Map<string, ArtifactReproducibilityRecipeFile>()
  for (const file of typed.frontiers.flatMap((frontier) => frontier.crossingFiles)) {
    const entityFile = frozenFileByEntityId.get(file.entityId)
    if (
      entityFile &&
      (entityFile.checksum !== file.checksum ||
        entityFile.sizeBytes !== file.sizeBytes ||
        entityFile.contentStorageKey !== file.contentStorageKey ||
        entityFile.materializationPath !== file.materializationPath)
    ) {
      return false
    }
    frozenFileByEntityId.set(file.entityId, file)

    const storedFile = frozenFileByStorageKey.get(file.contentStorageKey)
    if (
      storedFile &&
      (storedFile.checksum !== file.checksum || storedFile.sizeBytes !== file.sizeBytes)
    ) {
      return false
    }
    frozenFileByStorageKey.set(file.contentStorageKey, file)
  }
  const hasReadyFrontier = typed.frontiers.some((frontier) => frontier.reasonCodes.length === 0)
  if (
    stepIds.size !== typed.steps.length ||
    new Set(typed.steps.map((step) => step.activityId)).size !== typed.steps.length ||
    typed.steps.some((step, index) => {
      const previous = typed.steps[index - 1]
      return (
        (previous !== undefined &&
          (step.sequence < previous.sequence ||
            (step.sequence === previous.sequence &&
              step.activityId.localeCompare(previous.activityId) <= 0))) ||
        step.inputEntityIds.some((entityId) => !entityId) ||
        step.outputEntityIds.some((entityId) => !entityId) ||
        (step.kind === 'notebook-run' &&
          step.environmentRequirementId !== undefined &&
          !environmentIds.has(step.environmentRequirementId))
      )
    }) ||
    environmentIds.size !== typed.environmentRequirements.length ||
    new Set(typed.frontiers.map((frontier) => frontier.frontierId)).size !==
      typed.frontiers.length ||
    typed.frontiers.some(
      (frontier) =>
        frontier.stepIds.some((id) => !stepIds.has(id)) ||
        new Set(frontier.crossingFiles.map((file) => file.entityId)).size !==
          frontier.crossingFiles.length
    ) ||
    (typed.capture.state === 'sealed'
      ? typed.capture.reasonCodes.length !== 0 || !hasReadyFrontier
      : typed.capture.reasonCodes.length === 0 || hasReadyFrontier) ||
    sha256(canonicalJson(recipeDraft(typed) as unknown as CanonicalJson)) !== typed.recipeId
  ) {
    return false
  }
  return true
}

const artifactReproducibilityRecipeMatchesSnapshot = (
  recipe: ArtifactReproducibilityRecipe,
  input: SealArtifactReproducibilityRecipeInput
): boolean => {
  try {
    return (
      canonicalJson(recipe as unknown as CanonicalJson) ===
      canonicalJson(sealArtifactReproducibilityRecipe(input) as unknown as CanonicalJson)
    )
  } catch {
    return false
  }
}

const validateFrozenFiles = async (
  files: ArtifactReproducibilityRecipeFile[],
  storageRoot: string,
  signal?: AbortSignal
): Promise<void> => {
  for (const file of new Map(files.map((file) => [file.contentStorageKey, file])).values()) {
    signal?.throwIfAborted()
    const path = resolveStorageKey(storageRoot, file.contentStorageKey)
    const metadata = await stat(path).catch(() => undefined)
    if (!metadata?.isFile()) {
      throw new Error(`Reproducibility frozen file is unavailable: ${file.entityId}`)
    }
    const digest =
      metadata.size === file.sizeBytes
        ? await digestFileWithinBudget(path, file.sizeBytes, signal).catch(() => {
            signal?.throwIfAborted()
            return undefined
          })
        : undefined
    if (!digest || digest.sizeBytes !== file.sizeBytes || digest.checksum !== file.checksum) {
      throw new Error(`Reproducibility frozen file checksum mismatch: ${file.entityId}`)
    }
  }
}

const validateEnvironmentRequirements = async (
  requirements: ArtifactReproducibilityEnvironmentRequirement[],
  storageRoot: string,
  signal?: AbortSignal
): Promise<void> => {
  for (const requirement of requirements) {
    signal?.throwIfAborted()
    const key = storageKey(
      'runtime',
      'provenance',
      'environment-locks',
      `${requirement.lockChecksum}.json`
    )
    const serialized = await readFile(resolveStorageKey(storageRoot, key), {
      encoding: 'utf8',
      signal
    }).catch(() => {
      signal?.throwIfAborted()
      return undefined
    })
    if (!serialized) {
      throw new Error(
        `Reproducibility Environment lock is unavailable: ${requirement.lockChecksum}`
      )
    }
    if (sha256(serialized) !== requirement.lockChecksum) {
      throw new Error(
        `Reproducibility Environment lock checksum mismatch: ${requirement.lockChecksum}`
      )
    }
    const lock = parseNotebookEnvironmentLock(serialized)
    if (
      lock.kernelKind !== requirement.kernelKind ||
      (requirement.environmentName !== undefined &&
        lock.environmentName !== requirement.environmentName)
    ) {
      throw new Error(
        `Reproducibility Environment lock identity mismatch: ${requirement.lockChecksum}`
      )
    }
  }
}

const resolveArtifactReproducibilityExecutionPlan = (
  recipe: ArtifactReproducibilityRecipe,
  frontierId: string
): ArtifactReproducibilityExecutionPlan | undefined => {
  if (!artifactReproducibilityRecipeValue(recipe) || recipe.capture.state !== 'sealed') {
    return undefined
  }
  const frontier = recipe.frontiers.find((candidate) => candidate.frontierId === frontierId)
  if (!frontier || frontier.reasonCodes.length > 0 || frontier.stepIds.length === 0) {
    return undefined
  }

  const stepById = new Map(recipe.steps.map((step) => [step.stepId, step]))
  const steps = frontier.stepIds.flatMap((id) => {
    const step = stepById.get(id)
    return step ? [step] : []
  })
  if (steps.length !== frontier.stepIds.length) return undefined

  const requirementIds = new Set(
    steps.flatMap((step) =>
      step.kind === 'notebook-run' && step.environmentRequirementId
        ? [step.environmentRequirementId]
        : []
    )
  )
  const environmentRequirements = recipe.environmentRequirements.filter((requirement) =>
    requirementIds.has(requirement.requirementId)
  )
  if (environmentRequirements.length !== requirementIds.size) return undefined

  return { frontier, steps, environmentRequirements }
}

const prepareArtifactReproducibilityExecutionPlan = async (
  recipe: ArtifactReproducibilityRecipe,
  frontierId: string,
  storageRoot: string,
  signal?: AbortSignal
): Promise<ArtifactReproducibilityExecutionPlan> => {
  const plan = resolveArtifactReproducibilityExecutionPlan(recipe, frontierId)
  if (!plan) {
    throw new Error(`Artifact reproduction frontier is not executable: ${frontierId}`)
  }
  await validateFrozenFiles(plan.frontier.crossingFiles, storageRoot, signal)
  await validateEnvironmentRequirements(plan.environmentRequirements, storageRoot, signal)
  return plan
}

const validateArtifactReproducibilityRecipeStorage = async (
  recipe: ArtifactReproducibilityRecipe,
  storageRoot: string
): Promise<void> => {
  if (!artifactReproducibilityRecipeValue(recipe)) {
    throw new Error('Artifact reproduction recipe is invalid')
  }
  await validateFrozenFiles(
    recipe.frontiers.flatMap((frontier) => frontier.crossingFiles),
    storageRoot
  )
  await validateEnvironmentRequirements(recipe.environmentRequirements, storageRoot)
}

export {
  artifactReproducibilityRecipeMatchesSnapshot,
  artifactReproducibilityRecipeValue,
  prepareArtifactReproducibilityExecutionPlan,
  resolveArtifactReproducibilityExecutionPlan,
  sealArtifactReproducibilityRecipe,
  validateArtifactReproducibilityRecipeStorage
}
export type { ArtifactReproducibilityExecutionPlan, SealArtifactReproducibilityRecipeInput }
