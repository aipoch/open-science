import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { DeleteUploadRequest } from '../../shared/uploads'
import {
  assertPathInsideRoot,
  assertSafePathSegment,
  getSessionUploadDir,
  isFileExistsError,
  isMissingFileError
} from './storage-helpers'

const LEGACY_CLEANUP_PRIVATE_SUFFIX = '.legacy-cleanup.private'
const LEGACY_CLEANUP_CANDIDATE = 'candidate'

type VerifiedLegacyCleanupOptions = {
  getClient?: () => Promise<PrismaClient>
  getLegacyFileChecksum?: (path: string) => Promise<string>
  renameLegacyForCleanup?: (source: string, destination: string) => Promise<void>
}

type VerifiedLegacyCleanupDependencies = {
  resolveManagedUploadPath: (
    request: DeleteUploadRequest,
    scope?: { projectId?: string; sessionId?: string }
  ) => Promise<string>
}

type RemoveVerifiedLegacyCopyInput = {
  projectId: string
  sessionId: string
  uploadFileId: string
  versionId: string
  filename: string
  legacyPath?: string
}

type LegacyCleanupResult =
  { status: 'absent' | 'removed' } | { status: 'unsafe-residual'; reason: string }

type FileIdentity = Awaited<ReturnType<typeof lstat>>

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

const hasSameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size

const hasSameFileSnapshot = (left: FileIdentity, right: FileIdentity): boolean =>
  hasSameFileIdentity(left, right) &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

class LegacyCleanupIncompleteError extends Error {}

// Terminal Project deletion may leave bytes only when reconciliation has positively proved that the
// deterministic legacy path no longer contains the Version-owned source.
class UnsafeLegacyUploadResidualError extends Error {}

// Sole owner of verified legacy source removal, private-claim restoration and absence proof.
class VerifiedLegacyCleanupOwner {
  constructor(
    private readonly storageRoot: string,
    private readonly options: VerifiedLegacyCleanupOptions,
    private readonly dependencies: VerifiedLegacyCleanupDependencies
  ) {}

  async hasPrivateClaim(legacyPath: string): Promise<boolean> {
    try {
      await lstat(`${legacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`)
      return true
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  // Cleanup is fail-closed: SQLite authority, both byte copies, the deterministic legacy path and
  // source identity must all remain valid through the final pre-delete check.
  async removeVerifiedLegacyCopy(
    input: RemoveVerifiedLegacyCopyInput
  ): Promise<LegacyCleanupResult> {
    const projectId = assertSafePathSegment(input.projectId)
    const sessionId = assertSafePathSegment(input.sessionId)
    const uploadFileId = assertSafePathSegment(input.uploadFileId)
    const versionId = assertSafePathSegment(input.versionId)
    const legacyRoot = getSessionUploadDir(this.storageRoot, sessionId)
    const expectedLegacyPath = resolve(legacyRoot, input.filename)
    const cleanupPrivateDir = `${expectedLegacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    const cleanupPrivatePath = join(cleanupPrivateDir, LEGACY_CLEANUP_CANDIDATE)
    assertPathInsideRoot(legacyRoot, expectedLegacyPath)
    assertPathInsideRoot(legacyRoot, cleanupPrivateDir)
    assertPathInsideRoot(legacyRoot, cleanupPrivatePath)

    let initialLegacyInfo: FileIdentity | undefined
    let privateDirInfo: FileIdentity | undefined
    let privateInfo: FileIdentity | undefined
    try {
      initialLegacyInfo = await lstat(expectedLegacyPath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    try {
      privateDirInfo = await lstat(cleanupPrivateDir)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (privateDirInfo) {
      if (!privateDirInfo.isDirectory() || privateDirInfo.isSymbolicLink()) {
        throw new LegacyCleanupIncompleteError(
          `Legacy upload cleanup found an unsafe private claim: ${input.filename}`
        )
      }
      try {
        privateInfo = await lstat(cleanupPrivatePath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
        try {
          await rmdir(cleanupPrivateDir)
          privateDirInfo = undefined
        } catch {
          throw new LegacyCleanupIncompleteError(
            `Legacy upload cleanup found an incomplete private claim: ${input.filename}`
          )
        }
      }
    }
    if (!initialLegacyInfo && !privateInfo) return { status: 'absent' }

    if (input.legacyPath && resolve(input.legacyPath) !== expectedLegacyPath) {
      return {
        status: 'unsafe-residual',
        reason: 'the recorded legacy path does not match its deterministic Session path'
      }
    }
    if (!this.options.getClient) {
      throw new Error(`Upload Version authority is unavailable for legacy cleanup: ${versionId}`)
    }

    const client = await this.options.getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        id: versionId,
        uploadFileId,
        state: 'ready',
        uploadFile: { is: { projectId, sessionId } }
      },
      select: { contentStorageKey: true, filename: true, sizeBytes: true, checksum: true }
    })
    if (!version) throw new Error(`Ready Upload Version authority is unavailable: ${versionId}`)
    if (version.filename !== input.filename) {
      throw new Error(`Ready Upload Version filename does not match: ${versionId}`)
    }

    const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
    assertPathInsideRoot(this.storageRoot, finalPath, 'Upload storage key escapes storage.')
    const finalInfo = await stat(finalPath)
    if (
      !finalInfo.isFile() ||
      finalInfo.size !== Number(version.sizeBytes) ||
      (await sha256File(finalPath)) !== version.checksum
    ) {
      throw new Error(`Ready Upload Version content is unavailable or corrupt: ${versionId}`)
    }

    // A pre-existing claim has lost its original process's pre-rename inode witness. Restore it
    // without overwrite and make this invocation prove the legacy path again before reacquiring it.
    if (privateInfo) {
      await this.restoreLegacyCleanupPrivate(
        cleanupPrivateDir,
        cleanupPrivatePath,
        expectedLegacyPath,
        privateInfo
      )
    }

    let verifiedLegacyInfo: FileIdentity
    try {
      initialLegacyInfo = await lstat(expectedLegacyPath)
      if (!initialLegacyInfo.isFile() || initialLegacyInfo.isSymbolicLink()) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path is not a regular owned file'
        }
      }
      const sourcePath = await this.dependencies.resolveManagedUploadPath(
        { path: expectedLegacyPath },
        { projectId, sessionId }
      )
      const resolvedLegacyPath = await realpath(expectedLegacyPath)
      const resolvedFinalPath = await realpath(finalPath)
      if (
        sourcePath !== resolvedLegacyPath ||
        sourcePath === resolvedFinalPath ||
        initialLegacyInfo.size !== Number(version.sizeBytes)
      ) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path does not match the Version-owned source'
        }
      }
      const legacyChecksum = await (this.options.getLegacyFileChecksum ?? sha256File)(
        expectedLegacyPath
      )
      if (legacyChecksum !== version.checksum) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path contains different content'
        }
      }
      verifiedLegacyInfo = await lstat(expectedLegacyPath)
      const verifiedLegacyPath = await realpath(expectedLegacyPath)
      if (
        !verifiedLegacyInfo.isFile() ||
        verifiedLegacyInfo.isSymbolicLink() ||
        verifiedLegacyPath !== sourcePath ||
        !hasSameFileSnapshot(verifiedLegacyInfo, initialLegacyInfo)
      ) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path changed during ownership verification'
        }
      }
    } catch (error) {
      if (isMissingFileError(error)) return { status: 'absent' }
      throw error
    }

    try {
      // mkdir is the portable no-replace claim; the rename target inside it cannot collide with
      // another cooperating cleanup process.
      await mkdir(cleanupPrivateDir)
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new LegacyCleanupIncompleteError(
          `Legacy upload cleanup private claim is already occupied: ${input.filename}`
        )
      }
      throw error
    }
    try {
      await (this.options.renameLegacyForCleanup ?? rename)(expectedLegacyPath, cleanupPrivatePath)
    } catch (error) {
      if (isMissingFileError(error)) {
        try {
          await rmdir(cleanupPrivateDir)
        } catch {
          throw new LegacyCleanupIncompleteError(
            `Legacy upload cleanup could not release its private claim: ${input.filename}`
          )
        }
        return { status: 'absent' }
      }
      throw error
    }

    const movedInfo = await lstat(cleanupPrivatePath)
    const movedChecksum = await sha256File(cleanupPrivatePath)
    const reverifiedMovedInfo = await lstat(cleanupPrivatePath)
    if (
      !hasSameFileIdentity(movedInfo, verifiedLegacyInfo) ||
      movedChecksum !== version.checksum ||
      !hasSameFileSnapshot(reverifiedMovedInfo, movedInfo)
    ) {
      await this.restoreLegacyCleanupPrivate(
        cleanupPrivateDir,
        cleanupPrivatePath,
        expectedLegacyPath,
        reverifiedMovedInfo
      )
      return {
        status: 'unsafe-residual',
        reason: 'the claimed legacy source changed before removal'
      }
    }

    await rm(cleanupPrivatePath, { force: true })
    await rmdir(cleanupPrivateDir)
    return { status: 'removed' }
  }

  private async restoreLegacyCleanupPrivate(
    cleanupPrivateDir: string,
    cleanupPrivatePath: string,
    expectedLegacyPath: string,
    privateInfo: FileIdentity
  ): Promise<void> {
    if (!privateInfo.isFile() || privateInfo.isSymbolicLink()) {
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup left an unverifiable private candidate: ${basename(expectedLegacyPath)}`
      )
    }
    try {
      await link(cleanupPrivatePath, expectedLegacyPath)
    } catch (error) {
      if (isFileExistsError(error)) {
        const currentLegacyInfo = await lstat(expectedLegacyPath).catch(() => undefined)
        if (currentLegacyInfo && hasSameFileIdentity(currentLegacyInfo, privateInfo)) {
          await rm(cleanupPrivatePath, { force: true })
          await rmdir(cleanupPrivateDir)
          return
        }
      }
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup could not safely restore a private candidate: ${basename(expectedLegacyPath)}`
      )
    }
    await rm(cleanupPrivatePath, { force: true })
    await rmdir(cleanupPrivateDir)
  }

  async assertLegacySourceAbsent(
    sessionId: string,
    filename: string,
    cleanup: LegacyCleanupResult
  ): Promise<void> {
    const legacyRoot = getSessionUploadDir(this.storageRoot, assertSafePathSegment(sessionId))
    const legacyPath = resolve(legacyRoot, filename)
    const cleanupPrivateDir = `${legacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    assertPathInsideRoot(legacyRoot, legacyPath)
    assertPathInsideRoot(legacyRoot, cleanupPrivateDir)
    try {
      await lstat(cleanupPrivateDir)
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup found an incomplete private claim: ${filename}`
      )
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    try {
      await lstat(legacyPath)
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
    if (cleanup.status === 'unsafe-residual') {
      throw new UnsafeLegacyUploadResidualError(
        `Legacy upload source is not owned by its ready Version: ${filename}; ${cleanup.reason}.`
      )
    }
    throw new Error(`Legacy upload cleanup is incomplete: ${filename}`)
  }
}

export { UnsafeLegacyUploadResidualError, VerifiedLegacyCleanupOwner }
export type {
  LegacyCleanupResult,
  RemoveVerifiedLegacyCopyInput,
  VerifiedLegacyCleanupDependencies
}
