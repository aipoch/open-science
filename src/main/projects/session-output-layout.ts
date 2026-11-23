import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultFileDurability, writeDurableJsonFile } from '@aipoch/durable-files'
import {
  assertProjectRecordPath,
  getProjectRecordRoot,
  getProjectRecordRoute,
  readProjectRecordManifest,
  safeProjectRecordId
} from './record-storage'

export function getArtifactSessionOutputRelativePath(
  projectId: string,
  appSessionId: string
): string {
  return `artifacts/${safeProjectRecordId(projectId)}/${safeProjectRecordId(appSessionId)}`
}

export function getNotebookSessionOutputRelativePath(
  projectId: string,
  appSessionId: string,
  frameId?: string
): string {
  const root = `notebooks/${safeProjectRecordId(projectId)}/${safeProjectRecordId(appSessionId)}`
  return `${root}${frameId ? `/frames/${safeProjectRecordId(frameId)}` : ''}/data`
}

// Resolve on each use: the durable manifest and current folder binding own layout authority.
// Provider routing IDs, titles, run IDs and cwd never participate in these relative targets.
export function getProjectSessionOutputLayout(
  storageRoot: string,
  projectId: string,
  appSessionId: string
):
  | {
      projectRoot: string
      notebookDataRelativePath: string
      artifactDirectoryRelativePath: string
    }
  | undefined {
  const route = getProjectRecordRoute(storageRoot, projectId)
  if (!route || route.detached || route.reopening) return undefined
  const recordRoot = getProjectRecordRoot(storageRoot, projectId)!
  return {
    projectRoot: dirname(recordRoot),
    notebookDataRelativePath: getNotebookSessionOutputRelativePath(projectId, appSessionId),
    artifactDirectoryRelativePath: getArtifactSessionOutputRelativePath(projectId, appSessionId)
  }
}

const directoryQueues = new Map<string, Promise<unknown>>()
const ownershipPath = (recordRoot: string): string =>
  assertProjectRecordPath(recordRoot, join(recordRoot, 'session-output-directories.json'))

type DirectoryIdentity = { dev: string; ino: string; birthtimeNs: string }
type OutputDirectory = {
  relativePath: string
  identity: DirectoryIdentity
} & ({ state: 'committed' } | { state: 'prepared'; stagingName: string })

const relativeOutputDirectory =
  /^notebooks\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/(?:frames\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/)?data$/
const stagingDirectoryName = /^\.session-output-directory-[a-f0-9-]{36}$/

function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const info = lstatSync(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Session output directories cannot contain links or special files.')
    return { dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const sameIdentity = (first: DirectoryIdentity | undefined, second: DirectoryIdentity): boolean =>
  Boolean(
    first &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.birthtimeNs === second.birthtimeNs
  )

function outputDirectories(recordRoot: string, revalidatePathsOnly = false): OutputDirectory[] {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(ownershipPath(recordRoot), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!value || typeof value !== 'object' || !('version' in value))
    throw new Error('Invalid session output directory ownership records.')
  // The unreleased paths-only prototype cannot prove ownership after a copy or replacement.
  // Keep its records and user directories intact; do not silently adopt their present identities.
  if (value.version === 1) {
    if (!revalidatePathsOnly)
      throw new Error('Session output directory ownership requires explicit revalidation.')
    if (
      !('paths' in value) ||
      !Array.isArray(value.paths) ||
      value.paths.some((path) => typeof path !== 'string' || !relativeOutputDirectory.test(path))
    )
      throw new Error('Invalid session output directory ownership records.')
    return value.paths.map((relativePath: string) => ({
      relativePath,
      state: 'committed',
      identity: { dev: '0', ino: '0', birthtimeNs: '0' }
    }))
  }
  if (value.version !== 2 || !('directories' in value) || !Array.isArray(value.directories))
    throw new Error('Invalid session output directory ownership records.')
  for (const entry of value.directories) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !relativeOutputDirectory.test(entry.relativePath) ||
      !entry.identity ||
      typeof entry.identity !== 'object' ||
      !['dev', 'ino', 'birthtimeNs'].every(
        (key) => typeof entry.identity[key] === 'string' && /^\d+$/.test(entry.identity[key])
      ) ||
      !(
        entry.state === 'committed' ||
        (entry.state === 'prepared' && stagingDirectoryName.test(entry.stagingName))
      )
    )
      throw new Error('Invalid session output directory ownership records.')
  }
  const directories = value.directories as OutputDirectory[]
  if (new Set(directories.map((entry) => entry.relativePath)).size !== directories.length)
    throw new Error('Invalid session output directory ownership records.')
  return directories
}

async function saveOutputDirectories(
  recordRoot: string,
  directories: OutputDirectory[]
): Promise<void> {
  await writeDurableJsonFile(
    ownershipPath(recordRoot),
    JSON.stringify({ version: 2, directories }) + '\n'
  )
}

export function isOwnedProjectNotebookOutputDirectory(
  storageRoot: string,
  projectId: string,
  relativePath: string
): boolean {
  const root = getProjectRecordRoot(storageRoot, projectId)
  if (!root) return false
  const directory = outputDirectories(root).find((entry) => entry.relativePath === relativePath)
  if (!directory || directory.state !== 'committed') return false
  const projectRoot = getProjectRecordRoute(storageRoot, projectId)!.folder
  // Validate every ancestor, rather than following a link to an otherwise matching leaf.
  let path = projectRoot
  for (const segment of relativePath.split('/')) {
    path = join(path, segment)
    if (!directoryIdentity(path)) return false
  }
  return sameIdentity(directoryIdentity(path), directory.identity)
}

function serializeDirectories<Result>(
  storageRoot: string,
  projectId: string,
  run: () => Promise<Result>
): Promise<Result> {
  const key = `${storageRoot}\0${projectId}`
  const previous = directoryQueues.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(run)
  directoryQueues.set(key, operation)
  void operation
    .finally(() => {
      if (directoryQueues.get(key) === operation) directoryQueues.delete(key)
    })
    .catch(() => undefined)
  return operation
}

// Only explicit Locate/reopen may adopt physical identities from a selected copy of known records.
// Automatic route repair and health checks deliberately never call this boundary.
export function revalidateProjectNotebookOutputDirectories(
  storageRoot: string,
  projectId: string,
  folder: string
): Promise<void> {
  return serializeDirectories(storageRoot, projectId, async () => {
    const manifest = readProjectRecordManifest(folder)
    if (!manifest || manifest.projectId !== projectId)
      throw new Error('Project record identity does not match the selected folder.')
    const recordRoot = join(folder, '.open-science')
    const directories = outputDirectories(recordRoot, true)
    if (directories.length === 0) return
    const revalidated: OutputDirectory[] = []
    for (const directory of directories) {
      if (directory.relativePath.split('/')[1] !== projectId)
        throw new Error('Session output directory belongs to another Project.')
      let target = folder
      let missing = false
      for (const segment of directory.relativePath.split('/')) {
        target = join(target, segment)
        if (!directoryIdentity(target)) {
          missing = true
          break
        }
      }
      if (!missing) {
        revalidated.push({
          relativePath: directory.relativePath,
          state: 'committed',
          identity: directoryIdentity(target)!
        })
      } else if (directory.state === 'prepared') {
        const staging = assertProjectRecordPath(recordRoot, join(recordRoot, directory.stagingName))
        const identity = directoryIdentity(staging)
        if (identity) revalidated.push({ ...directory, identity })
      }
      // Missing leaves hold no files to adopt. Explicit Notebook use may prepare an empty directory;
      // rebind itself neither recreates directories nor restores their previous contents.
    }
    await saveOutputDirectories(recordRoot, revalidated)
  })
}

// Prepare an empty directory and durably record its identity before exposing its public leaf.
// Recovery recognizes either side of the rename; an unrelated/replaced directory is never adopted.
export function ensureProjectNotebookOutputDirectory(
  storageRoot: string,
  projectId: string,
  appSessionId: string,
  frameId?: string
): Promise<string | undefined> {
  return serializeDirectories(storageRoot, projectId, async () => {
    const layout = getProjectSessionOutputLayout(storageRoot, projectId, appSessionId)
    if (!layout) return undefined
    const relativePath = getNotebookSessionOutputRelativePath(projectId, appSessionId, frameId)
    const recordRoot = getProjectRecordRoot(storageRoot, projectId)!
    const directories = outputDirectories(recordRoot)
    let entry = directories.find((directory) => directory.relativePath === relativePath)
    let target = layout.projectRoot
    const segments = relativePath.split('/')
    for (const segment of segments.slice(0, -1)) {
      target = join(target, segment)
      if (!directoryIdentity(target)) {
        await mkdir(target)
        await defaultFileDurability.syncDirectory(dirname(target))
      }
    }
    target = join(target, segments.at(-1)!)
    const existing = directoryIdentity(target)
    if (existing) {
      if (!entry)
        throw new Error(
          'The session output directory already exists and is not owned by this Project.'
        )
      if (!sameIdentity(existing, entry.identity))
        throw new Error(
          'The session output directory was replaced and requires explicit revalidation.'
        )
      if (entry.state === 'committed') return target
    } else if (entry?.state === 'committed') {
      // Explicit Notebook use may recreate an empty deleted directory, never its old contents.
      directories.splice(directories.indexOf(entry), 1)
      entry = undefined
    }
    if (!entry) {
      const stagingName = `.session-output-directory-${randomUUID()}`
      const staging = assertProjectRecordPath(recordRoot, join(recordRoot, stagingName))
      await mkdir(staging)
      await defaultFileDurability.syncDirectory(recordRoot)
      entry = {
        relativePath,
        state: 'prepared',
        stagingName,
        identity: directoryIdentity(staging)!
      }
      directories.push(entry)
      await saveOutputDirectories(recordRoot, directories)
    }
    if (entry.state !== 'prepared') throw new Error('Invalid session output directory state.')
    if (!existing) {
      const staging = assertProjectRecordPath(recordRoot, join(recordRoot, entry.stagingName))
      if (!sameIdentity(directoryIdentity(staging), entry.identity))
        throw new Error('Prepared session output directory is unavailable or was replaced.')
      // Recheck the leaf immediately before rename. Never replace an observed occupant.
      if (directoryIdentity(target))
        throw new Error('The session output directory changed while being prepared.')
      await rename(staging, target)
    }
    if (!sameIdentity(directoryIdentity(target), entry.identity))
      throw new Error('The session output directory changed while being prepared.')
    await defaultFileDurability.syncDirectory(dirname(target))
    await defaultFileDurability.syncDirectory(recordRoot)
    directories[directories.indexOf(entry)] = {
      relativePath,
      state: 'committed',
      identity: entry.identity
    }
    await saveOutputDirectories(recordRoot, directories)
    return target
  })
}
