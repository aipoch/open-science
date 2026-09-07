import { createHash } from 'node:crypto'
import { constants, type BigIntStats, type Dirent } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle
} from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import {
  buildManagedVersionStoredFilename,
  isSafeManagedFileBasename,
  type ManagedFileSource
} from '../../shared/managed-file-versions'

type VersionFileScope = {
  source: ManagedFileSource
  projectId: string
  sessionId: string
  logicalFileId: string
}

type PlanImmutableInput = {
  operationId: string
  scope: VersionFileScope
  logicalFilename: string
  candidateIndex: number
}

type PlannedFile = {
  storageRef: string
  storedFilename: string
  versionToken: string
  candidateIndex: number
}

type Integrity = {
  sizeBytes: number
  checksum: string
}

type StoredFile = Integrity & {
  storageRef: string
  storedFilename: string
  versionToken?: string
}

type OpenImmutableOptions = {
  forceVerify?: boolean
}

type PublishImmutableInput = PlanImmutableInput & {
  plannedFile: PlannedFile
  content: Uint8Array
}

type InspectRecoveryInput = PlanImmutableInput & {
  plannedFile: PlannedFile
  expectedIntegrity: Integrity
}

type RemoveIncompleteInput = PlanImmutableInput & {
  plannedFile: PlannedFile
  actualIntegrity: Integrity
}

type ReadLease = Integrity & {
  localPath: string
  versionToken?: string
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
  assertCanCopyTo: (destinationPath: string) => Promise<void>
  verifyUnchanged: () => Promise<void>
  close: () => Promise<void>
}

type VersionFileOperatorErrorCode =
  | 'STORAGE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'OUT_OF_SPACE'
  | 'INTEGRITY_FAILED'
  | 'VERSION_CONFLICT'

class VersionFileOperatorError extends Error {
  readonly name = 'VersionFileOperatorError'

  constructor(
    readonly code: VersionFileOperatorErrorCode,
    message: string,
    readonly reason?: 'DESTINATION_COLLISION',
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

type LeaseSnapshot = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>

type StorageParentSnapshot = Pick<BigIntStats, 'dev' | 'ino'> & {
  path: string
  realPath: string
}

const snapshotMatches = (expected: LeaseSnapshot, actual: BigIntStats): boolean =>
  actual.isFile() &&
  expected.dev === actual.dev &&
  expected.ino === actual.ino &&
  expected.size === actual.size &&
  expected.mtimeNs === actual.mtimeNs

const verificationSnapshotMatches = (expected: LeaseSnapshot, actual: BigIntStats): boolean =>
  snapshotMatches(expected, actual) && expected.ctimeNs === actual.ctimeNs

const normalizeStorageError = (
  error: unknown,
  fallbackCode: VersionFileOperatorErrorCode,
  message: string
): VersionFileOperatorError => {
  if (error instanceof VersionFileOperatorError) return error
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new VersionFileOperatorError('PERMISSION_DENIED', message, undefined, { cause: error })
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new VersionFileOperatorError('OUT_OF_SPACE', message, undefined, { cause: error })
  }
  if (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EIO' ||
    code === 'ENODEV' ||
    code === 'ENXIO' ||
    code === 'ESTALE' ||
    code === 'ETIMEDOUT' ||
    code === 'EBUSY'
  ) {
    return new VersionFileOperatorError('STORAGE_UNAVAILABLE', message, undefined, {
      cause: error
    })
  }
  return new VersionFileOperatorError(fallbackCode, message, undefined, { cause: error })
}

interface VersionFileOperator {
  planImmutable(input: PlanImmutableInput): PlannedFile
  publishImmutable(input: PublishImmutableInput): Promise<StoredFile>
  openImmutable(
    storageRef: string,
    expectedIntegrity: Integrity,
    options?: OpenImmutableOptions
  ): Promise<ReadLease>
  removeImmutable(storageRef: string, expectedIntegrity: Integrity): Promise<void>
}

type VersionFileRecoveryInspection =
  | { state: 'missing' }
  | { state: 'complete'; integrity: Integrity }
  | { state: 'incomplete'; actualIntegrity: Integrity }
  | { state: 'occupied'; actualIntegrity: Integrity }

type VersionFileRecoveryClaim =
  | { state: 'reserved' }
  | { state: 'publishing' }
  | {
      state: 'deleting'
      actualIntegrity: Integrity
    }

interface VersionFileRecovery {
  inspectRecovery(input: InspectRecoveryInput): Promise<VersionFileRecoveryInspection>
  removeIncomplete(input: RemoveIncompleteInput): Promise<void>
}

type NodeVersionFileOperatorOptions = {
  storageRoot: string
  fileSystem?: Partial<VersionFileSystem>
}

type VersionFileSystem = {
  link: typeof link
  lstat: typeof lstat
  mkdir: (
    path: Parameters<typeof mkdir>[0],
    options?: Parameters<typeof mkdir>[1]
  ) => Promise<string | undefined>
  open: typeof open
  readdir: (
    path: Parameters<typeof readdir>[0],
    options: { withFileTypes: true }
  ) => Promise<Dirent[]>
  realpath: typeof realpath
  rename: typeof rename
  remove: typeof rm
  removeDirectory: typeof rmdir
}

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const VERSION_FILE_CANDIDATE_LIMIT = 16
const VERSION_TOKEN_SPACE = 36n ** 8n
const VERIFIED_IMMUTABLE_FILE_LIMIT = 1024
const immutableOperationTails = new Map<string, Promise<void>>()
const verifiedImmutableFiles = new Set<string>()

const immutableVerificationKey = (integrity: Integrity, snapshot: LeaseSnapshot): string =>
  [
    integrity.checksum,
    snapshot.dev,
    snapshot.ino,
    snapshot.size,
    snapshot.mtimeNs,
    snapshot.ctimeNs
  ].join('\0')

const rememberVerifiedImmutableFile = (key: string): void => {
  verifiedImmutableFiles.add(key)
  if (verifiedImmutableFiles.size <= VERIFIED_IMMUTABLE_FILE_LIMIT) return
  const oldest = verifiedImmutableFiles.values().next().value
  if (oldest !== undefined) verifiedImmutableFiles.delete(oldest)
}

const serializeImmutableOperation = async <T>(
  key: string,
  action: () => Promise<T>
): Promise<T> => {
  const previous = immutableOperationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const tail = previous.then(() => current)
  immutableOperationTails.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (immutableOperationTails.get(key) === tail) immutableOperationTails.delete(key)
  }
}

const assertScopeSegment = (value: string, label: string): string => {
  if (!SAFE_SCOPE_SEGMENT.test(value)) throw new Error(`Invalid version file ${label}.`)
  return value
}

const versionTokenFor = (operationId: string, candidateIndex: number): string => {
  if (!operationId) throw new Error('Version file operation id is required.')
  if (
    !Number.isSafeInteger(candidateIndex) ||
    candidateIndex < 0 ||
    candidateIndex >= VERSION_FILE_CANDIDATE_LIMIT
  ) {
    throw new Error('Version file candidate index is outside the bounded collision range.')
  }
  const digest = createHash('sha256')
    .update('managed-version\0')
    .update(operationId)
    .update('\0')
    .update(String(candidateIndex))
    .digest()
  const value = digest.readBigUInt64BE(0) % VERSION_TOKEN_SPACE
  return value.toString(36).padStart(8, '0')
}

const writeAll = async (
  handle: FileHandle,
  content: Uint8Array,
  hash?: ReturnType<typeof createHash>,
  position = 0
): Promise<void> => {
  let offset = 0
  while (offset < content.byteLength) {
    const result = await handle.write(
      content,
      offset,
      content.byteLength - offset,
      position + offset
    )
    if (result.bytesWritten <= 0) throw new Error('Version file write stalled.')
    hash?.update(content.subarray(offset, offset + result.bytesWritten))
    offset += result.bytesWritten
  }
}

const readExact = async (
  handle: FileHandle,
  buffer: Uint8Array,
  position: number
): Promise<void> => {
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, position + offset)
    if (result.bytesRead <= 0) throw new Error('Version file changed while reading.')
    offset += result.bytesRead
  }
}

const checksumHandle = async (handle: FileHandle, sizeBytes: number): Promise<string> => {
  const hash = createHash('sha256')
  let position = 0
  while (position < sizeBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, sizeBytes - position))
    await readExact(handle, buffer, position)
    hash.update(buffer)
    position += buffer.byteLength
  }
  return hash.digest('hex')
}

const measureImmutablePath = async (path: string, openFile: typeof open): Promise<Integrity> => {
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('Version storage reference is not a file.')
    return { sizeBytes: stats.size, checksum: await checksumHandle(handle, stats.size) }
  } finally {
    await handle.close()
  }
}

const isExistsError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'

const errorChainHasCode = (error: unknown, expectedCode: string): boolean => {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === expectedCode) return true
  return 'cause' in error && errorChainHasCode(error.cause, expectedCode)
}

class NodeVersionFileOperator implements VersionFileOperator, VersionFileRecovery {
  private readonly fileSystem: VersionFileSystem

  constructor(private readonly options: NodeVersionFileOperatorOptions) {
    if (!options.storageRoot) throw new Error('Version file storage root is required.')
    this.fileSystem = {
      link: options.fileSystem?.link ?? link,
      lstat: options.fileSystem?.lstat ?? lstat,
      mkdir: options.fileSystem?.mkdir ?? mkdir,
      open: options.fileSystem?.open ?? open,
      readdir: options.fileSystem?.readdir ?? readdir,
      realpath: options.fileSystem?.realpath ?? realpath,
      rename: options.fileSystem?.rename ?? rename,
      remove: options.fileSystem?.remove ?? rm,
      removeDirectory: options.fileSystem?.removeDirectory ?? rmdir
    }
  }

  planImmutable(input: PlanImmutableInput): PlannedFile {
    if (!isSafeManagedFileBasename(input.logicalFilename)) {
      throw new Error('Version file logical filename must be a safe basename.')
    }
    const versionToken = versionTokenFor(input.operationId, input.candidateIndex)
    const storedFilename = buildManagedVersionStoredFilename(
      input.logicalFilename,
      `v${versionToken}`
    )
    const sourceDirectory = input.scope.source === 'artifact' ? 'artifacts' : 'uploads'
    const storageRef = posix.join(
      sourceDirectory,
      assertScopeSegment(input.scope.projectId, 'project id'),
      assertScopeSegment(input.scope.sessionId, 'session id'),
      assertScopeSegment(input.scope.logicalFileId, 'logical file id'),
      'managed-versions',
      storedFilename
    )
    return { storageRef, storedFilename, versionToken, candidateIndex: input.candidateIndex }
  }

  async publishImmutable(input: PublishImmutableInput): Promise<StoredFile> {
    this.assertPlannedFile(input)
    const finalPath = this.resolveStorageRef(input.plannedFile.storageRef)
    return serializeImmutableOperation(finalPath, () =>
      this.publishImmutableUnlocked(input, finalPath)
    )
  }

  private async publishImmutableUnlocked(
    input: PublishImmutableInput,
    finalPath: string
  ): Promise<StoredFile> {
    let parentSnapshot: StorageParentSnapshot
    try {
      parentSnapshot = await this.prepareStorageParent(input.plannedFile.storageRef)
    } catch (error) {
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Unable to prepare immutable version storage.'
      )
    }
    let handle: FileHandle | undefined
    try {
      const claim = await this.ensureRecoveryReservation(input, parentSnapshot)
      try {
        handle = await this.fileSystem.open(finalPath, 'wx+', 0o600)
      } catch (error) {
        if (!isExistsError(error)) throw error
        await this.verifyStorageParentSnapshot(parentSnapshot)
        await this.assertNotSymbolicLink(finalPath)
        const existing = await measureImmutablePath(finalPath, this.fileSystem.open)
        await this.verifyStorageParentSnapshot(parentSnapshot)
        const expectedChecksum = createHash('sha256').update(input.content).digest('hex')
        if (
          existing.sizeBytes !== input.content.byteLength ||
          existing.checksum !== expectedChecksum
        ) {
          if (claim.state === 'reserved') {
            await this.removeRecoveryClaim(input, claim, parentSnapshot)
          }
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version destination already contains different bytes.',
            'DESTINATION_COLLISION',
            { cause: error }
          )
        }
        await this.removeRecoveryClaim(input, claim, parentSnapshot)
        return {
          storageRef: input.plannedFile.storageRef,
          storedFilename: input.plannedFile.storedFilename,
          sizeBytes: existing.sizeBytes,
          checksum: existing.checksum,
          versionToken: input.plannedFile.versionToken
        }
      }
      const createdFileSnapshot = await handle.stat({ bigint: true })
      try {
        if (!createdFileSnapshot.isFile() || createdFileSnapshot.size !== 0n) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'New immutable version destination is not an empty regular file.'
          )
        }
        await this.verifyStorageParentSnapshot(parentSnapshot)
      } catch (error) {
        await handle.close().catch(() => undefined)
        handle = undefined
        throw error
      }
      await this.writeRecoveryClaim(input, { state: 'publishing' }, parentSnapshot)
      const expectedChecksum = createHash('sha256').update(input.content).digest('hex')
      await writeAll(handle, input.content)
      await handle.sync()
      await this.verifyStorageParentSnapshot(parentSnapshot)
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size !== input.content.byteLength) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Version file size changed while publishing.'
        )
      }
      const checksum = await checksumHandle(handle, stats.size)
      if (checksum !== expectedChecksum) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Version file checksum changed while publishing.'
        )
      }
      await handle.close()
      handle = undefined
      await this.removeRecoveryClaim(input, undefined, parentSnapshot)
      return {
        storageRef: input.plannedFile.storageRef,
        storedFilename: input.plannedFile.storedFilename,
        sizeBytes: stats.size,
        checksum,
        versionToken: input.plannedFile.versionToken
      }
    } catch (error) {
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Unable to publish immutable version content.'
      )
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async openImmutable(
    storageRef: string,
    expectedIntegrity: Integrity,
    options?: OpenImmutableOptions
  ): Promise<ReadLease> {
    const localPath = this.resolveStorageRef(storageRef)
    if (
      !Number.isSafeInteger(expectedIntegrity.sizeBytes) ||
      expectedIntegrity.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(expectedIntegrity.checksum)
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version integrity metadata is invalid.'
      )
    }

    try {
      await this.verifyStorageParent(storageRef)
    } catch (error) {
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Immutable version storage is unavailable.'
      )
    }

    let handle: FileHandle | undefined
    try {
      await this.assertNotSymbolicLink(localPath)
      handle = await this.fileSystem.open(
        localPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      )
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size !== BigInt(expectedIntegrity.sizeBytes)) {
        throw new Error('Immutable version size or type does not match its record.')
      }
      const snapshot: LeaseSnapshot = {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs
      }
      let verificationKey = immutableVerificationKey(expectedIntegrity, snapshot)
      let cached = !options?.forceVerify && verifiedImmutableFiles.has(verificationKey)
      if (cached) {
        const after = await handle.stat({ bigint: true })
        if (!snapshotMatches(snapshot, after)) {
          throw new Error('Immutable version changed during cached integrity verification.')
        }
        if (snapshot.ctimeNs !== after.ctimeNs) {
          snapshot.ctimeNs = after.ctimeNs
          verificationKey = immutableVerificationKey(expectedIntegrity, snapshot)
          cached = false
        }
      }
      if (!cached) {
        const checksum = await checksumHandle(handle, expectedIntegrity.sizeBytes)
        const after = await handle.stat({ bigint: true })
        if (
          checksum !== expectedIntegrity.checksum ||
          !verificationSnapshotMatches(snapshot, after)
        ) {
          throw new Error('Immutable version changed during integrity verification.')
        }
        rememberVerifiedImmutableFile(verificationKey)
      }

      const leaseHandle = handle
      let closed = false
      const assertOpen = (): void => {
        if (closed) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Version file read lease is closed.'
          )
        }
      }
      const verifyUnchanged = async (): Promise<void> => {
        try {
          assertOpen()
          const current = await leaseHandle.stat({ bigint: true })
          if (!snapshotMatches(snapshot, current)) {
            throw new VersionFileOperatorError(
              'INTEGRITY_FAILED',
              'Immutable version changed during trusted consumption.'
            )
          }
          if (snapshot.ctimeNs !== current.ctimeNs) {
            const checksum = await checksumHandle(leaseHandle, expectedIntegrity.sizeBytes)
            const after = await leaseHandle.stat({ bigint: true })
            const revalidationSnapshot: LeaseSnapshot = {
              ...snapshot,
              ctimeNs: current.ctimeNs
            }
            if (
              checksum !== expectedIntegrity.checksum ||
              !verificationSnapshotMatches(revalidationSnapshot, after)
            ) {
              throw new VersionFileOperatorError(
                'INTEGRITY_FAILED',
                'Immutable version changed during trusted consumption.'
              )
            }
            verifiedImmutableFiles.delete(immutableVerificationKey(expectedIntegrity, snapshot))
            snapshot.ctimeNs = after.ctimeNs
            rememberVerifiedImmutableFile(immutableVerificationKey(expectedIntegrity, snapshot))
          }
        } catch (error) {
          throw normalizeStorageError(
            error,
            'INTEGRITY_FAILED',
            'Unable to verify immutable version content.'
          )
        }
      }
      const readRange = async (begin: number, end: number): Promise<Uint8Array> => {
        try {
          assertOpen()
          if (
            !Number.isSafeInteger(begin) ||
            !Number.isSafeInteger(end) ||
            begin < 0 ||
            end <= begin ||
            end > expectedIntegrity.sizeBytes
          ) {
            throw new VersionFileOperatorError(
              'INTEGRITY_FAILED',
              'Invalid version file lease range.'
            )
          }
          const buffer = Buffer.allocUnsafe(end - begin)
          await readExact(leaseHandle, buffer, begin)
          await verifyUnchanged()
          return new Uint8Array(buffer)
        } catch (error) {
          throw normalizeStorageError(
            error,
            'INTEGRITY_FAILED',
            'Unable to read immutable version content.'
          )
        }
      }
      const assertCanCopyTo = async (destinationPath: string): Promise<void> => {
        let destination: FileHandle | undefined
        try {
          assertOpen()
          try {
            destination = await this.fileSystem.open(destinationPath, constants.O_RDONLY)
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
            throw error
          }
          const sourceStats = await leaseHandle.stat()
          const destinationStats = await destination.stat()
          if (
            sourceStats.dev === destinationStats.dev &&
            sourceStats.ino === destinationStats.ino
          ) {
            throw new Error('Cannot copy an immutable version over itself.')
          }
        } catch (error) {
          throw normalizeStorageError(
            error,
            'INTEGRITY_FAILED',
            'Unable to validate immutable version copy destination.'
          )
        } finally {
          await destination?.close().catch(() => undefined)
        }
      }
      const copyTo = async (
        destinationPath: string,
        options?: { exclusive?: boolean }
      ): Promise<void> => {
        try {
          assertOpen()
          const destination = await this.fileSystem.open(
            destinationPath,
            constants.O_CREAT | constants.O_RDWR | (options?.exclusive ? constants.O_EXCL : 0),
            0o666
          )
          let primaryFailure: { error: unknown } | undefined
          try {
            const sourceStats = await leaseHandle.stat()
            const destinationStats = await destination.stat()
            if (
              sourceStats.dev === destinationStats.dev &&
              sourceStats.ino === destinationStats.ino
            ) {
              throw new Error('Cannot copy an immutable version over itself.')
            }
            await destination.truncate(0)
            const hash = createHash('sha256')
            let position = 0
            while (position < expectedIntegrity.sizeBytes) {
              const buffer = Buffer.allocUnsafe(
                Math.min(64 * 1024, expectedIntegrity.sizeBytes - position)
              )
              await readExact(leaseHandle, buffer, position)
              await writeAll(destination, buffer, hash, position)
              position += buffer.byteLength
            }
            await destination.sync()
            if (hash.digest('hex') !== expectedIntegrity.checksum) {
              throw new VersionFileOperatorError(
                'INTEGRITY_FAILED',
                'Immutable version changed during copy.'
              )
            }
            await verifyUnchanged()
          } catch (error) {
            primaryFailure = { error }
          }
          let closeFailure: { error: unknown } | undefined
          try {
            await destination.close()
          } catch (error) {
            closeFailure = { error }
          }
          if (primaryFailure) throw primaryFailure.error
          if (closeFailure) throw closeFailure.error
        } catch (error) {
          throw normalizeStorageError(
            error,
            'INTEGRITY_FAILED',
            'Unable to copy immutable version content.'
          )
        }
      }

      const versionTokenMatch = /^v([a-z0-9]{8})_/u.exec(posix.basename(storageRef))
      const lease: ReadLease = {
        localPath,
        sizeBytes: expectedIntegrity.sizeBytes,
        checksum: expectedIntegrity.checksum,
        ...(versionTokenMatch ? { versionToken: versionTokenMatch[1] } : {}),
        readRange,
        copyTo,
        assertCanCopyTo,
        verifyUnchanged,
        close: async () => {
          if (closed) return
          closed = true
          try {
            await leaseHandle.close()
          } catch (error) {
            throw normalizeStorageError(
              error,
              'STORAGE_UNAVAILABLE',
              'Unable to close immutable version content.'
            )
          }
        }
      }
      handle = undefined
      return lease
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (errorChainHasCode(error, 'ENOENT')) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Recorded immutable version content is missing.',
          undefined,
          { cause: error }
        )
      }
      throw normalizeStorageError(
        error,
        'INTEGRITY_FAILED',
        'Immutable version content is unavailable or corrupt.'
      )
    }
  }

  async removeImmutable(storageRef: string, expectedIntegrity: Integrity): Promise<void> {
    const localPath = this.resolveStorageRef(storageRef)
    await serializeImmutableOperation(localPath, () =>
      this.removeImmutableUnlocked(storageRef, expectedIntegrity, localPath)
    )
  }

  private async removeImmutableUnlocked(
    storageRef: string,
    expectedIntegrity: Integrity,
    localPath: string,
    fixedParentSnapshot?: StorageParentSnapshot
  ): Promise<void> {
    let parentSnapshot: StorageParentSnapshot
    if (fixedParentSnapshot) {
      try {
        await this.verifyStorageParentSnapshot(fixedParentSnapshot)
        parentSnapshot = fixedParentSnapshot
      } catch (error) {
        throw normalizeStorageError(
          error,
          'INTEGRITY_FAILED',
          'Immutable version storage parent changed before removal.'
        )
      }
    } else {
      try {
        await this.verifyStorageRoot()
        await this.verifyStorageParent(storageRef)
        parentSnapshot = await this.snapshotStorageParent(storageRef)
      } catch (error) {
        if (errorChainHasCode(error, 'ENOENT')) {
          try {
            await this.verifyStorageRoot()
            return
          } catch (rootError) {
            throw normalizeStorageError(
              rootError,
              'STORAGE_UNAVAILABLE',
              'Unable to inspect immutable version before removal.'
            )
          }
        }
        throw normalizeStorageError(
          error,
          'STORAGE_UNAVAILABLE',
          'Unable to inspect immutable version before removal.'
        )
      }
    }

    let heldHandle: FileHandle | undefined
    try {
      await this.verifyStorageParentSnapshot(parentSnapshot)
      let heldFile: { handle: FileHandle; identity: Pick<BigIntStats, 'dev' | 'ino'> }
      try {
        heldFile = await this.openHeldImmutable(localPath, expectedIntegrity, true)
      } catch (error) {
        await this.verifyStorageParentSnapshot(parentSnapshot)
        if (errorChainHasCode(error, 'ENOENT')) return
        throw error
      }
      heldHandle = heldFile.handle
      await this.verifyStorageParentSnapshot(parentSnapshot)
      await this.scrubHeldImmutable(heldHandle, heldFile.identity)
      await heldHandle.close()
      heldHandle = undefined
      await this.verifyStorageParentSnapshot(parentSnapshot)
      await this.verifyScrubbedFinalPath(localPath, heldFile.identity)
      await this.verifyStorageParentSnapshot(parentSnapshot)
    } catch (error) {
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Unable to remove immutable version.'
      )
    } finally {
      await heldHandle?.close().catch(() => undefined)
    }
  }

  async inspectRecovery(input: InspectRecoveryInput): Promise<VersionFileRecoveryInspection> {
    this.assertPlannedFile(input)
    const localPath = this.resolveStorageRef(input.plannedFile.storageRef)
    return serializeImmutableOperation(localPath, () => this.inspectRecoveryUnlocked(input))
  }

  private async inspectRecoveryUnlocked(
    input: InspectRecoveryInput
  ): Promise<VersionFileRecoveryInspection> {
    try {
      await this.verifyStorageRoot()
    } catch (error) {
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Unable to inspect immutable version recovery storage.'
      )
    }
    let parentSnapshot: StorageParentSnapshot
    try {
      await this.verifyStorageParent(input.plannedFile.storageRef)
      parentSnapshot = await this.snapshotStorageParent(input.plannedFile.storageRef)
    } catch (error) {
      if (errorChainHasCode(error, 'ENOENT')) return { state: 'missing' }
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Unable to inspect immutable version recovery storage.'
      )
    }
    try {
      const claim = await this.readRecoveryClaim(input, parentSnapshot)
      if (claim?.state === 'deleting') {
        return { state: 'incomplete', actualIntegrity: claim.actualIntegrity }
      }
      let actualIntegrity: Integrity
      try {
        actualIntegrity = await measureImmutablePath(
          this.resolveStorageRef(input.plannedFile.storageRef),
          this.fileSystem.open
        )
      } catch (error) {
        if (!errorChainHasCode(error, 'ENOENT')) throw error
        if (claim) await this.removeRecoveryClaim(input, claim, parentSnapshot)
        return { state: 'missing' }
      }
      if (
        actualIntegrity.sizeBytes === input.expectedIntegrity.sizeBytes &&
        actualIntegrity.checksum === input.expectedIntegrity.checksum
      ) {
        if (claim) await this.removeRecoveryClaim(input, claim, parentSnapshot)
        return { state: 'complete', integrity: actualIntegrity }
      }
      if (claim?.state === 'reserved' || claim?.state === 'publishing') {
        return { state: 'incomplete', actualIntegrity }
      }
      return { state: 'occupied', actualIntegrity }
    } catch (error) {
      if (errorChainHasCode(error, 'ENOENT')) return { state: 'missing' }
      throw normalizeStorageError(
        error,
        'STORAGE_UNAVAILABLE',
        'Unable to inspect immutable version recovery state.'
      )
    }
  }

  async removeIncomplete(input: RemoveIncompleteInput): Promise<void> {
    this.assertPlannedFile(input)
    const localPath = this.resolveStorageRef(input.plannedFile.storageRef)
    await serializeImmutableOperation(localPath, async () => {
      try {
        await this.removeIncompleteUnlocked(input, localPath)
      } catch (error) {
        throw normalizeStorageError(
          error,
          'INTEGRITY_FAILED',
          'Unable to remove incomplete immutable version content.'
        )
      }
    })
  }

  private async removeIncompleteUnlocked(
    input: RemoveIncompleteInput,
    localPath: string
  ): Promise<void> {
    const parentSnapshot = await this.snapshotStorageParent(input.plannedFile.storageRef)
    const claim = await this.readRecoveryClaim(input, parentSnapshot)
    if (!claim) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Incomplete immutable version content is not claimed by this operation.'
      )
    }
    if (claim.state === 'deleting') {
      if (!this.integrityMatches(claim.actualIntegrity, input.actualIntegrity)) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Incomplete immutable version deletion claim has different integrity.'
        )
      }
    } else {
      await this.writeRecoveryClaim(
        input,
        { state: 'deleting', actualIntegrity: input.actualIntegrity },
        parentSnapshot
      )
    }
    await this.removeImmutableUnlocked(
      input.plannedFile.storageRef,
      input.actualIntegrity,
      localPath,
      parentSnapshot
    )
    await this.removeRecoveryClaim(input, undefined, parentSnapshot)
  }

  private assertPlannedFile(input: PlanImmutableInput & { plannedFile: PlannedFile }): void {
    const expectedPlan = this.planImmutable(input)
    if (
      input.plannedFile.storageRef !== expectedPlan.storageRef ||
      input.plannedFile.storedFilename !== expectedPlan.storedFilename ||
      input.plannedFile.versionToken !== expectedPlan.versionToken ||
      input.plannedFile.candidateIndex !== expectedPlan.candidateIndex
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Version file plan does not match its operation.'
      )
    }
  }

  private recoveryClaimStorageRef(
    input: PlanImmutableInput & { plannedFile: PlannedFile }
  ): string {
    return posix.join(
      posix.dirname(input.plannedFile.storageRef),
      `.claim-${this.recoveryClaimDigest(input)}`
    )
  }

  private recoveryClaimDigest(input: PlanImmutableInput & { plannedFile: PlannedFile }): string {
    return createHash('sha256')
      .update('managed-version-recovery-claim\0')
      .update(input.operationId)
      .update('\0')
      .update(input.scope.source)
      .update('\0')
      .update(input.scope.projectId)
      .update('\0')
      .update(input.scope.sessionId)
      .update('\0')
      .update(input.scope.logicalFileId)
      .update('\0')
      .update(input.logicalFilename)
      .update('\0')
      .update(String(input.candidateIndex))
      .update('\0')
      .update(input.plannedFile.storageRef)
      .digest('hex')
  }

  private recoveryClaimStateName(
    claim: Exclude<VersionFileRecoveryClaim, { state: 'reserved' }>
  ): string {
    if (claim.state === 'publishing') return 'publishing'
    return `deleting-${claim.actualIntegrity.sizeBytes}-${claim.actualIntegrity.checksum}`
  }

  private recoveryClaimsMatch(
    left: VersionFileRecoveryClaim,
    right: VersionFileRecoveryClaim
  ): boolean {
    if (left.state !== right.state) return false
    return (
      left.state !== 'deleting' ||
      (right.state === 'deleting' &&
        this.integrityMatches(left.actualIntegrity, right.actualIntegrity))
    )
  }

  private async readRecoveryClaim(
    input: PlanImmutableInput & { plannedFile: PlannedFile },
    parentSnapshot?: StorageParentSnapshot
  ): Promise<VersionFileRecoveryClaim | undefined> {
    const claimPath = this.resolveStorageRef(this.recoveryClaimStorageRef(input))
    try {
      if (parentSnapshot) await this.verifyStorageParentSnapshot(parentSnapshot)
      const claimStats = await this.fileSystem.lstat(claimPath)
      if (claimStats.isSymbolicLink() || !claimStats.isDirectory()) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Immutable version recovery claim is not a trusted directory.'
        )
      }
      const entries = await this.fileSystem.readdir(claimPath, { withFileTypes: true })
      let publishing = false
      let deleting: Integrity | undefined
      for (const entry of entries) {
        const statePath = join(claimPath, entry.name)
        const stateStats = await this.fileSystem.lstat(statePath)
        if (
          entry.isSymbolicLink() ||
          !entry.isDirectory() ||
          stateStats.isSymbolicLink() ||
          !stateStats.isDirectory()
        ) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version recovery claim contains an invalid state marker.'
          )
        }
        if (entry.name === 'publishing') {
          publishing = true
          continue
        }
        const deletionMatch = /^deleting-([0-9]+)-([a-f0-9]{64})$/u.exec(entry.name)
        const sizeBytes = deletionMatch ? Number(deletionMatch[1]) : Number.NaN
        const integrity = { sizeBytes, checksum: deletionMatch?.[2] ?? '' }
        if (
          !deletionMatch ||
          String(sizeBytes) !== deletionMatch[1] ||
          !this.isValidIntegrity(integrity) ||
          deleting
        ) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version recovery claim contains an invalid state marker.'
          )
        }
        deleting = integrity
      }
      if (parentSnapshot) await this.verifyStorageParentSnapshot(parentSnapshot)
      if (deleting) return { state: 'deleting', actualIntegrity: deleting }
      if (publishing) return { state: 'publishing' }
      return { state: 'reserved' }
    } catch (error) {
      if (errorChainHasCode(error, 'ENOENT')) {
        if (parentSnapshot) await this.verifyStorageParentSnapshot(parentSnapshot)
        return undefined
      }
      throw error
    }
  }

  private async ensureRecoveryReservation(
    input: PlanImmutableInput & { plannedFile: PlannedFile },
    parentSnapshot: StorageParentSnapshot
  ): Promise<VersionFileRecoveryClaim> {
    const claimPath = this.resolveStorageRef(this.recoveryClaimStorageRef(input))
    const created = await this.createRecoveryDirectory(
      claimPath,
      parentSnapshot,
      'Immutable version recovery reservation was not created safely.'
    )
    if (created) return { state: 'reserved' }
    const existing = await this.readRecoveryClaim(input, parentSnapshot)
    if (existing) return existing
    throw new VersionFileOperatorError(
      'STORAGE_UNAVAILABLE',
      'Immutable version recovery reservation disappeared during publication.'
    )
  }

  private async writeRecoveryClaim(
    input: PlanImmutableInput & { plannedFile: PlannedFile },
    claim: Exclude<VersionFileRecoveryClaim, { state: 'reserved' }>,
    parentSnapshot: StorageParentSnapshot
  ): Promise<void> {
    const existing = await this.readRecoveryClaim(input, parentSnapshot)
    if (!existing) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version recovery claim disappeared before publication completed.'
      )
    }
    if (this.recoveryClaimsMatch(existing, claim)) return
    if (!(
      (existing.state === 'reserved' && claim.state === 'publishing') ||
      ((existing.state === 'reserved' || existing.state === 'publishing') &&
        claim.state === 'deleting')
    )) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version recovery claim transition is invalid.'
      )
    }
    const claimPath = this.resolveStorageRef(this.recoveryClaimStorageRef(input))
    const markerPath = join(claimPath, this.recoveryClaimStateName(claim))
    const created = await this.createRecoveryDirectory(
      markerPath,
      parentSnapshot,
      'Immutable version recovery claim transition was not created safely.'
    )
    if (!created) {
      const current = await this.readRecoveryClaim(input, parentSnapshot)
      if (current && this.recoveryClaimsMatch(current, claim)) return
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version recovery claim transition is occupied by different state.'
      )
    }
  }

  private async removeRecoveryClaim(
    input: PlanImmutableInput & { plannedFile: PlannedFile },
    expected?: VersionFileRecoveryClaim,
    parentSnapshot?: StorageParentSnapshot
  ): Promise<void> {
    const snapshot =
      parentSnapshot ?? (await this.snapshotStorageParent(input.plannedFile.storageRef))
    const existing = await this.readRecoveryClaim(input, snapshot)
    if (!existing) return
    if (expected && !this.recoveryClaimsMatch(existing, expected)) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version recovery claim changed during cleanup.'
      )
    }
    const claimPath = this.resolveStorageRef(this.recoveryClaimStorageRef(input))
    if (existing.state === 'deleting') {
      await this.removeRecoveryDirectory(
        join(claimPath, this.recoveryClaimStateName(existing)),
        snapshot
      )
    }
    if (existing.state !== 'reserved') {
      await this.removeRecoveryDirectory(join(claimPath, 'publishing'), snapshot)
    }
    await this.removeRecoveryDirectory(claimPath, snapshot)
  }

  private async createRecoveryDirectory(
    path: string,
    parentSnapshot: StorageParentSnapshot,
    failureMessage: string
  ): Promise<boolean> {
    await this.verifyStorageParentSnapshot(parentSnapshot)
    let createdSnapshot: Pick<BigIntStats, 'dev' | 'ino'> | undefined
    try {
      try {
        await this.fileSystem.mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (!isExistsError(error)) {
          await this.verifyStorageParentSnapshot(parentSnapshot)
          throw error
        }
        await this.verifyStorageParentSnapshot(parentSnapshot)
        return false
      }
      const stats = await this.fileSystem.lstat(path, { bigint: true })
      createdSnapshot = { dev: stats.dev, ino: stats.ino }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new VersionFileOperatorError('INTEGRITY_FAILED', failureMessage)
      }
      await this.verifyStorageParentSnapshot(parentSnapshot)
      return true
    } catch (error) {
      if (createdSnapshot) {
        try {
          await this.removeRecoveryDirectoryByIdentity(path, createdSnapshot)
        } catch (cleanupError) {
          throw new VersionFileOperatorError('INTEGRITY_FAILED', failureMessage, undefined, {
            cause: new AggregateError([error, cleanupError])
          })
        }
      }
      throw error
    }
  }

  private async removeRecoveryDirectory(
    path: string,
    parentSnapshot: StorageParentSnapshot
  ): Promise<void> {
    await this.verifyStorageParentSnapshot(parentSnapshot)
    let stats: BigIntStats
    try {
      stats = await this.fileSystem.lstat(path, { bigint: true })
    } catch (error) {
      if (errorChainHasCode(error, 'ENOENT')) return
      throw error
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version recovery claim changed during cleanup.'
      )
    }
    await this.removeRecoveryDirectoryByIdentity(path, stats)
    await this.verifyStorageParentSnapshot(parentSnapshot)
  }

  private async removeRecoveryDirectoryByIdentity(
    path: string,
    expected: Pick<BigIntStats, 'dev' | 'ino'>
  ): Promise<void> {
    let actual: BigIntStats
    try {
      actual = await this.fileSystem.lstat(path, { bigint: true })
    } catch (error) {
      if (errorChainHasCode(error, 'ENOENT')) return
      throw error
    }
    if (
      actual.isSymbolicLink() ||
      !actual.isDirectory() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version recovery claim changed during cleanup.'
      )
    }
    try {
      await this.fileSystem.removeDirectory(path)
    } catch (error) {
      if (!errorChainHasCode(error, 'ENOENT')) throw error
    }
  }

  private isValidIntegrity(value: { sizeBytes: unknown; checksum: unknown }): value is Integrity {
    return (
      Number.isSafeInteger(value.sizeBytes) &&
      Number(value.sizeBytes) >= 0 &&
      typeof value.checksum === 'string' &&
      /^[a-f0-9]{64}$/u.test(value.checksum)
    )
  }

  private integrityMatches(left: Integrity, right: Integrity): boolean {
    return left.sizeBytes === right.sizeBytes && left.checksum === right.checksum
  }

  private resolveStorageRef(storageRef: string): string {
    if (
      !storageRef ||
      storageRef.includes('\\') ||
      posix.isAbsolute(storageRef) ||
      posix.normalize(storageRef) !== storageRef
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage reference is invalid.'
      )
    }
    const localPath = resolve(this.options.storageRoot, ...storageRef.split('/'))
    const relativePath = relative(resolve(this.options.storageRoot), localPath)
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage reference escapes its root.'
      )
    }
    return localPath
  }

  private async prepareStorageParent(storageRef: string): Promise<StorageParentSnapshot> {
    await this.fileSystem.mkdir(this.options.storageRoot, { recursive: true })
    await this.verifyStorageRoot()
    const parentSegments = storageRef.split('/').slice(0, -1)
    let currentPath = resolve(this.options.storageRoot)
    for (const segment of parentSegments) {
      currentPath = join(currentPath, segment)
      try {
        const stats = await this.fileSystem.lstat(currentPath)
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version storage parent is not a trusted directory.'
          )
        }
      } catch (error) {
        if (!errorChainHasCode(error, 'ENOENT')) throw error
        try {
          await this.fileSystem.mkdir(currentPath)
        } catch (mkdirError) {
          if (!errorChainHasCode(mkdirError, 'EEXIST')) throw mkdirError
        }
        const stats = await this.fileSystem.lstat(currentPath)
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version storage parent is not a trusted directory.'
          )
        }
      }
    }
    return this.snapshotStorageParent(storageRef)
  }

  private async snapshotStorageParent(storageRef: string): Promise<StorageParentSnapshot> {
    const parentPath = dirname(this.resolveStorageRef(storageRef))
    const before = await this.fileSystem.lstat(parentPath, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage parent is not a trusted directory.'
      )
    }
    const realPath = await this.assertRealParentInsideStorageRoot(parentPath)
    const after = await this.fileSystem.lstat(parentPath, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage parent changed while it was prepared.'
      )
    }
    return { path: parentPath, realPath, dev: after.dev, ino: after.ino }
  }

  private async verifyStorageParentSnapshot(snapshot: StorageParentSnapshot): Promise<void> {
    await this.verifyStorageRoot()
    const before = await this.fileSystem.lstat(snapshot.path, { bigint: true })
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      before.dev !== snapshot.dev ||
      before.ino !== snapshot.ino
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage parent changed during publication.'
      )
    }
    const realPath = await this.assertRealParentInsideStorageRoot(snapshot.path)
    const after = await this.fileSystem.lstat(snapshot.path, { bigint: true })
    if (
      realPath !== snapshot.realPath ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== snapshot.dev ||
      after.ino !== snapshot.ino
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage parent changed during publication.'
      )
    }
  }

  private async verifyStorageParent(storageRef: string): Promise<void> {
    await this.verifyStorageRoot()
    const parentSegments = storageRef.split('/').slice(0, -1)
    let currentPath = resolve(this.options.storageRoot)
    for (const segment of parentSegments) {
      currentPath = join(currentPath, segment)
      const stats = await this.fileSystem.lstat(currentPath)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Immutable version storage parent is not a trusted directory.'
        )
      }
    }
    await this.assertRealParentInsideStorageRoot(dirname(this.resolveStorageRef(storageRef)))
  }

  private async verifyStorageRoot(): Promise<void> {
    const rootStats = await this.fileSystem.lstat(this.options.storageRoot)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage root is not a trusted directory.'
      )
    }
    await this.fileSystem.realpath(this.options.storageRoot)
  }

  private async assertRealParentInsideStorageRoot(parentPath: string): Promise<string> {
    const [rootPath, realParentPath] = await Promise.all([
      this.fileSystem.realpath(this.options.storageRoot),
      this.fileSystem.realpath(parentPath)
    ])
    const relativePath = relative(rootPath, realParentPath)
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version storage parent escapes its configured root.'
      )
    }
    return realParentPath
  }

  private async assertNotSymbolicLink(path: string): Promise<void> {
    try {
      if ((await this.fileSystem.lstat(path)).isSymbolicLink()) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Immutable version storage reference is a symbolic link.'
        )
      }
    } catch (error) {
      if (!errorChainHasCode(error, 'ENOENT')) throw error
    }
  }

  private async openHeldImmutable(
    path: string,
    expectedIntegrity: Integrity,
    allowEmptyTombstone = false
  ): Promise<{
    handle: FileHandle
    identity: Pick<BigIntStats, 'dev' | 'ino'>
    sizeBytes: number
  }> {
    const pathStats = await this.fileSystem.lstat(path, { bigint: true })
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version deletion source is not a trusted file.'
      )
    }
    let handle: FileHandle | undefined
    try {
      handle = await this.fileSystem.open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      const handleStats = await handle.stat({ bigint: true })
      if (
        !handleStats.isFile() ||
        handleStats.dev !== pathStats.dev ||
        handleStats.ino !== pathStats.ino ||
        handleStats.size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new VersionFileOperatorError(
          'INTEGRITY_FAILED',
          'Immutable version deletion source changed while it was opened.'
        )
      }
      const sizeBytes = Number(handleStats.size)
      if (!(allowEmptyTombstone && sizeBytes === 0)) {
        if (sizeBytes !== expectedIntegrity.sizeBytes) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version deletion source has different bytes.'
          )
        }
        const checksum = await checksumHandle(handle, sizeBytes)
        if (checksum !== expectedIntegrity.checksum) {
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'Immutable version deletion source has different bytes.'
          )
        }
      }
      const held = {
        handle,
        identity: { dev: handleStats.dev, ino: handleStats.ino },
        sizeBytes
      }
      handle = undefined
      return held
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async scrubHeldImmutable(
    handle: FileHandle,
    expected: Pick<BigIntStats, 'dev' | 'ino'>
  ): Promise<void> {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version deletion handle changed before scrub.'
      )
    }
    await handle.truncate(0)
    await handle.sync()
    const after = await handle.stat({ bigint: true })
    if (
      !after.isFile() ||
      after.dev !== expected.dev ||
      after.ino !== expected.ino ||
      after.size !== 0n
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version deletion scrub did not produce a durable tombstone.'
      )
    }
  }

  private async verifyScrubbedFinalPath(
    path: string,
    expected: Pick<BigIntStats, 'dev' | 'ino'>
  ): Promise<void> {
    let actual: BigIntStats
    try {
      actual = await this.fileSystem.lstat(path, { bigint: true })
    } catch (error) {
      if (!errorChainHasCode(error, 'ENOENT')) throw error
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version final path changed after deletion scrub.',
        undefined,
        { cause: error }
      )
    }
    if (
      actual.isSymbolicLink() ||
      !actual.isFile() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size !== 0n
    ) {
      throw new VersionFileOperatorError(
        'INTEGRITY_FAILED',
        'Immutable version final path changed after deletion scrub.'
      )
    }
  }
}

export {
  NodeVersionFileOperator,
  VersionFileOperatorError,
  type NodeVersionFileOperatorOptions,
  type Integrity,
  type InspectRecoveryInput,
  type OpenImmutableOptions,
  type PlanImmutableInput,
  type PlannedFile,
  type PublishImmutableInput,
  type ReadLease,
  type RemoveIncompleteInput,
  type StoredFile,
  type VersionFileSystem,
  VERSION_FILE_CANDIDATE_LIMIT,
  type VersionFileOperator,
  type VersionFileOperatorErrorCode,
  type VersionFileRecovery,
  type VersionFileRecoveryInspection,
  type VersionFileScope
}
