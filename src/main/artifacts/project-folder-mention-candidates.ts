import { constants, type Stats } from 'node:fs'
import { lstat, open, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { PublishedArtifactAlias } from '../../shared/project-folder-files'
import { digestOpenFileWithinBudget } from '../bounded-file-io'
import { projectFolderFileIdentity } from '../project-folders/staged-files'
import {
  getArtifactSessionOutputRelativePath,
  getNotebookSessionOutputRelativePath,
  isOwnedProjectNotebookOutputDirectory
} from '../projects/session-output-layout'
import { artifactProvenanceGraphMatchesTarget } from './artifact-provenance-graph'
import { isArtifactOutputDeliveryPath, parseArtifactOutputDelivery } from './output-delivery'
import { sha256 } from './provenance-canonical'
import { decodeArtifactExecutionSnapshot } from './provenance-execution-snapshot-decoder'

export type PublishedArtifactFolderRecord = {
  sourceFileId: string
  sessionId: string
  versionId: string
  filename: string
  displayName: string
  mimeType: string | null
  checksum: string
  sizeBytes: bigint
  createdAtMs: bigint
  agentFrameId: string | null
  producerRunId: string | null
  executionSnapshotJson: string | null
  executionSnapshotChecksum: string | null
  outputDeliveryJson: string | null
}

export type PublishedArtifactFolderLookup = {
  sessionId: string
  relativePath: string
  kind: 'delivery' | 'notebook'
  size: number
}

export type ReadPublishedArtifactFolderRecords = (
  projectId: string,
  lookups: PublishedArtifactFolderLookup[]
) => Promise<PublishedArtifactFolderRecord[]>

type Candidate = { path: string; info: Stats }
type ScopedCandidate = Candidate & { lookup: PublishedArtifactFolderLookup; frameId?: string }

function scopeCandidate(
  projectId: string,
  root: string,
  storageRoot: string,
  directoryOwnership: Map<string, boolean>,
  candidate: Candidate
): ScopedCandidate | undefined {
  const relativePath = relative(root, candidate.path).split(sep).join('/')
  const [tree, project, sessionId, branch, frameId] = relativePath.split('/')
  if (project !== projectId || !sessionId) return
  const size = candidate.info.size
  if (tree === 'artifacts') {
    const directory = getArtifactSessionOutputRelativePath(projectId, sessionId)
    if (isArtifactOutputDeliveryPath(directory, relativePath))
      return { ...candidate, lookup: { kind: 'delivery', sessionId, relativePath, size } }
    return
  }
  if (tree !== 'notebooks' || (branch !== 'data' && (branch !== 'frames' || !frameId))) return

  // The observer projects the owned external directory under the Notebook's logical data/ root.
  // Other logical paths can refer to managed or staged files.
  const frame = branch === 'frames' ? frameId : undefined
  const directory = getNotebookSessionOutputRelativePath(projectId, sessionId, frame)
  if (!relativePath.startsWith(directory + '/')) return
  if (!directoryOwnership.has(directory)) {
    directoryOwnership.set(
      directory,
      isOwnedProjectNotebookOutputDirectory(storageRoot, projectId, directory)
    )
  }
  if (directoryOwnership.get(directory))
    return {
      ...candidate,
      frameId: frame,
      lookup: { kind: 'notebook', sessionId, relativePath, size }
    }
  return undefined
}

async function readStableChecksum(
  { path, info }: Candidate,
  signal: AbortSignal
): Promise<string | undefined> {
  signal.throwIfAborted()
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    if (!sameFileStats(info, await handle.stat())) return undefined
    const digest = await digestOpenFileWithinBudget(handle, info.size, signal)
    return digest.sizeBytes === info.size &&
      sameFileStats(info, await lstat(path)) &&
      sameFileStats(info, await handle.stat())
      ? digest.checksum
      : undefined
  } finally {
    await handle.close()
  }
}

const sameFileStats = (before: Stats, after: Stats): boolean =>
  after.isFile() &&
  projectFolderFileIdentity(after) === projectFolderFileIdentity(before) &&
  after.size === before.size &&
  after.ctimeMs === before.ctimeMs &&
  after.mtimeMs === before.mtimeMs

const stillCurrent = ({ path, info }: Candidate): Promise<boolean> =>
  lstat(path).then(
    (current) => sameFileStats(info, current),
    () => false
  )

function publicationSourcePath(record: PublishedArtifactFolderRecord): string | undefined {
  const { producerRunId, executionSnapshotJson, executionSnapshotChecksum } = record
  if (
    !producerRunId ||
    !executionSnapshotJson ||
    sha256(executionSnapshotJson) !== executionSnapshotChecksum
  )
    return
  const decoded = decodeArtifactExecutionSnapshot(executionSnapshotJson)
  const graph = decoded.status === 'valid' ? decoded.value.provenanceGraph : undefined
  const size = Number(record.sizeBytes)
  if (
    !graph ||
    !Number.isSafeInteger(size) ||
    !artifactProvenanceGraphMatchesTarget(graph, { ...record, producerRunId, sizeBytes: size })
  )
    return

  // A Run can generate several files. This version's publication edge identifies the one used.
  const sourceEdges = graph.edges.filter(
    (edge) =>
      edge.kind === 'used' &&
      edge.activityId === `artifact-publication:${record.versionId}` &&
      edge.authority === 'authoritative' &&
      edge.evidenceSource === 'artifact-publication'
  )
  const edge = sourceEdges[0]
  if (sourceEdges.length !== 1 || edge.kind !== 'used') return
  const source = graph.entities.find((entity) => entity.entityId === edge.entityId)
  if (
    source?.kind === 'file-generation' &&
    source.pathPortability === 'relative' &&
    source.checksum === record.checksum &&
    source.sizeBytes === size &&
    source.relativePath.startsWith('data/')
  )
    return source.relativePath.slice('data/'.length)
  return undefined
}

export async function findPublishedArtifactCopies(
  projectId: string,
  root: string,
  storageRoot: string,
  candidates: Candidate[],
  readRecords: ReadPublishedArtifactFolderRecords
): Promise<Map<string, PublishedArtifactAlias[]>> {
  const directoryOwnership = new Map<string, boolean>()
  const scoped = new Map<string, ScopedCandidate>()
  for (const candidate of candidates) {
    try {
      const match = scopeCandidate(projectId, root, storageRoot, directoryOwnership, candidate)
      if (match) scoped.set(match.lookup.relativePath, match)
    } catch {
      // An invalid scope or unavailable Notebook directory leaves the candidate live.
    }
  }

  const matches = new Map<string, PublishedArtifactAlias[]>()
  if (scoped.size === 0) return matches
  const records = await readRecords(
    projectId,
    Array.from(scoped.values(), ({ lookup }) => lookup)
  )
  const rootIdentity = Array.from(scoped.values()).some(({ lookup }) => lookup.kind === 'delivery')
    ? projectFolderFileIdentity(await stat(root))
    : undefined
  let verificationBudget: AbortSignal | undefined
  const checksums = new Map<string, Promise<string | undefined>>()
  const matchesStableContent = async (candidate: Candidate, checksum: string): Promise<boolean> => {
    let pending = checksums.get(candidate.path)
    if (!pending) {
      verificationBudget ??= AbortSignal.timeout(250)
      pending = readStableChecksum(candidate, verificationBudget).catch(() => undefined)
      checksums.set(candidate.path, pending)
    }
    return (await pending) === checksum
  }
  const add = (path: string, artifact: PublishedArtifactAlias): void => {
    const aliases = matches.get(path) ?? []
    aliases.push(artifact)
    matches.set(path, aliases)
  }
  for (const record of records) {
    const size = Number(record.sizeBytes)
    if (!Number.isSafeInteger(size) || size < 0) continue
    const artifact = {
      sourceFileId: record.sourceFileId,
      sessionId: record.sessionId,
      versionId: record.versionId,
      name: record.displayName,
      mimeType: record.mimeType ?? undefined,
      size
    }
    const source = publicationSourcePath(record)
    const notebook = source && scoped.get(source)
    if (
      notebook &&
      notebook.lookup.kind === 'notebook' &&
      notebook.lookup.sessionId === record.sessionId &&
      (!notebook.frameId || notebook.frameId === record.agentFrameId) &&
      notebook.info.size === size &&
      Math.floor(notebook.info.birthtimeMs) <= Number(record.createdAtMs)
    ) {
      // The version sealed this exact path and generation. A later metadata change needs byte verification.
      const unchangedSinceSealing =
        Math.floor(Math.max(notebook.info.ctimeMs, notebook.info.mtimeMs)) <=
        Number(record.createdAtMs)
      if (
        unchangedSinceSealing
          ? await stillCurrent(notebook)
          : await matchesStableContent(notebook, record.checksum)
      )
        add(notebook.path, artifact)
    }

    try {
      const delivery = parseArtifactOutputDelivery(record.outputDeliveryJson)
      const target = delivery && scoped.get(delivery.relativePath)
      const baseline = delivery?.lastDelivered
      if (
        !target ||
        target.lookup.kind !== 'delivery' ||
        target.lookup.sessionId !== record.sessionId ||
        !baseline ||
        baseline.rootIdentity !== rootIdentity ||
        baseline.identity !== projectFolderFileIdentity(target.info) ||
        baseline.checksum !== record.checksum ||
        baseline.size !== size ||
        baseline.size !== target.info.size
      )
        continue
      // Every normal delivery records ctime. A legacy receipt or a metadata-only change needs
      // byte verification of this identified delivery file.
      if (
        baseline.ctimeMs === target.info.ctimeMs
          ? await stillCurrent(target)
          : await matchesStableContent(target, baseline.checksum)
      )
        add(target.path, artifact)
    } catch {
      // Unverifiable delivery records leave the folder candidate live.
    }
  }
  return matches
}
