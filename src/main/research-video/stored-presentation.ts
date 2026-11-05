import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import type {
  ResearchVideoPresentation,
  ResearchVideoPresentationRequest
} from '../../shared/research-video-presentation'

export const researchFilmScopeKey = (request: ResearchVideoPresentationRequest): string =>
  createHash('sha256')
    .update(JSON.stringify([request.projectId, request.sessionId, request.branchId ?? null]))
    .digest('hex')

export const researchFilmReceiptSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(160),
    duration: z.number().positive()
  })
  .strict()

export async function readStoredResearchFilm(
  root: string,
  request: ResearchVideoPresentationRequest
): Promise<ResearchVideoPresentation | undefined> {
  const base = join(root, 'research-video-presentations', researchFilmScopeKey(request))
  for (const path of [join(root, 'research-video-presentations'), base]) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe research presentation directory.')
  }
  const path = join(base, 'latest.json')
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Unsafe research presentation receipt.')
  const receipt = researchFilmReceiptSchema.parse(JSON.parse(await readFileWithinLimit(path, 4096)))
  if ((await deletedResearchFilmIds(root, request)).includes(receipt.id)) return undefined
  const directory = join(base, receipt.id),
    output = join(directory, 'output')
  for (const path of [directory, output]) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe research presentation directory.')
  }
  for (const name of ['player.html', 'sources.zip']) {
    const stat = await lstat(join(output, name))
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Research presentation is unavailable.')
  }
  return {
    ...receipt,
    playerPath: join(output, 'player.html'),
    sourcePath: join(output, 'sources.zip')
  }
}

export const researchFilmDeletionSchema = z
  .object({
    provenance: z.object({
      projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
      sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
      branchId: z.string().optional()
    }),
    ids: z.array(z.string().uuid()).max(10000)
  })
  .strict()

export async function deletedResearchFilmIds(
  root: string,
  request: ResearchVideoPresentationRequest
): Promise<string[]> {
  const base = await researchFilmDirectory(root, request, false)
  if (!base) return []
  const path = join(base, 'deleted.json')
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return []
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Unsafe research film deletion receipt.')
  const receipt = researchFilmDeletionSchema.parse(
    JSON.parse(await readFileWithinLimit(path, 1024 * 1024))
  )
  if (researchFilmScopeKey(receipt.provenance) !== researchFilmScopeKey(request))
    throw new Error('Invalid research film deletion ownership.')
  return receipt.ids
}

export async function researchFilmDirectory(
  root: string,
  request: ResearchVideoPresentationRequest,
  create: boolean
): Promise<string | undefined> {
  let current = root
  for (const part of ['research-video-presentations', researchFilmScopeKey(request)]) {
    current = join(current, part)
    if (create)
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe research film directory.')
  }
  return current
}

/** Mark first: interrupted cleanup must never revive a previous film or its imported fallback. */
export async function deleteStoredResearchFilms(
  root: string,
  request: ResearchVideoPresentationRequest,
  importedId?: string
): Promise<void> {
  const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
  identity.parse(request.projectId)
  identity.parse(request.sessionId)
  const requests = request.branchId ? [request, { ...request, branchId: undefined }] : [request]
  for (const scope of requests) {
    const base = (await researchFilmDirectory(root, scope, true))!
    const ids = new Set(await deletedResearchFilmIds(root, scope))
    if (importedId && scope === request) ids.add(z.string().uuid().parse(importedId))
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !z.string().uuid().safeParse(entry.name).success
      )
        continue
      const sourcePath = join(base, entry.name, 'session.json')
      const stat = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!stat?.isFile() || stat.isSymbolicLink()) continue
      const source = z
        .object({ provenance: researchFilmDeletionSchema.shape.provenance })
        .parse(JSON.parse(await readFileWithinLimit(sourcePath, 8 * 1024 * 1024)))
      if (researchFilmScopeKey(source.provenance) !== researchFilmScopeKey(request)) continue
      ids.add(entry.name)
    }
    await writeDurableJsonFile(
      join(base, 'deleted.json'),
      JSON.stringify(researchFilmDeletionSchema.parse({ provenance: scope, ids: [...ids] }))
    )
    await cleanupDeletedResearchFilms(root, scope, [...ids])
  }
}

export async function cleanupDeletedResearchFilms(
  root: string,
  request: ResearchVideoPresentationRequest,
  ids: string[]
): Promise<void> {
  researchFilmDeletionSchema.parse({ provenance: request, ids })
  const base = await researchFilmDirectory(root, request, false)
  if (!base) return
  // IDs from a prior interrupted attempt remain authorized even after session.json was removed.
  for (const id of ids) {
    const path = join(base, id)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('Unsafe research film directory.')
    await rm(path, { recursive: true, force: true })
    const imported = join('artifacts', request.projectId, request.sessionId, '.research-films', id)
    let current = root
    let exists = true
    for (const segment of [
      'artifacts',
      request.projectId,
      request.sessionId,
      '.research-films',
      id
    ]) {
      current = join(current, segment)
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!info) {
        exists = false
        break
      }
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Unsafe imported research film directory.')
    }
    if (exists) await rm(join(root, imported), { recursive: true, force: true })
  }
  const latest = join(base, 'latest.json')
  const stat = await lstat(latest).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Unsafe research presentation receipt.')
    const receipt = researchFilmReceiptSchema.parse(
      JSON.parse(await readFileWithinLimit(latest, 4096))
    )
    if (ids.includes(receipt.id)) await rm(latest, { force: true })
  }
}
