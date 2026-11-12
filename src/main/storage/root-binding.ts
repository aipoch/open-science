import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

type DirectoryIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
type CreateDirectory = (path: string) => Promise<unknown>

export type StorageRootBinding = Readonly<{
  path: string
  verify(): Promise<void>
  prepare(createDirectory: CreateDirectory): Promise<void>
}>

export class StorageRootChangedError extends Error {
  constructor() {
    super('Storage root alias changed after initialization.')
    this.name = 'StorageRootChangedError'
  }
}

const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code

const unavailableBinding = (path: string, error: unknown): StorageRootBinding => {
  const reject = async (): Promise<void> => {
    throw error
  }
  return { path, verify: reject, prepare: reject }
}

// Resolve every existing path component, while retaining the caller's logical path for verification.
// Missing suffixes may be created beneath the captured ancestor; an unavailable link is never
// reinterpreted as a missing directory or silently rebound when it reconnects.
export const bindStorageRoot = (root: string): StorageRootBinding => {
  // Anchor relative input without erasing link/.. before the filesystem interprets it.
  const prefix = parse(root).root
  const logicalRoot = isAbsolute(root)
    ? root
    : `${resolve(prefix || '.')}${sep}${root.slice(prefix.length)}`
  let anchor = logicalRoot
  const suffix: string[] = []
  for (;;) {
    const entry = lstatSync(anchor, { throwIfNoEntry: false })
    if (entry) break
    const parent = dirname(anchor)
    if (parent === anchor) {
      return unavailableBinding(
        logicalRoot,
        Object.assign(new Error('Storage root is unavailable.'), { code: 'ENOENT' })
      )
    }
    suffix.unshift(basename(anchor))
    anchor = parent
  }

  let physicalAnchor: string
  let anchorIdentity: BigIntStats
  try {
    // fs.promises.realpath uses these same native semantics, including Windows short names.
    physicalAnchor = realpathSync.native(anchor)
    anchorIdentity = lstatSync(physicalAnchor, { bigint: true })
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTDIR')) throw error
    return unavailableBinding(logicalRoot, error)
  }
  if (!anchorIdentity.isDirectory() || anchorIdentity.isSymbolicLink()) {
    return unavailableBinding(logicalRoot, new StorageRootChangedError())
  }
  const path = join(physicalAnchor, ...suffix)
  let rootIdentity: DirectoryIdentity | undefined = suffix.length === 0 ? anchorIdentity : undefined

  const verify = async (createDirectory?: CreateDirectory): Promise<void> => {
    if ((await realpath(anchor)) !== physicalAnchor) throw new StorageRootChangedError()
    let current = physicalAnchor
    let metadata = await lstat(current, { bigint: true })
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !sameIdentity(metadata, anchorIdentity)
    ) {
      throw new StorageRootChangedError()
    }
    for (const segment of suffix) {
      current = join(current, segment)
      try {
        metadata = await lstat(current, { bigint: true })
      } catch (error) {
        if (!hasCode(error, 'ENOENT') || rootIdentity || !createDirectory) throw error
        // Never use recursive mkdir: each previously absent component must be checked before
        // descending into it, so a newly inserted link cannot redirect root creation.
        await createDirectory(current).catch((creationError: unknown) => {
          if (!hasCode(creationError, 'EEXIST')) throw creationError
        })
        metadata = await lstat(current, { bigint: true })
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new StorageRootChangedError()
    }
    if (rootIdentity && !sameIdentity(metadata, rootIdentity)) throw new StorageRootChangedError()
    rootIdentity ??= metadata
  }

  return { path, verify: () => verify(), prepare: verify }
}
