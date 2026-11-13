import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { defaultFileDurability, type FileDurability } from '@aipoch/durable-files'
import { retryFileReplacement } from '@aipoch/durable-files'
import { publishNoReplace as publishAnchoredNoReplace } from './uploads/atomic-no-replace-publisher'
import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import {
  assertFileTarget,
  destinationChanged,
  fileFingerprint,
  matchesCapturedTarget,
  type FileSaveTarget
} from './file-save-target'

type PublishUserFileOptions = {
  target?: FileSaveTarget
  exclusive?: boolean
  userSelectedDestination?: boolean
  signal?: AbortSignal
  validateDestination?: () => Promise<void>
  durability?: FileDurability
  copyFileExclusive?: (sourcePath: string, destinationPath: string) => Promise<void>
  linkFile?: (sourcePath: string, destinationPath: string) => Promise<void>
  publishNoReplace?: (sourcePath: string, destinationPath: string) => Promise<void>
  replace?: (sourcePath: string, destinationPath: string) => Promise<void>
  wait?: (delayMs: number) => Promise<void>
}

type LinkFile = NonNullable<PublishUserFileOptions['linkFile']>
type CopyFileExclusive = NonNullable<PublishUserFileOptions['copyFileExclusive']>
type PublishNoReplace = NonNullable<PublishUserFileOptions['publishNoReplace']>

type RecoveryReceipt = {
  destinationPath: string
  previous: 'previous'
  temporaryDirectory: string
}

const RECOVERY_ROOT_ENV = 'OPEN_SCIENCE_FILE_RECOVERY_ROOT'
const RECOVERY_DIRECTORY_PREFIX = '.open-science-file-recovery-'
const RECOVERY_RECEIPT_NAME = 'recovery.json'
const RECOVERY_PREVIOUS_NAME = 'previous'
const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
let configuredRecoveryRoot: string | undefined

const hardLinkUnsupportedCodes = new Set([
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM'
])

const isHardLinkUnsupported = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  typeof error.code === 'string' &&
  hardLinkUnsupportedCodes.has(error.code)

// Writers can throw arbitrary errors. Only native filesystem codes belong in publication logs.
const publicationErrorCode = (error: unknown): string | undefined => {
  try {
    if (error instanceof Error && 'code' in error) {
      const code = error.code
      if (typeof code === 'string' && Object.hasOwn(osConstants.errno, code)) return code
    }
  } catch {
    // Diagnostic inspection must not replace the original error with a throwing property getter.
  }
  return undefined
}

const validRecoveryPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 32_768 &&
  !value.includes('\0') &&
  isAbsolute(value)

const parseRecoveryReceipt = (value: unknown): RecoveryReceipt | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const receipt = value as Record<string, unknown>
  return receipt.previous === RECOVERY_PREVIOUS_NAME &&
    validRecoveryPath(receipt.destinationPath) &&
    validRecoveryPath(receipt.temporaryDirectory)
    ? {
        destinationPath: receipt.destinationPath,
        previous: RECOVERY_PREVIOUS_NAME,
        temporaryDirectory: receipt.temporaryDirectory
      }
    : undefined
}

const recoveryRootFromEnvironment = (): string | undefined => {
  const root = configuredRecoveryRoot ?? process.env[RECOVERY_ROOT_ENV]
  return validRecoveryPath(root) ? root : undefined
}

export const configureUserFileRecoveryRoot = (root: string | undefined): void => {
  if (root !== undefined && !validRecoveryPath(root))
    throw new Error('File recovery root must be an absolute path.')
  configuredRecoveryRoot = root
  if (root === undefined) delete process.env[RECOVERY_ROOT_ENV]
  else process.env[RECOVERY_ROOT_ENV] = root
}

export async function recoverUserFilePublications(root: string): Promise<{
  restored: number
  retained: number
  removed: number
}> {
  if (!validRecoveryPath(root)) throw new Error('File recovery root must be an absolute path.')
  const log = createLogger('file-publisher')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (publicationErrorCode(error) === 'ENOENT') return { restored: 0, retained: 0, removed: 0 }
    throw error
  }
  let restored = 0
  let retained = 0
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RECOVERY_DIRECTORY_PREFIX)) continue
    const recoveryDirectory = join(root, entry.name)
    let receipt: RecoveryReceipt | undefined
    try {
      receipt = parseRecoveryReceipt(
        JSON.parse(await readFile(join(recoveryDirectory, RECOVERY_RECEIPT_NAME), 'utf8'))
      )
    } catch (error) {
      log.warn('save recovery receipt unreadable', {
        recoveryDirectory: entry.name,
        errorCode: publicationErrorCode(error)
      })
      continue
    }
    if (!receipt) {
      log.warn('save recovery receipt invalid', { recoveryDirectory: entry.name })
      continue
    }
    const previous = join(recoveryDirectory, receipt.previous)
    const previousExists = await stat(previous).then(
      () => true,
      () => false
    )
    if (!previousExists) {
      await rm(receipt.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
      await rm(recoveryDirectory, { recursive: true, force: true })
      removed += 1
      continue
    }
    const destinationExists = await stat(receipt.destinationPath).then(
      () => true,
      () => false
    )
    if (destinationExists) {
      const age = Date.now() - (await stat(recoveryDirectory)).mtimeMs
      if (age > RECOVERY_RETENTION_MS) {
        await rm(recoveryDirectory, { recursive: true, force: true })
        removed += 1
      } else {
        await rm(receipt.temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined
        )
        retained += 1
      }
      continue
    }
    try {
      await copyFile(previous, receipt.destinationPath, constants.COPYFILE_EXCL)
      await rm(receipt.temporaryDirectory, { recursive: true, force: true })
      await rm(recoveryDirectory, { recursive: true, force: true })
      restored += 1
    } catch (error) {
      retained += 1
      log.warn('save recovery restore deferred', {
        recoveryDirectory: entry.name,
        errorCode: publicationErrorCode(error)
      })
    }
  }
  return { restored, retained, removed }
}

const defaultCopyFileExclusive: CopyFileExclusive = (sourcePath, destinationPath) =>
  copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)

const defaultPublishNoReplace: PublishNoReplace = async (sourcePath, destinationPath) => {
  const directory = dirname(destinationPath)
  publishAnchoredNoReplace(directory, directory, basename(sourcePath), basename(destinationPath))
}

const publishExclusive = async (
  sourcePath: string,
  destinationPath: string,
  linkFile: LinkFile,
  copyFileExclusive: CopyFileExclusive,
  durability: FileDurability,
  publishNoReplace: PublishNoReplace,
  signal?: AbortSignal,
  validate?: () => Promise<void>
): Promise<void> => {
  try {
    await validate?.()
    signal?.throwIfAborted()
    await linkFile(sourcePath, destinationPath)
    return
  } catch (error) {
    if (!isHardLinkUnsupported(error)) throw error
  }

  // Some user-selected volumes (notably FAT/exFAT) cannot create hard links. Keep the fallback
  // copy under a private random name, flush it, then atomically rename it without replacement.
  const stagingPath = join(dirname(destinationPath), `.open-science-publish-${randomUUID()}`)
  try {
    signal?.throwIfAborted()
    await copyFileExclusive(sourcePath, stagingPath)
    signal?.throwIfAborted()
    await durability.syncFile(stagingPath)
    await validate?.()
    signal?.throwIfAborted()
    await publishNoReplace(stagingPath, destinationPath)
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined)
  }
}

// Keeps incomplete bytes private and only changes the user-selected path after the writer and file
// durability barrier succeed. The private child directory also prevents a temp-path symlink race.
const publishUserFile = async (
  destinationPath: string,
  write: (temporaryPath: string) => Promise<unknown>,
  options: PublishUserFileOptions = {}
): Promise<void> => {
  const log = createLogger('file-publisher')
  const operationId = randomUUID()
  const operation = startDiagnosticOperation(log, {
    operation: 'user-file-publication',
    operationId,
    fields: { targetConfirmed: Boolean(options.target), exclusive: Boolean(options.exclusive) }
  })
  let temporaryDirectory: string | undefined
  let recoveryDirectory: string | undefined
  let externalRecovery = false
  let preserveRecovery = false
  let recoveryReason: 'captured-file-changed' | 'restore-failed' | undefined
  let recoveryErrorCode: string | undefined

  try {
    operation.phase('prepare')
    const directory = dirname(destinationPath)
    temporaryDirectory = await mkdtemp(join(directory, '.open-science-save-'))
    const temporaryPath = join(temporaryDirectory, basename(destinationPath))
    const durability = options.durability ?? defaultFileDurability
    const userSelectedDestination = options.userSelectedDestination ?? Boolean(options.target)
    const validate = async (): Promise<void> => {
      await options.validateDestination?.()
      options.signal?.throwIfAborted()
    }
    const publishNoReplace = async (source: string, destination: string): Promise<void> =>
      publishExclusive(
        source,
        destination,
        options.linkFile ?? link,
        options.copyFileExclusive ?? defaultCopyFileExclusive,
        durability,
        options.publishNoReplace ?? defaultPublishNoReplace,
        options.signal,
        validate
      )

    await validate()
    if (options.target) await assertFileTarget(destinationPath, options.target)
    operation.phase('write-file')
    await write(temporaryPath)
    await durability.syncFile(temporaryPath)
    if (!options.exclusive) {
      try {
        await chmod(temporaryPath, (await stat(destinationPath)).mode & 0o7777)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await validate()
    operation.phase('publish-file')
    if (options.target?.fingerprint && !options.exclusive) {
      const target = options.target
      const recoveryRoot = recoveryRootFromEnvironment()
      if (recoveryRoot) {
        await mkdir(recoveryRoot, { recursive: true })
        recoveryDirectory = await mkdtemp(join(recoveryRoot, RECOVERY_DIRECTORY_PREFIX))
        externalRecovery = true
      } else recoveryDirectory = await mkdtemp(join(temporaryDirectory, '.recovery-'))
      const recoveryDirectoryPath = recoveryDirectory
      if (!recoveryDirectoryPath) throw new Error('File recovery directory was not created.')
      const previous = join(recoveryDirectoryPath, RECOVERY_PREVIOUS_NAME)
      // There is no portable compare-and-swap rename. Capture and verify the actual displaced
      // file, then publish exclusively so a concurrent creator is never overwritten. A receipt
      // survives process termination; failed restoration must never delete the captured bytes.
      const receipt = join(recoveryDirectoryPath, RECOVERY_RECEIPT_NAME)
      await writeFile(
        receipt,
        JSON.stringify({
          destinationPath,
          target,
          previous: RECOVERY_PREVIOUS_NAME,
          temporaryDirectory
        }),
        { flag: 'wx', mode: 0o600 }
      )
      await durability.syncFile(receipt)
      await durability.syncDirectory(recoveryDirectoryPath)
      await durability.syncDirectory(temporaryDirectory)
      let captured = false
      try {
        await retryFileReplacement(async () => {
          await validate()
          await assertFileTarget(destinationPath, target)
          options.signal?.throwIfAborted()
          await rename(destinationPath, previous)
          captured = true
        }, options.wait)
        if (!matchesCapturedTarget(await fileFingerprint(previous), target))
          throw destinationChanged()
        await durability.syncDirectory(directory, {
          allowPermissionDenied: userSelectedDestination
        })
        await durability.syncDirectory(recoveryDirectoryPath)
        await retryFileReplacement(async () => {
          await validate()
          if (!matchesCapturedTarget(await fileFingerprint(previous), target))
            throw destinationChanged()
          options.signal?.throwIfAborted()
          await publishNoReplace(temporaryPath, destinationPath)
        }, options.wait)
        await durability.syncDirectory(directory, {
          allowPermissionDenied: userSelectedDestination
        })
        // An external writer may still hold the old inode open. Preserve any observed late change.
        preserveRecovery = !matchesCapturedTarget(await fileFingerprint(previous), target)
        if (preserveRecovery) recoveryReason = 'captured-file-changed'
      } catch (error) {
        if (captured) {
          operation.phase('restore-file')
          try {
            // Recovery intentionally ignores cancellation and never replaces a new public target.
            await publishExclusive(
              previous,
              destinationPath,
              link,
              defaultCopyFileExclusive,
              durability,
              defaultPublishNoReplace
            )
            await durability.syncDirectory(directory, {
              allowPermissionDenied: userSelectedDestination
            })
            operation.phase('original-restored')
          } catch (recoveryError) {
            preserveRecovery = true
            recoveryReason = 'restore-failed'
            recoveryErrorCode = publicationErrorCode(recoveryError)
          }
        }
        throw error
      }
    } else if (options.target || options.exclusive) {
      if (options.target) await assertFileTarget(destinationPath, options.target)
      await publishExclusive(
        temporaryPath,
        destinationPath,
        options.linkFile ?? link,
        options.copyFileExclusive ?? defaultCopyFileExclusive,
        durability,
        options.publishNoReplace ?? defaultPublishNoReplace,
        options.signal,
        validate
      )
    } else {
      await retryFileReplacement(async () => {
        await validate()
        return (options.replace ?? rename)(temporaryPath, destinationPath)
      }, options.wait)
    }
    await durability.syncDirectory(directory, {
      allowPermissionDenied: userSelectedDestination
    })
    operation.complete({ recoveryRetained: preserveRecovery })
  } catch (error) {
    const errorCode = publicationErrorCode(error)
    const fields = { errorCode, recoveryRetained: preserveRecovery }
    if (options.signal?.aborted) operation.cancel({ ...fields, reason: 'caller-cancelled' })
    else
      operation.fail(error, {
        ...fields,
        reason:
          errorCode === 'ESTALE' || errorCode === 'EEXIST'
            ? 'destination-changed'
            : 'publication-failed'
      })
    throw error
  } finally {
    if (preserveRecovery && temporaryDirectory) {
      if (externalRecovery) await rm(temporaryDirectory, { recursive: true, force: true })
      log.warn('save recovery retained', {
        operation: 'user-file-publication',
        operationId,
        recoveryDirectory: basename(recoveryDirectory ?? temporaryDirectory),
        reason: recoveryReason,
        errorCode: recoveryErrorCode
      })
    } else {
      if (temporaryDirectory)
        await rm(temporaryDirectory, { recursive: true, force: true }).catch((error) =>
          log.warn('save cleanup deferred', { operationId, errorCode: publicationErrorCode(error) })
        )
      if (externalRecovery && recoveryDirectory)
        await rm(recoveryDirectory, { recursive: true, force: true }).catch((error) =>
          log.warn('save recovery cleanup deferred', {
            operationId,
            errorCode: publicationErrorCode(error)
          })
        )
    }
  }
}

export { publishUserFile }
export type { PublishUserFileOptions }
