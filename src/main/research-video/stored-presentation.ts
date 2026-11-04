import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
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
