import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultFileDurability } from '../storage/file-durability'

export type ManagedDirectoryIdentity = {
  nonce: string
  device: number
  inode: number
}

const markerName = '.open-science-environment-owner'
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

/** Call only after the intended exact path and nonce have been durably recorded. */
export const createManagedEnvironmentDirectory = async (
  path: string,
  nonce: string
): Promise<ManagedDirectoryIdentity> => {
  if ((await realpath(dirname(path))) !== dirname(path)) {
    throw new Error('Managed environment parent must be canonical.')
  }
  await mkdir(path, { mode: 0o700 })
  const marker = await open(
    join(path, markerName),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await marker.writeFile(nonce, 'utf8')
    await marker.sync()
  } finally {
    await marker.close()
  }
  await defaultFileDurability.syncDirectory(path)
  await defaultFileDurability.syncDirectory(dirname(path))
  const stat = await lstat(path)
  return { nonce, device: stat.dev, inode: stat.ino }
}

/** No marker-only adoption: an interrupted identity write is retained for diagnosis. */
export const verifyManagedEnvironmentDirectory = async (
  path: string,
  identity: ManagedDirectoryIdentity
): Promise<boolean> => {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
    (await realpath(path)) !== path
  ) {
    throw new Error('Managed environment directory ownership changed; preserving it.')
  }
  const marker = await open(join(path, markerName), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await marker.stat()
    if (!metadata.isFile() || metadata.size > 128 || metadata.nlink !== 1) {
      throw new Error('Managed environment ownership marker is invalid.')
    }
    if ((await marker.readFile('utf8')) !== identity.nonce) {
      throw new Error('Managed environment ownership marker does not match.')
    }
  } finally {
    await marker.close()
  }
  return true
}

/** The caller must first obtain stopped-process proof from the existing execution owner. */
export const removeManagedEnvironmentDirectory = async (
  path: string,
  identity?: ManagedDirectoryIdentity
): Promise<void> => {
  if (!identity) {
    try {
      await lstat(path)
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    throw new Error('Managed environment directory has no confirmed ownership; preserving it.')
  }
  if (!(await verifyManagedEnvironmentDirectory(path, identity))) return
  // rm does not follow child symlinks. The private parent and stopped execution fence prevent a
  // workload from replacing this directory during removal.
  await rm(path, { recursive: true, force: false })
  await defaultFileDurability.syncDirectory(dirname(path))
}
