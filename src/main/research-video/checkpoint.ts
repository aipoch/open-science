import { createHash } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import type { FilmAuthoringCheckpoint, ResearchVideoSessionSource } from '@aipoch/research-film'
import { researchFilmReceiptSchema } from './stored-presentation'

const pendingFilm = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  conversation: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  step: z.number().int().min(1).max(5),
  startedAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  attempt: z.number().int().positive(),
  completed: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
  built: researchFilmReceiptSchema.optional()
})
export type PendingFilm = z.infer<typeof pendingFilm>
export const digestFilmInput = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

export const filmConversationDigest = (source: ResearchVideoSessionSource): string =>
  digestFilmInput(
    JSON.stringify({ ...source, provenance: { ...source.provenance, sourceRevision: undefined } })
  )

export async function readPendingFilm(base: string): Promise<PendingFilm | undefined> {
  const path = join(base, 'pending.json')
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!info?.isFile() || info.size > 4096) return undefined
  let parsed
  try {
    parsed = pendingFilm.safeParse(JSON.parse(await readFileWithinLimit(path, 4096)))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (!parsed.success || (parsed.data.built && parsed.data.id !== parsed.data.built.id))
    return undefined
  const job = await lstat(join(base, 'pending')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  return job?.isDirectory() || (!job && parsed.data.built) ? parsed.data : undefined
}

export function savePendingFilm(base: string, value: PendingFilm): Promise<void> {
  return writeDurableJsonFile(join(base, 'pending.json'), JSON.stringify(value))
}

/** Each validated unit has its own atomic file, including independent concurrent scenes. */
export function filmAuthoringCheckpoint(
  directory: string,
  event: (outcome: string) => void
): FilmAuthoringCheckpoint {
  const file = (key: string): string => join(directory, 'unit-' + digestFilmInput(key) + '.json')
  return {
    async read(key) {
      const path = file(key)
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (!info?.isFile() || info.size > 512 * 1024) return undefined
      try {
        const entry = JSON.parse(await readFileWithinLimit(path, 512 * 1024))
        if (typeof entry?.value === 'string' && digestFilmInput(entry.value) === entry.digest) {
          event('reused')
          return entry.value
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      return undefined
    },
    async save(key, value) {
      await writeDurableJsonFile(
        file(key),
        JSON.stringify({ digest: digestFilmInput(value), value })
      )
      event('saved')
    }
  }
}
export async function removePendingPointer(base: string): Promise<void> {
  await rm(join(base, 'pending.json'), { force: true })
}
