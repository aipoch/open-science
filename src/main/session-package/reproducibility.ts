import { SessionReproducibilityStore } from '../artifacts/session-reproducibility-store'
import { sessionReproducibilityBatchSchema } from '../../shared/session-reproducibility'
import { sha256 } from '../artifacts/provenance-canonical'
import { parseNotebookEnvironmentLock } from '../notebook/environment-lock'
import { assertPackageSourcePath } from './archive'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { z } from 'zod'
import { ArtifactReproducibilityReceiptStore } from '../artifacts/artifact-reproducibility-receipts'
import {
  REPRODUCIBILITY_SOURCE_FILE,
  reproducibilitySourceSchema,
  readReproducibilityEnvironmentLock
} from '../artifacts/reproducibility-source'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import type { ArtifactReproducibilityReceiptScope } from '../../shared/artifact-reproducibility'
import type { NativeRow, PackageRecords } from './native-snapshot'
import type { PackageExcludedFile, SessionPackageManifest } from '../../shared/session-package'

const path = z.string().min(1).max(2048)
const output = z
  .object({
    storageKey: path,
    filename: z.string().min(1).max(1000),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const packageReproducibilitySchema = z
  .object({
    sourceSessionCheck: sessionReproducibilityBatchSchema
      .refine(
        (batch) => ['completed', 'cancelled'].includes(batch.status),
        'Only terminal Session checks can be packaged.'
      )
      .optional(),
    versions: z
      .array(
        z
          .object({
            versionId: z.string().min(1).max(200),
            sourceScope: reproducibilitySourceSchema.shape.sourceScope,
            entityIds: reproducibilitySourceSchema.shape.entityIds,
            omittedOutputChecksums: reproducibilitySourceSchema.shape.omittedOutputChecksums,
            metadataKeys: z.array(path).max(10000),
            outputs: z.array(output).max(10000),
            environmentLocks: z
              .array(
                z
                  .object({
                    checksum: z.string().regex(/^[a-f0-9]{64}$/),
                    serialized: z
                      .string()
                      .max(4 * 1024 * 1024)
                      .optional()
                  })
                  .strict()
              )
              .max(10000)
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
export type PackageReproducibility = z.infer<typeof packageReproducibilitySchema>

const versionOwner = (
  records: PackageRecords,
  versionId: string
): { version: NativeRow; directory: string; scope: ArtifactReproducibilityReceiptScope } => {
  const version = records.tables.ArtifactVersion.find((row) => row.id === versionId)
  const lineage = records.tables.ArtifactLineage.find((row) => row.id === version?.artifactId)
  if (!version || !lineage || typeof version.contentStorageKey !== 'string')
    throw new Error('Reproducibility evidence has no Artifact Version owner.')
  return {
    version,
    directory: posix.dirname(version.contentStorageKey),
    scope: {
      projectId: String(lineage.projectId),
      appSessionId: String(lineage.sessionId),
      artifactId: String(lineage.id),
      versionId
    }
  }
}

export const capturePackageReproducibility = async (
  root: string,
  records: PackageRecords,
  scope: { projectId: string; sessionId: string },
  signal?: AbortSignal
): Promise<PackageReproducibility> => {
  const versions: PackageReproducibility['versions'] = []
  const locks = new Map<string, string>()
  let lockBytes = 0
  for (const version of records.tables.ArtifactVersion) {
    signal?.throwIfAborted()
    const owner = versionOwner(records, String(version.id))
    const store = new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => resolveStorageKey(root, owner.directory)
    })
    const source = await store.source(owner.scope)
    const files = await store.packageFiles(owner.scope, signal)
    const snapshot =
      typeof version.executionSnapshotJson === 'string'
        ? JSON.parse(version.executionSnapshotJson)
        : undefined
    const checksums = new Set<string>([
      ...files.lockChecksums,
      ...(snapshot?.runs ?? []).flatMap((run: { environmentLock?: { lockChecksum?: string } }) =>
        run.environmentLock?.lockChecksum ? [run.environmentLock.lockChecksum] : []
      ),
      ...(snapshot?.reproducibilityRecipe?.environmentRequirements ?? []).map(
        (requirement: { lockChecksum: string }) => requirement.lockChecksum
      )
    ])
    const environmentLocks = []
    for (const checksum of checksums) {
      if (!locks.has(checksum)) {
        if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid environment lock checksum.')
        const directory = 'runtime/provenance/environment-locks'
        let serialized: string | undefined
        try {
          if (source) {
            serialized = await store.environmentLock(owner.scope, checksum)
          } else {
            await assertPackageSourcePath(root, `${directory}/${checksum}.json`)
            serialized = await readReproducibilityEnvironmentLock(
              resolveStorageKey(root, directory),
              checksum
            )
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        if (serialized !== undefined) locks.set(checksum, serialized)
      }
      signal?.throwIfAborted()
      lockBytes += locks.get(checksum) ? Buffer.byteLength(locks.get(checksum)!) : 0
      if (lockBytes > 32 * 1024 * 1024)
        throw new Error('Environment lock evidence exceeds the package limit.')
      environmentLocks.push({
        checksum,
        ...(locks.get(checksum) !== undefined ? { serialized: locks.get(checksum) } : {})
      })
    }
    versions.push({
      environmentLocks,
      versionId: owner.scope.versionId,
      sourceScope: source?.sourceScope ?? owner.scope,
      entityIds:
        source?.entityIds ??
        Object.fromEntries(
          (snapshot?.provenanceGraph?.entities ?? [])
            .filter((entity: { kind: string }) => entity.kind === 'file-generation')
            .map((entity: { entityId: string }) => [entity.entityId, entity.entityId])
        ),
      omittedOutputChecksums: source?.omittedOutputChecksums ?? [],
      metadataKeys: files.metadata.map((key) => `${owner.directory}/reproducibility-checks/${key}`),
      outputs: files.outputs.map(({ path, ...file }) => ({
        ...file,
        storageKey: `${owner.directory}/reproducibility-checks/${path}`
      }))
    })
  }
  const batch = await new SessionReproducibilityStore(root).load({
    projectId: scope.projectId,
    appSessionId: scope.sessionId
  })
  const sourceSessionCheck =
    batch && ['completed', 'cancelled'].includes(batch.status) ? batch : undefined
  return packageReproducibilitySchema.parse({
    versions,
    ...(sourceSessionCheck ? { sourceSessionCheck } : {})
  })
}

export const packageReproducibilityKeys = (records: PackageRecords): string[] =>
  records.reproducibility?.versions.flatMap((version) => [
    ...version.metadataKeys,
    ...version.outputs.map((file) => file.storageKey)
  ]) ?? []

export const packageReproducibilityExclusions = (records: PackageRecords): PackageExcludedFile[] =>
  records.reproducibility?.versions.flatMap((version) =>
    version.outputs
      .filter((file) => version.omittedOutputChecksums.includes(file.checksum))
      .map(({ storageKey, filename, sizeBytes }) => ({ storageKey, filename, sizeBytes }))
  ) ?? []

// Source identities are evidence. Keep them intact and install an explicitly derived read mapping,
// rather than rewriting a sender's receipt and claiming it was produced by this installation.
export const installPackageReproducibility = async (
  root: string,
  records: PackageRecords,
  excluded: ReadonlySet<string>
): Promise<void> => {
  let lockBytes = 0
  for (const entry of records.reproducibility?.versions ?? []) {
    for (const lock of entry.environmentLocks) {
      lockBytes += lock.serialized ? Buffer.byteLength(lock.serialized) : 0
      if (lockBytes > 32 * 1024 * 1024)
        throw new Error('Environment lock evidence exceeds the package limit.')
    }
    const owner = versionOwner(records, entry.versionId)
    const directory = resolveStorageKey(root, owner.directory)
    await mkdir(directory, { recursive: true })
    for (const lock of entry.environmentLocks) {
      if (lock.serialized === undefined) continue
      if (sha256(lock.serialized) !== lock.checksum)
        throw new Error('Environment lock checksum mismatch.')
      parseNotebookEnvironmentLock(lock.serialized)
      await mkdir(join(directory, 'reproducibility-locks'), { recursive: true })
      await writeFile(
        join(directory, 'reproducibility-locks', `${lock.checksum}.json`),
        lock.serialized
      )
    }
    await writeFile(
      join(directory, REPRODUCIBILITY_SOURCE_FILE),
      JSON.stringify({
        sourceScope: entry.sourceScope,
        entityIds: entry.entityIds,
        lockChecksums: entry.environmentLocks.map((lock) => lock.checksum),
        omittedOutputChecksums: entry.outputs
          .filter((file) => excluded.has(file.storageKey))
          .map((file) => file.checksum)
      })
    )
  }
}

export const validatePackageReproducibility = async (
  root: string,
  records: PackageRecords,
  manifest: SessionPackageManifest,
  sourceIdentity = manifest.source
): Promise<void> => {
  const files = new Map(manifest.inventory.map((entry) => [entry.storageKey, entry]))
  const excluded = new Set(manifest.excludedFiles.map((file) => file.storageKey))
  const seen = new Set<string>()
  const batch = records.reproducibility?.sourceSessionCheck
  if (
    batch &&
    (batch.projectId !== sourceIdentity.projectId ||
      batch.appSessionId !== sourceIdentity.sessionId)
  )
    throw new Error('Source Session check identity mismatch.')
  let lockBytes = 0
  for (const entry of records.reproducibility?.versions ?? []) {
    if (seen.has(entry.versionId)) throw new Error('Duplicate reproducibility Version.')
    seen.add(entry.versionId)
    const owner = versionOwner(records, entry.versionId)
    const prefix = `${owner.directory}/reproducibility-checks/`
    const locks = new Set<string>()
    for (const lock of entry.environmentLocks) {
      if (locks.has(lock.checksum)) throw new Error('Duplicate environment lock.')
      locks.add(lock.checksum)
      lockBytes += lock.serialized ? Buffer.byteLength(lock.serialized) : 0
      if (lockBytes > 32 * 1024 * 1024)
        throw new Error('Environment lock evidence exceeds the package limit.')
    }
    for (const key of [...entry.metadataKeys, ...entry.outputs.map((file) => file.storageKey)]) {
      if (!key.startsWith(prefix)) throw new Error('Reproducibility evidence escapes its Version.')
      if (!files.has(key) && !excluded.has(key))
        throw new Error('Package omits reproducibility evidence.')
    }
    for (const output of entry.outputs) {
      if (excluded.has(output.storageKey)) continue
      const file = files.get(output.storageKey)
      if (file?.checksum !== output.checksum || file.sizeBytes !== output.sizeBytes)
        throw new Error('Reproduced output metadata mismatch.')
    }
    const store = new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => resolveStorageKey(root, owner.directory)
    })
    const captured = await store.packageFiles(owner.scope)
    if (captured.targetChecksums.some((checksum) => checksum !== owner.version.checksum))
      throw new Error('Reproducibility target checksum mismatch.')
    if (captured.lockChecksums.some((checksum) => !locks.has(checksum)))
      throw new Error('Package omits an environment lock reference.')
    if (
      JSON.stringify([...captured.metadata].sort()) !==
      JSON.stringify(entry.metadataKeys.map((key) => key.slice(prefix.length)).sort())
    )
      throw new Error('Reproducibility history inventory mismatch.')
    const expectedOutputs = captured.outputs.map(({ path, ...file }) => ({
      ...file,
      storageKey: `${prefix}${path}`
    }))
    if (
      !isDeepStrictEqual(
        expectedOutputs.sort((a, b) => a.storageKey.localeCompare(b.storageKey)),
        [...entry.outputs].sort((a, b) => a.storageKey.localeCompare(b.storageKey))
      )
    )
      throw new Error('Reproducibility output inventory mismatch.')
  }
}
