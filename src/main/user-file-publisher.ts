import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, link, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { defaultFileDurability, type FileDurability } from './storage/file-durability'
import { retryFileReplacement } from './storage/file-replacement'
import { publishNoReplace as publishAnchoredNoReplace } from './uploads/atomic-no-replace-publisher'

type PublishUserFileOptions = {
  exclusive?: boolean
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
  publishNoReplace: PublishNoReplace
): Promise<void> => {
  try {
    await linkFile(sourcePath, destinationPath)
    return
  } catch (error) {
    if (!isHardLinkUnsupported(error)) throw error
  }

  // Some user-selected volumes (notably FAT/exFAT) cannot create hard links. Keep the fallback
  // copy under a private random name, flush it, then atomically rename it without replacement.
  const stagingPath = join(dirname(destinationPath), `.open-science-publish-${randomUUID()}`)
  try {
    await copyFileExclusive(sourcePath, stagingPath)
    await durability.syncFile(stagingPath)
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
  const directory = dirname(destinationPath)
  const temporaryDirectory = await mkdtemp(join(directory, '.open-science-save-'))
  const temporaryPath = join(temporaryDirectory, basename(destinationPath))
  const durability = options.durability ?? defaultFileDurability

  try {
    await write(temporaryPath)
    await durability.syncFile(temporaryPath)
    if (!options.exclusive) {
      try {
        await chmod(temporaryPath, (await stat(destinationPath)).mode & 0o7777)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await options.validateDestination?.()
    if (options.exclusive) {
      await publishExclusive(
        temporaryPath,
        destinationPath,
        options.linkFile ?? link,
        options.copyFileExclusive ?? defaultCopyFileExclusive,
        durability,
        options.publishNoReplace ?? defaultPublishNoReplace
      )
    } else {
      await retryFileReplacement(
        () => (options.replace ?? rename)(temporaryPath, destinationPath),
        options.wait
      )
    }
    await durability.syncDirectory(directory)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { publishUserFile }
export type { PublishUserFileOptions }
