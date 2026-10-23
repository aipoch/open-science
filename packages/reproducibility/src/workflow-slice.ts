import { lstat, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseNotebookEnvironmentLock } from '@aipoch/environment'
import { canonicalJson, sha256, type CanonicalJson } from './canonical'
import { notebookHelperEvidenceKey } from './helper-identity'
import { restoreRRandomState } from './r-random-replay'
import { validatePythonRandomState } from './python-random-replay'
import { notebookExecutionContextSchema } from './execution-context'
import { validRStageCheckpointForRun } from './r-stage-checkpoint'
import type {
  ArtifactHelperEvidenceStatus,
  ArtifactProvenanceGraphEntity,
  ArtifactProvenanceGraphReason,
  ArtifactReproducibilityEnvironmentRequirement,
  ArtifactReproducibilityRecipeFile,
  WorkflowCapture,
  WorkflowPlan,
  WorkflowSelection
} from './evidence'
import type { ReproductionEvidence, ReproductionRecipeOptions } from './ports'

const digest = (value: unknown): string => sha256(canonicalJson(value as CanonicalJson))
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
const checksum = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const unique = (values: string[]): boolean => new Set(values).size === values.length
const sorted = (values: string[]): string[] => [...new Set(values)].sort()
const portable = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  !/^[A-Za-z]:/u.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..')
const storageKey = (value: unknown): value is string => typeof value === 'string' && portable(value)
const size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const graphReasons = new Set<string>([
  'activity-evidence-unavailable',
  'activity-evidence-corrupt',
  'activity-evidence-partial',
  'target-generation-unavailable',
  'file-reads-unavailable',
  'writer-attribution-unavailable',
  'absolute-path-unfrozen',
  'kernel-epoch-unknown',
  'kernel-dependencies-unavailable',
  'kernel-epoch-conservative',
  'history-truncated',
  'graph-budget-exceeded',
  'dependency-cycle'
] satisfies ArtifactProvenanceGraphReason[])
// These describe capture-wide loss rather than a local activity barrier.
const globalGraphReasons = new Set<string>([
  'history-truncated',
  'graph-budget-exceeded',
  'dependency-cycle'
])
const graphReason = (value: unknown): value is ArtifactProvenanceGraphReason =>
  typeof value === 'string' && graphReasons.has(value)
const helperStatus = (value: unknown): value is ArtifactHelperEvidenceStatus =>
  object(value) &&
  (value.state === 'complete'
    ? Object.keys(value).length === 1
    : value.state === 'incomplete' &&
      Object.keys(value).every((key) => key === 'state' || key === 'reasons') &&
      Array.isArray(value.reasons) &&
      value.reasons.length > 0 &&
      unique(value.reasons) &&
      value.reasons.every((reason) =>
        ['source-missing', 'source-corrupt', 'payload-limit'].includes(String(reason))
      ))

// Captures can arrive from the host's VM realm. Require plain JSON records without
// requiring their Object.prototype to be the same instance as this package's.
const workflowJson = (
  value: unknown,
  omitUndefinedProperties = false,
  seen: Set<object> = new Set()
): boolean => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  const valid = Array.isArray(value)
    ? value.every((entry) => workflowJson(entry, omitUndefinedProperties, seen))
    : prototype !== null &&
      Object.getPrototypeOf(prototype) === null &&
      Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name === 'Object' &&
      Object.values(value).every(
        (entry) =>
          (omitUndefinedProperties && entry === undefined) ||
          workflowJson(entry, omitUndefinedProperties, seen)
      )
  seen.delete(value)
  return valid
}

export const validWorkflowCapture = (value: unknown): value is WorkflowCapture => {
  try {
    if (
      !workflowJson(value) ||
      !object(value) ||
      value.schemaVersion !== 1 ||
      !checksum(value.captureId) ||
      !Array.isArray(value.runs) ||
      !Array.isArray(value.inputFiles) ||
      !object(value.graph)
    )
      return false
    const allowed = new Set([
      'schemaVersion',
      'captureId',
      'runs',
      'inputFiles',
      'graph',
      'helperModules',
      'helperEvidenceStatus',
      'truncation',
      'activityReasonCodes'
    ])
    if (Object.keys(value).some((key) => !allowed.has(key))) return false
    const graph = value.graph
    const capturedRuns = value.runs
    if (
      graph.schemaVersion !== 1 ||
      !identity(graph.targetEntityId) ||
      !['complete', 'conservative', 'incomplete'].includes(String(graph.completeness)) ||
      !Array.isArray(graph.reasonCodes) ||
      !graph.reasonCodes.every(graphReason) ||
      !Array.isArray(graph.activities) ||
      !Array.isArray(graph.entities) ||
      !Array.isArray(graph.edges)
    )
      return false
    if (value.runs.length > 10000 || graph.activities.length > 20000 || graph.edges.length > 100000)
      return false
    if (
      !value.runs.every(
        (run) =>
          object(run) &&
          identity(run.runId) &&
          size(run.runIndex) &&
          typeof run.script === 'string' &&
          Array.isArray(run.inputFileVersionKeys) &&
          Array.isArray(run.outputs) &&
          ['python', 'r', 'bash', 'repl'].includes(String(run.kernelKind)) &&
          [
            'queued',
            'running',
            'completed',
            'failed',
            'timeout',
            'interrupted',
            'cancelled'
          ].includes(String(run.status)) &&
          (run.environmentLock === undefined ||
            (object(run.environmentLock) &&
              (run.environmentLock.state === 'unavailable' ||
                (['available', 'partial'].includes(String(run.environmentLock.state)) &&
                  checksum(run.environmentLock.lockChecksum)))))
      )
    )
      return false
    if (
      !unique(value.runs.map((run) => run.runId)) ||
      new Set(value.runs.map((run) => run.runIndex)).size !== value.runs.length
    )
      return false
    if (
      value.runs.some(
        (run) =>
          run.stageCheckpoint !== undefined &&
          (run.stageCheckpoint.state === 'available'
            ? !validRStageCheckpointForRun(run)
            : run.stageCheckpoint.state !== 'unavailable' ||
              typeof run.stageCheckpoint.reason !== 'string' ||
              !run.stageCheckpoint.reason ||
              run.stageCheckpoint.reason.length > 1024)
      )
    )
      return false
    if (
      !value.runs.every(
        (run) =>
          run.inputFileVersionKeys.every(
            (key: unknown) =>
              object(key) &&
              identity(key.inputFileVersionId) &&
              ['upload-version', 'artifact-version'].includes(String(key.sourceKind))
          ) &&
          (run.executionContext === undefined ||
            notebookExecutionContextSchema.safeParse(run.executionContext).success) &&
          (run.helperModuleKeys === undefined ||
            (Array.isArray(run.helperModuleKeys) && run.helperModuleKeys.every(identity)))
      )
    )
      return false
    if (
      !graph.activities.every(
        (activity) =>
          object(activity) &&
          identity(activity.activityId) &&
          size(activity.sequence) &&
          ['notebook-run', 'compute-job', 'artifact-publication'].includes(String(activity.kind)) &&
          ['available', 'partial', 'unavailable'].includes(String(activity.evidenceState)) &&
          (activity.kind === 'artifact-publication' || activity.inclusion === 'workflow-capture')
      )
    )
      return false
    if (!unique(graph.activities.map((activity) => activity.activityId))) return false
    if (
      !graph.activities
        .filter((activity) => activity.kind === 'notebook-run')
        .every((activity) => {
          const run = capturedRuns.find((candidate) => candidate.runId === activity.activityId)
          return (
            run &&
            activity.runIndex === run.runIndex &&
            (activity.kernelEpochId === undefined || activity.kernelEpochId === run.kernelEpochId)
          )
        })
    )
      return false
    if (
      JSON.stringify(sorted(value.runs.map((run) => run.runId))) !==
      JSON.stringify(
        sorted(
          graph.activities
            .filter((activity) => activity.kind === 'notebook-run')
            .map((activity) => activity.activityId)
        )
      )
    )
      return false
    if (
      value.activityReasonCodes !== undefined &&
      (!object(value.activityReasonCodes) ||
        Object.keys(value.activityReasonCodes).length !== capturedRuns.length ||
        !Object.entries(value.activityReasonCodes).every(
          ([id, reasons]) =>
            capturedRuns.some((run) => run.runId === id) &&
            Array.isArray(reasons) &&
            reasons.every(graphReason)
        ))
    )
      return false
    if (object(value.activityReasonCodes)) {
      const localReasons = new Set(
        Object.values(value.activityReasonCodes).flat() as ArtifactProvenanceGraphReason[]
      )
      const aggregateReasons = graph.reasonCodes
      if (
        aggregateReasons.some(
          (reason) => !globalGraphReasons.has(reason) && !localReasons.has(reason)
        ) ||
        [...localReasons].some((reason) => !aggregateReasons.includes(reason))
      )
        return false
    }
    if (
      !graph.entities.every(
        (entity) =>
          object(entity) &&
          identity(entity.entityId) &&
          checksum(entity.checksum) &&
          size(entity.sizeBytes) &&
          (entity.kind === 'file-generation'
            ? identity(entity.generationId) &&
              typeof entity.relativePath === 'string' &&
              ['relative', 'absolute'].includes(String(entity.pathPortability)) &&
              storageKey(entity.contentStorageKey)
            : entity.kind === 'registered-input-generation'
              ? identity(entity.inputFileVersionId) &&
                identity(entity.filename) &&
                ['upload-version', 'artifact-version'].includes(String(entity.sourceKind))
              : entity.kind === 'artifact-version' && identity(entity.versionId))
      )
    )
      return false
    if (!unique(graph.entities.map((entity) => entity.entityId))) return false
    const activities = new Set(graph.activities.map((activity) => activity.activityId))
    const entities = new Set(graph.entities.map((entity) => entity.entityId))
    if (
      !graph.edges.every(
        (edge) =>
          object(edge) &&
          activities.has(edge.activityId) &&
          ['authoritative', 'advisory'].includes(String(edge.authority)) &&
          identity(edge.evidenceSource) &&
          (edge.kind === 'depends-on'
            ? activities.has(edge.dependencyActivityId)
            : ['used', 'generated'].includes(String(edge.kind)) && entities.has(edge.entityId))
      )
    )
      return false
    const edgeIds = graph.edges.map(
      (edge) =>
        `${edge.kind}\0${edge.activityId}\0${edge.kind === 'depends-on' ? edge.dependencyActivityId : edge.entityId}`
    )
    if (!unique(edgeIds)) return false
    if (
      graph.outputGroups !== undefined &&
      (!Array.isArray(graph.outputGroups) ||
        !graph.outputGroups.every(
          (group) =>
            object(group) &&
            identity(group.outputId) &&
            activities.has(group.activityId) &&
            Array.isArray(group.memberEntityIds) &&
            group.memberEntityIds.every((id) => entities.has(id))
        ))
    )
      return false
    if (
      !value.inputFiles.every(
        (input) =>
          object(input) &&
          identity(input.inputFileVersionId) &&
          identity(input.filename) &&
          checksum(input.checksum) &&
          size(input.sizeBytes) &&
          storageKey(input.storageKey) &&
          ['upload-version', 'artifact-version'].includes(String(input.sourceKind))
      )
    )
      return false
    const inputIdentity = (input: { sourceKind: unknown; inputFileVersionId: unknown }): string =>
      JSON.stringify([input.sourceKind, input.inputFileVersionId])
    if (!unique(value.inputFiles.map(inputIdentity))) return false
    const inputsById = new Map(value.inputFiles.map((input) => [inputIdentity(input), input]))
    if (
      !value.runs.every((run) =>
        run.inputFileVersionKeys.every(
          (key: { sourceKind: unknown; inputFileVersionId: unknown }) =>
            inputsById.has(inputIdentity(key))
        )
      )
    )
      return false
    if (
      !graph.entities
        .filter((entity) => entity.kind === 'registered-input-generation')
        .every((entity) => {
          const input = inputsById.get(inputIdentity(entity))
          return (
            input &&
            input.checksum === entity.checksum &&
            input.sizeBytes === entity.sizeBytes &&
            input.filename === entity.filename
          )
        })
    )
      return false
    if (
      value.helperModules !== undefined &&
      (!Array.isArray(value.helperModules) ||
        !value.helperModules.every(
          (helper) =>
            object(helper) &&
            identity(helper.helperId) &&
            identity(helper.skillIdentity) &&
            identity(helper.registeredGeneration) &&
            typeof helper.source === 'string' &&
            checksum(helper.sourceDigest) &&
            sha256(helper.source) === helper.sourceDigest &&
            Array.isArray(helper.exports) &&
            helper.exports.every(identity)
        ))
    )
      return false
    if (value.helperEvidenceStatus !== undefined && !helperStatus(value.helperEvidenceStatus))
      return false
    // Scope is authoritative only when every run has a valid status and the aggregate
    // still accounts for every failure. Older captures retain their global barrier.
    if (value.runs.some((run) => run.helperEvidenceStatus !== undefined)) {
      if (!value.runs.every((run) => helperStatus(run.helperEvidenceStatus))) return false
      const localReasons = sorted(
        value.runs.flatMap((run) =>
          run.helperEvidenceStatus.state === 'incomplete' ? run.helperEvidenceStatus.reasons : []
        )
      )
      const aggregateReasons =
        value.helperEvidenceStatus?.state === 'incomplete'
          ? sorted(value.helperEvidenceStatus.reasons)
          : []
      if (digest(localReasons) !== digest(aggregateReasons)) return false
    }
    if (
      value.truncation !== undefined &&
      (!object(value.truncation) ||
        value.truncation.reason !== 'payload-limit' ||
        !size(value.truncation.omittedLeadingRunCount) ||
        !size(value.truncation.omittedInputCount) ||
        !size(value.truncation.omittedOutputCount))
    )
      return false
    const { captureId, ...draft } = value
    return digest(draft) === captureId
  } catch {
    return false
  }
}

export const sealWorkflowCapture = (draft: Omit<WorkflowCapture, 'captureId'>): WorkflowCapture => {
  if (!workflowJson(draft, true)) throw new Error('Invalid Workflow capture')
  // Optional undefined host fields are omitted exactly as in the persisted JSON.
  const normalized = JSON.parse(canonicalJson(draft as unknown as CanonicalJson))
  const capture = { ...normalized, captureId: digest(normalized) }
  if (!validWorkflowCapture(capture)) throw new Error('Invalid Workflow capture.')
  return capture
}

export const createWorkflowSlices = (
  options: ReproductionRecipeOptions
): {
  planWorkflowSlice(capture: WorkflowCapture, selection: WorkflowSelection): WorkflowPlan
  workflowPlanMatchesCapture(capture: WorkflowCapture, plan: WorkflowPlan): boolean
  prepareWorkflowSlice(
    capture: WorkflowCapture,
    plan: WorkflowPlan,
    evidence: ReproductionEvidence,
    signal?: AbortSignal
  ): Promise<WorkflowPlan>
} => {
  const planWorkflowSlice = (
    capture: WorkflowCapture,
    selection: WorkflowSelection
  ): WorkflowPlan => {
    if (!validWorkflowCapture(capture)) throw new Error('Invalid Workflow capture.')
    if (
      !selection ||
      !identity(selection.captureId) ||
      !Array.isArray(selection.targetRunIds) ||
      !selection.targetRunIds.every(identity) ||
      (selection.independent !== undefined && selection.independent !== true) ||
      (selection.boundaryEntityIds !== undefined &&
        (!Array.isArray(selection.boundaryEntityIds) ||
          !selection.boundaryEntityIds.every(identity)))
    )
      throw new Error('Invalid Workflow selection.')
    const reasons = new Set<string>()
    if (selection.captureId !== capture.captureId) reasons.add('capture-identity-mismatch')
    if (!selection.targetRunIds.length || !unique(selection.targetRunIds))
      reasons.add('invalid-target-selection')
    if (!unique(selection.boundaryEntityIds ?? [])) reasons.add('duplicate-boundary-selection')
    if (
      capture.graph.reasonCodes.some((reason) => globalGraphReasons.has(reason)) ||
      (capture.graph.completeness !== 'complete' && capture.graph.reasonCodes.length === 0) ||
      (!capture.activityReasonCodes &&
        (capture.graph.completeness !== 'complete' || capture.graph.reasonCodes.length > 0)) ||
      (capture.truncation?.omittedLeadingRunCount ?? 0) > 0 ||
      (capture.truncation?.omittedInputCount ?? 0) > 0
    )
      reasons.add('workflow-evidence-incomplete')
    const normalized: WorkflowSelection = {
      ...(selection.independent ? { independent: true } : {}),
      captureId: selection.captureId,
      targetRunIds: sorted(selection.targetRunIds),
      ...(selection.boundaryEntityIds?.length
        ? { boundaryEntityIds: sorted(selection.boundaryEntityIds) }
        : {})
    }
    const runs = new Map(capture.runs.map((run) => [run.runId, run]))
    const activities = new Map(
      capture.graph.activities.map((activity) => [activity.activityId, activity])
    )
    const entities = new Map(capture.graph.entities.map((entity) => [entity.entityId, entity]))
    const boundaries = new Set(normalized.boundaryEntityIds ?? [])
    const targets = new Set(normalized.targetRunIds)
    for (const target of targets)
      if (!runs.has(target) || activities.get(target)?.kind !== 'notebook-run')
        reasons.add('unknown-target-run')
    for (const boundary of boundaries)
      if (!entities.has(boundary) || entities.get(boundary)?.kind === 'artifact-version')
        reasons.add('unknown-boundary-entity')
    const writers = new Map<string, string[]>()
    const edgesByActivity = new Map<string, typeof capture.graph.edges>()
    for (const edge of capture.graph.edges) {
      edgesByActivity.set(edge.activityId, [...(edgesByActivity.get(edge.activityId) ?? []), edge])
      if (edge.kind === 'generated')
        writers.set(edge.entityId, [...(writers.get(edge.entityId) ?? []), edge.activityId])
    }
    const requiredInputs = new Set<string>()
    const usedBoundaries = new Set<string>()
    const selected = new Set<string>()
    const visiting = new Set<string>()
    const visit = (activityId: string): void => {
      if (visiting.size >= 512) {
        reasons.add('dependency-depth-exceeded')
        return
      }
      if (visiting.has(activityId)) {
        reasons.add('dependency-cycle')
        return
      }
      if (selected.has(activityId)) return
      const activity = activities.get(activityId)
      if (!activity || activity.kind !== 'notebook-run' || !runs.has(activityId)) {
        reasons.add('required-run-unavailable')
        return
      }
      visiting.add(activityId)
      const checkpointed = validRStageCheckpointForRun(runs.get(activityId)!)
      if (selection.independent && !checkpointed) reasons.add('stage-checkpoint-unavailable')
      for (const edge of edgesByActivity.get(activityId) ?? []) {
        if (edge.kind === 'generated') continue
        // A sealed pre-execution object boundary replaces memory ancestors, never file evidence.
        if (checkpointed && edge.kind === 'depends-on') continue
        if (edge.authority !== 'authoritative' || edge.evidenceSource === 'conservative-fallback')
          reasons.add('advisory-dependency')
        if (edge.kind === 'depends-on') {
          const upstream = activities.get(edge.dependencyActivityId)
          const before = runs.get(edge.dependencyActivityId)
          const after = runs.get(activityId)!
          if (!upstream || upstream.sequence >= activity.sequence)
            reasons.add('invalid-dependency-order')
          if (
            !before?.kernelEpochId ||
            before.kernelEpochId !== after.kernelEpochId ||
            before.kernelKind !== after.kernelKind
          )
            reasons.add('unrestorable-kernel-dependency')
          visit(edge.dependencyActivityId)
          continue
        }
        const entity = entities.get(edge.entityId)!
        if (entity.kind === 'file-generation' && (writers.get(entity.entityId)?.length ?? 0) > 1)
          reasons.add('ambiguous-generation-producer')
        if (entity.kind === 'registered-input-generation') {
          requiredInputs.add(entity.entityId)
          if (boundaries.has(entity.entityId)) usedBoundaries.add(entity.entityId)
          continue
        }
        if (
          boundaries.has(entity.entityId) ||
          (checkpointed && !(writers.get(entity.entityId) ?? []).some((id) => targets.has(id)))
        ) {
          requiredInputs.add(entity.entityId)
          if (boundaries.has(entity.entityId)) usedBoundaries.add(entity.entityId)
          continue
        }
        const producerIds = writers.get(entity.entityId) ?? []
        if (entity.kind !== 'file-generation' || producerIds.length !== 1) {
          reasons.add('file-boundary-required')
          continue
        }
        if ((activities.get(producerIds[0]!)?.sequence ?? Infinity) >= activity.sequence)
          reasons.add('invalid-dependency-order')
        visit(producerIds[0]!)
      }
      visiting.delete(activityId)
      selected.add(activityId)
    }
    for (const target of targets) visit(target)
    for (const group of capture.graph.outputGroups ?? []) {
      if (
        group.memberEntityIds.some((id) => boundaries.has(id)) &&
        !group.memberEntityIds.every((id) => boundaries.has(id))
      )
        reasons.add('incomplete-output-group-boundary')
      if (
        group.memberEntityIds.some((id) => usedBoundaries.has(id)) &&
        group.memberEntityIds.every((id) => boundaries.has(id))
      ) {
        for (const id of group.memberEntityIds) {
          requiredInputs.add(id)
          usedBoundaries.add(id)
        }
      }
    }
    for (const boundary of boundaries)
      if (!usedBoundaries.has(boundary)) reasons.add('unused-boundary-selection')

    const crossingFiles: ArtifactReproducibilityRecipeFile[] = []
    for (const entityId of sorted([...requiredInputs])) {
      const entity = entities.get(entityId)!
      if (entity.kind === 'file-generation') {
        if (entity.pathPortability !== 'relative' || !portable(entity.relativePath)) {
          reasons.add('absolute-read-remapping-required')
          continue
        }
        crossingFiles.push({
          entityId,
          checksum: entity.checksum,
          sizeBytes: entity.sizeBytes,
          contentStorageKey: entity.contentStorageKey,
          materializationPath: entity.relativePath
        })
      } else if (entity.kind === 'registered-input-generation') {
        const inputs = capture.inputFiles.filter(
          (input) =>
            input.sourceKind === entity.sourceKind &&
            input.inputFileVersionId === entity.inputFileVersionId &&
            input.checksum === entity.checksum &&
            input.sizeBytes === entity.sizeBytes
        )
        if (inputs.length !== 1) {
          reasons.add('crossing-entity-unavailable')
          continue
        }
        const materializationPath = options.inputPath(entity.filename, entity.checksum)
        if (!portable(materializationPath)) {
          reasons.add('unsafe-input-path')
          continue
        }
        crossingFiles.push({
          entityId,
          checksum: entity.checksum,
          sizeBytes: entity.sizeBytes,
          contentStorageKey: inputs[0]!.storageKey,
          materializationPath
        })
      } else reasons.add('crossing-entity-unavailable')
    }
    const destinations = new Set<string>()
    const destination = (entity: ArtifactProvenanceGraphEntity, path: string): string => {
      const value = entity.kind === 'registered-input-generation' ? `data/${path}` : path
      return process.platform === 'win32' ? value.toLowerCase() : value
    }
    for (const file of crossingFiles) {
      const path = destination(entities.get(file.entityId)!, file.materializationPath)
      if (destinations.has(path)) reasons.add('materialization-path-conflict')
      destinations.add(path)
    }
    const inputDestinations = new Map(
      crossingFiles.map((file) => [
        file.entityId,
        destination(entities.get(file.entityId)!, file.materializationPath)
      ])
    )
    const currentGenerations = new Map(
      crossingFiles.map((file) => [inputDestinations.get(file.entityId)!, file.entityId])
    )
    const requirements = new Map<string, ArtifactReproducibilityEnvironmentRequirement>()
    const epochs = new Map<string, string>()
    const helpers = new Map(
      (capture.helperModules ?? []).map((helper) => [notebookHelperEvidenceKey(helper), helper])
    )
    const targetOutputEntityIds: string[] = []
    const executionOnlyTargetRunIds = sorted(
      [...targets].filter(
        (id) =>
          !validRStageCheckpointForRun(runs.get(id)!) &&
          !(edgesByActivity.get(id) ?? []).some(
            (edge) =>
              edge.kind === 'generated' && entities.get(edge.entityId)?.kind === 'file-generation'
          )
      )
    )
    const sequences = new Set<number>()
    const steps: WorkflowPlan['steps'] = []
    const stateComparisonRunIds: string[] = []
    const stageRestoreRunIds: string[] = []
    const stageSupplementNames: Record<string, string[]> = {}
    let availableStageNames = new Set<string>()
    for (const activityId of [...selected].sort(
      (a, b) => activities.get(a)!.sequence - activities.get(b)!.sequence
    )) {
      const run = runs.get(activityId)!
      const activity = activities.get(activityId)!
      const checkpointed = validRStageCheckpointForRun(run)
      if (checkpointed) {
        stateComparisonRunIds.push(run.runId)
        const position = capture.runs.findIndex((candidate) => candidate.runId === run.runId)
        const previous = capture.runs[position - 1]
        if (
          !previous ||
          !selected.has(previous.runId) ||
          previous.kernelEpochId !== run.kernelEpochId ||
          !validRStageCheckpointForRun(previous)
        ) {
          stageRestoreRunIds.push(run.runId)
          availableStageNames = new Set(
            run.stageCheckpoint?.state === 'available' ? run.stageCheckpoint.inputNames : []
          )
        } else if (run.stageCheckpoint?.state === 'available') {
          const missing = run.stageCheckpoint.inputNames.filter(
            (name) => !availableStageNames.has(name)
          )
          if (missing.length) stageSupplementNames[run.runId] = sorted(missing)
          for (const name of missing) availableStageNames.add(name)
        }
        if (run.stageCheckpoint?.state === 'available')
          for (const name of run.stageCheckpoint.outputNames) availableStageNames.add(name)
      }
      for (const reason of capture.activityReasonCodes?.[activityId] ?? []) {
        if (
          checkpointed &&
          ['kernel-dependencies-unavailable', 'kernel-epoch-conservative'].includes(reason)
        )
          continue
        reasons.add(reason)
      }
      if (sequences.has(activity.sequence)) reasons.add('ambiguous-activity-order')
      sequences.add(activity.sequence)
      if (activity.evidenceState !== 'available') reasons.add('activity-evidence-not-complete')
      if (run.status !== 'completed') reasons.add('required-run-not-completed')
      if (run.scriptTruncated || run.hasOmittedFiles || run.hasOmittedInputs)
        reasons.add('execution-evidence-truncated')
      if (run.kernelKind !== 'python' && run.kernelKind !== 'r') {
        reasons.add('unsupported-kernel-kind')
        continue
      }
      if ((run.helperEvidenceStatus ?? capture.helperEvidenceStatus)?.state === 'incomplete')
        reasons.add('helper-source-incomplete')
      for (const key of run.helperModuleKeys ?? []) {
        const helper = helpers.get(key)
        if (!helper || sha256(helper.source) !== helper.sourceDigest)
          reasons.add('helper-source-incomplete')
      }
      const lock = run.environmentLock
      let environmentRequirementId: string | undefined
      if (!lock || lock.state !== 'available') reasons.add('environment-lock-unavailable')
      else {
        environmentRequirementId = `environment-lock:${lock.lockChecksum}`
        const requirement: ArtifactReproducibilityEnvironmentRequirement = {
          requirementId: environmentRequirementId,
          kernelKind: run.kernelKind,
          ...(run.environmentName ? { environmentName: run.environmentName } : {}),
          lockChecksum: lock.lockChecksum,
          lockState: 'available'
        }
        const previous = requirements.get(environmentRequirementId)
        if (previous && digest(previous) !== digest(requirement))
          reasons.add('environment-identity-conflict')
        requirements.set(environmentRequirementId, requirement)
        const epoch = `${run.kernelKind}\0${run.kernelEpochId ?? run.runId}`
        if (epochs.has(epoch) && epochs.get(epoch) !== lock.lockChecksum)
          reasons.add('environment-transition')
        epochs.set(epoch, lock.lockChecksum)
      }
      const inputs: string[] = [],
        outputs: string[] = []
      for (const edge of edgesByActivity.get(activityId) ?? []) {
        if (edge.kind === 'depends-on') continue
        if (edge.pathPortability === 'absolute') reasons.add('absolute-path-not-isolated')
        if (edge.kind === 'used') inputs.push(edge.entityId)
        else {
          const entity = entities.get(edge.entityId)!
          if (entity.kind !== 'file-generation') continue
          if (entity.pathPortability !== 'relative' || !portable(entity.relativePath))
            reasons.add('absolute-write-not-isolated')
          outputs.push(entity.entityId)
          if (targets.has(activityId)) targetOutputEntityIds.push(entity.entityId)
        }
      }
      // Frozen bytes initialize the workspace, then each selected run consumes the
      // generation visible before it writes. A consumer may transform its own copy,
      // but an earlier selected writer must not replace another consumer's input.
      for (const entityId of inputs) {
        const entity = entities.get(entityId)!
        const path =
          entity.kind === 'file-generation'
            ? destination(entity, entity.relativePath)
            : inputDestinations.get(entityId)
        if (path === undefined || currentGenerations.get(path) !== entityId)
          reasons.add('materialization-path-conflict')
      }
      const writtenPaths = new Set<string>()
      for (const entityId of outputs) {
        const entity = entities.get(entityId)!
        if (entity.kind !== 'file-generation') continue
        const path = destination(entity, entity.relativePath)
        // A run's graph has no ordering for multiple generations at one path.
        if (writtenPaths.has(path)) reasons.add('materialization-path-conflict')
        writtenPaths.add(path)
        currentGenerations.set(path, entityId)
      }
      steps.push({
        kind: 'notebook-run',
        stepId: `step:${run.runId}`,
        activityId,
        sequence: activity.sequence,
        runId: run.runId,
        runIndex: run.runIndex,
        kernelKind: run.kernelKind,
        sourceChecksum: sha256(run.script),
        ...(environmentRequirementId ? { environmentRequirementId } : {}),
        inputEntityIds: sorted(inputs),
        outputEntityIds: sorted(outputs)
      })
    }
    const draft: Omit<WorkflowPlan, 'planId'> = {
      schemaVersion: 1,
      captureId: capture.captureId,
      selection: normalized,
      selectedStepIds: steps.map((step) => step.stepId),
      steps,
      crossingFiles,
      targetOutputEntityIds: sorted(targetOutputEntityIds),
      executionOnlyTargetRunIds,
      ...(stateComparisonRunIds.length
        ? {
            stateComparisonRunIds,
            stageRestoreRunIds,
            ...(Object.keys(stageSupplementNames).length ? { stageSupplementNames } : {})
          }
        : {}),
      environmentRequirements: [...requirements.values()].sort((a, b) =>
        a.requirementId.localeCompare(b.requirementId)
      ),
      verification: executionOnlyTargetRunIds.length
        ? 'execution-only'
        : stateComparisonRunIds.length
          ? 'state-comparison'
          : targetOutputEntityIds.length
            ? 'file-comparison'
            : 'execution-only',
      status: reasons.size ? 'blocked' : 'ready',
      reasonCodes: sorted([...reasons])
    }
    return { ...draft, planId: digest(draft) }
  }

  const workflowPlanMatchesCapture = (capture: WorkflowCapture, plan: WorkflowPlan): boolean => {
    try {
      return (
        workflowJson(plan) &&
        canonicalJson(plan as unknown as CanonicalJson) ===
          canonicalJson(planWorkflowSlice(capture, plan.selection) as unknown as CanonicalJson)
      )
    } catch {
      return false
    }
  }
  const prepareWorkflowSlice = async (
    capture: WorkflowCapture,
    plan: WorkflowPlan,
    evidence: ReproductionEvidence,
    signal?: AbortSignal
  ): Promise<WorkflowPlan> => {
    signal?.throwIfAborted()
    if (!workflowPlanMatchesCapture(capture, plan))
      throw new Error('Workflow plan does not match its capture.')
    if (plan.status !== 'ready')
      throw new Error(`Workflow slice is blocked: ${plan.reasonCodes.join(', ')}`)
    const disk = await statfs(tmpdir()).catch(() => undefined)
    const checkpointBytes = (plan.stateComparisonRunIds ?? []).reduce((sum, runId) => {
      const checkpoint = capture.runs.find((run) => run.runId === runId)?.stageCheckpoint
      return (
        sum +
        (checkpoint?.state === 'available'
          ? checkpoint.input.sizeBytes + checkpoint.output.sizeBytes
          : 0)
      )
    }, 0)
    if (
      disk &&
      disk.bavail * disk.bsize <
        plan.crossingFiles.reduce((sum, file) => sum + file.sizeBytes, 0) +
          checkpointBytes +
          64 * 1024 * 1024
    )
      throw new Error('Workflow reproduction has insufficient disk space.')
    for (const file of plan.crossingFiles) {
      signal?.throwIfAborted()
      const path = evidence.resolveFile(file.contentStorageKey)
      const metadata = await lstat(path).catch(() => undefined)
      if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== file.sizeBytes)
        throw new Error(`Workflow frozen file is unavailable: ${file.entityId}`)
      const actual = await options.fileIO.digestFile(path, file.sizeBytes, signal)
      if (actual.checksum !== file.checksum || actual.sizeBytes !== file.sizeBytes)
        throw new Error(`Workflow frozen file checksum mismatch: ${file.entityId}`)
    }
    for (const requirement of plan.environmentRequirements) {
      signal?.throwIfAborted()
      const serialized = await evidence.readEnvironmentLock(requirement.lockChecksum, signal)
      if (!serialized || sha256(serialized) !== requirement.lockChecksum)
        throw new Error('Workflow environment lock checksum mismatch.')
      const lock = parseNotebookEnvironmentLock(serialized)
      if (
        lock.kernelKind !== requirement.kernelKind ||
        (requirement.environmentName !== undefined &&
          lock.environmentName !== requirement.environmentName)
      )
        throw new Error('Workflow environment lock identity mismatch.')
    }
    for (const step of plan.steps) {
      const run = capture.runs.find((candidate) => candidate.runId === step.runId)!
      if (plan.stateComparisonRunIds?.includes(run.runId)) {
        if (!validRStageCheckpointForRun(run) || run.stageCheckpoint?.state !== 'available')
          throw new Error('Workflow state checkpoint identity mismatch.')
        for (const file of [run.stageCheckpoint.input, run.stageCheckpoint.output]) {
          const path = evidence.resolveFile(file.storageKey)
          const metadata = await lstat(path).catch(() => undefined)
          if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== file.sizeBytes)
            throw new Error('Workflow state checkpoint is unavailable.')
          const actual = await options.fileIO.digestFile(path, file.sizeBytes, signal)
          if (actual.checksum !== file.checksum || actual.sizeBytes !== file.sizeBytes)
            throw new Error('Workflow state checkpoint checksum mismatch.')
        }
      }
      if (run.kernelKind === 'r') restoreRRandomState('', run.executionContext?.before.rRandomState)
      if (run.kernelKind === 'python')
        validatePythonRandomState(run.executionContext?.before.pythonRandomState)
    }
    return structuredClone(plan)
  }
  return { planWorkflowSlice, workflowPlanMatchesCapture, prepareWorkflowSlice }
}
