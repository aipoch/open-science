import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  getProjectRecordRoot,
  getProjectRecordRoute,
  PROJECT_RECORD_DIRECTORY,
  projectRecordRoutePath,
  readProjectRecordManifest,
  safeProjectRecordId,
  type ProjectRecordManifest
} from '../storage/data-location-identity'

export {
  assertProjectRecordPath,
  getProjectRecordRoot,
  getProjectRecordRoute,
  listProjectRecordIds,
  PROJECT_RECORD_DIRECTORY,
  readProjectRecordManifest,
  safeProjectRecordId,
  type ProjectRecordManifest
} from '../storage/data-location-identity'

export async function registerProjectRecordStorage(
  storageRoot: string,
  folder: string,
  projectId: string,
  options: { reopening?: boolean } = {}
): Promise<void> {
  const canonical = realpathSync.native(folder)
  const manifest = readProjectRecordManifest(canonical)
  if (!manifest || manifest.projectId !== projectId)
    throw new Error('Project record identity does not match the selected folder.')
  const path = projectRecordRoutePath(storageRoot, projectId)
  await mkdir(dirname(path), { recursive: true })
  await writeDurableJsonFile(
    path,
    JSON.stringify({
      version: 1,
      projectId,
      folder: canonical,
      ...(options.reopening ? { reopening: true } : {})
    }) + '\n'
  )
}

export async function initializeProjectRecordStorage(
  storageRoot: string,
  folder: string,
  manifest: ProjectRecordManifest,
  options: { reopening?: boolean } = {}
): Promise<void> {
  safeProjectRecordId(manifest.projectId)
  const canonical = realpathSync.native(folder)
  const existing = readProjectRecordManifest(canonical)
  if (existing && existing.projectId !== manifest.projectId)
    throw new Error('This folder already contains another Project’s records.')
  if (!existing) {
    const root = join(canonical, PROJECT_RECORD_DIRECTORY)
    await mkdir(root)
    await writeDurableJsonFile(join(root, 'project.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  await registerProjectRecordStorage(storageRoot, canonical, manifest.projectId, options)
}

export async function completeProjectRecordReopen(
  storageRoot: string,
  projectId: string
): Promise<void> {
  const route = getProjectRecordRoute(storageRoot, projectId)
  if (!route?.reopening) return
  getProjectRecordRoot(storageRoot, projectId)
  const completed = { ...route }
  delete completed.reopening
  await writeDurableJsonFile(
    projectRecordRoutePath(storageRoot, projectId),
    JSON.stringify(completed) + '\n'
  )
}

export async function unregisterProjectRecordStorage(
  storageRoot: string,
  projectId: string
): Promise<void> {
  await rm(projectRecordRoutePath(storageRoot, projectId), { force: true })
}

// Keep routing available while existing cleanup owners remove managed runtime/index state. The
// durable marker prevents retries after a crash from overwriting retained research with empty DBs.
export async function markProjectRecordDetached(
  storageRoot: string,
  projectId: string
): Promise<void> {
  const route = getProjectRecordRoute(storageRoot, projectId)
  if (!route) return
  await writeDurableJsonFile(
    projectRecordRoutePath(storageRoot, projectId),
    JSON.stringify({ ...route, detached: true }) + '\n'
  )
}

// A single durable manifest replacement is the enable commit. No files or internal storage keys
// move, and an interrupted replacement leaves either the supported v1 or the complete v2 manifest.
// The caller must hold the Project's idle-work admission fence.
export async function enableProjectSessionOutputs(
  storageRoot: string,
  projectId: string
): Promise<void> {
  const root = getProjectRecordRoot(storageRoot, projectId)
  const route = getProjectRecordRoute(storageRoot, projectId)
  if (!root || !route || route.detached || route.reopening)
    throw new Error('Project research records are not ready for session outputs.')
  const manifest = readProjectRecordManifest(route.folder)!
  if (manifest.version === 2) return
  await writeDurableJsonFile(
    join(root, 'project.json'),
    JSON.stringify({ ...manifest, version: 2, outputLayout: 'session-v1' }, null, 2) + '\n'
  )
}
