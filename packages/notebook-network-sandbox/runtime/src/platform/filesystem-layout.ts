import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

type FilesystemLayoutInput = Readonly<{
  restrictFolders?: boolean
  privateRoot?: string
  readOnlyRoots: readonly string[]
  optionalReadOnlyRoots?: readonly string[]
  readWriteRoots: readonly string[]
  deniedReadRoots: readonly string[]
  deniedWriteRoots: readonly string[]
}>

type FilesystemLayout = Readonly<{
  restrictFolders?: boolean
  privateRoot?: string
  readOnlyRoots: readonly string[]
  optionalReadOnlyRoots?: readonly string[]
  readWriteRoots: readonly string[]
  deniedReadRoots: readonly string[]
  deniedWriteRoots: readonly string[]
}>

const absolutePhysicalPath = (value: string): string => {
  if (!isAbsolute(value)) throw new Error(`Sandbox filesystem path must be absolute: ${value}`)
  try {
    // Resolve links before folding .., which otherwise changes the policy's target.
    return realpathSync.native(value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      lstatSync(value)
      // A dangling link is not a missing leaf whose destination we can safely infer.
      throw error
    } catch (entryError) {
      if (entryError === error || (entryError as NodeJS.ErrnoException).code !== 'ENOENT')
        throw entryError
    }
    const parent = dirname(value)
    const name = basename(value)
    if (parent === value || name === '..') throw error
    const physicalParent = absolutePhysicalPath(parent)
    if (name === '.') return physicalParent
    try {
      if (!statSync(physicalParent).isDirectory())
        throw new Error('Sandbox path ancestor is not a directory')
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
    }
    return join(physicalParent, name)
  }
}

const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

const shallowRoots = (values: readonly string[]): string[] => {
  const ordered = [...new Set(values.map(absolutePhysicalPath))].sort(
    (left, right) => left.length - right.length
  )
  return ordered.filter((candidate, index) =>
    ordered.slice(0, index).every((existing) => !contains(existing, candidate))
  )
}

const normalizeFilesystemLayout = (input: FilesystemLayoutInput): FilesystemLayout => {
  const readOnlyRoots = shallowRoots(input.readOnlyRoots)
  const readWriteRoots = shallowRoots(input.readWriteRoots)
  const deniedReadRoots = shallowRoots(input.deniedReadRoots)
  const deniedWriteRoots = shallowRoots(input.deniedWriteRoots)
  return {
    ...(input.restrictFolders === false ? { restrictFolders: false } : {}),
    ...(input.privateRoot ? { privateRoot: absolutePhysicalPath(input.privateRoot) } : {}),
    readOnlyRoots,
    ...(input.optionalReadOnlyRoots
      ? {
          // A parent may fail its optional grant while a child remains independently usable.
          optionalReadOnlyRoots: [...new Set(input.optionalReadOnlyRoots.map(absolutePhysicalPath))]
        }
      : {}),
    readWriteRoots,
    deniedReadRoots,
    deniedWriteRoots
  }
}

const pathIsDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return path.endsWith(sep)
  }
}

const hiddenByFilesystemLayout = (layout: FilesystemLayout, value: string): boolean => {
  if (!isAbsolute(value)) return false
  let candidate: string
  try {
    candidate = absolutePhysicalPath(value)
  } catch {
    // Diagnostics can contain invalid paths; resolution failure does not prove sandbox denial.
    return false
  }
  if (layout.deniedReadRoots.some((root) => contains(root, candidate))) return true
  if (
    layout.restrictFolders === false ||
    !layout.privateRoot ||
    !contains(layout.privateRoot, candidate)
  )
    return false
  return [...layout.readOnlyRoots, ...layout.readWriteRoots].every(
    (root) => !contains(root, candidate)
  )
}

export {
  absolutePhysicalPath,
  contains,
  hiddenByFilesystemLayout,
  normalizeFilesystemLayout,
  pathIsDirectory
}
export type { FilesystemLayout, FilesystemLayoutInput }
