import type { PrismaClient } from '@prisma/client'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { ApplicationCommandError } from '../../shared/application-command-contract'
import type { ProjectFolderValidationResult } from '../../shared/projects'

// Resolve the surviving prefix of unavailable bindings too: unplugging a drive must not release
// an active Project's reservation or accidentally make a nearby spelling a different folder.
function unavailableLocation(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(
    (error as NodeJS.ErrnoException).code ?? ''
  )
}

async function physicalPath(path: string, reserveUnavailable: boolean): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(reserveUnavailable && unavailableLocation(error))
    )
      throw error
    const parent = dirname(path)
    if (parent === path) return resolve(path)
    return join(await physicalPath(parent, reserveUnavailable), basename(path))
  }
}

function contains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

async function identities(path: string, reserveUnavailable: boolean): Promise<string[]> {
  const result = [`path:${path}`]
  try {
    const info = await stat(path, { bigint: true })
    if (process.platform !== 'win32' && info.ino > 0n) result.push(`inode:${info.dev}:${info.ino}`)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !(reserveUnavailable && unavailableLocation(error))
    )
      throw error
  }
  return result
}

async function location(
  path: string,
  reserveUnavailable = false
): Promise<{ own: string[]; ancestors: Set<string> }> {
  const canonical = await physicalPath(path, reserveUnavailable)
  const ancestors = new Set<string>()
  // A broken sibling binding still reserves its saved spelling and reachable physical prefix.
  // Its inaccessible leaf must not turn every other Project's health check into an access error.
  const spellings = reserveUnavailable ? new Set([path, canonical]) : new Set([canonical])
  const own = new Set<string>()
  for (const spelling of spellings) {
    for (const identity of await identities(spelling, reserveUnavailable)) own.add(identity)
    for (let current = spelling; ; current = dirname(current)) {
      for (const identity of await identities(current, reserveUnavailable)) ancestors.add(identity)
      if (dirname(current) === current) break
    }
  }
  return { own: [...own], ancestors }
}

export async function sameProjectFolderSpelling(
  saved: string,
  canonical: string
): Promise<boolean> {
  if (saved === canonical) return true
  if (saved.toLowerCase() !== canonical.toLowerCase()) return false
  const [original, current] = await Promise.all([
    lstat(saved, { bigint: true }),
    lstat(canonical, { bigint: true })
  ])
  if (
    !original.isDirectory() ||
    !current.isDirectory() ||
    original.ino === 0n ||
    original.dev !== current.dev ||
    original.ino !== current.ino
  )
    return false
  // Bindings were canonical at admission. A new symbolic ancestor is a rebinding, even if its
  // target happens to have the same folded spelling; case folding alone never grants identity.
  for (let path = saved; ; path = dirname(path)) {
    if ((await lstat(path)).isSymbolicLink()) return false
    if (dirname(path) === path) return true
  }
}

export async function assertProjectFolderAvailable(
  client: Pick<PrismaClient, 'project'>,
  path: string,
  excludedProjectId?: string
): Promise<void> {
  try {
    const candidate = await location(path)
    const bindings = await client.project.findMany({
      where: { deletedAt: null, archivedAt: null, rootPath: { not: null } },
      select: { id: true, name: true, rootPath: true }
    })
    for (const binding of bindings) {
      if (!binding.rootPath || binding.id === excludedProjectId) continue
      const occupied = await location(binding.rootPath, true)
      if (
        candidate.own.some((identity) => occupied.ancestors.has(identity)) ||
        occupied.own.some((identity) => candidate.ancestors.has(identity))
      ) {
        throw new ApplicationCommandError(
          'project-folder-conflict',
          `Project folder is already in use.\nProject: ${binding.name}\nProject ID: ${binding.id}\nSelected folder: ${path}\nOccupied folder: ${binding.rootPath}`
        )
      }
    }
  } catch (error) {
    if (error instanceof ApplicationCommandError) throw error
    throw new ApplicationCommandError(
      'project-folder-unavailable',
      error instanceof Error ? error.message : String(error),
      undefined,
      { cause: error }
    )
  }
}

export function projectFolderFailure(
  error: unknown
): Extract<ProjectFolderValidationResult, { ok: false }> {
  const code = error instanceof ApplicationCommandError ? error.code : undefined
  return {
    ok: false,
    kind:
      code === 'project-folder-conflict'
        ? 'conflict'
        : code === 'project-folder-not-found'
          ? 'not-found'
          : 'unavailable',
    diagnostics: error instanceof Error ? error.message : String(error)
  }
}

// These are recognized location hints, not a claim that every sync provider or mount is detected.
// Execution-capability validation always runs first; a warning never overrides a rejected volume.
export function projectFolderWarnings(
  path: string,
  environment: NodeJS.ProcessEnv = process.env
): Array<'cloud-synced' | 'network'> {
  const normalized = path.replaceAll('\\', '/')
  const warnings: Array<'cloud-synced' | 'network'> = []
  const cloudRoots = [
    environment.OneDrive,
    environment.OneDriveCommercial,
    environment.OneDriveConsumer
  ].filter((root): root is string => Boolean(root))
  if (
    /(?:^|\/)Library\/(?:CloudStorage|Mobile Documents)(?:\/|$)/i.test(normalized) ||
    cloudRoots.some((root) => contains(resolve(root), resolve(path)))
  )
    warnings.push('cloud-synced')
  if (/^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(path)) warnings.push('network')
  return warnings
}
