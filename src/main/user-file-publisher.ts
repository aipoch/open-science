import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, link, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
      const recoveryDirectory = await mkdtemp(join(temporaryDirectory, '.recovery-'))
      const previous = join(recoveryDirectory, 'previous')
      // There is no portable compare-and-swap rename. Capture and verify the actual displaced
      // file, then publish exclusively so a concurrent creator is never overwritten. A receipt
      // survives process termination; failed restoration must never delete the captured bytes.
      const receipt = join(recoveryDirectory, 'recovery.json')
      await writeFile(receipt, JSON.stringify({ destinationPath, target, previous: 'previous' }), {
        flag: 'wx',
        mode: 0o600
      })
      await durability.syncFile(receipt)
      await durability.syncDirectory(recoveryDirectory)
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
        await durability.syncDirectory(recoveryDirectory)
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
      log.warn('save recovery retained', {
        operation: 'user-file-publication',
        operationId,
        recoveryDirectory: basename(temporaryDirectory),
        reason: recoveryReason,
        errorCode: recoveryErrorCode
      })
    } else if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true }).catch((error) =>
        log.warn('save cleanup deferred', { operationId, errorCode: publicationErrorCode(error) })
      )
  }
}

export { publishUserFile }
export type { PublishUserFileOptions }
