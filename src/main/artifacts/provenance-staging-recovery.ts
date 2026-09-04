import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type { ArtifactDurability } from './durability'
import { sha256 } from './provenance-canonical'
import { readOptionalFile, resolveStorageKey, storageKey } from './provenance-storage'
import { ArtifactCompatibilityScanIncompleteError, type ArtifactRepository } from './repository'
import type {
  CompatibilityRoutingPublicationOptions,
  PersistedVersionFileRecord,
  PublishCompatibilityRouting,
  StagingArtifactVersionRecord
} from './provenance-version-writer'
import { requireAgentArtifactVersion } from './provenance-version-kind'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Reconciliation can also run from a read path while an active writer is between copying bytes and
// inserting its staging row. Only rowless directories older than a full hour are proven abandoned.
const ORPHAN_STAGING_GRACE_MS = 60 * 60 * 1_000

type ArtifactProvenanceStagingRecoveryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  compatibilityRepository: ArtifactRepository
  createId: () => string
  now: () => Date
  durability: ArtifactDurability
  projectVersionFile: (
    version: PersistedVersionFileRecord,
    projectId: string,
    appSessionId: string
  ) => Promise<ArtifactVersionFile>
}

type ArtifactStagingReconciliationResult = {
  recoveredVersionIds: string[]
  quarantinedVersionIds: string[]
}

const moveDirectoryIfPresent = async (source: string, destination: string): Promise<boolean> => {
  try {
    await rename(source, destination)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

export class ArtifactProvenanceStagingRecovery {
  constructor(private readonly options: ArtifactProvenanceStagingRecoveryOptions) {}

  routingPublisher(
    projectId: string,
    artifactStorageSessionId: string,
    filename: string
  ): PublishCompatibilityRouting {
    return (version, options) =>
      this.ensureCompatibilityRouting(
        version,
        projectId,
        artifactStorageSessionId,
        filename,
        options
      )
  }

  async recoverVersion(
    version: StagingArtifactVersionRecord,
    projectId: string,
    appSessionId: string,
    requestedFilename: string,
    publishCompatibilityRouting?: PublishCompatibilityRouting
  ): Promise<ArtifactVersionFile> {
    if (sha256(version.evidenceJson) !== version.evidenceChecksum) {
      throw new Error(`Artifact Version canonical evidence is corrupt: ${version.id}`)
    }
    if (
      version.executionSnapshotJson &&
      (!version.executionSnapshotChecksum ||
        sha256(version.executionSnapshotJson) !== version.executionSnapshotChecksum)
    ) {
      throw new Error(`Artifact Version canonical execution snapshot is corrupt: ${version.id}`)
    }

    const stagingDirectory = resolveStorageKey(
      this.options.storageRoot,
      storageKey(
        'artifacts',
        projectId,
        appSessionId,
        '.provenance',
        '.staging',
        'versions',
        version.id
      )
    )
    const finalContentPath = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const finalDirectory = dirname(finalContentPath)
    const [stagingContent, finalContent] = await Promise.all([
      readOptionalFile(join(stagingDirectory, 'content')),
      readOptionalFile(finalContentPath)
    ])
    if (stagingContent && finalContent) {
      throw new Error(`Artifact Version has conflicting staging and final content: ${version.id}`)
    }
    const content = finalContent ?? stagingContent
    if (!content) throw new Error(`Artifact Version staging content is unavailable: ${version.id}`)
    if (content.byteLength !== Number(version.sizeBytes) || sha256(content) !== version.checksum) {
      throw new Error(`Artifact Version staging content is corrupt: ${version.id}`)
    }

    const publishDirectory = finalContent ? finalDirectory : stagingDirectory
    await this.syncAndVerifyFile(
      join(publishDirectory, 'content'),
      version.checksum,
      `Artifact Version staging content is corrupt: ${version.id}`
    )
    await this.ensureCanonicalMirror(
      join(publishDirectory, 'evidence.json'),
      version.evidenceJson,
      version.evidenceChecksum,
      `Artifact Version evidence mirror is corrupt: ${version.id}`
    )
    if (
      version.executionSnapshotJson &&
      version.executionSnapshotChecksum &&
      version.executionSnapshotStorageKey
    ) {
      await this.ensureCanonicalMirror(
        join(publishDirectory, 'execution.json'),
        version.executionSnapshotJson,
        version.executionSnapshotChecksum,
        `Artifact Version execution mirror is corrupt: ${version.id}`
      )
    }

    if (!finalContent) {
      await mkdir(dirname(finalDirectory), { recursive: true })
      await this.options.durability.syncDirectory(stagingDirectory)
      await rename(stagingDirectory, finalDirectory)
    }
    await this.options.durability.syncDirectory(dirname(finalDirectory))
    let routingPublisher = publishCompatibilityRouting
    if (!routingPublisher) {
      const pendingOwner = await this.options.compatibilityRepository.findPendingFileForRun({
        projectId: projectId,
        runId: version.artifactRunId,
        filename: requestedFilename,
        checksum: version.checksum
      })
      if (!pendingOwner) {
        throw new Error(
          `Artifact Version staging compatibility route is unavailable: ${version.id}`
        )
      }
      routingPublisher = this.routingPublisher(
        projectId,
        pendingOwner.storageSessionId,
        requestedFilename
      )
    }
    await routingPublisher(version, { allowRoutingReplacement: true })

    const client = await this.options.getClient()
    const recovered = await client.$transaction(async (transaction) => {
      await transaction.artifactLineage.update({
        where: { id: version.artifactId },
        data: { filename: requestedFilename }
      })
      return transaction.artifactVersion.update({
        where: { id: version.id },
        data: { state: 'pending' }
      })
    })
    return this.options.projectVersionFile(
      requireAgentArtifactVersion(recovered),
      projectId,
      appSessionId
    )
  }

  async reconcileSession(
    projectId: string,
    appSessionId: string,
    removeOrphanStaging = false
  ): Promise<ArtifactStagingReconciliationResult> {
    const provenanceRoot = resolveStorageKey(
      this.options.storageRoot,
      storageKey('artifacts', projectId, appSessionId, '.provenance')
    )
    const result: ArtifactStagingReconciliationResult = {
      recoveredVersionIds: [],
      quarantinedVersionIds: []
    }
    const client = await this.options.getClient()
    const stagingVersions = await client.artifactVersion
      .findMany({
        where: {
          originKind: 'agent_generated',
          state: 'staging',
          artifact: { is: { projectId, sessionId: appSessionId } }
        },
        include: { artifact: true }
      })
      .then((rows) => rows.map(requireAgentArtifactVersion))

    // A crash can leave a complete staging row after its immutable bytes were copied but before the
    // final state update. Resume those rows from SQLite authority before scanning unindexed folders.
    for (const version of stagingVersions) {
      try {
        await this.recoverVersion(version, projectId, appSessionId, version.filename)
        result.recoveredVersionIds.push(version.id)
      } catch (error) {
        // A transient/unrelated compatibility I/O error proves only that the scan was incomplete.
        // Leave the authoritative staging row untouched so a later startup can retry; quarantine is
        // reserved for a complete scan that positively fails the recovery proof.
        if (error instanceof ArtifactCompatibilityScanIncompleteError) continue
        const stillStaging = await client.artifactVersion.findUnique({
          where: { id: version.id },
          select: { state: true }
        })
        if (stillStaging?.state !== 'staging') continue

        // A staging row that cannot be resumed must not poison the operation forever. Preserve any
        // bytes for diagnosis under quarantine, then remove only the still-staging row so an exact
        // retry can start cleanly instead of colliding with a permanently broken lifecycle record.
        const quarantineDirectory = join(
          provenanceRoot,
          '.quarantine',
          'staging-invalid',
          version.artifactId,
          `${version.id}-${this.options.createId()}`
        )
        await mkdir(quarantineDirectory, { recursive: true })
        const stagingDirectory = join(provenanceRoot, '.staging', 'versions', version.id)
        const finalDirectory = dirname(
          resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
        )
        await moveDirectoryIfPresent(stagingDirectory, join(quarantineDirectory, 'staging'))
        await moveDirectoryIfPresent(finalDirectory, join(quarantineDirectory, 'published'))
        const deleted = await client.artifactVersion.deleteMany({
          where: { id: version.id, state: 'staging' }
        })
        if (deleted.count === 1) result.quarantinedVersionIds.push(version.id)
      }
    }

    if (removeOrphanStaging) {
      // A process can exit after copying immutable bytes but before inserting the staging authority
      // row. Only startup reconciliation may remove those rowless temporary copies: read-triggered
      // reconciliation can overlap an active writer and therefore remains non-destructive.
      const stagingVersionsRoot = join(provenanceRoot, '.staging', 'versions')
      const orphanCandidates = await readdir(stagingVersionsRoot, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
          ) {
            return []
          }
          throw error
        }
      )
      for (const candidate of orphanCandidates) {
        if (!candidate.isDirectory() || !SAFE_SEGMENT_PATTERN.test(candidate.name)) continue
        const authority = await client.artifactVersion.findUnique({
          where: { id: candidate.name },
          select: { id: true }
        })
        if (authority) continue
        const candidatePath = join(stagingVersionsRoot, candidate.name)
        const candidateStat = await stat(candidatePath).catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
          ) {
            return undefined
          }
          throw error
        })
        if (
          !candidateStat ||
          this.options.now().getTime() - candidateStat.mtimeMs < ORPHAN_STAGING_GRACE_MS
        ) {
          continue
        }
        await rm(candidatePath, { recursive: true, force: true })
      }
    }

    return result
  }

  private async ensureCompatibilityRouting(
    version: PersistedVersionFileRecord,
    projectId: string,
    artifactStorageSessionId: string,
    filename: string,
    options: CompatibilityRoutingPublicationOptions = {}
  ): Promise<void> {
    await this.options.compatibilityRepository.ensurePendingVersionRouting({
      projectId: projectId,
      sessionId: artifactStorageSessionId,
      runId: version.artifactRunId,
      filename,
      sourcePath: resolveStorageKey(this.options.storageRoot, version.contentStorageKey),
      routing: {
        artifactId: version.artifactId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        artifactRunId: version.artifactRunId,
        checksum: version.checksum,
        ...(version.contentType ? { mimeType: version.contentType } : {})
      },
      ...options
    })
  }

  private async syncAndVerifyFile(
    path: string,
    expectedChecksum: string,
    corruptMessage: string
  ): Promise<Buffer> {
    await this.options.durability.syncFile(path)
    const bytes = await readFile(path)
    if (sha256(bytes) !== expectedChecksum) throw new Error(corruptMessage)
    return bytes
  }

  private async ensureCanonicalMirror(
    path: string,
    canonical: string,
    checksum: string,
    corruptMessage: string
  ): Promise<string> {
    if (sha256(canonical) !== checksum) throw new Error(corruptMessage)
    let bytes = await readOptionalFile(path)
    if (!bytes) {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${this.options.createId()}.tmp`
      try {
        await writeFile(temporaryPath, canonical, { encoding: 'utf8', flag: 'wx' })
        await this.syncAndVerifyFile(temporaryPath, checksum, corruptMessage)
        await rename(temporaryPath, path)
        await this.options.durability.syncDirectory(dirname(path))
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      bytes = await this.syncAndVerifyFile(path, checksum, corruptMessage)
    } else {
      bytes = await this.syncAndVerifyFile(path, checksum, corruptMessage)
    }
    const value = bytes.toString('utf8')
    if (value !== canonical || sha256(bytes) !== checksum) throw new Error(corruptMessage)
    return value
  }
}

export type { ArtifactStagingReconciliationResult }
