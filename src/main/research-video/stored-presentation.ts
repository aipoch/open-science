import { createLogger } from '@aipoch/diagnostics/node'
import { RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES } from '@aipoch/research-film/contracts'
import { createHash } from 'node:crypto'
import { open, lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DurableJsonReadLimitError, readFileWithinLimit } from '@aipoch/durable-files'
import { z } from 'zod'
import { researchFilmModeSchema } from '../../shared/research-video-presentation'
import type {
  ResearchVideoPresentation,
  ResearchVideoPresentationRequest
} from '../../shared/research-video-presentation'

const log = createLogger('research-video')

export const researchFilmScopeKey = (request: ResearchVideoPresentationRequest): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        request.projectId,
        request.sessionId,
        request.branchId ?? null,
        ...(request.mode === 'operation-replay' ? [request.mode] : [])
      ])
    )
    .digest('hex')

export const researchFilmReceiptSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(160),
    duration: z.number().positive(),
    scriptScore: z.number().int().min(0).max(9).optional(),
    sessionAppMode: z.enum(['live', 'drawn']).optional()
  })
  .strict()

export class CorruptResearchFilmReceiptError extends Error {
  constructor() {
    super('The saved research film receipt is damaged.')
  }
}

const missing = (error: NodeJS.ErrnoException): undefined => {
  if (error.code !== 'ENOENT') throw error
}

export async function hasResearchFilmOutputs(directory: string): Promise<boolean> {
  const output = join(directory, 'output')
  for (const path of [directory, output]) {
    const stat = await lstat(path).catch(missing)
    if (!stat) return false
    if (!stat.isDirectory()) throw new Error('Unsafe research presentation directory.')
  }
  let complete = true
  for (const name of ['player.html', 'sources.zip']) {
    const stat = await lstat(join(output, name)).catch(missing)
    if (stat && !stat.isFile()) throw new Error('Research presentation is unavailable.')
    if (!stat?.size) complete = false
  }
  return complete
}

export async function readResearchFilmReceipt(
  base: string
): Promise<z.infer<typeof researchFilmReceiptSchema> | undefined> {
  const path = join(base, 'latest.json')
  const stat = await lstat(path).catch(missing)
  if (!stat) return undefined
  if (!stat.isFile()) throw new Error('Unsafe research presentation receipt.')
  try {
    return researchFilmReceiptSchema.parse(JSON.parse(await readFileWithinLimit(path, 4096)))
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof z.ZodError ||
      error instanceof DurableJsonReadLimitError
    )
      throw new CorruptResearchFilmReceiptError()
    throw error
  }
}

/** Read only the bounded marker emitted by the player builder, never load or execute the film. */
export async function readResearchFilmCard(
  playerPath: string
): Promise<Pick<ResearchVideoPresentation, 'scriptScore' | 'sessionAppMode'>> {
  const handle = await open(playerPath, 'r')
  try {
    const prefix = Buffer.alloc(96)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    const match = /^<!doctype html><!--open-science-film-card:([0-9]?):(live|drawn|)-->/.exec(
      prefix.toString('utf8', 0, bytesRead)
    )
    const mode = match?.[2]
    return {
      ...(match?.[1] && { scriptScore: Number(match[1]) }),
      ...((mode === 'live' || mode === 'drawn') && { sessionAppMode: mode })
    }
  } finally {
    await handle.close()
  }
}

export async function readStoredResearchFilm(
  root: string,
  request: ResearchVideoPresentationRequest,
  known?: ResearchVideoPresentation
): Promise<ResearchVideoPresentation | undefined> {
  const base = await researchFilmDirectory(root, request)
  if (!base) return undefined
  const receipt = await readResearchFilmReceipt(base).catch(async (error: unknown) => {
    if (!(error instanceof CorruptResearchFilmReceiptError) || !known) throw error
    const directory = join(base, known.id)
    if (
      known.playerPath !== join(directory, 'output', 'player.html') ||
      !(await hasResearchFilmOutputs(directory))
    )
      throw error
    const { id, title, duration, scriptScore, sessionAppMode } = known
    return { id, title, duration, scriptScore, sessionAppMode }
  })
  if (!receipt) return undefined
  const directory = join(base, receipt.id)
  if (!(await hasResearchFilmOutputs(directory))) return undefined
  const playerPath = join(directory, 'output', 'player.html')
  return {
    ...receipt,
    ...(await readResearchFilmCard(playerPath)),
    playerPath,
    sourcePath: join(directory, 'output', 'sources.zip')
  }
}

/** Retention runs only after publication; unknown or unfinished directories are never candidates. */
export async function pruneStoredResearchFilms(
  root: string,
  request: ResearchVideoPresentationRequest,
  currentId: string,
  previousId: string,
  withUnusedFiles: (paths: string[], remove: () => Promise<void>) => Promise<boolean>
): Promise<void> {
  const base = await researchFilmDirectory(root, request)
  if (!base || (await readResearchFilmReceipt(base))?.id !== currentId) return
  const owner = z.object({
    provenance: z.object({
      projectId: z.string(),
      sessionId: z.string(),
      branchId: z.string().optional(),
      mode: researchFilmModeSchema.optional()
    })
  })
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !z.string().uuid().safeParse(entry.name).success ||
      entry.name === currentId ||
      entry.name === previousId
    )
      continue
    try {
      const directory = join(base, entry.name)
      if (!(await hasResearchFilmOutputs(directory))) continue
      const sourcePath = join(directory, 'session.json')
      const stat = await lstat(sourcePath).catch(missing)
      if (!stat?.isFile() || stat.isSymbolicLink()) continue
      const source = owner.safeParse(
        JSON.parse(await readFileWithinLimit(sourcePath, RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES))
      )
      if (
        !source.success ||
        researchFilmScopeKey(source.data.provenance) !== researchFilmScopeKey(request)
      )
        continue
      await withUnusedFiles(
        ['player.html', 'sources.zip'].map((name) => join(directory, 'output', name)),
        () => rm(directory, { recursive: true, force: true })
      )
    } catch (error) {
      // Unproven or inaccessible output must not prevent retiring independent old films.
      log.info('film retention candidate skipped', {
        scope: researchFilmScopeKey(request),
        filmId: entry.name,
        reason: error instanceof SyntaxError ? 'invalid-json' : 'candidate-io-failed'
      })
    }
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
      request.mode === 'operation-replay' ? '.operation-replay-films' : '.research-films',
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
  const requests =
    request.branchId && request.mode !== 'operation-replay'
      ? [request, { ...request, branchId: undefined }]
      : [request]
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
            branchId: z.string().optional(),
            mode: researchFilmModeSchema.optional()
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
