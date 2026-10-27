import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseSavedSkillRepository } from '../../shared/skill-sources'
import {
  readDurableJsonFile,
  writeDurableJsonFile,
  DurableJsonRecoveryBarrierError
} from '@aipoch/durable-files'
import type {
  SavedSkillSource,
  AddSkillSourceRequest,
  RemoveSkillSourceRequest
} from '../../shared/skill-sources'

export function normalizeSkillSource(input: string): SavedSkillSource {
  const source = parseSavedSkillRepository(input)
  const id = createHash('sha256')
    .update(JSON.stringify([source.repository, source.ref ?? null]))
    .digest('hex')
  return { id, ...source }
}

const sourceSchema = z
  .strictObject({ id: z.string(), repository: z.string(), ref: z.string().optional() })
  .refine((source) => {
    try {
      const normalized = normalizeSkillSource(
        source.repository + (source.ref ? `@${source.ref}` : '')
      )
      return (
        normalized.id === source.id &&
        normalized.repository === source.repository &&
        normalized.ref === source.ref
      )
    } catch {
      return false
    }
  })
const documentSchema = z
  .strictObject({ version: z.literal(1), sources: z.array(sourceSchema).max(100) })
  .refine(
    (document) =>
      new Set(document.sources.map((source) => source.id)).size === document.sources.length
  )

/** The sole writer of saved Skill repository bookmarks; never writes installed Skills. */
export class SkillSourceRepository {
  private readonly path: string
  private queue: Promise<void> = Promise.resolve()
  constructor(configRoot: string) {
    this.path = join(configRoot, 'skill-sources.json')
  }

  async list(): Promise<SavedSkillSource[]> {
    const result = await readDurableJsonFile(this.path, (contents) => {
      try {
        return documentSchema.parse(JSON.parse(contents)).sources
      } catch {
        throw new DurableJsonRecoveryBarrierError(
          'Skill source configuration is unreadable. The original file has been preserved.'
        )
      }
    })
    return result.status === 'found' ? result.value : []
  }

  add(request: AddSkillSourceRequest): Promise<SavedSkillSource[]> {
    const { repository } = z
      .strictObject({ repository: z.string().trim().min(1).max(2048) })
      .parse(request)
    const source = normalizeSkillSource(repository)
    return this.mutate((sources) =>
      sources.some((item) => item.id === source.id) ? sources : [...sources, source]
    )
  }

  remove(request: RemoveSkillSourceRequest): Promise<SavedSkillSource[]> {
    const { id } = z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request)
    return this.mutate((sources) => sources.filter((source) => source.id !== id))
  }

  private mutate(
    update: (sources: SavedSkillSource[]) => SavedSkillSource[]
  ): Promise<SavedSkillSource[]> {
    const run = this.queue.then(async () => {
      const document = documentSchema.parse({ version: 1, sources: update(await this.list()) })
      await writeDurableJsonFile(this.path, JSON.stringify(document, null, 2) + '\n')
      return document.sources
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
