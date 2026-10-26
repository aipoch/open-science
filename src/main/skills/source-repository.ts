import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseGitHubRepo } from '@aipoch/skills/sources'
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

const invalidSource = (): Error => new Error('Enter a GitHub repository URL or owner/repo@ref.')
const sourceId = (repository: string, ref?: string): string =>
  createHash('sha256')
    .update(JSON.stringify([repository, ref ?? null]))
    .digest('hex')

export function normalizeSkillSource(input: string): SavedSkillSource {
  const value = input.trim()
  if (value.includes('://')) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw invalidSource()
    }
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1)
    // A subtree URL is ambiguous with slash-containing refs. Use owner/repo@ref for those.
    if (
      url.protocol !== 'https:' ||
      url.host !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(parts.length === 2 || (parts.length === 4 && parts[2] === 'tree'))
    )
      throw invalidSource()
  }
  const parsed = parseGitHubRepo(value)
  if (
    !parsed ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(parsed.owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(parsed.repo) ||
    ['.', '..'].includes(parsed.repo) ||
    (parsed.ref !== undefined &&
      (!parsed.ref ||
        parsed.ref.length > 255 ||
        // eslint-disable-next-line no-control-regex -- Git refs cannot contain ASCII controls.
        /[\s\x00-\x1f\x7f~^:?*[\\]/.test(parsed.ref) ||
        parsed.ref.includes('..') ||
        parsed.ref.includes('@{') ||
        parsed.ref.startsWith('/') ||
        parsed.ref.endsWith('/') ||
        parsed.ref
          .split('/')
          .some(
            (part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')
          )))
  )
    throw invalidSource()
  const repository = `${parsed.owner}/${parsed.repo}`.toLowerCase()
  return {
    id: sourceId(repository, parsed.ref),
    repository,
    ...(parsed.ref ? { ref: parsed.ref } : {})
  }
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
