import type {
  ArtifactPackageSourceEvidence,
  ArtifactVersionCoreProvenance,
  ArtifactVersionEnvironmentEvidence,
  GetArtifactVersionProvenanceRequest
} from '../../shared/artifact-provenance'
import { isArtifactNotebookProducer } from '../../shared/artifact-provenance'
import type {
  HostLineageDependencyRelation,
  HostLineageDirection,
  HostLineageEdge,
  HostLineageGraph,
  HostLineageNode,
  HostLineageVersion
} from '../../shared/host-lineage'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import { isRecord } from '../value-guards'

type HostLineageReadContext = { projectId: string; sessionId: string }

type HostLineageServiceOptions = {
  catalog: {
    readHostArtifactCatalog(request: {
      projectId: string
      versionId?: string
    }): Promise<HostArtifactCatalogItem[]>
  }
  provenance: {
    readDependencyRelations(request: {
      projectId: string
      versionId: string
      direction: HostLineageDirection
    }): Promise<HostLineageDependencyRelation[]>
    getVersionCore(
      request: GetArtifactVersionProvenanceRequest
    ): Promise<ArtifactVersionCoreProvenance>
  }
}

const GRAPH_OPTION_KEYS = new Set(['direction', 'max_depth', 'max_nodes'])
const ENVIRONMENT_ATTEMPT_REASONS = new Set([
  'package-not-found',
  'solver-failed',
  'installer-unavailable',
  'permission',
  'network',
  'authentication',
  'tls-policy',
  'validation',
  'cancelled',
  'process-unconfirmed',
  'recovery-blocked',
  'unknown'
])
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const projectPackageSource = (value: unknown): ArtifactPackageSourceEvidence => {
  if (!isRecord(value) || (value.type !== 'github' && value.type !== 'bioconductor')) {
    throw new Error('Artifact Version package source evidence is corrupt.')
  }
  if (value.type === 'github') {
    if (
      Object.keys(value).some((key) => !['type', 'repository', 'ref', 'commit'].includes(key)) ||
      typeof value.repository !== 'string' ||
      (value.ref !== undefined && typeof value.ref !== 'string') ||
      (value.commit !== undefined && typeof value.commit !== 'string')
    ) {
      throw new Error('Artifact Version package source evidence is corrupt.')
    }
    return {
      type: value.type,
      repository: value.repository,
      ...(value.ref !== undefined ? { ref: value.ref } : {}),
      ...(value.commit !== undefined ? { commit: value.commit } : {})
    }
  }
  if (
    Object.keys(value).some((key) => !['type', 'version'].includes(key)) ||
    (value.version !== undefined && typeof value.version !== 'string')
  ) {
    throw new Error('Artifact Version package source evidence is corrupt.')
  }
  return { type: value.type, ...(value.version !== undefined ? { version: value.version } : {}) }
}

const normalizeGraphOptions = (
  value: unknown
): { direction: HostLineageDirection; maxDepth: number; maxNodes: number } => {
  if (value === undefined) value = {}
  if (!isRecord(value)) throw new Error('host.lineage.graph options must be an object.')
  const unknown = Object.keys(value).find((key) => !GRAPH_OPTION_KEYS.has(key))
  if (unknown) throw new Error(`host.lineage.graph unknown option: ${unknown}`)

  const direction = value.direction ?? 'up'
  if (direction !== 'up' && direction !== 'down') {
    throw new Error("host.lineage.graph direction must be 'up' or 'down'.")
  }
  const maxDepth = value.max_depth ?? 5
  if (!Number.isInteger(maxDepth) || (maxDepth as number) < 0 || (maxDepth as number) > 20) {
    throw new Error('host.lineage.graph max_depth must be an integer between 0 and 20.')
  }
  const maxNodes = value.max_nodes ?? 100
  if (!Number.isInteger(maxNodes) || (maxNodes as number) < 1 || (maxNodes as number) > 500) {
    throw new Error('host.lineage.graph max_nodes must be an integer between 1 and 500.')
  }
  return { direction, maxDepth: maxDepth as number, maxNodes: maxNodes as number }
}

const toNode = (item: HostArtifactCatalogItem): HostLineageNode => {
  if (
    !Number.isSafeInteger(item.versionNumber) ||
    !item.createdAt ||
    !item.checksum ||
    item.agentFrameId === undefined
  ) {
    throw new Error(`Artifact Version metadata is incomplete: ${item.versionId}`)
  }
  return {
    file_id: item.sourceFileId,
    version_id: item.versionId,
    filename: item.filename,
    version_number: item.versionNumber!,
    session_id: item.sessionId,
    root_frame_id: item.rootFrameId,
    agent_frame_id: item.agentFrameId,
    created_at: item.createdAt,
    ...(item.contentType ? { content_type: item.contentType } : {}),
    size_bytes: item.sizeBytes,
    checksum: item.checksum,
    is_user_upload: item.source === 'upload'
  }
}

const toEdge = (relation: HostLineageDependencyRelation): HostLineageEdge => ({
  version_id: relation.versionId,
  depends_on_version_id: relation.dependsOnVersionId,
  ordinal: relation.ordinal,
  source_kind: relation.sourceKind,
  input_filename: relation.inputFilename,
  association: relation.association
})

const projectAvailability = (
  value: ArtifactVersionCoreProvenance['evidence']['execution_status']
): HostLineageVersion['execution_status'] =>
  value.state === 'unavailable'
    ? { state: value.state, reason: value.reason }
    : { state: value.state }

const projectProducer = (
  value: ArtifactVersionCoreProvenance['evidence']['producer']
): HostLineageVersion['producer'] =>
  value.state === 'unavailable'
    ? { state: value.state, reason: value.reason }
    : isArtifactNotebookProducer(value)
      ? {
          state: value.state,
          notebook_session_id: value.notebook_session_id,
          producer_run_id: value.producer_run_id,
          run_index: value.run_index,
          kernel_kind: value.kernel_kind,
          association_method: value.association_method,
          ...(value.environment_manifest_checksum
            ? { environment_manifest_checksum: value.environment_manifest_checksum }
            : {})
        }
      : {
          state: value.state,
          kind: value.kind,
          connector_id: value.connector_id,
          tool_id: value.tool_id,
          invocation_id: value.invocation_id,
          implementation_version: value.implementation_version,
          arguments_checksum: value.arguments_checksum,
          association_method: value.association_method
        }

const projectEnvironment = (
  value: ArtifactVersionEnvironmentEvidence
): ArtifactVersionEnvironmentEvidence => {
  if (
    value.op_log?.some((entry) =>
      entry.attempts.some(
        (attempt) =>
          attempt.reason !== undefined && !ENVIRONMENT_ATTEMPT_REASONS.has(attempt.reason)
      )
    ) ||
    (value.op_log_truncation !== undefined &&
      (!Number.isSafeInteger(value.op_log_truncation.omitted_count) ||
        value.op_log_truncation.omitted_count <= 0))
  ) {
    throw new Error('Artifact Version environment evidence is corrupt.')
  }

  return {
    capture_kind: value.capture_kind,
    environment_name: value.environment_name,
    kernel_kind: value.kernel_kind,
    runtime_source: value.runtime_source,
    ...(value.runtime_version ? { runtime_version: value.runtime_version } : {}),
    ...(value.platform ? { platform: value.platform } : {}),
    ...(value.architecture ? { architecture: value.architecture } : {}),
    packages: value.packages.map((entry) => ({
      name: entry.name,
      ...(entry.version ? { version: entry.version } : {}),
      version_status: entry.version_status,
      ecosystem: entry.ecosystem,
      evidence_sources: [...entry.evidence_sources],
      loaded_state: entry.loaded_state,
      ...(entry.library_rank !== undefined ? { library_rank: entry.library_rank } : {}),
      ...(entry.library_scope ? { library_scope: entry.library_scope } : {}),
      ...(entry.built_for_runtime ? { built_for_runtime: entry.built_for_runtime } : {}),
      ...(entry.priority ? { priority: entry.priority } : {}),
      ...(entry.source !== undefined ? { source: projectPackageSource(entry.source) } : {})
    })),
    ...(value.python_version ? { python_version: value.python_version } : {}),
    ...(value.r_version ? { r_version: value.r_version } : {}),
    inventory_sources: [...value.inventory_sources],
    installed_inventory: {
      captured_at: value.installed_inventory.captured_at,
      source: value.installed_inventory.source,
      validation: value.installed_inventory.validation
    },
    ...(value.op_log
      ? {
          op_log: value.op_log.map((entry) => ({
            operation_id: entry.operation_id,
            timestamp: entry.timestamp,
            operation: entry.operation,
            packages: [...entry.packages],
            result: entry.result,
            attempts: entry.attempts.map((attempt) => ({
              group_ordinal: attempt.group_ordinal,
              installer: attempt.installer,
              packages: [...attempt.packages],
              status: attempt.status,
              mutation_risk: attempt.mutation_risk,
              ...(attempt.reason !== undefined ? { reason: attempt.reason } : {})
            })),
            fallback_used: entry.fallback_used,
            inventory_refresh: entry.inventory_refresh,
            inventory_refresh_attempts: entry.inventory_refresh_attempts.map((attempt) => ({
              attempt: attempt.attempt,
              trigger: attempt.trigger,
              timestamp: attempt.timestamp,
              result: attempt.result,
              ...(attempt.error ? { error: attempt.error } : {})
            })),
            ...(entry.package_changes
              ? {
                  package_changes: entry.package_changes.map((change) => ({
                    name: change.name,
                    ecosystem: change.ecosystem,
                    relationship: change.relationship,
                    change: change.change,
                    ...(change.before_version ? { before_version: change.before_version } : {}),
                    ...(change.after_version ? { after_version: change.after_version } : {}),
                    ...(change.library_rank !== undefined
                      ? { library_rank: change.library_rank }
                      : {}),
                    ...(change.library_scope ? { library_scope: change.library_scope } : {}),
                    ...(change.source !== undefined
                      ? { source: projectPackageSource(change.source) }
                      : {})
                  }))
                }
              : {})
          }))
        }
      : {}),
    ...(value.op_log_truncation
      ? {
          op_log_truncation: {
            omitted_count: value.op_log_truncation.omitted_count,
            ...(value.op_log_truncation.earliest_retained_at
              ? { earliest_retained_at: value.op_log_truncation.earliest_retained_at }
              : {})
          }
        }
      : {}),
    captured_at: value.captured_at,
    source_manifest_checksum: value.source_manifest_checksum,
    complete: value.complete,
    capture_status: value.capture_status,
    ...(value.warnings ? { warnings: [...value.warnings] } : {})
  }
}

class HostLineageService {
  constructor(private readonly options: HostLineageServiceOptions) {}

  async get(versionIdValue: unknown, context: HostLineageReadContext): Promise<HostLineageVersion> {
    if (typeof versionIdValue !== 'string' || !versionIdValue) {
      throw new Error('host.lineage.get version_id must be a non-empty string.')
    }
    const items = await this.options.catalog.readHostArtifactCatalog({
      projectId: context.projectId,
      versionId: versionIdValue
    })
    if (items.length !== 1) {
      throw new Error(`Artifact Version not found in the current Project: ${versionIdValue}`)
    }
    const item = items[0]
    if (item.projectId !== context.projectId || item.versionId !== versionIdValue) {
      throw new Error(`Artifact Version identity is corrupt: ${versionIdValue}`)
    }
    if (item.source === 'upload') throw new Error('Upload has no generated lineage.')
    const core = await this.options.provenance.getVersionCore({
      projectId: context.projectId,
      appSessionId: item.sessionId,
      artifactId: item.sourceFileId,
      versionId: item.versionId
    })
    const { descriptor, evidence } = core
    if (
      descriptor.artifactId !== item.sourceFileId ||
      descriptor.versionId !== item.versionId ||
      descriptor.versionNumber !== item.versionNumber ||
      descriptor.name !== item.filename ||
      descriptor.sessionId !== item.sessionId ||
      descriptor.createdAt !== item.createdAt ||
      descriptor.size !== item.sizeBytes ||
      descriptor.checksum !== item.checksum ||
      descriptor.mimeType !== item.contentType ||
      evidence.project_id !== context.projectId ||
      evidence.app_session_id !== item.sessionId ||
      evidence.artifact_id !== item.sourceFileId ||
      evidence.version_id !== item.versionId ||
      evidence.version_number !== item.versionNumber ||
      evidence.filename !== item.filename ||
      evidence.created_at !== item.createdAt ||
      evidence.size_bytes !== item.sizeBytes ||
      evidence.checksum !== item.checksum ||
      evidence.content_type !== item.contentType ||
      evidence.conversation.root_frame_id !== item.rootFrameId ||
      evidence.conversation.agent_frame_id !== item.agentFrameId ||
      evidence.is_user_upload !== false ||
      evidence.inputs.some(
        (input, ordinal) =>
          input.ordinal !== ordinal || input.source_project_id !== context.projectId
      )
    ) {
      throw new Error(`Artifact Version core provenance is corrupt: ${versionIdValue}`)
    }
    const relations = await this.options.provenance.readDependencyRelations({
      projectId: context.projectId,
      versionId: item.versionId,
      direction: 'up'
    })
    relations.sort((left, right) => left.ordinal - right.ordinal)
    if (relations.length !== evidence.inputs.length) {
      throw new Error(`Artifact Version core provenance is corrupt: ${versionIdValue}`)
    }
    for (const [ordinal, input] of evidence.inputs.entries()) {
      const relation = relations[ordinal]
      const sourceItems = await this.options.catalog.readHostArtifactCatalog({
        projectId: context.projectId,
        versionId: input.input_file_version_id
      })
      const source = sourceItems[0]
      if (
        sourceItems.length !== 1 ||
        !source ||
        source.projectId !== context.projectId ||
        source.versionId !== input.input_file_version_id ||
        source.sourceFileId !== input.source_file_id ||
        source.source !== (input.source_kind === 'artifact-version' ? 'artifact' : 'upload') ||
        source.versionNumber !== input.source_version_number ||
        source.sourceCreatedAt !== input.source_created_at ||
        source.sessionId !== input.source_session_id ||
        source.filename !== input.filename ||
        source.contentType !== input.content_type ||
        source.sizeBytes !== input.size_bytes ||
        source.checksum !== input.checksum ||
        relation?.versionId !== item.versionId ||
        relation.dependsOnVersionId !== input.input_file_version_id ||
        relation.ordinal !== ordinal ||
        relation.sourceKind !== input.source_kind ||
        relation.inputFilename !== input.filename ||
        relation.association !== input.strongest_association
      ) {
        throw new Error(`Artifact Version core provenance is corrupt: ${versionIdValue}`)
      }
    }

    return {
      project_id: evidence.project_id,
      artifact_id: evidence.artifact_id,
      version_id: evidence.version_id,
      filename: evidence.filename,
      version_number: evidence.version_number,
      session_id: evidence.app_session_id,
      root_frame_id: evidence.conversation.root_frame_id,
      agent_frame_id: evidence.conversation.agent_frame_id,
      message_branch_id: evidence.conversation.message_branch_id,
      runtime_segment_id: evidence.conversation.runtime_segment_id,
      prompt_message_id: evidence.conversation.prompt_message_id,
      created_at: evidence.created_at,
      ...(evidence.content_type ? { content_type: evidence.content_type } : {}),
      size_bytes: evidence.size_bytes,
      checksum: evidence.checksum,
      ...(evidence.agent_name ? { agent_name: evidence.agent_name } : {}),
      content_status:
        core.contentStatus.state === 'available'
          ? { state: core.contentStatus.state }
          : { state: core.contentStatus.state, reason: core.contentStatus.reason },
      ...(evidence.reproduction_code ? { reproduction_code: evidence.reproduction_code } : {}),
      execution_status: projectAvailability(evidence.execution_status),
      producer: projectProducer(evidence.producer),
      environment_status: projectAvailability(evidence.environment_status),
      ...(evidence.environment ? { environment: projectEnvironment(evidence.environment) } : {}),
      inputs: evidence.inputs.map((input) => ({
        ordinal: input.ordinal,
        version_id: input.input_file_version_id,
        file_id: input.source_file_id,
        source_kind: input.source_kind,
        ...(input.source_version_number !== undefined
          ? { version_number: input.source_version_number }
          : {}),
        ...(input.source_created_at ? { created_at: input.source_created_at } : {}),
        session_id: input.source_session_id,
        filename: input.filename,
        ...(input.content_type ? { content_type: input.content_type } : {}),
        size_bytes: input.size_bytes,
        checksum: input.checksum,
        association: input.strongest_association
      }))
    }
  }

  async graph(
    versionIdValue: unknown,
    optionsValue: unknown,
    context: HostLineageReadContext
  ): Promise<HostLineageGraph> {
    if (typeof versionIdValue !== 'string' || !versionIdValue) {
      throw new Error('host.lineage.graph version_id must be a non-empty string.')
    }
    const { direction, maxDepth, maxNodes } = normalizeGraphOptions(optionsValue)
    const resolveNode = async (versionId: string): Promise<HostLineageNode> => {
      const items = await this.options.catalog.readHostArtifactCatalog({
        projectId: context.projectId,
        versionId
      })
      if (items.length !== 1) {
        throw new Error(`Artifact Version not found in the current Project: ${versionId}`)
      }
      const item = items[0]
      if (item.projectId !== context.projectId || item.versionId !== versionId) {
        throw new Error(`Artifact Version identity is corrupt: ${versionId}`)
      }
      return toNode(item)
    }

    const nodes = [await resolveNode(versionIdValue)]
    const edges: HostLineageEdge[] = []
    const maxDepthFrontier: string[] = []
    const omittedNodeFrontier: string[] = []
    let pendingNodeFrontier: string[] = []
    let maxNodesTruncated = false
    const visited = new Set([versionIdValue])
    const queue = [{ versionId: versionIdValue, depth: 0 }]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (maxNodesTruncated) {
        pendingNodeFrontier = [current.versionId, ...queue.map((entry) => entry.versionId)]
        break
      }
      const relations = await this.options.provenance.readDependencyRelations({
        projectId: context.projectId,
        versionId: current.versionId,
        direction
      })
      relations.sort((left, right) =>
        direction === 'up'
          ? left.ordinal - right.ordinal ||
            compareText(left.sourceKind, right.sourceKind) ||
            compareText(left.dependsOnVersionId, right.dependsOnVersionId)
          : compareText(left.versionId, right.versionId) || left.ordinal - right.ordinal
      )
      const neighbors = relations.map((relation) => {
        if (
          (direction === 'up' && relation.versionId !== current.versionId) ||
          (direction === 'down' && relation.dependsOnVersionId !== current.versionId)
        ) {
          throw new Error(`Artifact dependency relation is corrupt: ${current.versionId}`)
        }
        return direction === 'up' ? relation.dependsOnVersionId : relation.versionId
      })
      if (current.depth >= maxDepth) {
        if (neighbors.some((versionId) => !visited.has(versionId))) {
          maxDepthFrontier.push(current.versionId)
        }
        continue
      }
      for (const relation of relations) {
        const neighborVersionId =
          direction === 'up' ? relation.dependsOnVersionId : relation.versionId
        if (visited.has(neighborVersionId)) {
          edges.push(toEdge(relation))
          continue
        }
        if (nodes.length >= maxNodes) {
          maxNodesTruncated = true
          omittedNodeFrontier.push(neighborVersionId)
          continue
        }
        edges.push(toEdge(relation))
        visited.add(neighborVersionId)
        nodes.push(await resolveNode(neighborVersionId))
        queue.push({ versionId: neighborVersionId, depth: current.depth + 1 })
      }
    }

    const maxNodesFrontier = [...new Set([...pendingNodeFrontier, ...omittedNodeFrontier])]
    const truncated = maxNodesFrontier.length > 0 || maxDepthFrontier.length > 0
    const truncation =
      maxNodesFrontier.length > 0
        ? { truncation_reason: 'max_nodes' as const, frontier_version_ids: maxNodesFrontier }
        : maxDepthFrontier.length > 0
          ? { truncation_reason: 'max_depth' as const, frontier_version_ids: maxDepthFrontier }
          : {}

    return {
      project_id: context.projectId,
      root_version_id: versionIdValue,
      direction,
      truncated,
      ...truncation,
      nodes,
      edges
    }
  }
}

export { HostLineageService }
export type { HostLineageReadContext, HostLineageServiceOptions }
