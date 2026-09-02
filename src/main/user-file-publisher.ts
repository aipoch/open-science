import { chmod, link, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { defaultFileDurability, type FileDurability } from './storage/file-durability'
import { retryFileReplacement } from './storage/file-replacement'

type PublishUserFileOptions = {
  exclusive?: boolean
  validateDestination?: () => Promise<void>
  durability?: FileDurability
  replace?: (sourcePath: string, destinationPath: string) => Promise<void>
  wait?: (delayMs: number) => Promise<void>
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
    if (!options.exclusive) {
      try {
        await chmod(temporaryPath, (await stat(destinationPath)).mode & 0o7777)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await durability.syncFile(temporaryPath)
    await options.validateDestination?.()
    if (options.exclusive) await link(temporaryPath, destinationPath)
    else {
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
