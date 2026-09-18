import type {
  ArtifactReproducibilityActivity,
  ArtifactReproducibilityEntity,
  ArtifactReproducibilityOutputGroup,
  ArtifactReproducibilityProjection,
  ArtifactReproducibilityStartFrontier
} from '../../../../shared/artifact-provenance'

export type GraphNode =
  | { key: string; kind: 'activity'; value: ArtifactReproducibilityActivity }
  | { key: string; kind: 'entity'; value: ArtifactReproducibilityEntity }
  | { key: string; kind: 'output-group'; value: ArtifactReproducibilityOutputGroup }

export type PositionedNode = GraphNode & { x: number; y: number }

export type DisplayEdge = {
  key: string
  sourceKey: string
  targetKey: string
  relation: 'provenance' | 'contains' | 'publication'
  authority: 'authoritative' | 'advisory'
  conservative: boolean
}

export const NODE_WIDTH = 224
export const NODE_HEIGHT = 56
export const NODE_ICON_SIZE = 28
export const NODE_ICON_X = 12
export const NODE_ICON_Y = (NODE_HEIGHT - NODE_ICON_SIZE) / 2
const COLUMN_GAP = 88
const VERTICAL_GAP = 40
const ROW_GAP = 24
const PADDING = 24

export const graphNodeKey = (kind: GraphNode['kind'], id: string): string => `${kind}:${id}`

export const displayGraph = (
  projection: ArtifactReproducibilityProjection,
  expandedOutputIds: ReadonlySet<string>
): { nodes: GraphNode[]; edges: DisplayEdge[] } => {
  const outputGroups = projection.outputGroups ?? []
  const publicationActivityIds = new Set(
    projection.activities
      .filter((activity) => activity.kind === 'artifact-publication')
      .map((activity) => activity.activityId)
  )
  const groupByMemberId = new Map<string, ArtifactReproducibilityOutputGroup>()
  for (const group of outputGroups) {
    for (const entityId of group.memberEntityIds) groupByMemberId.set(entityId, group)
  }

  const nodes: GraphNode[] = [
    ...projection.activities.flatMap((value): GraphNode[] =>
      value.kind === 'artifact-publication'
        ? []
        : [{ key: graphNodeKey('activity', value.activityId), kind: 'activity', value }]
    ),
    ...outputGroups.map((value): GraphNode => ({
      key: graphNodeKey('output-group', value.outputId),
      kind: 'output-group',
      value
    })),
    ...projection.entities.flatMap((value): GraphNode[] => {
      const group = groupByMemberId.get(value.entityId)
      if (group && !expandedOutputIds.has(group.outputId)) return []
      return [{ key: graphNodeKey('entity', value.entityId), kind: 'entity', value }]
    })
  ]
  const edges = new Map<string, DisplayEdge>()
  const addEdge = (edge: DisplayEdge): void => {
    const current = edges.get(edge.key)
    if (!current) {
      edges.set(edge.key, edge)
      return
    }
    if (edge.authority === 'advisory') current.authority = 'advisory'
    if (edge.conservative) current.conservative = true
  }

  const entityNodeKey = (entityId: string): string => {
    const group = groupByMemberId.get(entityId)
    if (!group || expandedOutputIds.has(group.outputId)) return graphNodeKey('entity', entityId)
    return graphNodeKey('output-group', group.outputId)
  }

  for (const activity of projection.activities) {
    if (activity.kind !== 'artifact-publication') continue
    const inputs = projection.edges.flatMap((edge) =>
      edge.kind === 'used' && edge.activityId === activity.activityId ? [edge] : []
    )
    const outputs = projection.edges.flatMap((edge) =>
      edge.kind === 'generated' && edge.activityId === activity.activityId ? [edge] : []
    )
    for (const input of inputs) {
      for (const output of outputs) {
        const sourceKey = entityNodeKey(input.entityId)
        const targetKey = entityNodeKey(output.entityId)
        addEdge({
          key: `${sourceKey}->${targetKey}:publication`,
          sourceKey,
          targetKey,
          relation: 'publication',
          authority:
            input.authority === 'advisory' || output.authority === 'advisory'
              ? 'advisory'
              : 'authoritative',
          conservative:
            input.evidenceSource === 'conservative-fallback' ||
            output.evidenceSource === 'conservative-fallback'
        })
      }
    }
  }

  for (const edge of projection.edges) {
    if (publicationActivityIds.has(edge.activityId)) continue
    const activityKey = graphNodeKey('activity', edge.activityId)
    if (edge.kind === 'depends-on') {
      const sourceKey = graphNodeKey('activity', edge.dependencyActivityId)
      addEdge({
        key: `${sourceKey}->${activityKey}:depends-on`,
        sourceKey,
        targetKey: activityKey,
        relation: 'provenance',
        authority: edge.authority,
        conservative: edge.evidenceSource === 'conservative-fallback'
      })
      continue
    }
    const entityKey = graphNodeKey('entity', edge.entityId)
    const group = groupByMemberId.get(edge.entityId)
    const groupKey = group ? graphNodeKey('output-group', group.outputId) : undefined
    const expanded = group ? expandedOutputIds.has(group.outputId) : false
    const sourceKey =
      edge.kind === 'used' ? (group ? (expanded ? entityKey : groupKey) : entityKey) : activityKey
    const targetKey = edge.kind === 'used' ? activityKey : (groupKey ?? entityKey)
    if (!sourceKey || !targetKey) continue
    const key = `${sourceKey}->${targetKey}`
    addEdge({
      key,
      sourceKey,
      targetKey,
      relation: 'provenance',
      authority: edge.authority,
      conservative: edge.evidenceSource === 'conservative-fallback'
    })
  }

  for (const group of outputGroups) {
    if (!expandedOutputIds.has(group.outputId)) continue
    const sourceKey = graphNodeKey('output-group', group.outputId)
    for (const entityId of group.memberEntityIds) {
      const targetKey = graphNodeKey('entity', entityId)
      addEdge({
        key: `${sourceKey}->${targetKey}:contains`,
        sourceKey,
        targetKey,
        relation: 'contains',
        authority: 'authoritative',
        conservative: false
      })
    }
  }

  const displayEdges = [...edges.values()]
  const connectedNodeKeys = new Set(
    displayEdges.flatMap((edge) => [edge.sourceKey, edge.targetKey])
  )

  return {
    nodes: nodes.filter((node) => connectedNodeKeys.has(node.key)),
    edges: displayEdges
  }
}

export const upstreamNodeKeys = (
  display: { nodes: GraphNode[]; edges: DisplayEdge[] },
  startKey: string
): Set<string> => {
  const incoming = new Map<string, string[]>()
  for (const edge of display.edges) {
    incoming.set(edge.targetKey, [...(incoming.get(edge.targetKey) ?? []), edge.sourceKey])
  }
  const keys = new Set<string>()
  const queue = [startKey]
  while (queue.length > 0) {
    const key = queue.shift()!
    if (keys.has(key)) continue
    keys.add(key)
    queue.push(...(incoming.get(key) ?? []))
  }
  return keys
}

export const relatedNodeKeys = (
  display: { nodes: GraphNode[]; edges: DisplayEdge[] },
  startKey: string
): Set<string> => {
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of display.edges) {
    incoming.set(edge.targetKey, [...(incoming.get(edge.targetKey) ?? []), edge.sourceKey])
    outgoing.set(edge.sourceKey, [...(outgoing.get(edge.sourceKey) ?? []), edge.targetKey])
  }
  const keys = new Set([startKey])
  for (const adjacency of [incoming, outgoing]) {
    const visited = new Set<string>()
    const queue = [startKey]
    while (queue.length > 0) {
      const key = queue.shift()!
      if (visited.has(key)) continue
      visited.add(key)
      keys.add(key)
      queue.push(...(adjacency.get(key) ?? []))
    }
  }
  return keys
}

export const filterDisplayGraph = (
  display: { nodes: GraphNode[]; edges: DisplayEdge[] },
  includedKeys: ReadonlySet<string>
): { nodes: GraphNode[]; edges: DisplayEdge[] } => ({
  nodes: display.nodes.filter((node) => includedKeys.has(node.key)),
  edges: display.edges.filter(
    (edge) => includedKeys.has(edge.sourceKey) && includedKeys.has(edge.targetKey)
  )
})

export const graphEdgePath = (
  source: PositionedNode,
  target: PositionedNode,
  orientation: 'horizontal' | 'vertical'
): string => {
  if (orientation === 'horizontal') {
    const startX = source.x + NODE_WIDTH
    const startY = source.y + NODE_HEIGHT / 2
    const endX = target.x
    const endY = target.y + NODE_HEIGHT / 2
    const controlOffset = Math.max(28, (endX - startX) * 0.45)
    return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`
  }
  const startX = source.x + NODE_WIDTH / 2
  const startY = source.y + NODE_HEIGHT
  const endX = target.x + NODE_WIDTH / 2
  const endY = target.y
  const controlOffset = Math.max(28, (endY - startY) * 0.45)
  return `M ${startX} ${startY} C ${startX} ${startY + controlOffset}, ${endX} ${endY - controlOffset}, ${endX} ${endY}`
}

export const graphEdgeLabelPosition = (
  source: PositionedNode,
  target: PositionedNode,
  orientation: 'horizontal' | 'vertical'
): { x: number; y: number } =>
  orientation === 'horizontal'
    ? {
        x: (source.x + NODE_WIDTH + target.x) / 2,
        y: (source.y + target.y) / 2 + NODE_HEIGHT / 2
      }
    : {
        x: (source.x + target.x) / 2 + NODE_WIDTH / 2,
        y: (source.y + NODE_HEIGHT + target.y) / 2
      }

export const scopedNodeKeys = (
  projection: ArtifactReproducibilityProjection,
  frontier: ArtifactReproducibilityStartFrontier | undefined
): Set<string> => {
  const outputGroups = projection.outputGroups ?? []
  if (!frontier || frontier.kind === 'original-inputs') {
    const keys = new Set([
      ...projection.activities.map((activity) => graphNodeKey('activity', activity.activityId)),
      ...projection.entities.map((entity) => graphNodeKey('entity', entity.entityId))
    ])
    for (const group of outputGroups) {
      keys.add(graphNodeKey('output-group', group.outputId))
    }
    return keys
  }
  const activityIds = new Set(frontier.downstreamActivityIds)
  const entityIds = new Set([projection.targetEntityId, ...frontier.crossingEntityIds])
  for (const edge of projection.edges) {
    if (edge.kind !== 'depends-on' && activityIds.has(edge.activityId)) {
      entityIds.add(edge.entityId)
    }
  }
  const keys = new Set([
    ...[...activityIds].map((id) => graphNodeKey('activity', id)),
    ...[...entityIds].map((id) => graphNodeKey('entity', id))
  ])
  for (const group of outputGroups) {
    if (group.memberEntityIds.some((entityId) => entityIds.has(entityId))) {
      keys.add(graphNodeKey('output-group', group.outputId))
    }
  }
  return keys
}

export const layoutGraph = (
  display: { nodes: GraphNode[]; edges: DisplayEdge[] },
  orientation: 'horizontal' | 'vertical'
): {
  nodes: PositionedNode[]
  width: number
  height: number
  orientation: 'horizontal' | 'vertical'
} => {
  const rankByKey = new Map(display.nodes.map((node) => [node.key, 0]))
  const indegree = new Map(display.nodes.map((node) => [node.key, 0]))
  const outgoing = new Map<string, DisplayEdge[]>()
  for (const edge of display.edges) {
    indegree.set(edge.targetKey, (indegree.get(edge.targetKey) ?? 0) + 1)
    outgoing.set(edge.sourceKey, [...(outgoing.get(edge.sourceKey) ?? []), edge])
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) => left.targetKey.localeCompare(right.targetKey))
  }
  const queue = display.nodes
    .filter((node) => (indegree.get(node.key) ?? 0) === 0)
    .map((node) => node.key)
    .sort()
  let queueIndex = 0
  while (queueIndex < queue.length) {
    const key = queue[queueIndex++]!
    for (const edge of outgoing.get(key) ?? []) {
      rankByKey.set(
        edge.targetKey,
        Math.max(rankByKey.get(edge.targetKey) ?? 0, (rankByKey.get(key) ?? 0) + 1)
      )
      const nextIndegree = (indegree.get(edge.targetKey) ?? 1) - 1
      indegree.set(edge.targetKey, nextIndegree)
      if (nextIndegree === 0) queue.push(edge.targetKey)
    }
  }

  const columns = new Map<number, GraphNode[]>()
  for (const node of display.nodes) {
    const rank = rankByKey.get(node.key) ?? 0
    columns.set(rank, [...(columns.get(rank) ?? []), node])
  }

  const nodes: PositionedNode[] = []
  const orderedRanks = [...columns.keys()].sort((left, right) => left - right)
  const incoming = new Map<string, string[]>()
  for (const edge of display.edges) {
    incoming.set(edge.targetKey, [...(incoming.get(edge.targetKey) ?? []), edge.sourceKey])
  }
  const orderByKey = new Map<string, number>()
  orderedRanks.forEach((rank) => {
    const column = columns.get(rank) ?? []
    column.sort((left, right) => {
      const score = (node: GraphNode): number => {
        const predecessors = incoming.get(node.key) ?? []
        if (predecessors.length === 0) return Number.POSITIVE_INFINITY
        return (
          predecessors.reduce((sum, key) => sum + (orderByKey.get(key) ?? 0), 0) /
          predecessors.length
        )
      }
      const scoreDifference = score(left) - score(right)
      return Number.isFinite(scoreDifference) && scoreDifference !== 0
        ? scoreDifference
        : left.key.localeCompare(right.key)
    })
    column.forEach((node, index) => orderByKey.set(node.key, index))
    columns.set(rank, column)
  })
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length))
  const crossAxisStep = orientation === 'horizontal' ? NODE_HEIGHT + ROW_GAP : NODE_WIDTH + ROW_GAP
  orderedRanks.forEach((rank, columnIndex) => {
    const column = columns.get(rank) ?? []
    const crossAxisOffset = ((maxRows - column.length) * crossAxisStep) / 2
    column.forEach((node, row) => {
      nodes.push({
        ...node,
        x:
          orientation === 'horizontal'
            ? PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP)
            : PADDING + crossAxisOffset + row * (NODE_WIDTH + ROW_GAP),
        y:
          orientation === 'horizontal'
            ? PADDING + crossAxisOffset + row * (NODE_HEIGHT + ROW_GAP)
            : PADDING + columnIndex * (NODE_HEIGHT + VERTICAL_GAP)
      })
    })
  })
  const rankCount = Math.max(1, orderedRanks.length)
  return {
    nodes,
    width:
      orientation === 'horizontal'
        ? PADDING * 2 + rankCount * NODE_WIDTH + (rankCount - 1) * COLUMN_GAP
        : PADDING * 2 + maxRows * NODE_WIDTH + (maxRows - 1) * ROW_GAP,
    height:
      orientation === 'horizontal'
        ? PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP
        : PADDING * 2 + rankCount * NODE_HEIGHT + (rankCount - 1) * VERTICAL_GAP,
    orientation
  }
}
