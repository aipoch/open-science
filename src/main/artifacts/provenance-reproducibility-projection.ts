import type {
  ArtifactProvenanceGraph,
  ArtifactProvenanceGraphActivity,
  ArtifactProvenanceGraphEntity,
  ArtifactReproducibilityBarrierReason,
  ArtifactReproducibilityProjection,
  ArtifactReproducibilityStartFrontier,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'

const compareActivities = (
  left: ArtifactProvenanceGraphActivity,
  right: ArtifactProvenanceGraphActivity
): number => left.sequence - right.sequence || left.activityId.localeCompare(right.activityId)

const compareEntities = (
  left: ArtifactProvenanceGraphEntity,
  right: ArtifactProvenanceGraphEntity
): number => left.entityId.localeCompare(right.entityId)

const absolutePathLike = (value: string): boolean =>
  value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)

const basename = (value: string): string =>
  value.split(/[\\/]/).filter(Boolean).at(-1) ?? 'External file'

const displayLabel = (entity: ArtifactProvenanceGraphEntity): string => {
  if (entity.kind !== 'file-generation') {
    return absolutePathLike(entity.filename) ? basename(entity.filename) : entity.filename
  }
  if (entity.pathPortability === 'relative' && !absolutePathLike(entity.relativePath)) {
    return entity.relativePath
  }
  return basename(entity.relativePath)
}

const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

const commonPathPrefix = (paths: string[]): string => {
  if (paths.length === 0) return 'Scientific output'
  let prefix = paths[0]!
  for (const path of paths.slice(1)) {
    while (prefix.length > 0 && !path.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix.replace(/[._/-]+$/u, '') || paths[0]!
}

const fileSetLabel = (members: string[]): string => {
  const prefix = commonPathPrefix(members)
  if (members.includes(prefix)) return prefix

  const filenameStart = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\')) + 1
  const extensionStart = prefix.indexOf('.', filenameStart)
  return extensionStart > filenameStart ? prefix.slice(0, extensionStart) : prefix
}

const outputGroupLabel = (
  members: string[],
  storageShape: 'file-set' | 'directory-tree'
): string => {
  if (storageShape === 'directory-tree') {
    const segments = members.map((member) => member.split('/'))
    const shared: string[] = []
    for (let index = 0; index < Math.min(...segments.map((value) => value.length)); index += 1) {
      const segment = segments[0]?.[index]
      if (!segment || segments.some((value) => value[index] !== segment)) break
      shared.push(segment)
    }
    if (shared.length > 0) return shared.join('/')
  }
  return fileSetLabel(members)
}

const projectOutputGroups = (
  graph: ArtifactProvenanceGraph
): ArtifactReproducibilityProjection['outputGroups'] => {
  const entityById = new Map(graph.entities.map((entity) => [entity.entityId, entity]))
  return (graph.outputGroups ?? []).map((output) => {
    const memberLabels = output.memberEntityIds.flatMap((entityId) => {
      const entity = entityById.get(entityId)
      return entity?.kind === 'file-generation' ? [displayLabel(entity)] : []
    })
    return {
      outputId: output.outputId,
      activityId: output.activityId,
      label: outputGroupLabel(memberLabels, output.storageShape),
      storageShape: output.storageShape,
      ...(output.formatHint ? { formatHint: output.formatHint } : {}),
      memberEntityIds: [...output.memberEntityIds],
      riskCodes: [...output.riskCodes]
    }
  })
}

const projectEntity = (
  entity: ArtifactProvenanceGraphEntity
): ArtifactReproducibilityProjection['entities'][number] => ({
  entityId: entity.entityId,
  kind: entity.kind,
  label: displayLabel(entity),
  checksum: entity.checksum,
  sizeBytes: entity.sizeBytes,
  ...(entity.kind === 'file-generation' ? { pathPortability: entity.pathPortability } : {}),
  ...(entity.kind === 'registered-input-generation' ? { sourceKind: entity.sourceKind } : {})
})

const checkpointFrontiers = (
  graph: ArtifactProvenanceGraph,
  activities: ArtifactProvenanceGraphActivity[]
): ArtifactReproducibilityStartFrontier[] => {
  const activityById = new Map(activities.map((activity) => [activity.activityId, activity]))
  const entityById = new Map(graph.entities.map((entity) => [entity.entityId, entity]))
  const generatedByEntity = new Map(
    graph.edges.flatMap((edge) =>
      edge.kind === 'generated' ? [[edge.entityId, activityById.get(edge.activityId)] as const] : []
    )
  )
  const sequenceCounts = new Map<number, number>()
  for (const activity of activities) {
    sequenceCounts.set(activity.sequence, (sequenceCounts.get(activity.sequence) ?? 0) + 1)
  }

  const frontiers: ArtifactReproducibilityStartFrontier[] = []
  const seenBoundaries = new Set<string>()
  for (const cutoff of activities) {
    if (cutoff.kind === 'artifact-publication') continue
    const downstream = activities.filter((activity) => activity.sequence > cutoff.sequence)
    if (downstream.length === 0) continue
    const downstreamIds = new Set(downstream.map((activity) => activity.activityId))
    const crossingEdges = graph.edges.filter((edge) => {
      if (edge.kind !== 'used' || !downstreamIds.has(edge.activityId)) return false
      const generator = generatedByEntity.get(edge.entityId)
      return !generator || generator.sequence <= cutoff.sequence
    })
    const crossingDependencyEdges = graph.edges.filter((edge) => {
      if (edge.kind !== 'depends-on' || !downstreamIds.has(edge.activityId)) return false
      const dependency = activityById.get(edge.dependencyActivityId)
      return dependency !== undefined && dependency.sequence <= cutoff.sequence
    })
    const crossingEntityIds = uniqueSorted(
      crossingEdges.flatMap((edge) => (edge.kind === 'used' ? [edge.entityId] : []))
    )
    if (crossingEntityIds.length === 0 && crossingDependencyEdges.length === 0) continue

    const boundaryKey = `${crossingEntityIds.join('\u0000')}|${downstream
      .map((activity) => activity.activityId)
      .join('\u0000')}`
    if (seenBoundaries.has(boundaryKey)) continue
    seenBoundaries.add(boundaryKey)

    const reasons = new Set<ArtifactReproducibilityBarrierReason>()
    if (graph.completeness !== 'complete') {
      for (const reason of graph.reasonCodes) reasons.add(reason)
    }
    if ((sequenceCounts.get(cutoff.sequence) ?? 0) > 1) reasons.add('ambiguous-activity-order')
    if (downstream.some((activity) => activity.evidenceState !== 'available')) {
      reasons.add('activity-evidence-not-complete')
    }
    if (
      crossingEdges.some(
        (edge) =>
          edge.authority !== 'authoritative' || edge.evidenceSource === 'conservative-fallback'
      )
    ) {
      reasons.add('advisory-boundary')
    }
    if (crossingDependencyEdges.length > 0) reasons.add('advisory-boundary')
    if (
      crossingEntityIds.some((entityId) => {
        const entity = entityById.get(entityId)
        return (
          entity?.kind === 'file-generation' &&
          (entity.pathPortability === 'absolute' || absolutePathLike(entity.relativePath))
        )
      })
    ) {
      reasons.add('absolute-path-boundary')
    }

    frontiers.push({
      frontierId: `checkpoint:${cutoff.activityId}`,
      kind: 'checkpoint',
      claimScope: 'downstream-only',
      eligibility: reasons.size === 0 ? 'available' : 'blocked',
      afterActivityId: cutoff.activityId,
      crossingEntityIds,
      downstreamActivityIds: downstream.map((activity) => activity.activityId),
      reasonCodes: [...reasons]
    })
  }
  return frontiers
}

export const projectArtifactReproducibility = (
  graph: ArtifactProvenanceGraph,
  runs: ProvenanceNotebookRun[]
): ArtifactReproducibilityProjection => {
  const activities = [...graph.activities].sort(compareActivities)
  const entities = [...graph.entities].sort(compareEntities)
  const includedRunIds = new Set(
    activities
      .filter((activity) => activity.kind === 'notebook-run')
      .map((activity) => activity.activityId)
  )
  const includedNotebookRunCount = runs.filter((run) => includedRunIds.has(run.runId)).length
  const originalInputIds = entities
    .filter((entity) => entity.kind === 'registered-input-generation')
    .map((entity) => entity.entityId)

  return {
    completeness: graph.completeness,
    reasonCodes: [...graph.reasonCodes],
    targetEntityId: graph.targetEntityId,
    activities: activities.map((activity) => ({
      activityId: activity.activityId,
      kind: activity.kind,
      sequence: activity.sequence,
      ...(activity.runIndex === undefined ? {} : { runIndex: activity.runIndex }),
      inclusion: activity.inclusion,
      evidenceState: activity.evidenceState
    })),
    entities: entities.map(projectEntity),
    outputGroups: projectOutputGroups(graph),
    edges: graph.edges.map((edge) =>
      edge.kind === 'depends-on'
        ? {
            kind: edge.kind,
            activityId: edge.activityId,
            dependencyActivityId: edge.dependencyActivityId,
            authority: edge.authority,
            evidenceSource: edge.evidenceSource
          }
        : {
            kind: edge.kind,
            activityId: edge.activityId,
            entityId: edge.entityId,
            authority: edge.authority,
            evidenceSource: edge.evidenceSource
          }
    ),
    startFrontiers: [
      {
        frontierId: 'original-inputs',
        kind: 'original-inputs',
        claimScope: 'end-to-end',
        eligibility: graph.completeness === 'complete' ? 'available' : 'limited',
        crossingEntityIds: originalInputIds,
        downstreamActivityIds: activities.map((activity) => activity.activityId),
        reasonCodes: [...graph.reasonCodes]
      },
      ...checkpointFrontiers(graph, activities)
    ],
    executionRunCount: runs.length,
    includedNotebookRunCount,
    skippedRunCount: runs.length - includedNotebookRunCount
  }
}
