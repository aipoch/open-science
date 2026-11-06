import { RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES } from '@aipoch/research-film/contracts'
import { createHash } from 'node:crypto'
import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit } from '@aipoch/durable-files'
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
  const directory = join(base, receipt.id),
    output = join(directory, 'output')
  for (const path of [directory, output]) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe research presentation directory.')
  }
  for (const name of ['player.html', 'sources.zip']) {
    const stat = await lstat(join(output, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Research presentation is unavailable.')
  }
  return {
    ...receipt,
    playerPath: join(output, 'player.html'),
    sourcePath: join(output, 'sources.zip')
  }
}

async function researchFilmDirectory(
  root: string,
  request: ResearchVideoPresentationRequest
): Promise<string | undefined> {
  let current = root
  for (const part of ['research-video-presentations', researchFilmScopeKey(request)]) {
    current = join(current, part)
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

/** Files belong to the Session; deletion leaves no separate film tombstone. */
export async function deleteStoredResearchFilms(
  root: string,
  request: ResearchVideoPresentationRequest,
  importedId?: string
): Promise<void> {
  const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
  identity.parse(request.projectId)
  identity.parse(request.sessionId)
  if (importedId) {
    z.string().uuid().parse(importedId)
    let current = root
    let exists = true
    for (const segment of [
      'artifacts',
      request.projectId,
      request.sessionId,
      '.research-films',
      importedId
    ]) {
      current = join(current, segment)
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!stat) {
        exists = false
        break
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe imported research film directory.')
    }
    if (exists) await rm(current, { recursive: true, force: true })
  }
  const requests = request.branchId ? [request, { ...request, branchId: undefined }] : [request]
  for (const scope of requests) {
    const base = await researchFilmDirectory(root, scope)
    if (!base) continue
    const ids = new Set<string>()
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
        .object({
          provenance: z.object({
            projectId: identity,
            sessionId: identity,
            branchId: z.string().optional()
          })
        })
        .parse(
          JSON.parse(await readFileWithinLimit(sourcePath, RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES))
        )
      if (researchFilmScopeKey(source.provenance) !== researchFilmScopeKey(request)) continue
      await rm(join(base, entry.name), { recursive: true, force: true })
      ids.add(entry.name)
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
      const exists = await lstat(join(base, receipt.id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (ids.has(receipt.id) || !exists) await rm(latest, { force: true })
    }
    // Discard markers left by development builds; no deletion record is read or written.
    await rm(join(base, 'deleted.json'), { force: true })
    await rmdir(base).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
    })
  }
}
