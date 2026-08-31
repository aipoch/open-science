import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

type FilesystemLayoutInput = Readonly<{
  privateRoot?: string
  readOnlyRoots: readonly string[]
  readWriteRoots: readonly string[]
  deniedReadRoots: readonly string[]
  deniedWriteRoots: readonly string[]
}>

type FilesystemLayout = Readonly<{
  privateRoot?: string
  readOnlyRoots: readonly string[]
  readWriteRoots: readonly string[]
  deniedReadRoots: readonly string[]
  deniedWriteRoots: readonly string[]
}>

const absolutePhysicalPath = (value: string): string => {
  if (!isAbsolute(value)) throw new Error(`Sandbox filesystem path must be absolute: ${value}`)
  const absolute = resolve(value)
  if (existsSync(absolute)) return realpathSync.native(absolute)
  let ancestor = dirname(absolute)
  while (ancestor !== dirname(ancestor) && !existsSync(ancestor)) ancestor = dirname(ancestor)
  if (!existsSync(ancestor)) return absolute
  const physicalAncestor = realpathSync.native(ancestor)
  return resolve(
    physicalAncestor,
    absolute.slice(ancestor.length + (ancestor.endsWith(sep) ? 0 : 1))
  )
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
    ...(input.privateRoot ? { privateRoot: absolutePhysicalPath(input.privateRoot) } : {}),
    readOnlyRoots,
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
  const candidate = absolutePhysicalPath(value)
  if (layout.deniedReadRoots.some((root) => contains(root, candidate))) return true
  if (!layout.privateRoot || !contains(layout.privateRoot, candidate)) return false
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
