import { imageTaskEvidenceMatches } from '../../shared/image-task'
import { validateResearchFilms } from './research-films'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PackageProgress, SessionPackageManifest } from '../../shared/session-package'
import { sha256 } from '../artifacts/provenance-canonical'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { decodeReviewScopeSnapshot } from '../artifacts/provenance-snapshot-decoder'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  environmentManifestChecksumForRun,
  environmentManifestStorageKey
} from '../notebook/repository'
import { createPackageMaterializer } from './materialize'
import { executionEvidenceKeys, hasComputeLogEvidence } from './execution-evidence'
import { validatePackageLiterature } from './literature'
import {
  nativeStorageKeys,
  prepareNativePublication,
  projectIncludedHeads,
  readPackageNotebooks
} from './native-snapshot'
import type { PackageRecords } from './records-contract'
import { installPackageReproducibility, validatePackageReproducibility } from './reproducibility'
import { validatePackageRoCrateMetadata } from './ro-crate'
import { assertNoExcludedContentCopies, validateExcludedFiles } from './selection'
import { validatePackageWebEvidence } from './web-evidence'

// A validation database contains only the current schema until package rows are published into it.
// Build that immutable seed once per process, then copy it into each isolated validation directory.
// This keeps every validation independent while avoiding a full migration walk for every import.
const validationDatabaseSeeds = new Map<string, Promise<string>>()
const validationDatabaseSeedRoots = new Set<string>()

process.once('exit', () => {
  for (const root of validationDatabaseSeedRoots) rmSync(root, { recursive: true, force: true })
})

const getValidationDatabaseSeed = (temporaryRoot: string): Promise<string> => {
  const existing = validationDatabaseSeeds.get(temporaryRoot)
  if (existing) return existing
  const prune = async (): Promise<void> => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const entries = await readdir(temporaryRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('open-science-package-validation-seed-'))
        continue
      const root = join(temporaryRoot, entry.name)
      if (validationDatabaseSeedRoots.has(root)) continue
      try {
        if ((await stat(root)).mtimeMs < cutoff)
          await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      } catch {
        // A racing process or unreadable entry must not block validation.
      }
    }
  }
  const pending = (async () => {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
    await prune()
    const root = await mkdtemp(join(temporaryRoot, 'open-science-package-validation-seed-'))
    validationDatabaseSeedRoots.add(root)
    const client = createProjectDbClient(root)
    try {
      await migrateApplicationDatabase(client)
      await client.$disconnect()
      return join(root, 'open-science.db')
    } catch (error) {
      await client.$disconnect().catch(() => undefined)
      validationDatabaseSeedRoots.delete(root)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      throw error
    }
  })()
  validationDatabaseSeeds.set(temporaryRoot, pending)
  pending.catch(() => {
    if (validationDatabaseSeeds.get(temporaryRoot) === pending)
      validationDatabaseSeeds.delete(temporaryRoot)
  })
  return pending
}

export const assertPortablePackageStorageKey = (key: string): void => {
  if (/^notebooks\/[^/]+\/[^/]+\/(?:frames\/[^/]+\/)?\.pending-runs(?:\/|$)/iu.test(key))
    throw new Error('Reserved Notebook pending Run path.')
  const segments = key.split('/')
  const isEnvironmentManifest =
    /^runtime\/provenance\/environment-manifests\/[a-f0-9]{64}\.json$/u.test(key)
  if (
    (!isEnvironmentManifest &&
      ![
        'artifacts',
        'uploads',
        'notebooks',
        'execution-file-evidence',
        'notebook-file-evidence',
        'file-evidence'
      ].includes(segments[0])) ||
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
  temporaryRoot = tmpdir(),
  onProgress?: (progress: PackageProgress) => void,
  destination = false
): Promise<void> => {
  if (records.webEvidence) validatePackageWebEvidence(records.webEvidence)
  if (
    Boolean(records.webEvidence?.requiredCapabilities?.includes('web-result-v2')) !==
    Boolean(manifest.requiredFeatures?.includes('web-evidence-v2'))
  )
    throw new Error('Web evidence reader capability declaration is invalid.')
  if (
    Boolean(records.webEvidence?.requiredCapabilities?.includes('web-restricted-result-v1')) !==
    Boolean(manifest.requiredFeatures?.includes('web-restricted-result-v1'))
  )
    throw new Error('Restricted Web reader capability declaration is invalid.')
  if (
    Boolean(records.webEvidence?.requiredCapabilities?.includes('web-search-operations-v1')) !==
    Boolean(manifest.requiredFeatures?.includes('web-search-operations-v1'))
  )
    throw new Error('Web operation protocol reader capability declaration is invalid.')
  if (Boolean(records.literature) !== Boolean(manifest.requiredFeatures?.includes('literature')))
    throw new Error('Literature package capability declaration is invalid.')
  if (
    hasComputeLogEvidence(records.logEvidence) !==
    Boolean(manifest.requiredFeatures?.includes('compute-log-evidence'))
  )
    throw new Error('Invalid Compute log feature declaration.')
  if (Boolean(records.logEvidence) !== Boolean(manifest.requiredFeatures?.includes('log-evidence')))
    throw new Error('Invalid execution log feature declaration.')
  validateResearchFilms(records, manifest)
  validatePackageLiterature(records)
  for (const file of manifest.excludedFiles) assertPortablePackageStorageKey(file.storageKey)
  const excluded = validateExcludedFiles(records, manifest.excludedFiles)
  assertNoExcludedContentCopies(records, manifest.excludedFiles, manifest.inventory)
  const files = new Map<string, SessionPackageManifest['inventory'][number]>()
  const portableKeys = new Set<string>()
  for (const entry of manifest.inventory) {
    if (!entry.storageKey) continue
    if (
      entry.storageKey.startsWith('execution-file-evidence/') &&
      entry.storageKey
        .split('/')
        .some((segment) => segment === '.shadow-evidence' || segment === '.shadow-evidence-v1')
    )
      throw new Error('Reserved local evidence metadata path.')
    if (excluded.has(entry.storageKey))
      throw new Error('Excluded package content must not be included.')
    assertPortablePackageStorageKey(entry.storageKey)
    const normalized = entry.storageKey.normalize('NFC').toLowerCase()
    if (portableKeys.has(normalized))
      throw new Error('Session package has colliding storage paths.')
    portableKeys.add(normalized)
    files.set(entry.storageKey, entry)
  }
  for (const lane of records.logEvidence ?? []) {
    const [, project, session] = lane.key.split('/')
    if (
      project !== manifest.source.projectId ||
      session === 'blobs' ||
      (session !== manifest.source.sessionId &&
        !records.tables.FileOriginSession.some(
          (row) => row.projectId === project && row.sessionId === session
        ))
    )
      throw new Error('Execution log is outside its Session scope.')
    for (const record of lane.records)
      if (files.has(lane.key + '/activity-' + record.activityId + '/evidence.json'))
        throw new Error('Duplicate native and log evidence owner.')
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
  const materializeStage = destination ? 'prepare-validation' : 'prepare-preview'
  const validationStage = destination ? 'validate-import' : 'validate-preview'
  const reportValidation = (stageProgress: number): void =>
    onProgress?.({ phase: 'validating', importStage: validationStage, stageProgress })
  const totalBytes = [...files.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0)
  let completedBytes = 0
  onProgress?.({ phase: 'validating', importStage: materializeStage, completedBytes, totalBytes })
  const root = await mkdtemp(join(temporaryRoot, 'open-science-package-validation-'))
  let client: ReturnType<typeof createProjectDbClient> | undefined
  try {
    const materialize = await createPackageMaterializer(
      directory,
      root,
      [...files.values()],
      signal,
      nativeStorageKeys(records)
    )
    for (const [key, entry] of files) {
      await materialize(entry, key, (bytes) =>
        onProgress?.({
          phase: 'validating',
          importStage: materializeStage,
          completedBytes: completedBytes + bytes,
          totalBytes
        })
      )
      completedBytes += entry.sizeBytes
    }
    reportValidation(0)
    await installPackageReproducibility(root, records, excluded)
    await validatePackageReproducibility(root, records, manifest, sourceIdentity)
    const notebooks = await readPackageNotebooks(root, [...files.keys()])
    const evidenceKeys = new Set(await executionEvidenceKeys(root, records, notebooks, signal))
    for (const key of files.keys()) {
      if (/^execution-file-evidence\/[^/]+\/blobs\//u.test(key) && !evidenceKeys.has(key))
        throw new Error('Unreferenced evidence pool object.')
    }
    await validatePackageRoCrateMetadata(directory, manifest, records, signal)
    reportValidation(0.35)
    // File and reproducibility checks still apply to conversation-only packages. With no
    // native rows, there are no database relationships or provenance records to validate.
    for (const document of notebooks) {
      for (const run of document.runs) {
        const checksum = environmentManifestChecksumForRun(run)
        if (!checksum || run.environmentManifest) continue
        const key = environmentManifestStorageKey(checksum)
        const entry = files.get(key)
        if (!entry || entry.checksum !== checksum)
          throw new Error('Session package omits required environment manifest evidence.')
      }
    }
    if (Object.values(records.tables).every((rows) => rows.length === 0)) {
      if (records.imageTasks?.length) throw new Error('Image task source Version is missing.')
      return
    }
    await copyFile(await getValidationDatabaseSeed(temporaryRoot), join(root, 'open-science.db'))
    client = createProjectDbClient(root)
    reportValidation(0.6)
    const projectIds = new Set([manifest.source.projectId])
    for (const rows of Object.values(records.tables))
      for (const row of rows) if (typeof row.projectId === 'string') projectIds.add(row.projectId)
    const publishRecords = prepareNativePublication(projectIncludedHeads(records))
    await client.$transaction(async (transaction) => {
      for (const id of projectIds)
        await transaction.project.create({ data: { id, name: 'Package validation' } })
      await publishRecords(transaction)
    })
    const tasksById = new Map(records.imageTasks?.map((task) => [task.id, task]))
    for (const task of records.imageTasks ?? []) {
      if (
        task.projectId !== manifest.source.projectId ||
        task.sessionId !== manifest.source.sessionId ||
        task.state === 'queued' ||
        task.state === 'running'
      )
        throw new Error('Invalid Session image task ownership or state.')
      const source = task.edit.source
      const artifactSource = source.sourceKind === 'artifact-version'
      const sourceVersion = records.tables[
        artifactSource ? 'ArtifactVersion' : 'UploadVersion'
      ].find((row) => row.id === source.sourceVersionId)
      const sourceFile = records.tables[artifactSource ? 'ArtifactLineage' : 'UploadFile'].find(
        (row) => row.id === source.sourceFileId
      )
      if (
        !sourceVersion ||
        !sourceFile ||
        sourceVersion[artifactSource ? 'artifactId' : 'uploadFileId'] !== sourceFile.id ||
        sourceFile.projectId !== source.projectId ||
        sourceFile.sessionId !== source.sourceSessionId ||
        sourceVersion.state !== (artifactSource ? 'finalized' : 'ready')
      )
        throw new Error('Image task source Version ownership does not match.')
      if (task.result) {
        const result = task.result
        const output = records.tables.ArtifactVersion.find((row) => row.id === result.versionId)
        const lineage = records.tables.ArtifactLineage.find((row) => row.id === result.artifactId)
        if (
          !output ||
          !lineage ||
          lineage.projectId !== task.projectId ||
          lineage.sessionId !== task.sessionId ||
          output.artifactId !== result.artifactId ||
          output.artifactRunId !== task.id ||
          output.state !== 'finalized' ||
          output.checksum !== result.checksum ||
          Number(output.sizeBytes) !== result.size ||
          output.versionNumber !== result.versionNumber ||
          output.filename !== result.name ||
          (output.contentType ?? undefined) !== result.mimeType
        )
          throw new Error('Image task output Version does not match.')
      }
    }
    reportValidation(0.7)
    let validatedVersions = 0
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
        const task = tasksById.get(String(version.artifactRunId))
        if (
          task &&
          !imageTaskEvidenceMatches(result.evidence, task.id, task.edit.source.sourceVersionId)
        )
          throw new Error('Image task output does not match its source Version.')
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
      reportValidation(0.7 + (0.3 * ++validatedVersions) / records.tables.ArtifactVersion.length)
    }
  } finally {
    try {
      await client?.$disconnect()
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}
