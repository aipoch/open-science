import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

type LocationIdentityDependencies = {
  platform?: NodeJS.Platform
  stat: (root: string) => { dev: bigint; ino: bigint }
  realpath: (root: string) => string
}

// Some filesystems do not expose usable inode numbers. Zero is an unavailable identity,
// never evidence that two data directories are the same. Preserve exact canonical case:
// Windows supports case-sensitive directories too, so lowercasing can hide distinct data.
export const dataLocationIdentity = (
  root: string,
  dependencies: LocationIdentityDependencies = {
    stat: (path) => statSync(path, { bigint: true }),
    realpath: (path) => realpathSync.native(path)
  }
): string => {
  // Windows file indexes (notably ReFS) are not a portable unique directory identity.
  if ((dependencies.platform ?? process.platform) === 'win32')
    return `path:${dependencies.realpath(root)}`
  const info = dependencies.stat(root)
  return info.ino > 0n ? `inode:${info.dev}:${info.ino}` : `path:${dependencies.realpath(root)}`
}

export function sameProjectFolderSpelling(saved: string, canonical: string): boolean {
  if (saved === canonical) return true
  if (saved.toLowerCase() !== canonical.toLowerCase()) return false
  const original = lstatSync(saved, { bigint: true })
  const current = lstatSync(canonical, { bigint: true })
  if (
    !original.isDirectory() ||
    !current.isDirectory() ||
    original.ino === 0n ||
    original.dev !== current.dev ||
    original.ino !== current.ino
  )
    return false
  // Bindings were canonical at admission. A replacement link anywhere in the saved path
  // is a rebinding, even when the target has the same folded spelling.
  for (let path = dirname(saved); ; path = dirname(path)) {
    if (lstatSync(path).isSymbolicLink()) return false
    if (dirname(path) === path) return true
  }
}

export const PROJECT_RECORD_DIRECTORY = '.open-science'
const ROUTES_DIRECTORY = 'project-record-routes'
export const safeProjectRecordId = (id: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id === '..')
    throw new Error('Invalid Project record identity.')
  return id
}
export type ProjectRecordManifest = Readonly<{
  version: 1
  format: 'open-science-project'
  projectId: string
  name: string
  createdAt: number
}>
type RecordRoute = {
  version: 1
  projectId: string
  folder: string
  detached?: boolean
  reopening?: boolean
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const projectRecordRoutesDirectory = (storageRoot: string): string =>
  join(storageRoot, ROUTES_DIRECTORY)
export const projectRecordRoutePath = (storageRoot: string, projectId: string): string =>
  join(projectRecordRoutesDirectory(storageRoot), `${safeProjectRecordId(projectId)}.json`)

// These files are rebuildable location indexes, never copies of the research records. Reading
// them synchronously keeps existing pure storage-key helpers independent of process-global state.
export function getProjectRecordRoute(
  storageRoot: string,
  projectId: string
): RecordRoute | undefined {
  let text: string
  try {
    text = readFileSync(projectRecordRoutePath(storageRoot, projectId), 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const value = JSON.parse(text) as RecordRoute
  if (
    value.version !== 1 ||
    value.projectId !== projectId ||
    typeof value.folder !== 'string' ||
    !isAbsolute(value.folder)
  )
    throw new Error('Invalid Project record location index.')
  return value
}

export function readProjectRecordManifest(folder: string): ProjectRecordManifest | undefined {
  const root = join(folder, PROJECT_RECORD_DIRECTORY)
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(root)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Project records must be a real directory.')
  const path = join(root, 'project.json')
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('Invalid Project record manifest.')
  const value = JSON.parse(readFileSync(path, 'utf8')) as ProjectRecordManifest
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 5 ||
    value.format !== 'open-science-project' ||
    value.version !== 1 ||
    typeof value.projectId !== 'string' ||
    typeof value.name !== 'string' ||
    value.name.length > 200 ||
    !Number.isFinite(value.createdAt)
  )
    throw new Error('Unsupported or damaged Project record manifest.')
  safeProjectRecordId(value.projectId)
  return value
}

export function getProjectRecordRoot(storageRoot: string, projectId: string): string | undefined {
  const route = getProjectRecordRoute(storageRoot, projectId)
  if (!route) return undefined
  const folder = realpathSync.native(route.folder)
  if (!sameProjectFolderSpelling(route.folder, folder))
    throw new Error('Project record folder binding changed on disk.')
  const manifest = readProjectRecordManifest(folder)
  if (!manifest || manifest.projectId !== projectId)
    throw new Error('Project record identity is missing or does not match.')
  return join(folder, PROJECT_RECORD_DIRECTORY)
}

// Formerly-private record subtrees are now in a user-owned folder. Validate existing ancestors
// before scoped reads/writes; absent descendants can be created by the normal durable writer.
export function assertProjectRecordPath(recordRoot: string, path: string): string {
  const suffix = relative(recordRoot, path)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
    throw new Error('Research record path leaves its Project record directory.')
  let current = recordRoot
  for (const segment of suffix.split(sep)) {
    current = join(current, segment)
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new Error('Research record paths cannot contain links or special files.')
    } catch (error) {
      if (missing(error)) break
      throw error
    }
  }
  return path
}

export function listProjectRecordIds(storageRoot: string): string[] {
  try {
    return readdirSync(projectRecordRoutesDirectory(storageRoot))
      .filter((name) => name.endsWith('.json'))
      .map((name) => safeProjectRecordId(name.slice(0, -5)))
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

export function getProjectRecordRoots(storageRoot: string): string[] {
  return listProjectRecordIds(storageRoot).flatMap((id) => {
    // One disconnected Project must not prevent another Project's preview. Direct scoped reads
    // still throw and never silently create a replacement in managed storage.
    try {
      const root = getProjectRecordRoot(storageRoot, id)
      return root ? [root] : []
    } catch {
      return []
    }
  })
}
