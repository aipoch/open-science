import { z } from 'zod'
import { PACKAGE_MAX_FILE_BYTES } from '../../shared/session-package'
import type { NotebookRunDocument } from '../../shared/notebook'
import type { PackageRecords } from './native-snapshot'
import { assertPackageSourcePath, fileChecksum, readPackageJson } from './archive'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { digestFileWithinBudget } from '../bounded-file-io'

const checksum = z.string().regex(/^[a-f0-9]{64}$/)
export const executionEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: z.string(),
    activityId: z.string(),
    activityKind: z.enum(['notebook-run', 'compute-job']),
    relations: z
      .array(
        z
          .object({
            generation: z
              .object({
                generationId: z.string(),
                checksum,
                contentStorageKey: z.string(),
                sizeBytes: z.number().int().nonnegative().max(PACKAGE_MAX_FILE_BYTES)
              })
              .passthrough()
              .optional()
          })
          .passthrough()
      )
      .max(10000)
  })
  .passthrough()

// Follow immutable references, not the whole Project blob pool or its machine-local ownership
// receipts. Notebook and Compute summaries share this evidence format.
export const executionEvidenceKeys = async (
  storageRoot: string,
  records: PackageRecords,
  notebooks: readonly NotebookRunDocument[],
  signal?: AbortSignal
): Promise<string[]> => {
  const references = new Map<
    string,
    { checksum: string; evidenceId?: string; activityId?: string }
  >()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const row = value as Record<string, unknown>
    const key = row.storageKey ?? row.storage_key
    if (
      typeof key === 'string' &&
      key.startsWith('execution-file-evidence/') &&
      typeof row.checksum === 'string'
    ) {
      const previous = references.get(key)
      if (previous && previous.checksum !== row.checksum)
        throw new Error('Conflicting execution file evidence checksums.')
      references.set(key, {
        checksum: row.checksum,
        evidenceId:
          typeof row.evidenceId === 'string'
            ? row.evidenceId
            : typeof row.evidence_id === 'string'
              ? row.evidence_id
              : undefined,
        activityId: typeof row.activityId === 'string' ? row.activityId : undefined
      })
    }
    Object.values(row).forEach(visit)
  }
  for (const notebook of notebooks) for (const run of notebook.runs) visit(run.fileEvidence)
  for (const job of records.history?.computeJobs ?? []) visit(job.fileEvidence)
  for (const version of records.tables.ArtifactVersion)
    if (typeof version.executionSnapshotJson === 'string')
      visit(JSON.parse(version.executionSnapshotJson))
  const keys = new Set<string>()
  for (const [key, reference] of references) {
    signal?.throwIfAborted()
    if (
      !/^execution-file-evidence\/[^/]+\/[^/]+\/(?:frames\/[^/]+\/)?activity-[^/]+\/evidence\.json$/.test(
        key
      )
    )
      throw new Error('Invalid execution file evidence path.')
    await assertPackageSourcePath(storageRoot, key)
    const path = resolveStorageKey(storageRoot, key)
    if ((await fileChecksum(path, signal)) !== reference.checksum)
      throw new Error('Execution file evidence checksum mismatch.')
    const evidence = executionEvidenceSchema.parse(await readPackageJson(path))
    if (
      (reference.evidenceId && evidence.evidenceId !== reference.evidenceId) ||
      (reference.activityId && evidence.activityId !== reference.activityId)
    )
      throw new Error('Execution file evidence ownership mismatch.')
    keys.add(key)
    for (const relation of evidence.relations) {
      if (!relation.generation) continue
      const generation = relation.generation
      const project = key.split('/')[1]
      if (!generation.contentStorageKey.startsWith(`execution-file-evidence/${project}/`))
        throw new Error('Execution file generation escapes its Project.')
      await assertPackageSourcePath(storageRoot, generation.contentStorageKey)
      const digest = await digestFileWithinBudget(
        resolveStorageKey(storageRoot, generation.contentStorageKey),
        generation.sizeBytes,
        signal
      )
      if (digest.checksum !== generation.checksum || digest.sizeBytes !== generation.sizeBytes)
        throw new Error('Execution file generation checksum mismatch.')
      keys.add(generation.contentStorageKey)
      if (keys.size > 10000) throw new Error('Execution file evidence exceeds the package limit.')
    }
  }
  return [...keys].sort()
}
