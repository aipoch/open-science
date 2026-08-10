import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { DeleteUploadRequest } from '../../shared/uploads'
import {
  assertPathInsideRoot,
  assertSafePathSegment,
  getSessionUploadDir,
  isFileExistsError,
  isMissingFileError
} from './storage-helpers'
import { publishNoReplace } from './atomic-no-replace-publisher'

const LEGACY_CLEANUP_PRIVATE_SUFFIX = '.legacy-cleanup.private'
const LEGACY_RECOVERY_TEMP_STALE_AFTER_MS = 24 * 60 * 60 * 1_000
const LEGACY_RECOVERY_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HARD_LINK_FALLBACK_ERROR_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV'
])
const ATOMIC_PUBLICATION_UNAVAILABLE_ERROR_CODES = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])
const LEGACY_CLEANUP_CANDIDATE = 'candidate'

type VerifiedLegacyCleanupOptions = {
  getClient?: () => Promise<PrismaClient>
  getLegacyFileChecksum?: (path: string) => Promise<string>
  renameLegacyForCleanup?: (source: string, destination: string) => Promise<void>
  linkReadyContent?: typeof link
  copyReadyContent?: typeof copyFile
  publishReadyContentNoReplace?: typeof publishNoReplace
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
type ReadyContentCopyResult =
  | { status: 'published' }
  | { status: 'destination-exists' }
  | { status: 'unsafe-residual'; reason: string }

const isHardLinkUnavailableError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  HARD_LINK_FALLBACK_ERROR_CODES.has(String((error as { code?: unknown }).code))

const isAtomicPublicationUnavailableError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ATOMIC_PUBLICATION_UNAVAILABLE_ERROR_CODES.has(String((error as { code?: unknown }).code))

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

  private async reclaimStaleRecoveryTemporaries(finalPath: string): Promise<void> {
    const parentPath = dirname(finalPath)
    const namePrefix = `${basename(finalPath)}.legacy-recovery.copy.`
    const nameSuffix = '.tmp'
    const staleBefore = Date.now() - LEGACY_RECOVERY_TEMP_STALE_AFTER_MS
    const entries = await readdir(parentPath, { withFileTypes: true })

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(namePrefix) ||
        !entry.name.endsWith(nameSuffix)
      ) {
        continue
      }
      const attemptId = entry.name.slice(namePrefix.length, -nameSuffix.length)
      if (!LEGACY_RECOVERY_ATTEMPT_ID_PATTERN.test(attemptId)) continue

      const candidatePath = join(parentPath, entry.name)
      assertPathInsideRoot(this.storageRoot, candidatePath, 'Upload recovery path escapes storage.')
      const candidateInfo = await lstat(candidatePath).catch((error: unknown) => {
        if (isMissingFileError(error)) return undefined
        throw error
      })
      if (
        !candidateInfo?.isFile() ||
        candidateInfo.isSymbolicLink() ||
        candidateInfo.mtimeMs > staleBefore
      ) {
        continue
      }

      const currentInfo = await lstat(candidatePath).catch((error: unknown) => {
        if (isMissingFileError(error)) return undefined
        throw error
      })
      if (currentInfo && hasSameFileSnapshot(currentInfo, candidateInfo)) {
        await rm(candidatePath, { force: true })
      }
    }
  }

  private async ensureSafeFinalParent(finalPath: string): Promise<boolean> {
    const storageRoot = resolve(this.storageRoot)
    const finalParent = dirname(finalPath)
    const parentSegments = relative(storageRoot, finalParent).split(sep).filter(Boolean)
    let currentPath = storageRoot

    for (const segment of parentSegments) {
      currentPath = join(currentPath, segment)
      let currentInfo: FileIdentity
      try {
        currentInfo = await lstat(currentPath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
        try {
          await mkdir(currentPath)
        } catch (mkdirError) {
          if (!isFileExistsError(mkdirError)) throw mkdirError
        }
        currentInfo = await lstat(currentPath)
      }
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) return false
    }

    const canonicalStorageRoot = await realpath(storageRoot)
    const canonicalFinalParent = await realpath(finalParent)
    try {
      assertPathInsideRoot(
        canonicalStorageRoot,
        join(canonicalFinalParent, basename(finalPath)),
        'Ready Upload Version parent escapes storage.'
      )
      return true
    } catch {
      return false
    }
  }

  private async publishReadyContentCopy(
    expectedLegacyPath: string,
    finalPath: string,
    verifiedLegacyInfo: FileIdentity,
    expectedSize: number,
    expectedChecksum: string
  ): Promise<ReadyContentCopyResult> {
    const temporaryPath = `${finalPath}.legacy-recovery.copy.${randomUUID()}.tmp`
    assertPathInsideRoot(this.storageRoot, temporaryPath, 'Upload recovery path escapes storage.')
    let ownedTemporaryInfo: FileIdentity | undefined
    try {
      try {
        // A UUID plus exclusive creation gives this attempt its own publication path. A crash may
        // leave that path behind, but it cannot block a later attempt with a different UUID.
        await (this.options.copyReadyContent ?? copyFile)(
          expectedLegacyPath,
          temporaryPath,
          constants.COPYFILE_EXCL
        )
      } catch (error) {
        if (!isFileExistsError(error)) {
          const partialInfo = await lstat(temporaryPath).catch(() => undefined)
          if (partialInfo?.isFile() === true && !partialInfo.isSymbolicLink()) {
            ownedTemporaryInfo = partialInfo
          }
        }
        throw error
      }
      ownedTemporaryInfo = await lstat(temporaryPath)
      const copiedContentIsValid =
        ownedTemporaryInfo.isFile() &&
        !ownedTemporaryInfo.isSymbolicLink() &&
        ownedTemporaryInfo.size === expectedSize &&
        (await sha256File(temporaryPath)) === expectedChecksum
      const reverifiedLegacyInfo = await lstat(expectedLegacyPath).catch((error: unknown) => {
        if (isMissingFileError(error)) return undefined
        throw error
      })
      const sourceStayedStable =
        reverifiedLegacyInfo?.isFile() === true &&
        !reverifiedLegacyInfo.isSymbolicLink() &&
        hasSameFileSnapshot(reverifiedLegacyInfo, verifiedLegacyInfo)
      if (!copiedContentIsValid || !sourceStayedStable) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path changed while copying Version content'
        }
      }

      if (!(await this.ensureSafeFinalParent(finalPath))) {
        return {
          status: 'unsafe-residual',
          reason: 'the ready Version content parent changed before publication'
        }
      }

      try {
        // The native adapter anchors the parent by descriptor/handle and atomically refuses an
        // existing destination. Path-based rename cannot provide both guarantees cross-platform.
        await (this.options.publishReadyContentNoReplace ?? publishNoReplace)(
          this.storageRoot,
          dirname(finalPath),
          basename(temporaryPath),
          basename(finalPath)
        )
        ownedTemporaryInfo = undefined
        return { status: 'published' }
      } catch (error) {
        if (isFileExistsError(error)) return { status: 'destination-exists' }
        if (isAtomicPublicationUnavailableError(error)) {
          return {
            status: 'unsafe-residual',
            reason: 'atomic no-replace publication is unavailable on the storage filesystem'
          }
        }
        throw error
      }
    } finally {
      if (ownedTemporaryInfo) {
        const currentTemporaryInfo = await lstat(temporaryPath).catch(() => undefined)
        if (currentTemporaryInfo && hasSameFileIdentity(currentTemporaryInfo, ownedTemporaryInfo)) {
          await rm(temporaryPath, { force: true })
        }
      }
    }
  }

  // Cleanup is fail-closed: SQLite authority, a verified byte source, the deterministic legacy
  // path and source identity must all remain valid through the final pre-delete check.
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
    let finalInfo: FileIdentity | undefined
    try {
      finalInfo = await stat(finalPath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (
      finalInfo &&
      (!finalInfo.isFile() ||
        finalInfo.size !== Number(version.sizeBytes) ||
        (await sha256File(finalPath)) !== version.checksum)
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
      const resolvedFinalPath = finalInfo ? await realpath(finalPath) : undefined
      if (
        sourcePath !== resolvedLegacyPath ||
        (resolvedFinalPath && sourcePath === resolvedFinalPath) ||
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

    if (!(await this.ensureSafeFinalParent(finalPath))) {
      return {
        status: 'unsafe-residual',
        reason: 'the ready Version content parent contains a symbolic link or escapes storage'
      }
    }
    await this.reclaimStaleRecoveryTemporaries(finalPath)

    let recoveredFinalInfo: FileIdentity | undefined
    if (!finalInfo) {
      let createdFinal = false
      let createdHardLink = false
      try {
        // Both paths are below the storage root, so linking publishes the verified inode without
        // exposing a partially copied immutable file.
        await (this.options.linkReadyContent ?? link)(expectedLegacyPath, finalPath)
        createdFinal = true
        createdHardLink = true
      } catch (error) {
        if (!isFileExistsError(error)) {
          if (!isHardLinkUnavailableError(error)) throw error
          const copyResult = await this.publishReadyContentCopy(
            expectedLegacyPath,
            finalPath,
            verifiedLegacyInfo,
            Number(version.sizeBytes),
            version.checksum
          )
          if (copyResult.status === 'unsafe-residual') return copyResult
          createdFinal = copyResult.status === 'published'
        }
      }

      const restoredFinalInfo = await lstat(finalPath)
      const reverifiedLegacyInfo = await lstat(expectedLegacyPath)
      const restoredContentIsValid =
        restoredFinalInfo.isFile() &&
        !restoredFinalInfo.isSymbolicLink() &&
        restoredFinalInfo.size === Number(version.sizeBytes) &&
        (await sha256File(finalPath)) === version.checksum
      const verifiedSourceStayedStable =
        reverifiedLegacyInfo.isFile() &&
        !reverifiedLegacyInfo.isSymbolicLink() &&
        hasSameFileIdentity(reverifiedLegacyInfo, verifiedLegacyInfo) &&
        reverifiedLegacyInfo.mtimeMs === verifiedLegacyInfo.mtimeMs
      const createdLinkHasVerifiedIdentity =
        !createdHardLink || hasSameFileIdentity(restoredFinalInfo, verifiedLegacyInfo)

      if (
        !restoredContentIsValid ||
        !verifiedSourceStayedStable ||
        !createdLinkHasVerifiedIdentity
      ) {
        if (createdFinal) {
          const currentFinalInfo = await lstat(finalPath).catch(() => undefined)
          if (currentFinalInfo && hasSameFileIdentity(currentFinalInfo, restoredFinalInfo)) {
            await rm(finalPath, { force: true })
          }
        }
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path changed while restoring Version content'
        }
      }
      if (createdHardLink) recoveredFinalInfo = restoredFinalInfo
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
      if (recoveredFinalInfo && hasSameFileIdentity(reverifiedMovedInfo, recoveredFinalInfo)) {
        let currentFinalInfo: FileIdentity | undefined
        try {
          currentFinalInfo = await lstat(finalPath)
        } catch (error) {
          if (!isMissingFileError(error)) throw error
        }
        if (currentFinalInfo && hasSameFileIdentity(currentFinalInfo, recoveredFinalInfo)) {
          await rm(finalPath, { force: true })
        }
      }
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
