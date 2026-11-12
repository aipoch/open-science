import { readLoggedEvidence } from '../artifacts/execution-evidence-log'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createComputeOutputPreviewKey } from '../../shared/compute'
import {
  hasImmutableExecutionFileEvidenceReference,
  parseOwnedExecutionFileEvidenceSummary
} from '../../shared/execution-file-evidence'

type Scope = { projectId: string; sessionId: string; jobId: string }
type FileReceipt = { checksum?: string; sizeBytes?: number }

// The first immutable evidence may be from an unsuccessful harvest, even after a successful retry.
// A successful capture records one harvested-output relation for every published featured/hidden
// file. Its relation still exists when the evidence budget could not freeze a second copy.
export async function readJobArchiveReceipt(
  root: string,
  scope: Scope,
  producerRunId: string | undefined,
  raw: unknown
): Promise<Map<string, FileReceipt> | undefined> {
  const key = `execution-file-evidence/${scope.projectId}/${scope.sessionId}/activity-${scope.jobId}/evidence.json`
  const evidence = parseOwnedExecutionFileEvidenceSummary(raw, {
    activityId: scope.jobId,
    activityKind: 'compute-job',
    parentActivityId: producerRunId,
    storageKey: key
  })
  if (
    !hasImmutableExecutionFileEvidenceReference(evidence) ||
    evidence.reasonCodes.includes('harvest-incomplete')
  )
    return undefined
  const path = join(root, ...key.split('/'))
  const invalid = (): Error => new Error('Compute output archive receipt is unavailable.')
  const physical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (physical && physical !== path) throw invalid()
  const bytes = physical
    ? await readSidecar(path, evidence.checksum)
    : await readLoggedEvidence(root, key, evidence.checksum, 16 * 1024 * 1024)
  const doc = JSON.parse(bytes.toString('utf8'))
  if (
    doc.schemaVersion !== 1 ||
    doc.evidenceId !== evidence.evidenceId ||
    doc.activityId !== scope.jobId ||
    doc.activityKind !== 'compute-job' ||
    doc.parentActivityId !== producerRunId ||
    !Array.isArray(doc.relations) ||
    doc.relations.length !== evidence.relationCount
  )
    throw invalid()
  const files = new Map<string, FileReceipt>()
  for (const relation of doc.relations) {
    if (
      relation.relation !== 'harvested-output' ||
      relation.authority !== 'explicit-transfer' ||
      relation.pathPortability !== 'relative'
    )
      continue
    const path = relation.relativePath
    try {
      createComputeOutputPreviewKey({ ...scope, path })
    } catch {
      continue
    }
    const file = relation.generation
    if (
      file &&
      (file.relativePath !== path ||
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.checksum))
    )
      throw invalid()
    files.set(path, file ? { checksum: file.checksum, sizeBytes: file.sizeBytes } : {})
  }
  return files
}

async function readSidecar(path: string, checksum: string): Promise<Buffer> {
  const invalid = (): Error => new Error('Compute output archive receipt is unavailable.')
  const fd = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  let bytes: Buffer
  try {
    const snapshot = await fd.stat()
    // Bound an untrusted local file before allocating a JSON document in the main process.
    if (!snapshot.isFile() || snapshot.size > 16 * 1024 * 1024) throw invalid()
    bytes = Buffer.alloc(snapshot.size)
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw invalid()
      offset += bytesRead
    }
  } finally {
    await fd.close()
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw invalid()
  return bytes
}
