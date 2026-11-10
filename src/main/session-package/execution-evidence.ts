import { readdir } from 'node:fs/promises'
import {
  collectLaneRecords,
  compactLaneViews,
  viewRows,
  evidenceLocation,
  indexPortableEvidence,
  type PortableEvidence
} from '../artifacts/execution-evidence-log'
import { posix } from 'node:path'
import { z } from 'zod'
import type { NotebookRunDocument } from '../../shared/notebook'
import { PACKAGE_MAX_FILE_BYTES } from '../../shared/session-package'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { createPackageContentVerifier } from './materialize'
import { assertPackageSourcePath, fileChecksum, readPackageJson } from './archive'
import type { PackageRecords } from './records-contract'

const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const generationSchema = z
  .object({
    generationId: z.string(),
    checksum,
    contentStorageKey: z.string(),
    sizeBytes: z.number().int().nonnegative().max(PACKAGE_MAX_FILE_BYTES)
  })
  .passthrough()
export const executionEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: z.string(),
    activityId: z.string(),
    activityKind: z.enum(['notebook-run', 'compute-job']),
    predecessorGenerations: z.array(generationSchema).max(10000).optional(),
    relations: z
      .array(
        z
          .object({
            generation: generationSchema.optional(),
            previousGenerationId: z.string().optional()
          })
          .passthrough()
      )
      .max(10000)
  })
  .passthrough()

// Legacy Notebook sidecars identify their owner with runId. Normalize only that known
// format; current sidecars still pass through the same schema without inferred ownership.
const legacyNotebookEvidenceSchema = executionEvidenceSchema
  .omit({ activityId: true, activityKind: true })
  .extend({
    runId: z.string(),
    activityId: z.undefined().optional(),
    activityKind: z.undefined().optional()
  })
  .refine((value) => value.evidenceId === `notebook-file-evidence-${value.runId}`)
  .transform((value) => ({
    ...value,
    activityId: value.runId,
    activityKind: 'notebook-run' as const
  }))

export const readExecutionEvidence = (value: unknown): z.infer<typeof executionEvidenceSchema> =>
  z.union([executionEvidenceSchema, legacyNotebookEvidenceSchema]).parse(value)

// Follow immutable references, not the whole Project blob pool or its machine-local ownership
// receipts. Notebook and Compute summaries share this evidence format.
type EvidenceReference = {
  checksum: string
  evidenceId?: string
  activityId?: string
  activityKind?: string
  parentActivityId?: string
}
const evidenceReferences = (
  records: PackageRecords,
  notebooks: readonly NotebookRunDocument[],
  owners?: Map<string, EvidenceReference>
): Map<string, EvidenceReference> => {
  const references = new Map<string, EvidenceReference>()
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
      /^(?:execution-file-evidence|notebook-file-evidence|file-evidence)\//.test(key) &&
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
        activityId: typeof row.activityId === 'string' ? row.activityId : previous?.activityId,
        activityKind:
          typeof row.activityKind === 'string' ? row.activityKind : previous?.activityKind,
        parentActivityId:
          typeof row.parentActivityId === 'string'
            ? row.parentActivityId
            : previous?.parentActivityId
      })
    }
    Object.values(row).forEach(visit)
  }
  for (const notebook of notebooks)
    for (const run of notebook.runs) {
      const ref = run.fileEvidence
      visit(ref)
      if (
        ref?.storageKey &&
        ref.checksum &&
        ref.activityId === run.runId &&
        ref.activityKind === 'notebook-run'
      )
        owners?.set(ref.storageKey, references.get(ref.storageKey)!)
    }
  for (const job of records.history?.computeJobs ?? []) {
    const ref = job.fileEvidence
    if (
      ref?.storageKey &&
      (ref.activityKind !== 'compute-job' ||
        ref.activityId !== job.id ||
        ref.parentActivityId !== job.producerRunId)
    )
      throw new Error('Compute file evidence ownership mismatch.')
    visit(ref)
    if (ref?.storageKey && ref.checksum)
      owners?.set(ref.storageKey, references.get(ref.storageKey)!)
  }
  for (const version of records.tables.ArtifactVersion)
    if (typeof version.executionSnapshotJson === 'string')
      visit(JSON.parse(version.executionSnapshotJson))
  return references
}

function hasAuthorizedViews(
  lane: PortableEvidence[number],
  record: PortableEvidence[number]['records'][number],
  bytes: Buffer
): boolean {
  const evidence = readExecutionEvidence(JSON.parse(bytes.toString()))
  const allowed = new Set(
    [
      ...evidence.relations.flatMap((r) => (r.generation ? [r.generation] : [])),
      ...(evidence.predecessorGenerations ?? [])
    ].map((g) => JSON.stringify([g.relativePath, g.checksum, g.sizeBytes]))
  )
  return [record.pre, record.post].every((hash) =>
    viewRows(lane, hash).every((row) => allowed.has(JSON.stringify(row)))
  )
}
export const hasComputeLogEvidence = (logs: PackageRecords['logEvidence']): boolean =>
  logs?.some((lane) =>
    lane.records.some((record) => JSON.parse(record.detail).activityKind === 'compute-job')
  ) ?? false

// Compute rows are historical snapshots on import. Recover the destination checksum from
// the native log and its authenticated transfer provenance before forwarding the history.
export async function inheritedComputeChecksums(
  root: string,
  lane: string,
  history: PackageRecords['history'],
  identities: Record<string, string>,
  manifestChecksum: string
): Promise<Record<string, string>> {
  const jobs = new Map(
    (history?.computeJobs ?? []).flatMap((job) => {
      const ref = job.fileEvidence
      return ref?.checksum && ref.evidenceId && identities[job.id]
        ? [[identities[job.id], { job, ref }] as const]
        : []
    })
  )
  if (!jobs.size) return {}
  const records = await collectLaneRecords(root, lane, new Set(jobs.keys()))
  const checksums: Record<string, string> = Object.create(null)
  for (const record of records?.records ?? []) {
    const { job, ref } = jobs.get(record.activityId)!
    const source = record.sources?.at(-1)
    if (
      !source ||
      source.manifestChecksum !== manifestChecksum ||
      source.activityId !== job.id ||
      source.evidenceId !== ref.evidenceId ||
      source.checksum !== ref.checksum
    )
      throw new Error('Imported Compute evidence origin mismatch.')
    checksums[source.checksum] = record.checksum
  }
  return checksums
}

export async function collectPackageLogEvidence(
  root: string,
  records: PackageRecords,
  notebooks: readonly NotebookRunDocument[],
  signal?: AbortSignal,
  backfillSession?: { projectId: string; sessionId: string }
): Promise<PortableEvidence | undefined> {
  const owners = backfillSession ? new Map<string, EvidenceReference>() : undefined
  const refs = evidenceReferences(records, notebooks, owners)
  const groups = new Map<string, Set<string>>()
  for (const key of refs.keys()) {
    const loc = evidenceLocation(key)
    if (!loc) continue
    const group = groups.get(loc.lane) ?? new Set<string>()
    group.add(loc.activity)
    groups.set(loc.lane, group)
  }
  const result: PortableEvidence = []
  for (const [key, ids] of groups) {
    let lane = await collectLaneRecords(root, key, ids, signal)
    const [, project, session] = key.split('/')
    if (
      backfillSession &&
      project === backfillSession.projectId &&
      session === backfillSession.sessionId
    ) {
      const logged = new Set(lane?.records.map((r) => r.activityId))
      const missing = [...ids].flatMap((activityId) => {
        const path = key + '/activity-' + activityId + '/evidence.json'
        const ref = owners?.get(path)
        if (
          !ref ||
          logged.has(activityId) ||
          ref.activityId !== activityId ||
          (ref.activityKind !== 'notebook-run' && ref.activityKind !== 'compute-job') ||
          ref.evidenceId !== 'execution-file-evidence-' + activityId
        )
          return []
        return [
          {
            activityId,
            activityKind: ref.activityKind,
            evidenceId: ref.evidenceId,
            parentActivityId: ref.parentActivityId,
            checksum: ref.checksum
          }
        ] as const
      })
      if (missing.length) {
        const { backfillWorkingFileEvidence } = await import('../notebook/working-file-observer')
        await backfillWorkingFileEvidence(root, key, missing, signal)
        lane = await collectLaneRecords(root, key, ids, signal)
      }
    }
    if (!lane) continue
    const verified = indexPortableEvidence([lane])
    lane.records = lane.records.filter((record) => {
      const path = key + '/activity-' + record.activityId + '/evidence.json'
      const ref = refs.get(path)!
      if (record.checksum !== ref.checksum)
        throw new Error('Execution file evidence checksum mismatch.')
      return hasAuthorizedViews(lane, record, verified.get(path)!.bytes)
    })
    const views = new Set(lane.records.flatMap((record) => [record.pre, record.post]))
    for (const hash of Object.keys(lane.views)) if (!views.has(hash)) delete lane.views[hash]
    if (lane.records.length) result.push(compactLaneViews(lane))
  }
  return result.length ? result : undefined
}

export const executionEvidenceKeys = async (
  storageRoot: string,
  records: PackageRecords,
  notebooks: readonly NotebookRunDocument[],
  signal?: AbortSignal
): Promise<string[]> => {
  const references = evidenceReferences(records, notebooks)
  const logged = indexPortableEvidence(records.logEvidence ?? [])
  for (const key of logged.keys())
    if (!references.has(key)) throw new Error('Unreferenced log evidence.')
  const verifiedPoolSizes = new Map<string, number>()
  const verifyContent = createPackageContentVerifier()
  const keys = new Set<string>()
  for (const [key, reference] of references) {
    signal?.throwIfAborted()
    if (
      !/^(?:execution-file-evidence\/[^/]+\/[^/]+\/(?:frames\/[^/]+\/)?activity-[^/]+|(?:notebook-file-evidence|file-evidence)\/[^/]+\/[^/]+\/(?:frames\/[^/]+\/)?run-[^/]+)\/evidence\.json$/.test(
        key
      )
    )
      throw new Error('Invalid execution file evidence path.')
    const projected = logged.get(key)
    let evidence
    if (projected) {
      if (
        projected.record.checksum !== reference.checksum ||
        !hasAuthorizedViews(projected.lane, projected.record, projected.bytes)
      )
        throw new Error('Execution file evidence checksum or view mismatch.')
      evidence = readExecutionEvidence(JSON.parse(projected.bytes.toString()))
    } else {
      await assertPackageSourcePath(storageRoot, key)
      const path = resolveStorageKey(storageRoot, key)
      if ((await fileChecksum(path, signal)) !== reference.checksum)
        throw new Error('Execution file evidence checksum mismatch.')
      evidence = readExecutionEvidence(await readPackageJson(path))
      keys.add(key)
    }
    if (
      (reference.evidenceId && evidence.evidenceId !== reference.evidenceId) ||
      (reference.activityId && evidence.activityId !== reference.activityId) ||
      (reference.activityKind &&
        (evidence.activityKind !== reference.activityKind ||
          evidence.parentActivityId !== reference.parentActivityId))
    )
      throw new Error('Execution file evidence ownership mismatch.')
    const generations = [
      ...evidence.relations.flatMap((relation) =>
        relation.generation ? [relation.generation] : []
      ),
      ...(evidence.predecessorGenerations ?? [])
    ]
    const generationIds = new Set(generations.map((generation) => generation.generationId))
    // Old writers retained predecessor bytes but sometimes omitted their mapping. Preserve the
    // entire Activity blob directory; exporting must not silently discard potentially needed bytes.
    if (
      evidence.relations.some(
        (relation) =>
          relation.previousGenerationId && !generationIds.has(relation.previousGenerationId)
      )
    ) {
      const blobKey = `${posix.dirname(key)}/blobs`
      await assertPackageSourcePath(storageRoot, blobKey)
      for (const entry of await readdir(resolveStorageKey(storageRoot, blobKey), {
        withFileTypes: true
      })) {
        if (!entry.isFile() || !/^sha256-[a-f0-9]{64}$/.test(entry.name))
          throw new Error('Unverifiable legacy predecessor content.')
        const contentKey = `${blobKey}/${entry.name}`
        await assertPackageSourcePath(storageRoot, contentKey)
        if (
          (
            await verifyContent(
              resolveStorageKey(storageRoot, contentKey),
              PACKAGE_MAX_FILE_BYTES,
              signal
            )
          ).checksum !== entry.name.slice(7)
        )
          throw new Error('Legacy predecessor content checksum mismatch.')
        keys.add(contentKey)
        if (keys.size > 10000) throw new Error('Execution file evidence exceeds the package limit.')
      }
    }
    for (const generation of generations) {
      const project = key.split('/')[1]
      if (!generation.contentStorageKey.startsWith(`${key.split('/')[0]}/${project}/`))
        throw new Error('Execution file generation escapes its Project.')
      const contentKey = projected
        ? `execution-file-evidence/${project}/blobs/sha256-${generation.checksum}`
        : generation.contentStorageKey
      if (projected && verifiedPoolSizes.get(contentKey) === generation.sizeBytes) continue
      await assertPackageSourcePath(storageRoot, contentKey)
      const digest = await verifyContent(
        resolveStorageKey(storageRoot, contentKey),
        generation.sizeBytes,
        signal
      )
      if (digest.checksum !== generation.checksum || digest.sizeBytes !== generation.sizeBytes)
        throw new Error('Execution file generation checksum mismatch.')
      if (projected) verifiedPoolSizes.set(contentKey, generation.sizeBytes)
      keys.add(contentKey)
      if (keys.size > 10000) throw new Error('Execution file evidence exceeds the package limit.')
    }
  }
  return [...keys].sort()
}
