import { constants, type Stats } from 'node:fs'
import { lstat, open, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { artifactProvenanceGraphMatchesTarget } from './artifact-provenance-graph'
import { isArtifactOutputDeliveryPath, parseArtifactOutputDelivery } from './output-delivery'
import { sha256 } from './provenance-canonical'
import { decodeArtifactExecutionSnapshot } from './provenance-execution-snapshot-decoder'
import { digestOpenFileWithinBudget } from '../bounded-file-io'
import { projectFolderFileIdentity } from '../project-folders/staged-files'
import {
  getArtifactSessionOutputRelativePath,
  getNotebookSessionOutputRelativePath,
  isOwnedProjectNotebookOutputDirectory
} from '../projects/session-output-layout'

export type PublishedArtifactFolderRecord = {
  sessionId: string
  versionId: string
  filename: string
  checksum: string
  sizeBytes: bigint
  agentFrameId: string | null
  producerRunId: string | null
  executionSnapshotJson: string | null
  executionSnapshotChecksum: string | null
  outputDeliveryJson: string | null
}

export type ReadPublishedArtifactFolderRecords = (
  projectId: string,
  sessionId: string,
  relativePath: string,
  source: 'delivery' | 'notebook'
) => Promise<PublishedArtifactFolderRecord[]>

function matchesDelivery(
  record: PublishedArtifactFolderRecord,
  projectId: string,
  relativePath: string,
  rootIdentity: string,
  info: Stats
): boolean {
  const delivery = parseArtifactOutputDelivery(record.outputDeliveryJson)
  const baseline = delivery?.lastDelivered
  return (
    delivery?.relativePath === relativePath &&
    isArtifactOutputDeliveryPath(
      getArtifactSessionOutputRelativePath(projectId, record.sessionId),
      relativePath
    ) &&
    baseline?.rootIdentity === rootIdentity &&
    baseline.identity === projectFolderFileIdentity(info) &&
    baseline.size === info.size &&
    (baseline.ctimeMs === undefined || baseline.ctimeMs === info.ctimeMs)
  )
}

function matchesNotebookSource(
  record: PublishedArtifactFolderRecord,
  relativePath: string,
  size: number
): boolean {
  const { producerRunId, executionSnapshotJson, executionSnapshotChecksum } = record
  if (
    !producerRunId ||
    !executionSnapshotJson ||
    sha256(executionSnapshotJson) !== executionSnapshotChecksum
  )
    return false
  const decoded = decodeArtifactExecutionSnapshot(executionSnapshotJson)
  const graph = decoded.status === 'valid' ? decoded.value.provenanceGraph : undefined
  if (
    !graph ||
    BigInt(size) !== record.sizeBytes ||
    !artifactProvenanceGraphMatchesTarget(graph, { ...record, producerRunId, sizeBytes: size })
  )
    return false

  // A single Run can generate several files. The version's publication edge names the one used.
  const sourceEdges = graph.edges.filter(
    (edge) =>
      edge.kind === 'used' &&
      edge.activityId === `artifact-publication:${record.versionId}` &&
      edge.authority === 'authoritative' &&
      edge.evidenceSource === 'artifact-publication'
  )
  const edge = sourceEdges[0]
  if (sourceEdges.length !== 1 || edge.kind !== 'used') return false
  const source = graph.entities.find((entity) => entity.entityId === edge.entityId)
  return (
    source?.kind === 'file-generation' &&
    source.pathPortability === 'relative' &&
    source.checksum === record.checksum &&
    source.sizeBytes === size &&
    source.relativePath === `data/${relativePath}`
  )
}

export function createPublishedArtifactCopyCheck(
  projectId: string,
  root: string,
  storageRoot: string,
  readRecords: ReadPublishedArtifactFolderRecords
): (path: string, info: Stats, signal: AbortSignal) => Promise<boolean> {
  let rootIdentity: Promise<string> | undefined
  const directoryOwnership = new Map<string, boolean>()
  return async (path, info, signal) => {
    const relativePath = relative(root, path).split(sep).join('/')
    const [tree, project, sessionId, branch, frameId] = relativePath.split('/')
    if (project !== projectId || !sessionId) return false
    if (tree === 'artifacts') {
      const directory = getArtifactSessionOutputRelativePath(projectId, sessionId)
      if (!isArtifactOutputDeliveryPath(directory, relativePath)) return false
      rootIdentity ??= stat(root).then(projectFolderFileIdentity)
      const [records, identity] = await Promise.all([
        readRecords(projectId, sessionId, relativePath, 'delivery'),
        rootIdentity
      ])
      return records.some((record) =>
        matchesDelivery(record, projectId, relativePath, identity, info)
      )
    }
    if (tree !== 'notebooks' || (branch !== 'data' && (branch !== 'frames' || !frameId)))
      return false

    // The observer projects the owned external directory under the Notebook's logical data/ root.
    // Other logical paths can refer to managed or staged files and convey no live folder identity.
    const frame = branch === 'frames' ? frameId : undefined
    const directory = getNotebookSessionOutputRelativePath(projectId, sessionId, frame)
    if (!relativePath.startsWith(directory + '/')) return false
    if (!directoryOwnership.has(directory)) {
      directoryOwnership.set(
        directory,
        isOwnedProjectNotebookOutputDirectory(storageRoot, projectId, directory)
      )
    }
    if (!directoryOwnership.get(directory)) return false

    const records = await readRecords(projectId, sessionId, relativePath, 'notebook')
    const matching = records.filter((record) => {
      return (
        (!frame || frame === record.agentFrameId) &&
        matchesNotebookSource(record, relativePath, info.size)
      )
    })
    if (matching.length === 0) return false

    // The publication edge establishes the path association. Verify this specific generation so
    // that a later unpublished write to the same path can still be mentioned.
    const identity = projectFolderFileIdentity(info)
    const unchanged = (current: Stats): boolean =>
      current.isFile() &&
      projectFolderFileIdentity(current) === identity &&
      current.size === info.size &&
      current.ctimeMs === info.ctimeMs &&
      current.mtimeMs === info.mtimeMs
    signal.throwIfAborted()
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      if (!unchanged(await handle.stat())) return false
      const digest = await digestOpenFileWithinBudget(handle, info.size, signal)
      return (
        digest.sizeBytes === info.size &&
        matching.some((record) => record.checksum === digest.checksum) &&
        unchanged(await lstat(path)) &&
        unchanged(await handle.stat())
      )
    } finally {
      await handle.close()
    }
  }
}
