import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { isLocalPathRoot } from '../../shared/local-fs'
import { canonicalizeDirectory } from '../local-fs/directory-validation'
import type { PreflightGrantedLocalRoot } from '../local-fs/service'
import { runtimeMetadata } from '../runtime-metadata'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { ProjectFolderPath } from '../storage/workspace-location'

export type ProjectFolderValidationReason = 'is-root' | 'is-home' | 'app-storage-overlap'

export class ProjectFolderValidationError extends Error {
  constructor(
    readonly reason: ProjectFolderValidationReason,
    readonly path: string
  ) {
    super(`Project folder validation failed (${reason}): ${path}`)
    this.name = 'ProjectFolderValidationError'
  }
}

export type ProjectFolderValidationOptions = {
  homePath?: string
  dataRoot?: string
  configRoot?: string
  // Use the same execution-capability check as Folder access. The owner supplies this because
  // supported locations depend on the active native/WSL execution mode.
  preflight: PreflightGrantedLocalRoot
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

// Protected storage roots may not have been created yet. Canonicalize their existing parent,
// retaining missing path components so an alias to that parent cannot bypass the exclusion.
async function canonicalStoragePath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const parent = dirname(path)
    if (!isMissing(error) || parent === path) throw error
    return join(await canonicalStoragePath(parent), basename(path))
  }
}

// Resolve every ancestor through the filesystem. Comparing canonical names plus nonzero inode
// identities handles case-insensitive volumes, case-sensitive directories and symlink aliases
// without lowercasing paths (which would merge distinct directories on some filesystems).
async function directoryAncestry(path: string): Promise<Set<string>> {
  const ancestors = new Set<string>()
  for (let current = path; ; current = dirname(current)) {
    for (const identity of await directoryIdentity(current)) ancestors.add(identity)
    if (dirname(current) === current) return ancestors
  }
}

async function directoryIdentity(path: string): Promise<string[]> {
  const canonical = await canonicalStoragePath(path)
  try {
    const info = await stat(canonical, { bigint: true })
    return [
      `path:${canonical}`,
      ...(process.platform !== 'win32' && info.ino > 0n ? [`inode:${info.dev}:${info.ino}`] : [])
    ]
  } catch (error) {
    if (!isMissing(error)) throw error
    return [`path:${canonical}`]
  }
}

export async function validateProjectFolder(
  path: string,
  options: ProjectFolderValidationOptions,
  scope: 'tree' | 'target' = 'tree'
): Promise<ProjectFolderPath> {
  if (isLocalPathRoot(path, process.platform))
    throw new ProjectFolderValidationError('is-root', path)
  const canonical = await canonicalizeDirectory(path)
  if (isLocalPathRoot(canonical, process.platform))
    throw new ProjectFolderValidationError('is-root', path)
  const candidateIdentity = await directoryIdentity(canonical)
  const homeIdentity = new Set(
    await directoryIdentity(options.homePath ?? runtimeMetadata().homePath)
  )
  if (candidateIdentity.some((identity) => homeIdentity.has(identity)))
    throw new ProjectFolderValidationError('is-home', path)

  const candidateAncestry = await directoryAncestry(canonical)
  for (const root of [
    options.dataRoot ?? resolveDataRoot(),
    options.configRoot ?? resolveConfigRoot()
  ]) {
    const rootAncestry = await directoryAncestry(root)
    const rootIdentity = await directoryIdentity(root)
    if (
      candidateIdentity.some((identity) => rootAncestry.has(identity)) ||
      rootIdentity.some((identity) => candidateAncestry.has(identity))
    )
      throw new ProjectFolderValidationError('app-storage-overlap', path)
  }
  if (process.platform !== 'win32') await access(canonical, constants.X_OK)
  await options.preflight(canonical, 'rw', path, scope)
  return canonical as ProjectFolderPath
}
