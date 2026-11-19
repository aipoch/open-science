import { createHash } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import type { FilmAuthoringCheckpoint, ResearchVideoSessionSource } from '@aipoch/research-film'
import {
  researchFilmModeSchema,
  type ResearchFilmMode
} from '../../shared/research-video-presentation'
import { digestFileWithinBudget } from '../bounded-file-io'
import { hasResearchFilmOutputs, researchFilmReceiptSchema } from './stored-presentation'

const pendingFilmFields = {
  id: z.string().uuid(),
  conversation: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  step: z.number().int().min(1).max(5),
  startedAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  attempt: z.number().int().positive(),
  completed: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
  built: researchFilmReceiptSchema.optional(),
  visualChecked: z.literal(true).optional(),
  outputFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
}
export const pendingFilmSchema = z.discriminatedUnion('version', [
  z.object({ ...pendingFilmFields, version: z.literal(1), mode: z.undefined().optional() }),
  z.object({ ...pendingFilmFields, version: z.literal(2), mode: researchFilmModeSchema }).strict()
])
export type PendingFilm = z.infer<typeof pendingFilmSchema>
export const PENDING_FILM_OWNER = 'pending-owner.json'
const identity = z.string().min(1).max(512)
const ownerFields = {
  id: z.string().uuid(),
  projectId: identity,
  sessionId: identity,
  branchId: identity.optional()
}
export const pendingFilmOwnerSchema = z.discriminatedUnion('version', [
  z.object({ ...ownerFields, version: z.literal(1), mode: z.undefined().optional() }).strict(),
  z.object({ ...ownerFields, version: z.literal(2), mode: researchFilmModeSchema }).strict()
])

export function savePendingFilmOwner(
  directory: string,
  owner: {
    id: string
    projectId: string
    sessionId: string
    branchId?: string
    mode?: ResearchFilmMode
  }
): Promise<void> {
  return writeDurableJsonFile(
    join(directory, PENDING_FILM_OWNER),
    JSON.stringify({ ...owner, version: 2, mode: owner.mode ?? 'research-explanation' })
  )
}

export const digestFilmInput = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

/** Changing the review rules invalidates unpublished builds without changing published receipts. */
export async function filmOutputFingerprint(
  directory: string,
  signal: AbortSignal
): Promise<string | undefined> {
  if (!(await hasResearchFilmOutputs(directory))) return undefined
  const files = []
  for (const name of ['player.html', 'sources.zip']) {
    const path = join(directory, 'output', name)
    const stat = await lstat(path)
    files.push(await digestFileWithinBudget(path, stat.size, signal))
  }
  return digestFilmInput(JSON.stringify(['film-output-review-v1', ...files]))
}

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
    parsed = pendingFilmSchema.safeParse(JSON.parse(await readFileWithinLimit(path, 4096)))
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

// Budget for the serialized recovery file, independent of the model response size.
const MAX_AUTHORING_CHECKPOINT_BYTES = 8 * 1024 * 1024

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
      if (!info?.isFile() || info.size > MAX_AUTHORING_CHECKPOINT_BYTES) return undefined
      try {
        const entry = JSON.parse(await readFileWithinLimit(path, MAX_AUTHORING_CHECKPOINT_BYTES))
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
      if (Buffer.byteLength(value) > MAX_AUTHORING_CHECKPOINT_BYTES) return
      const entry = JSON.stringify({ digest: digestFilmInput(value), value })
      if (Buffer.byteLength(entry) > MAX_AUTHORING_CHECKPOINT_BYTES) return
      await writeDurableJsonFile(file(key), entry)
      event('saved')
    }
  }
}
export async function removePendingPointer(base: string): Promise<void> {
  await rm(join(base, 'pending.json'), { force: true })
}
