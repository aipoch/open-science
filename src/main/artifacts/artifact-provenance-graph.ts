import type {
  ArtifactProvenanceGraph,
  ArtifactProvenanceGraphActivity,
  ArtifactProvenanceGraphEdge,
  ArtifactProvenanceGraphEntity,
  ArtifactProvenanceGraphOutputGroup,
  ArtifactProvenanceGraphReason
} from '../../shared/artifact-provenance'
import {
  hasImmutableExecutionFileEvidenceReference,
  type ExecutionFileEvidenceSummary,
  type ScientificOutputEvidence,
  type ScientificOutputRisk
} from '../../shared/execution-file-evidence'
import type { NotebookRunInputFile, NotebookRunRecord } from '../../shared/notebook'
import type { NotebookDependencyProjection } from '../notebook/dependency-analysis'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_GRAPH_BYTES = 1024 * 1024
const MAX_GRAPH_ACTIVITIES = 256
const MAX_GRAPH_EDGES = 4096
const MAX_GRAPH_OUTPUT_GROUPS = 1024
const GRAPH_REASONS = new Set<ArtifactProvenanceGraphReason>([
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
])
const EXECUTION_FILE_EVIDENCE_REASONS = new Set<
  ExecutionFileEvidenceSummary['reasonCodes'][number]
>([
  'file-reads-not-observed',
  'initial-file-generations-not-captured',
  'external-paths-not-observed',
  'remote-outputs-not-observed',
  'transient-files-not-captured',
  'delayed-writes-not-observed',
  'writer-not-isolated',
  'watcher-unavailable',
  'observation-not-started',
  'observer-conflict',
  'observer-limit-exceeded',
  'observer-failed',
  'generation-budget-exceeded',
  'generation-freeze-failed',
  'evidence-persistence-failed',
  'activity-identity-missing',
  'remote-input-generation-not-captured',
  'remote-output-not-harvested',
  'harvest-incomplete',
  'compute-activity-lineage-missing',
  'dynamic-path-unresolved',
  'absolute-path-not-frozen',
  'source-analysis-unsupported-call'
])
const SCIENTIFIC_OUTPUT_RISKS = new Set<ScientificOutputRisk>([
  'format-validity-not-verified',
  'multi-file-consistency-not-verified',
  'database-state-not-verified',
  'runtime-dependent-serialization'
])

type FileGeneration = Extract<ArtifactProvenanceGraphEntity, { kind: 'file-generation' }>
type EntityGraphEdge = Exclude<ArtifactProvenanceGraphEdge, { kind: 'depends-on' }>
type EvidenceRelationKind =
  | 'present-before'
  | 'staged-input'
  | 'created'
  | 'modified'
  | 'deleted'
  | 'harvested-output'
  | 'remote-input-reference'

type EvidenceRelation = {
  relation: EvidenceRelationKind
  relativePath: string
  pathPortability: 'relative' | 'absolute'
  authority: 'advisory' | 'explicit-transfer'
  generation?: FileGeneration
  previousGenerationId?: string
  registeredInput?: {
    sourceKind: NotebookRunInputFile['sourceKind']
    inputFileVersionId: string
    checksum: string
  }
}

type DecodedActivityEvidence = {
  state: ExecutionFileEvidenceSummary['state']
  evidenceId?: string
  checksum?: string
  fileReads: ExecutionFileEvidenceSummary['fileReads']
  writerAttribution: ExecutionFileEvidenceSummary['writerAttribution']
  reasonCodes: ExecutionFileEvidenceSummary['reasonCodes']
  relations: EvidenceRelation[]
  scientificOutputs: ScientificOutputEvidence[]
  failure?: 'unavailable' | 'corrupt'
}

type ArtifactProvenanceNotebookActivityInput = {
  run: NotebookRunRecord
  runIndex: number
  evidenceJson?: string
}

type ArtifactProvenanceComputeActivityInput = {
  activityId: string
  parentActivityId?: string
  ordinal: number
  fileEvidence?: ExecutionFileEvidenceSummary
  evidenceJson?: string
}

type SealArtifactProvenanceGraphInput = {
  target: {
    versionId: string
    filename: string
    checksum: string
    sizeBytes: number
    producerRunId: string
    sourceGenerationId?: string
  }
  notebookActivities: ArtifactProvenanceNotebookActivityInput[]
  computeActivities: ArtifactProvenanceComputeActivityInput[]
  notebookDependencies?: NotebookDependencyProjection
  omittedLeadingActivityCount?: number
}

type CandidateActivity = {
  activity: ArtifactProvenanceGraphActivity
  notebookRun?: NotebookRunRecord
  decodedEvidence: DecodedActivityEvidence
  inputs: NotebookRunInputFile[]
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const exactFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => {
  const allowed = new Set(fields)
  return Object.keys(value).every((field) => allowed.has(field))
}

const hasExactlyFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).length === fields.length && exactFields(value, fields)

const isLegacyNotebookStorageKey = (value: string, activityId: string): boolean =>
  validStorageKey(value) &&
  (value.startsWith('notebook-file-evidence/') || value.startsWith('file-evidence/')) &&
  value.endsWith(`/run-${activityId}/evidence.json`)

const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const scientificOutputValue = (value: unknown): ScientificOutputEvidence | undefined => {
  const output = recordValue(value)
  if (
    !output ||
    !exactFields(output, [
      'outputId',
      'storageShape',
      'formatHint',
      'classificationAuthority',
      'members',
      'riskCodes'
    ]) ||
    typeof output.outputId !== 'string' ||
    output.outputId.length === 0 ||
    !['single-file', 'file-set', 'directory-tree'].includes(String(output.storageShape)) ||
    (output.formatHint !== undefined &&
      (typeof output.formatHint !== 'string' || output.formatHint.length === 0)) ||
    output.classificationAuthority !== 'path-heuristic' ||
    !stringArray(output.members) ||
    output.members.length === 0 ||
    new Set(output.members).size !== output.members.length ||
    output.members.some((member) => member.length === 0) ||
    !stringArray(output.riskCodes) ||
    output.riskCodes.some((risk) => !SCIENTIFIC_OUTPUT_RISKS.has(risk as ScientificOutputRisk)) ||
    new Set(output.riskCodes).size !== output.riskCodes.length
  ) {
    return undefined
  }
  return output as ScientificOutputEvidence
}

const sameStrings = (left: string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

const validStorageKey = (value: string, checksum?: string): boolean => {
  if (!value || value.includes('\\') || value.startsWith('/')) return false
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  return checksum === undefined || value.endsWith(`/blobs/sha256-${checksum}`)
}

const generationValue = (value: unknown): FileGeneration | undefined => {
  const generation = recordValue(value)
  if (
    !generation ||
    !exactFields(generation, [
      'generationId',
      'relativePath',
      'checksum',
      'sizeBytes',
      'contentStorageKey',
      'capturedAt'
    ]) ||
    typeof generation.generationId !== 'string' ||
    typeof generation.relativePath !== 'string' ||
    typeof generation.checksum !== 'string' ||
    !SHA256_PATTERN.test(generation.checksum) ||
    !safeInteger(generation.sizeBytes) ||
    typeof generation.contentStorageKey !== 'string' ||
    !validStorageKey(generation.contentStorageKey, generation.checksum) ||
    typeof generation.capturedAt !== 'string'
  ) {
    return undefined
  }
  return {
    entityId: `file-generation:${generation.generationId}`,
    kind: 'file-generation',
    generationId: generation.generationId,
    relativePath: generation.relativePath,
    pathPortability: 'relative',
    checksum: generation.checksum,
    sizeBytes: generation.sizeBytes,
    contentStorageKey: generation.contentStorageKey
  }
}

const relationValue = (value: unknown): EvidenceRelation | undefined => {
  const relation = recordValue(value)
  const relationKinds = new Set<EvidenceRelationKind>([
    'present-before',
    'staged-input',
    'created',
    'modified',
    'deleted',
    'harvested-output',
    'remote-input-reference'
  ])
  if (
    !relation ||
    !exactFields(relation, [
      'relation',
      'relativePath',
      'pathPortability',
      'authority',
      'before',
      'previousGenerationId',
      'previousReasonCode',
      'generation',
      'reasonCode',
      'registeredInput'
    ]) ||
    typeof relation.relation !== 'string' ||
    !relationKinds.has(relation.relation as EvidenceRelationKind) ||
    typeof relation.relativePath !== 'string' ||
    relation.relativePath.length === 0 ||
    (relation.pathPortability !== 'relative' && relation.pathPortability !== 'absolute') ||
    (relation.authority !== 'advisory' && relation.authority !== 'explicit-transfer') ||
    (relation.previousGenerationId !== undefined &&
      typeof relation.previousGenerationId !== 'string')
  ) {
    return undefined
  }
  const generation =
    relation.generation === undefined ? undefined : generationValue(relation.generation)
  if (relation.generation !== undefined && !generation) return undefined
  const registeredInput = recordValue(relation.registeredInput)
  if (
    relation.registeredInput !== undefined &&
    (!registeredInput ||
      !exactFields(registeredInput, ['sourceKind', 'inputFileVersionId', 'checksum']) ||
      (registeredInput.sourceKind !== 'upload-version' &&
        registeredInput.sourceKind !== 'artifact-version') ||
      typeof registeredInput.inputFileVersionId !== 'string' ||
      registeredInput.inputFileVersionId.length === 0 ||
      typeof registeredInput.checksum !== 'string' ||
      !SHA256_PATTERN.test(registeredInput.checksum) ||
      !generation ||
      generation.checksum !== registeredInput.checksum ||
      (relation.relation !== 'present-before' && relation.relation !== 'staged-input'))
  ) {
    return undefined
  }
  return {
    relation: relation.relation as EvidenceRelationKind,
    relativePath: relation.relativePath,
    pathPortability: relation.pathPortability,
    authority: relation.authority,
    ...(generation
      ? {
          generation: {
            ...generation,
            relativePath: relation.relativePath,
            pathPortability: relation.pathPortability
          }
        }
      : {}),
    ...(typeof relation.previousGenerationId === 'string'
      ? { previousGenerationId: relation.previousGenerationId }
      : {}),
    ...(registeredInput
      ? {
          registeredInput: {
            sourceKind: registeredInput.sourceKind as NotebookRunInputFile['sourceKind'],
            inputFileVersionId: registeredInput.inputFileVersionId as string,
            checksum: registeredInput.checksum as string
          }
        }
      : {})
  }
}

const unavailableEvidence = (
  summary: ExecutionFileEvidenceSummary | undefined,
  failure: DecodedActivityEvidence['failure']
): DecodedActivityEvidence => ({
  state: summary?.state ?? 'unavailable',
  evidenceId: summary?.evidenceId,
  checksum: summary?.checksum,
  fileReads: summary?.fileReads ?? 'unavailable',
  writerAttribution: summary?.writerAttribution ?? 'unavailable',
  reasonCodes: summary?.reasonCodes ?? [],
  relations: [],
  scientificOutputs: [],
  failure
})

const decodeActivityEvidence = (
  activityId: string,
  activityKind: 'notebook-run' | 'compute-job',
  parentActivityId: string | undefined,
  summary: ExecutionFileEvidenceSummary | undefined,
  evidenceJson: string | undefined
): DecodedActivityEvidence => {
  if (!hasImmutableExecutionFileEvidenceReference(summary) || evidenceJson === undefined) {
    return unavailableEvidence(summary, 'unavailable')
  }
  if (sha256(evidenceJson) !== summary.checksum) return unavailableEvidence(summary, 'corrupt')
  try {
    const evidence = recordValue(JSON.parse(evidenceJson))
    if (
      activityKind === 'notebook-run' &&
      parentActivityId === undefined &&
      evidence &&
      hasExactlyFields(evidence, ['schemaVersion', 'evidenceId', 'runId']) &&
      evidence.schemaVersion === 1 &&
      evidence.evidenceId === summary.evidenceId &&
      evidence.runId === activityId &&
      isLegacyNotebookStorageKey(summary.storageKey, activityId)
    ) {
      return {
        state: summary.state,
        evidenceId: summary.evidenceId,
        checksum: summary.checksum,
        fileReads: summary.fileReads,
        writerAttribution: summary.writerAttribution,
        reasonCodes: [...summary.reasonCodes],
        relations: [],
        scientificOutputs: []
      }
    }
    if (
      !evidence ||
      !exactFields(evidence, [
        'schemaVersion',
        'evidenceId',
        'activityId',
        'activityKind',
        'parentActivityId',
        'state',
        'observedRoots',
        'initialViewState',
        'managedRootsFinalState',
        'fileReads',
        'externalPaths',
        'writerAttribution',
        'reasonCodes',
        'scientificOutputs',
        'relations'
      ]) ||
      evidence.schemaVersion !== 1 ||
      evidence.evidenceId !== summary.evidenceId ||
      evidence.activityId !== activityId ||
      evidence.activityKind !== activityKind ||
      evidence.parentActivityId !== parentActivityId ||
      evidence.state !== summary.state ||
      !stringArray(evidence.observedRoots) ||
      evidence.initialViewState !== summary.initialViewState ||
      evidence.managedRootsFinalState !== summary.managedRootsFinalState ||
      evidence.fileReads !== summary.fileReads ||
      evidence.externalPaths !== summary.externalPaths ||
      evidence.writerAttribution !== summary.writerAttribution ||
      !stringArray(evidence.reasonCodes) ||
      !sameStrings(evidence.reasonCodes, summary.reasonCodes) ||
      !Array.isArray(evidence.scientificOutputs) ||
      evidence.scientificOutputs.length !== summary.scientificOutputCount ||
      !Array.isArray(evidence.relations) ||
      (summary.relationCount !== undefined && evidence.relations.length !== summary.relationCount)
    ) {
      return unavailableEvidence(summary, 'corrupt')
    }
    const relations = evidence.relations.map(relationValue)
    const scientificOutputs = evidence.scientificOutputs.map(scientificOutputValue)
    if (relations.some((relation) => relation === undefined)) {
      return unavailableEvidence(summary, 'corrupt')
    }
    if (
      scientificOutputs.some((output) => output === undefined) ||
      new Set(scientificOutputs.map((output) => output?.outputId)).size !==
        scientificOutputs.length ||
      new Set(scientificOutputs.flatMap((output) => output?.members ?? [])).size !==
        scientificOutputs.reduce((count, output) => count + (output?.members.length ?? 0), 0)
    ) {
      return unavailableEvidence(summary, 'corrupt')
    }
    if (
      summary.generationCount !== undefined &&
      relations.filter((relation) => relation?.generation).length !== summary.generationCount
    ) {
      return unavailableEvidence(summary, 'corrupt')
    }
    return {
      state: summary.state,
      evidenceId: summary.evidenceId,
      checksum: summary.checksum,
      fileReads: summary.fileReads,
      writerAttribution: summary.writerAttribution,
      reasonCodes: [...summary.reasonCodes],
      relations: relations as EvidenceRelation[],
      scientificOutputs: scientificOutputs as ScientificOutputEvidence[]
    }
  } catch {
    return unavailableEvidence(summary, 'corrupt')
  }
}

const inputEntity = (input: NotebookRunInputFile): ArtifactProvenanceGraphEntity => ({
  entityId: `registered-input:${input.sourceKind}:${input.inputFileVersionId}`,
  kind: 'registered-input-generation',
  inputFileVersionId: input.inputFileVersionId,
  sourceKind: input.sourceKind,
  filename: input.filename,
  checksum: input.checksum,
  sizeBytes: input.sizeBytes
})

const pathKey = (relativePath: string, checksum: string): string =>
  `${relativePath.replaceAll('\\', '/').replace(/^\.\//u, '')}\0${checksum}`

const edgeTargetId = (edge: ArtifactProvenanceGraphEdge): string =>
  edge.kind === 'depends-on' ? edge.dependencyActivityId : edge.entityId

const edgeKey = (edge: ArtifactProvenanceGraphEdge): string =>
  `${edge.kind}\0${edge.activityId}\0${edgeTargetId(edge)}`

const mergeEdge = (
  edges: Map<string, ArtifactProvenanceGraphEdge>,
  edge: ArtifactProvenanceGraphEdge
): void => {
  const key = edgeKey(edge)
  const current = edges.get(key)
  if (!current) {
    edges.set(key, edge)
    return
  }
  if (current.authority === 'authoritative' || edge.authority !== 'authoritative') return
  edges.set(key, edge)
}

const graphBytes = (graph: ArtifactProvenanceGraph): number =>
  Buffer.byteLength(canonicalJson(graph as unknown as CanonicalJson), 'utf8')

const graphIsAcyclic = (graph: ArtifactProvenanceGraph): boolean => {
  const activityKey = (id: string): string => `activity:${id}`
  const entityKey = (id: string): string => `entity:${id}`
  const nodes = new Set([
    ...graph.activities.map((activity) => activityKey(activity.activityId)),
    ...graph.entities.map((entity) => entityKey(entity.entityId))
  ])
  const outgoing = new Map<string, string[]>()
  const indegree = new Map([...nodes].map((node) => [node, 0]))
  for (const edge of graph.edges) {
    const from =
      edge.kind === 'used'
        ? entityKey(edge.entityId)
        : edge.kind === 'depends-on'
          ? activityKey(edge.dependencyActivityId)
          : activityKey(edge.activityId)
    const to =
      edge.kind === 'used'
        ? activityKey(edge.activityId)
        : edge.kind === 'depends-on'
          ? activityKey(edge.activityId)
          : entityKey(edge.entityId)
    outgoing.set(from, [...(outgoing.get(from) ?? []), to])
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }
  const ready = [...nodes].filter((node) => indegree.get(node) === 0)
  let visited = 0
  while (ready.length > 0) {
    const node = ready.pop()!
    visited += 1
    for (const next of outgoing.get(node) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }
  return visited === nodes.size
}

const sortGraph = (graph: ArtifactProvenanceGraph): ArtifactProvenanceGraph => ({
  ...graph,
  reasonCodes: [...new Set(graph.reasonCodes)].sort(),
  activities: [...graph.activities].sort(
    (left, right) =>
      left.sequence - right.sequence || left.activityId.localeCompare(right.activityId)
  ),
  entities: [...graph.entities].sort((left, right) => left.entityId.localeCompare(right.entityId)),
  edges: [...graph.edges].sort(
    (left, right) =>
      left.activityId.localeCompare(right.activityId) ||
      left.kind.localeCompare(right.kind) ||
      edgeTargetId(left).localeCompare(edgeTargetId(right))
  ),
  ...(graph.outputGroups
    ? {
        outputGroups: graph.outputGroups
          .map((group) => ({
            ...group,
            memberEntityIds: [...group.memberEntityIds].sort(),
            riskCodes: [...group.riskCodes].sort()
          }))
          .sort((left, right) => left.outputId.localeCompare(right.outputId))
      }
    : {})
})

const boundGraph = (input: ArtifactProvenanceGraph): ArtifactProvenanceGraph => {
  let graph = sortGraph(input)
  if (
    graph.activities.length <= MAX_GRAPH_ACTIVITIES &&
    graph.edges.length <= MAX_GRAPH_EDGES &&
    (graph.outputGroups?.length ?? 0) <= MAX_GRAPH_OUTPUT_GROUPS &&
    graphBytes(graph) <= MAX_GRAPH_BYTES
  ) {
    return graph
  }

  const publicationActivity = graph.edges.find(
    (edge) => edge.kind === 'generated' && edge.entityId === graph.targetEntityId
  )?.activityId
  const priority = (edge: ArtifactProvenanceGraphEdge): number =>
    edge.kind !== 'depends-on' && edge.entityId === graph.targetEntityId
      ? 0
      : edge.activityId === publicationActivity
        ? 1
        : edge.authority === 'authoritative'
          ? 2
          : 3
  let edges = [...graph.edges]
    .sort(
      (left, right) =>
        priority(left) - priority(right) || edgeKey(left).localeCompare(edgeKey(right))
    )
    .slice(0, MAX_GRAPH_EDGES)
  const retainedActivityIds = new Set(
    edges.flatMap((edge) => [
      edge.activityId,
      ...(edge.kind === 'depends-on' ? [edge.dependencyActivityId] : [])
    ])
  )
  const publication = graph.activities.find(
    (activity) => activity.activityId === publicationActivity
  )
  if (publicationActivity) retainedActivityIds.add(publicationActivity)
  if (publication?.parentActivityId) retainedActivityIds.add(publication.parentActivityId)
  let activities = graph.activities.filter((activity) =>
    retainedActivityIds.has(activity.activityId)
  )
  if (activities.length > MAX_GRAPH_ACTIVITIES) {
    const required = activities.filter(
      (activity) =>
        activity.activityId === publicationActivity ||
        activity.activityId === publication?.parentActivityId
    )
    const optional = activities.filter((activity) => !required.includes(activity))
    activities = [...optional.slice(-(MAX_GRAPH_ACTIVITIES - required.length)), ...required].sort(
      (left, right) =>
        left.sequence - right.sequence || left.activityId.localeCompare(right.activityId)
    )
  }
  const allowedActivityIds = new Set(activities.map((activity) => activity.activityId))
  edges = edges.filter(
    (edge) =>
      allowedActivityIds.has(edge.activityId) &&
      (edge.kind !== 'depends-on' || allowedActivityIds.has(edge.dependencyActivityId))
  )
  const generatedEdgeByMember = new Map(
    graph.edges.flatMap((edge) =>
      edge.kind === 'generated' ? [[`${edge.activityId}\0${edge.entityId}`, edge] as const] : []
    )
  )
  const outputGroupsForEdges = (): ArtifactProvenanceGraphOutputGroup[] => {
    const retainedEdgeKeys = new Set(edges.map(edgeKey))
    return (graph.outputGroups ?? [])
      .filter(
        (group) =>
          allowedActivityIds.has(group.activityId) &&
          group.memberEntityIds.every((entityId) => {
            const generated = generatedEdgeByMember.get(`${group.activityId}\0${entityId}`)
            return generated ? retainedEdgeKeys.has(edgeKey(generated)) : false
          })
      )
      .slice(0, MAX_GRAPH_OUTPUT_GROUPS)
  }
  const entitiesForEdges = (): ArtifactProvenanceGraphEntity[] => {
    const ids = new Set([
      graph.targetEntityId,
      ...edges.flatMap((edge) => (edge.kind === 'depends-on' ? [] : [edge.entityId]))
    ])
    return graph.entities.filter((entity) => ids.has(entity.entityId))
  }
  graph = sortGraph({
    ...graph,
    completeness: 'incomplete',
    reasonCodes: [...graph.reasonCodes, 'graph-budget-exceeded'],
    activities,
    entities: entitiesForEdges(),
    edges,
    outputGroups: outputGroupsForEdges()
  })
  while (graphBytes(graph) > MAX_GRAPH_BYTES && edges.length > 1) {
    edges.pop()
    graph = sortGraph({
      ...graph,
      entities: entitiesForEdges(),
      edges,
      outputGroups: outputGroupsForEdges()
    })
  }
  if (graphBytes(graph) <= MAX_GRAPH_BYTES) return graph

  const publicationParent = graph.activities.find(
    (activity) => activity.activityId === publication?.parentActivityId
  )
  const target = graph.entities.find((entity) => entity.entityId === graph.targetEntityId)!
  const targetEdge = graph.edges.find(
    (edge) => edge.kind === 'generated' && edge.entityId === graph.targetEntityId
  )!
  return sortGraph({
    ...graph,
    activities: [publicationParent, publication].filter(
      (activity): activity is ArtifactProvenanceGraphActivity => activity !== undefined
    ),
    entities: [target],
    edges: targetEdge ? [targetEdge] : [],
    outputGroups: []
  })
}

const completenessFor = (
  reasons: ReadonlySet<ArtifactProvenanceGraphReason>
): ArtifactProvenanceGraph['completeness'] => {
  const incomplete = new Set<ArtifactProvenanceGraphReason>([
    'activity-evidence-unavailable',
    'activity-evidence-corrupt',
    'activity-evidence-partial',
    'target-generation-unavailable',
    'absolute-path-unfrozen',
    'kernel-epoch-unknown',
    'kernel-dependencies-unavailable',
    'history-truncated',
    'graph-budget-exceeded',
    'dependency-cycle'
  ])
  return [...reasons].some((reason) => incomplete.has(reason))
    ? 'incomplete'
    : reasons.size > 0
      ? 'conservative'
      : 'complete'
}

const sealArtifactProvenanceGraph = (
  input: SealArtifactProvenanceGraphInput
): ArtifactProvenanceGraph => {
  const notebookInputs = [...input.notebookActivities].sort(
    (left, right) => left.runIndex - right.runIndex || left.run.runId.localeCompare(right.run.runId)
  )
  const runIndexById = new Map(notebookInputs.map((item) => [item.run.runId, item.runIndex]))
  const computeInputs = [...input.computeActivities].sort(
    (left, right) =>
      (runIndexById.get(left.parentActivityId ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (runIndexById.get(right.parentActivityId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
      left.ordinal - right.ordinal ||
      left.activityId.localeCompare(right.activityId)
  )
  const computeByParent = new Map<string, ArtifactProvenanceComputeActivityInput[]>()
  for (const compute of computeInputs) {
    if (!compute.parentActivityId) continue
    computeByParent.set(compute.parentActivityId, [
      ...(computeByParent.get(compute.parentActivityId) ?? []),
      compute
    ])
  }

  const candidates: CandidateActivity[] = []
  let sequence = 0
  for (const notebook of notebookInputs) {
    const decodedEvidence = decodeActivityEvidence(
      notebook.run.runId,
      'notebook-run',
      undefined,
      notebook.run.fileEvidence,
      notebook.evidenceJson
    )
    candidates.push({
      activity: {
        activityId: notebook.run.runId,
        kind: 'notebook-run',
        sequence: sequence++,
        runIndex: notebook.runIndex,
        ...(notebook.run.kernelEpochId ? { kernelEpochId: notebook.run.kernelEpochId } : {}),
        inclusion: 'target-closure',
        evidenceState: decodedEvidence.state,
        ...(decodedEvidence.evidenceId ? { evidenceId: decodedEvidence.evidenceId } : {}),
        ...(decodedEvidence.checksum ? { evidenceChecksum: decodedEvidence.checksum } : {}),
        ...(decodedEvidence.reasonCodes.length > 0
          ? { evidenceReasonCodes: [...decodedEvidence.reasonCodes] }
          : {})
      },
      notebookRun: notebook.run,
      decodedEvidence,
      inputs: notebook.run.inputFiles ?? []
    })
    for (const compute of computeByParent.get(notebook.run.runId) ?? []) {
      const computeEvidence = decodeActivityEvidence(
        compute.activityId,
        'compute-job',
        compute.parentActivityId,
        compute.fileEvidence,
        compute.evidenceJson
      )
      candidates.push({
        activity: {
          activityId: compute.activityId,
          kind: 'compute-job',
          sequence: sequence++,
          ...(compute.parentActivityId ? { parentActivityId: compute.parentActivityId } : {}),
          inclusion: 'target-closure',
          evidenceState: computeEvidence.state,
          ...(computeEvidence.evidenceId ? { evidenceId: computeEvidence.evidenceId } : {}),
          ...(computeEvidence.checksum ? { evidenceChecksum: computeEvidence.checksum } : {}),
          ...(computeEvidence.reasonCodes.length > 0
            ? { evidenceReasonCodes: [...computeEvidence.reasonCodes] }
            : {})
        },
        decodedEvidence: computeEvidence,
        inputs: []
      })
    }
  }

  const entities = new Map<string, ArtifactProvenanceGraphEntity>()
  const edges = new Map<string, ArtifactProvenanceGraphEdge>()
  const notebookCandidateById = new Map(
    candidates.flatMap((candidate) =>
      candidate.notebookRun ? [[candidate.activity.activityId, candidate] as const] : []
    )
  )
  const completeKernelDependencyActivityIds = new Set<string>()
  const missingKernelDependencyActivityIds = new Set<string>()
  if (input.notebookDependencies) {
    for (const [activityId, candidate] of notebookCandidateById) {
      const dependencies = input.notebookDependencies.dependenciesByRunId?.[activityId]
      if (
        input.notebookDependencies.stalenessByRunId[activityId]?.state !== 'clear' ||
        dependencies === undefined
      ) {
        continue
      }
      completeKernelDependencyActivityIds.add(activityId)
      for (const dependencyActivityId of dependencies) {
        const dependency = notebookCandidateById.get(dependencyActivityId)
        if (
          !dependency ||
          !candidate.notebookRun?.kernelEpochId ||
          candidate.notebookRun.kernelEpochId !== dependency.notebookRun?.kernelEpochId ||
          dependency.activity.sequence >= candidate.activity.sequence
        ) {
          missingKernelDependencyActivityIds.add(activityId)
          completeKernelDependencyActivityIds.delete(activityId)
          continue
        }
        mergeEdge(edges, {
          kind: 'depends-on',
          activityId,
          dependencyActivityId,
          authority: 'authoritative',
          evidenceSource: 'dependency-analysis'
        })
      }
    }
  }
  const priorOutputByPath = new Map<
    string,
    { generation: FileGeneration; writerAttributionComplete: boolean }
  >()
  const candidateOutputGroups: ArtifactProvenanceGraphOutputGroup[] = []

  for (const candidate of candidates) {
    const registeredByChecksum = new Map<string, ArtifactProvenanceGraphEntity[]>()
    const registeredByIdentity = new Map<string, ArtifactProvenanceGraphEntity>()
    for (const inputFile of candidate.inputs) {
      const entity = inputEntity(inputFile)
      entities.set(entity.entityId, entity)
      registeredByIdentity.set(`${inputFile.sourceKind}\0${inputFile.inputFileVersionId}`, entity)
      registeredByChecksum.set(inputFile.checksum, [
        ...(registeredByChecksum.get(inputFile.checksum) ?? []),
        entity
      ])
      if (inputFile.association === 'resolver-accessed') {
        mergeEdge(edges, {
          kind: 'used',
          activityId: candidate.activity.activityId,
          entityId: entity.entityId,
          authority: 'authoritative',
          evidenceSource: 'registered-contract'
        })
      }
    }

    const generations = new Map<string, FileGeneration>()
    for (const relation of candidate.decodedEvidence.relations) {
      if (relation.generation)
        generations.set(relation.generation.generationId, relation.generation)
    }

    const resolveUsedEntity = (
      generation: FileGeneration,
      relation: EvidenceRelation
    ): ArtifactProvenanceGraphEntity => {
      const direct = relation.registeredInput
        ? registeredByIdentity.get(
            `${relation.registeredInput.sourceKind}\0${relation.registeredInput.inputFileVersionId}`
          )
        : undefined
      if (relation.registeredInput) {
        return direct?.checksum === generation.checksum ? direct : generation
      }
      const registered = registeredByChecksum.get(generation.checksum)
      if (registered?.length === 1) return registered[0]!
      const prior = priorOutputByPath.get(pathKey(relation.relativePath, generation.checksum))
      return prior?.generation ?? generation
    }

    const produced: FileGeneration[] = []
    for (const relation of candidate.decodedEvidence.relations) {
      const usedGeneration =
        relation.relation === 'staged-input' ||
        (relation.relation === 'present-before' &&
          candidate.decodedEvidence.fileReads === 'complete')
          ? relation.generation
          : relation.relation === 'modified' || relation.relation === 'deleted'
            ? generations.get(relation.previousGenerationId ?? '')
            : undefined
      if (usedGeneration) {
        const entity = resolveUsedEntity(usedGeneration, relation)
        const correlatedGeneration =
          entity.kind !== 'file-generation' || entity.generationId !== usedGeneration.generationId
        const correlatedPrior = priorOutputByPath.get(
          pathKey(relation.relativePath, usedGeneration.checksum)
        )
        entities.set(entity.entityId, entity)
        mergeEdge(edges, {
          kind: 'used',
          activityId: candidate.activity.activityId,
          entityId: entity.entityId,
          authority:
            (entity.kind === 'registered-input-generation' &&
              (candidate.decodedEvidence.fileReads === 'complete' ||
                candidate.inputs.some(
                  (inputFile) =>
                    inputFile.inputFileVersionId === entity.inputFileVersionId &&
                    inputFile.association === 'resolver-accessed'
                ))) ||
            relation.authority === 'explicit-transfer' ||
            (correlatedGeneration &&
              correlatedPrior?.writerAttributionComplete === true &&
              candidate.decodedEvidence.fileReads === 'complete')
              ? 'authoritative'
              : 'advisory',
          evidenceSource:
            relation.authority === 'explicit-transfer'
              ? 'explicit-transfer'
              : 'runtime-observation',
          ...(candidate.decodedEvidence.evidenceId
            ? { evidenceId: candidate.decodedEvidence.evidenceId }
            : {}),
          observedGenerationId: usedGeneration.generationId,
          relativePath: relation.relativePath,
          pathPortability: relation.pathPortability
        })
      }

      if (
        relation.generation &&
        (relation.relation === 'created' ||
          relation.relation === 'modified' ||
          relation.relation === 'harvested-output')
      ) {
        const generated = relation.generation
        entities.set(generated.entityId, generated)
        mergeEdge(edges, {
          kind: 'generated',
          activityId: candidate.activity.activityId,
          entityId: generated.entityId,
          authority: relation.authority === 'explicit-transfer' ? 'authoritative' : 'advisory',
          evidenceSource:
            relation.authority === 'explicit-transfer'
              ? 'explicit-transfer'
              : 'runtime-observation',
          ...(candidate.decodedEvidence.evidenceId
            ? { evidenceId: candidate.decodedEvidence.evidenceId }
            : {}),
          relativePath: relation.relativePath,
          pathPortability: relation.pathPortability
        })
        produced.push(generated)
      }
    }
    for (const generation of produced) {
      priorOutputByPath.set(pathKey(generation.relativePath, generation.checksum), {
        generation,
        writerAttributionComplete: candidate.decodedEvidence.writerAttribution === 'complete'
      })
    }
    const producedEntityIdByPath = new Map(
      candidate.decodedEvidence.relations.flatMap((relation) =>
        relation.generation &&
        (relation.relation === 'created' ||
          relation.relation === 'modified' ||
          relation.relation === 'harvested-output')
          ? [[relation.relativePath, relation.generation.entityId] as const]
          : []
      )
    )
    for (const output of candidate.decodedEvidence.scientificOutputs) {
      if (output.storageShape === 'single-file') continue
      const memberEntityIds = [
        ...new Set(
          output.members.flatMap((member) => {
            const entityId = producedEntityIdByPath.get(member)
            return entityId ? [entityId] : []
          })
        )
      ]
      if (memberEntityIds.length < 2) continue
      candidateOutputGroups.push({
        outputId: output.outputId,
        activityId: candidate.activity.activityId,
        storageShape: output.storageShape,
        ...(output.formatHint ? { formatHint: output.formatHint } : {}),
        memberEntityIds,
        riskCodes: [...output.riskCodes]
      })
    }
  }

  const publicationActivityId = `artifact-publication:${input.target.versionId}`
  const targetEntityId = `artifact-version:${input.target.versionId}`
  const publicationActivity: ArtifactProvenanceGraphActivity = {
    activityId: publicationActivityId,
    kind: 'artifact-publication',
    sequence: sequence++,
    parentActivityId: input.target.producerRunId,
    inclusion: 'target-closure',
    evidenceState: 'available'
  }
  const targetEntity: ArtifactProvenanceGraphEntity = {
    entityId: targetEntityId,
    kind: 'artifact-version',
    versionId: input.target.versionId,
    filename: input.target.filename,
    checksum: input.target.checksum,
    sizeBytes: input.target.sizeBytes
  }
  entities.set(targetEntityId, targetEntity)
  const publicationGenerated: ArtifactProvenanceGraphEdge = {
    kind: 'generated',
    activityId: publicationActivityId,
    entityId: targetEntityId,
    authority: 'authoritative',
    evidenceSource: 'artifact-publication'
  }
  mergeEdge(edges, publicationGenerated)

  const reasons = new Set<ArtifactProvenanceGraphReason>()
  if ((input.omittedLeadingActivityCount ?? 0) > 0) reasons.add('history-truncated')
  const sourceEntityId = input.target.sourceGenerationId
    ? `file-generation:${input.target.sourceGenerationId}`
    : undefined
  const sourceEntity = sourceEntityId ? entities.get(sourceEntityId) : undefined
  const publicationUsed =
    sourceEntity?.kind === 'file-generation' && sourceEntity.checksum === input.target.checksum
      ? ({
          kind: 'used',
          activityId: publicationActivityId,
          entityId: sourceEntity.entityId,
          authority: 'authoritative',
          evidenceSource: 'artifact-publication'
        } satisfies ArtifactProvenanceGraphEdge)
      : undefined
  if (publicationUsed) mergeEdge(edges, publicationUsed)
  else reasons.add('target-generation-unavailable')

  const candidateById = new Map(
    candidates.map((candidate) => [candidate.activity.activityId, candidate])
  )
  const allEdges = [...edges.values()]
  const usedByActivity = new Map<string, EntityGraphEdge[]>()
  const generatedByEntity = new Map<string, ArtifactProvenanceGraphEdge>()
  for (const edge of allEdges) {
    if (edge.kind === 'used') {
      usedByActivity.set(edge.activityId, [...(usedByActivity.get(edge.activityId) ?? []), edge])
    } else if (edge.kind === 'generated') {
      generatedByEntity.set(edge.entityId, edge)
    }
  }
  const dependenciesByActivity = new Map<
    string,
    Array<Extract<ArtifactProvenanceGraphEdge, { kind: 'depends-on' }>>
  >()
  for (const edge of allEdges) {
    if (edge.kind !== 'depends-on') continue
    dependenciesByActivity.set(edge.activityId, [
      ...(dependenciesByActivity.get(edge.activityId) ?? []),
      edge
    ])
  }

  const selectedActivityIds = new Set([publicationActivityId, input.target.producerRunId])
  const requiredEdgeKeys = new Set([edgeKey(publicationGenerated)])
  if (publicationUsed) requiredEdgeKeys.add(edgeKey(publicationUsed))
  const queue: string[] = [publicationActivityId, input.target.producerRunId]

  const expandDependencies = (): void => {
    while (queue.length > 0) {
      const activityId = queue.shift()!
      for (const used of usedByActivity.get(activityId) ?? []) {
        requiredEdgeKeys.add(edgeKey(used))
        const generated = generatedByEntity.get(used.entityId)
        if (!generated) continue
        requiredEdgeKeys.add(edgeKey(generated))
        if (!selectedActivityIds.has(generated.activityId)) {
          selectedActivityIds.add(generated.activityId)
          queue.push(generated.activityId)
        }
      }
      for (const dependency of dependenciesByActivity.get(activityId) ?? []) {
        requiredEdgeKeys.add(edgeKey(dependency))
        if (!selectedActivityIds.has(dependency.dependencyActivityId)) {
          selectedActivityIds.add(dependency.dependencyActivityId)
          queue.push(dependency.dependencyActivityId)
        }
      }
    }
  }
  expandDependencies()

  for (const activityId of selectedActivityIds) {
    const candidate = candidateById.get(activityId)
    if (!candidate?.notebookRun) continue
    const fileReadsComplete = candidate.decodedEvidence.fileReads === 'complete'
    const kernelDependenciesComplete = input.notebookDependencies
      ? completeKernelDependencyActivityIds.has(activityId)
      : fileReadsComplete
    if (kernelDependenciesComplete) continue
    if (missingKernelDependencyActivityIds.has(activityId)) reasons.add('history-truncated')
    if (!fileReadsComplete) reasons.add('file-reads-unavailable')
    if (!candidate.notebookRun.kernelEpochId) reasons.add('kernel-epoch-unknown')
    reasons.add('kernel-dependencies-unavailable')
  }

  for (const activityId of selectedActivityIds) {
    const evidence = candidateById.get(activityId)?.decodedEvidence
    if (!evidence) continue
    if (evidence.failure === 'corrupt') reasons.add('activity-evidence-corrupt')
    else if (evidence.failure === 'unavailable') reasons.add('activity-evidence-unavailable')
    if (evidence.state === 'partial') reasons.add('activity-evidence-partial')
    if (evidence.fileReads !== 'complete') reasons.add('file-reads-unavailable')
    if (evidence.writerAttribution !== 'complete') reasons.add('writer-attribution-unavailable')
    if (
      evidence.reasonCodes.includes('absolute-path-not-frozen') ||
      evidence.relations.some(
        (relation) => relation.pathPortability === 'absolute' && !relation.generation
      )
    ) {
      reasons.add('absolute-path-unfrozen')
    }
  }

  const outputGroups = candidateOutputGroups.filter(
    (group) =>
      selectedActivityIds.has(group.activityId) &&
      group.memberEntityIds.some((entityId) => {
        const generated = generatedByEntity.get(entityId)
        return generated ? requiredEdgeKeys.has(edgeKey(generated)) : false
      })
  )
  for (const group of outputGroups) {
    for (const entityId of group.memberEntityIds) {
      const generated = generatedByEntity.get(entityId)
      if (generated?.activityId === group.activityId) requiredEdgeKeys.add(edgeKey(generated))
    }
  }

  const requiredEdges = allEdges.filter((edge) => requiredEdgeKeys.has(edgeKey(edge)))
  const requiredEntityIds = new Set([
    targetEntityId,
    ...requiredEdges.flatMap((edge) => (edge.kind === 'depends-on' ? [] : [edge.entityId]))
  ])
  const selectedActivities = [
    ...candidates
      .filter((candidate) => selectedActivityIds.has(candidate.activity.activityId))
      .map((candidate) => candidate.activity),
    publicationActivity
  ]
  let graph: ArtifactProvenanceGraph = {
    schemaVersion: 1,
    targetEntityId,
    completeness: completenessFor(reasons),
    reasonCodes: [...reasons],
    activities: selectedActivities,
    entities: [...entities.values()].filter((entity) => requiredEntityIds.has(entity.entityId)),
    edges: requiredEdges,
    outputGroups
  }
  graph = boundGraph(graph)
  if (!graphIsAcyclic(graph)) {
    const producerActivity = candidateById.get(input.target.producerRunId)?.activity
    graph = sortGraph({
      schemaVersion: 1,
      targetEntityId,
      completeness: 'incomplete',
      reasonCodes: [...graph.reasonCodes, 'dependency-cycle'],
      activities: [producerActivity, publicationActivity].filter(
        (activity): activity is ArtifactProvenanceGraphActivity => activity !== undefined
      ),
      entities: [targetEntity],
      edges: [publicationGenerated],
      outputGroups: []
    })
  }
  return graph
}

const artifactProvenanceGraphValue = (value: unknown): value is ArtifactProvenanceGraph => {
  const graph = recordValue(value)
  if (
    !graph ||
    !exactFields(graph, [
      'schemaVersion',
      'targetEntityId',
      'completeness',
      'reasonCodes',
      'activities',
      'entities',
      'edges',
      'outputGroups'
    ]) ||
    graph.schemaVersion !== 1 ||
    typeof graph.targetEntityId !== 'string' ||
    !['complete', 'conservative', 'incomplete'].includes(String(graph.completeness)) ||
    !stringArray(graph.reasonCodes) ||
    graph.reasonCodes.some(
      (reason) => !GRAPH_REASONS.has(reason as ArtifactProvenanceGraphReason)
    ) ||
    !Array.isArray(graph.activities) ||
    graph.activities.length > MAX_GRAPH_ACTIVITIES ||
    !Array.isArray(graph.entities) ||
    !Array.isArray(graph.edges) ||
    graph.edges.length > MAX_GRAPH_EDGES ||
    (graph.outputGroups !== undefined &&
      (!Array.isArray(graph.outputGroups) || graph.outputGroups.length > MAX_GRAPH_OUTPUT_GROUPS))
  ) {
    return false
  }
  const activityKinds = new Set(['notebook-run', 'compute-job', 'artifact-publication'])
  const evidenceStates = new Set(['available', 'partial', 'unavailable'])
  const inclusions = new Set(['target-closure', 'kernel-epoch-conservative'])
  const activities = graph.activities as unknown[]
  if (
    activities.some((value) => {
      const activity = recordValue(value)
      return (
        !activity ||
        !exactFields(activity, [
          'activityId',
          'kind',
          'sequence',
          'parentActivityId',
          'runIndex',
          'kernelEpochId',
          'inclusion',
          'evidenceState',
          'evidenceId',
          'evidenceChecksum',
          'evidenceReasonCodes'
        ]) ||
        typeof activity.activityId !== 'string' ||
        !activityKinds.has(String(activity.kind)) ||
        !safeInteger(activity.sequence) ||
        (activity.parentActivityId !== undefined &&
          typeof activity.parentActivityId !== 'string') ||
        (activity.runIndex !== undefined && !safeInteger(activity.runIndex)) ||
        (activity.kernelEpochId !== undefined && typeof activity.kernelEpochId !== 'string') ||
        !inclusions.has(String(activity.inclusion)) ||
        !evidenceStates.has(String(activity.evidenceState)) ||
        (activity.evidenceId !== undefined && typeof activity.evidenceId !== 'string') ||
        (activity.evidenceChecksum !== undefined &&
          (typeof activity.evidenceChecksum !== 'string' ||
            !SHA256_PATTERN.test(activity.evidenceChecksum))) ||
        (activity.evidenceReasonCodes !== undefined &&
          (!stringArray(activity.evidenceReasonCodes) ||
            activity.evidenceReasonCodes.some(
              (reason) =>
                !EXECUTION_FILE_EVIDENCE_REASONS.has(
                  reason as ExecutionFileEvidenceSummary['reasonCodes'][number]
                )
            )))
      )
    })
  ) {
    return false
  }
  const entities = graph.entities as unknown[]
  if (
    entities.some((value) => {
      const entity = recordValue(value)
      if (!entity || typeof entity.entityId !== 'string' || typeof entity.kind !== 'string') {
        return true
      }
      if (entity.kind === 'registered-input-generation') {
        return (
          !exactFields(entity, [
            'entityId',
            'kind',
            'inputFileVersionId',
            'sourceKind',
            'filename',
            'checksum',
            'sizeBytes'
          ]) ||
          typeof entity.inputFileVersionId !== 'string' ||
          (entity.sourceKind !== 'upload-version' && entity.sourceKind !== 'artifact-version') ||
          typeof entity.filename !== 'string' ||
          typeof entity.checksum !== 'string' ||
          !SHA256_PATTERN.test(entity.checksum) ||
          !safeInteger(entity.sizeBytes)
        )
      }
      if (entity.kind === 'file-generation') {
        return (
          !exactFields(entity, [
            'entityId',
            'kind',
            'generationId',
            'relativePath',
            'pathPortability',
            'checksum',
            'sizeBytes',
            'contentStorageKey'
          ]) ||
          typeof entity.generationId !== 'string' ||
          typeof entity.relativePath !== 'string' ||
          (entity.pathPortability !== 'relative' && entity.pathPortability !== 'absolute') ||
          typeof entity.checksum !== 'string' ||
          !SHA256_PATTERN.test(entity.checksum) ||
          !safeInteger(entity.sizeBytes) ||
          typeof entity.contentStorageKey !== 'string' ||
          !validStorageKey(entity.contentStorageKey, entity.checksum)
        )
      }
      if (entity.kind === 'artifact-version') {
        return (
          !exactFields(entity, [
            'entityId',
            'kind',
            'versionId',
            'filename',
            'checksum',
            'sizeBytes'
          ]) ||
          typeof entity.versionId !== 'string' ||
          typeof entity.filename !== 'string' ||
          typeof entity.checksum !== 'string' ||
          !SHA256_PATTERN.test(entity.checksum) ||
          !safeInteger(entity.sizeBytes)
        )
      }
      return true
    })
  ) {
    return false
  }
  const edges = graph.edges as unknown[]
  const authorities = new Set(['authoritative', 'advisory'])
  const sources = new Set([
    'registered-contract',
    'runtime-observation',
    'explicit-transfer',
    'artifact-publication',
    'conservative-fallback'
  ])
  if (
    edges.some((value) => {
      const edge = recordValue(value)
      if (edge?.kind === 'depends-on') {
        return (
          !hasExactlyFields(edge, [
            'kind',
            'activityId',
            'dependencyActivityId',
            'authority',
            'evidenceSource'
          ]) ||
          typeof edge.activityId !== 'string' ||
          typeof edge.dependencyActivityId !== 'string' ||
          !authorities.has(String(edge.authority)) ||
          (edge.evidenceSource !== 'dependency-analysis' &&
            edge.evidenceSource !== 'conservative-fallback')
        )
      }
      return (
        !edge ||
        !exactFields(edge, [
          'kind',
          'activityId',
          'entityId',
          'authority',
          'evidenceSource',
          'evidenceId',
          'observedGenerationId',
          'relativePath',
          'pathPortability'
        ]) ||
        (edge.kind !== 'used' && edge.kind !== 'generated') ||
        typeof edge.activityId !== 'string' ||
        typeof edge.entityId !== 'string' ||
        !authorities.has(String(edge.authority)) ||
        !sources.has(String(edge.evidenceSource)) ||
        (edge.evidenceId !== undefined && typeof edge.evidenceId !== 'string') ||
        (edge.observedGenerationId !== undefined &&
          typeof edge.observedGenerationId !== 'string') ||
        (edge.relativePath !== undefined && typeof edge.relativePath !== 'string') ||
        (edge.pathPortability !== undefined &&
          edge.pathPortability !== 'relative' &&
          edge.pathPortability !== 'absolute')
      )
    })
  ) {
    return false
  }
  const outputGroups = (graph.outputGroups ?? []) as unknown[]
  if (
    outputGroups.some((value) => {
      const group = recordValue(value)
      return (
        !group ||
        !exactFields(group, [
          'outputId',
          'activityId',
          'storageShape',
          'formatHint',
          'memberEntityIds',
          'riskCodes'
        ]) ||
        typeof group.outputId !== 'string' ||
        group.outputId.length === 0 ||
        typeof group.activityId !== 'string' ||
        (group.storageShape !== 'file-set' && group.storageShape !== 'directory-tree') ||
        (group.formatHint !== undefined &&
          (typeof group.formatHint !== 'string' || group.formatHint.length === 0)) ||
        !stringArray(group.memberEntityIds) ||
        group.memberEntityIds.length < 2 ||
        group.memberEntityIds.some((entityId) => entityId.length === 0) ||
        new Set(group.memberEntityIds).size !== group.memberEntityIds.length ||
        !stringArray(group.riskCodes) ||
        new Set(group.riskCodes).size !== group.riskCodes.length ||
        group.riskCodes.some((risk) => !SCIENTIFIC_OUTPUT_RISKS.has(risk as ScientificOutputRisk))
      )
    })
  ) {
    return false
  }
  const typed = value as ArtifactProvenanceGraph
  const activityIds = new Set(typed.activities.map((activity) => activity.activityId))
  const entityIds = new Set(typed.entities.map((entity) => entity.entityId))
  const entityById = new Map(typed.entities.map((entity) => [entity.entityId, entity]))
  const target = typed.entities.find((entity) => entity.entityId === typed.targetEntityId)
  const generatedEntityIds = typed.edges.flatMap((edge) =>
    edge.kind === 'generated' ? [edge.entityId] : []
  )
  const groupedEntityIds = (typed.outputGroups ?? []).flatMap((group) => group.memberEntityIds)
  if (
    activityIds.size !== typed.activities.length ||
    entityIds.size !== typed.entities.length ||
    target?.kind !== 'artifact-version' ||
    typed.edges.some(
      (edge) =>
        !activityIds.has(edge.activityId) ||
        (edge.kind === 'depends-on'
          ? !activityIds.has(edge.dependencyActivityId)
          : !entityIds.has(edge.entityId))
    ) ||
    (typed.outputGroups ?? []).some(
      (group) =>
        !activityIds.has(group.activityId) ||
        group.memberEntityIds.some(
          (entityId) =>
            entityById.get(entityId)?.kind !== 'file-generation' ||
            !typed.edges.some(
              (edge) =>
                edge.kind === 'generated' &&
                edge.activityId === group.activityId &&
                edge.entityId === entityId
            )
        )
    ) ||
    new Set((typed.outputGroups ?? []).map((group) => group.outputId)).size !==
      (typed.outputGroups ?? []).length ||
    new Set(groupedEntityIds).size !== groupedEntityIds.length ||
    new Set(typed.edges.map(edgeKey)).size !== typed.edges.length ||
    new Set(generatedEntityIds).size !== generatedEntityIds.length ||
    completenessFor(new Set(typed.reasonCodes)) !== typed.completeness
  ) {
    return false
  }
  return graphBytes(typed) <= MAX_GRAPH_BYTES && graphIsAcyclic(typed)
}

const artifactProvenanceGraphMatchesTarget = (
  graph: ArtifactProvenanceGraph,
  expected: {
    versionId: string
    filename: string
    checksum: string
    sizeBytes: number
    producerRunId: string
  }
): boolean => {
  const targetEntityId = `artifact-version:${expected.versionId}`
  const target = graph.entities.find((entity) => entity.entityId === graph.targetEntityId)
  const publicationActivityId = `artifact-publication:${expected.versionId}`
  return (
    graph.targetEntityId === targetEntityId &&
    target?.kind === 'artifact-version' &&
    target.versionId === expected.versionId &&
    target.filename === expected.filename &&
    target.checksum === expected.checksum &&
    target.sizeBytes === expected.sizeBytes &&
    graph.activities.some(
      (activity) =>
        activity.activityId === publicationActivityId &&
        activity.kind === 'artifact-publication' &&
        activity.parentActivityId === expected.producerRunId
    ) &&
    graph.edges.some(
      (edge) =>
        edge.kind === 'generated' &&
        edge.activityId === publicationActivityId &&
        edge.entityId === targetEntityId &&
        edge.authority === 'authoritative' &&
        edge.evidenceSource === 'artifact-publication'
    )
  )
}

export {
  artifactProvenanceGraphMatchesTarget,
  artifactProvenanceGraphValue,
  sealArtifactProvenanceGraph
}
export type {
  ArtifactProvenanceComputeActivityInput,
  ArtifactProvenanceNotebookActivityInput,
  SealArtifactProvenanceGraphInput
}
