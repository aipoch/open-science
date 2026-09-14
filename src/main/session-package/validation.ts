import { installPackageReproducibility, validatePackageReproducibility } from './reproducibility'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionPackageManifest } from '../../shared/session-package'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { sha256 } from '../artifacts/provenance-canonical'
import { decodeReviewScopeSnapshot } from '../artifacts/provenance-snapshot-decoder'
import { executionEvidenceKeys } from './execution-evidence'
import { validateExcludedFiles, assertNoExcludedContentCopies } from './selection'
import { copyFileWithinBudget } from '../bounded-file-io'
import { assertPackageCapacity } from './capacity'
import {
  nativeStorageKeys,
  projectIncludedHeads,
  prepareNativePublication,
  readPackageNotebooks,
  type PackageRecords
} from './native-snapshot'

export const assertPortablePackageStorageKey = (key: string): void => {
  const segments = key.split('/')
  if (
    !['artifacts', 'uploads', 'notebooks', 'execution-file-evidence'].includes(segments[0]) ||
    segments.length < 4 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        // eslint-disable-next-line no-control-regex -- portable file names must reject ASCII controls
        /[\\<>:"|?*\u0000-\u001f]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        // Windows also reserves the superscript digits ¹, ² and ³ in COM/LPT device names.
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)
    )
  )
    throw new Error('Session package contains a non-portable storage path.')
}

// Validate in a disposable, current-schema database using the existing public provenance reader.
// This checks ownership, foreign keys, immutable evidence, execution and inputs before touching the
// application's authority DB. Archive checksums alone cannot establish these relationships.
export const validatePackageRecords = async (
  directory: string,
  manifest: SessionPackageManifest,
  records: PackageRecords,
  signal?: AbortSignal,
  sourceIdentity = manifest.source,
  temporaryRoot = tmpdir()
): Promise<void> => {
  for (const file of manifest.excludedFiles) assertPortablePackageStorageKey(file.storageKey)
  const excluded = validateExcludedFiles(records, manifest.excludedFiles)
  assertNoExcludedContentCopies(records, manifest.excludedFiles, manifest.inventory)
  const files = new Map<string, SessionPackageManifest['inventory'][number]>()
  const portableKeys = new Set<string>()
  for (const entry of manifest.inventory) {
    if (!entry.storageKey) continue
    if (excluded.has(entry.storageKey))
      throw new Error('Excluded package content must not be included.')
    assertPortablePackageStorageKey(entry.storageKey)
    const normalized = entry.storageKey.normalize('NFC').toLowerCase()
    if (portableKeys.has(normalized))
      throw new Error('Session package has colliding storage paths.')
    portableKeys.add(normalized)
    files.set(entry.storageKey, entry)
  }
  for (const key of nativeStorageKeys(records)) {
    if (!files.has(key) && !excluded.has(key))
      throw new Error('Session package omits required evidence or content.')
  }
  for (const table of ['ArtifactVersion', 'UploadVersion'] as const) {
    for (const row of records.tables[table]) {
      if (excluded.has(String(row.contentStorageKey))) continue
      const entry = files.get(String(row.contentStorageKey))
      if (entry?.checksum !== row.checksum || entry.sizeBytes !== Number(row.sizeBytes))
        throw new Error('Session package content metadata mismatch.')
    }
  }
  for (const snapshot of records.tables.ReviewScopeSnapshot) {
    const entry = files.get(String(snapshot.storageKey))
    if (
      snapshot.state !== 'ready' ||
      typeof snapshot.snapshotJson !== 'string' ||
      sha256(snapshot.snapshotJson) !== snapshot.checksum ||
      entry?.checksum !== snapshot.checksum
    )
      throw new Error('Session package Review snapshot checksum or state is invalid.')
    const decoded = decodeReviewScopeSnapshot(snapshot.snapshotJson)
    if (decoded.status !== 'valid' && decoded.status !== 'legacy')
      throw new Error('Session package Review snapshot is invalid or unsupported.')
    const value = JSON.parse(snapshot.snapshotJson)
    if (
      value.snapshotId !== snapshot.id ||
      value.projectId !== snapshot.projectId ||
      value.sessionId !== snapshot.sessionId ||
      value.reviewId !== snapshot.reviewId ||
      decoded.value.length !== Number(snapshot.blockCount)
    )
      throw new Error('Session package Review snapshot ownership is invalid.')
  }
  const root = await mkdtemp(join(temporaryRoot, 'open-science-package-validation-'))
  let client: ReturnType<typeof createProjectDbClient> | undefined
  try {
    await assertPackageCapacity(
      root,
      [...files.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0)
    )
    for (const [key, entry] of files) {
      const target = resolveStorageKey(root, key)
      await mkdir(dirname(target), { recursive: true })
      await copyFileWithinBudget(join(directory, entry.path), target, entry.sizeBytes, signal)
    }
    await installPackageReproducibility(root, records, excluded)
    await validatePackageReproducibility(root, records, manifest, sourceIdentity)
    const notebooks = await readPackageNotebooks(root, [...files.keys()])
    await executionEvidenceKeys(root, records, notebooks, signal)
    // File and reproducibility checks still apply to conversation-only packages. With no
    // native rows, there are no database relationships or provenance records to validate.
    if (Object.values(records.tables).every((rows) => rows.length === 0)) return
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const projectIds = new Set([manifest.source.projectId])
    for (const rows of Object.values(records.tables))
      for (const row of rows) if (typeof row.projectId === 'string') projectIds.add(row.projectId)
    const publishRecords = prepareNativePublication(projectIncludedHeads(records))
    await client.$transaction(async (transaction) => {
      for (const id of projectIds)
        await transaction.project.create({ data: { id, name: 'Package validation' } })
      await publishRecords(transaction)
    })
    const repository = new ArtifactProvenanceRepository({
      storageRoot: root,
      getClient: async () => client!
    })
    for (const version of records.tables.ArtifactVersion) {
      signal?.throwIfAborted()
      const lineage = records.tables.ArtifactLineage.find((row) => row.id === version.artifactId)
      if (!lineage) throw new Error('Session package Artifact lineage is missing.')
      const identity = {
        projectId: String(lineage.projectId),
        appSessionId: String(lineage.sessionId),
        artifactId: String(lineage.id),
        versionId: String(version.id)
      }
      if (version.originKind === 'agent_generated') {
        const result = await repository.getVersionProvenance(identity)
        if (
          result.contentStatus.state !== 'available' &&
          !excluded.has(String(version.contentStorageKey))
        )
          throw new Error('Session package Artifact content is unavailable.')
        if (version.messageSnapshotId && result.messages.state === 'unavailable')
          throw new Error('Session package Message snapshot is invalid or unsupported.')
      }
      await repository.readDependencyRelations({
        projectId: identity.projectId,
        versionId: identity.versionId,
        direction: 'up'
      })
    }
  } finally {
    try {
      await client?.$disconnect()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
