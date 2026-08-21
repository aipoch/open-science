import {
  Prisma,
  type MemoryCategory as PrismaMemoryCategory,
  type MemoryEntry as PrismaMemoryEntry,
  type PrismaClient
} from '@prisma/client'

import {
  ABOUT_YOU_MEMORY_CATEGORY_ID,
  ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY,
  MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH,
  MEMORY_CATEGORY_NAME_MAX_LENGTH,
  MEMORY_CUSTOM_CATEGORY_LIMIT,
  MEMORY_ENTRY_MAX_LENGTH,
  MEMORY_SEARCH_CANDIDATE_LIMIT,
  MEMORY_SETTINGS_ID,
  type CreateMemoryCategoryRequest,
  type DeleteMemoryCategoryRequest,
  type DeleteMemoryEntryRequest,
  type MemoryAgentContext,
  type MemoryCategoryView,
  type MemoryEntryView,
  type MemorySnapshot,
  type SetMemoryEnabledRequest,
  type UpdateMemoryCategoryRequest,
  type UpdateMemoryEntryRequest
} from '../../shared/memory'
import { migrationSqlExecutor } from '../database/migration-sql-executor'

type MemoryClientProvider = () => Promise<PrismaClient>
type MemoryCategoryWithEntries = PrismaMemoryCategory & { entries: PrismaMemoryEntry[] }
type MemorySearchCandidate = PrismaMemoryEntry & {
  category: Pick<PrismaMemoryCategory, 'id' | 'name' | 'systemKey'>
}
type MemorySearchRow = Omit<PrismaMemoryEntry, 'createdAt' | 'updatedAt'> & {
  createdAt: Date | string
  updatedAt: Date | string
  categoryName: string | null
  categorySystemKey: string | null
}

const cleanMemoryCategoryName = (input: string): string =>
  input.normalize('NFKC').trim().replace(/\s+/gu, ' ')
const memoryCategoryNameKey = (input: string): string =>
  cleanMemoryCategoryName(input).toLowerCase()
const cleanMemoryContent = (input: string): string => input.normalize('NFKC').trim()
const memoryContentKey = (input: string): string => cleanMemoryContent(input).toLowerCase()

const validateMemoryContent = (input: string): { content: string; contentKey: string } => {
  const content = cleanMemoryContent(input)
  const contentKey = memoryContentKey(content)
  if (!content) throw new Error('Memory note is required.')
  if (content.length > MEMORY_ENTRY_MAX_LENGTH || contentKey.length > MEMORY_ENTRY_MAX_LENGTH) {
    throw new Error('Memory note is too long.')
  }
  return { content, contentKey }
}

const validateMemoryCategory = (
  request: CreateMemoryCategoryRequest
): { name: string; nameKey: string; guidance: string } => {
  const name = cleanMemoryCategoryName(request.name)
  const nameKey = memoryCategoryNameKey(name)
  const guidance = request.guidance.trim()
  if (!name) throw new Error('Memory category name is required.')
  if (
    name.length > MEMORY_CATEGORY_NAME_MAX_LENGTH ||
    nameKey.length > MEMORY_CATEGORY_NAME_MAX_LENGTH
  ) {
    throw new Error('Memory category name is too long.')
  }
  if (guidance.length > MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH) {
    throw new Error('Memory category guidance is too long.')
  }
  return { name, nameKey, guidance }
}

const toEntryView = (row: PrismaMemoryEntry): MemoryEntryView => ({
  id: row.id,
  content: row.content,
  origin: row.origin as 'user' | 'agent',
  revision: row.revision,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

const toCategoryView = (row: MemoryCategoryWithEntries): MemoryCategoryView => {
  const base = {
    id: row.id,
    autoRecall: row.autoRecall,
    revision: row.revision,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    entries: row.entries.map(toEntryView)
  }
  if (row.systemKey === ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY) {
    return {
      ...base,
      id: ABOUT_YOU_MEMORY_CATEGORY_ID,
      systemKey: ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY,
      autoRecall: true
    }
  }
  if (!row.name) throw new Error(`Memory category ${row.id} has an invalid persisted shape.`)
  return { ...base, name: row.name, guidance: row.guidance }
}

const duplicateCategoryNameError = (error: unknown): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new Error('A memory category with this name already exists.')
  }
  throw error
}

class MemoryRepository {
  constructor(private readonly getClient: MemoryClientProvider) {}

  private async mutate(
    operation: (client: Prisma.TransactionClient) => Promise<void>
  ): Promise<void> {
    const client = await this.getClient()
    await client.$transaction(async (transaction) => {
      await this.enableSecureDelete(transaction)
      await operation(transaction)
      await transaction.memorySettings.update({
        where: { id: MEMORY_SETTINGS_ID },
        data: { revision: { increment: 1 } }
      })
    })
  }

  private async enableSecureDelete(client: PrismaClient | Prisma.TransactionClient): Promise<void> {
    await migrationSqlExecutor.query(client, 'PRAGMA secure_delete = ON')
  }

  async snapshot(): Promise<MemorySnapshot> {
    const client = await this.getClient()
    await this.enableSecureDelete(client)
    const [settings, categories] = await Promise.all([
      client.memorySettings.findUniqueOrThrow({ where: { id: MEMORY_SETTINGS_ID } }),
      client.memoryCategory.findMany({
        include: { entries: { orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] } },
        orderBy: [{ systemKey: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }]
      })
    ])
    return {
      revision: settings.revision,
      enabled: settings.enabled,
      categories: categories.map(toCategoryView)
    }
  }

  async isEnabled(): Promise<boolean> {
    const client = await this.getClient()
    await this.enableSecureDelete(client)
    return (await client.memorySettings.findUniqueOrThrow({ where: { id: MEMORY_SETTINGS_ID } }))
      .enabled
  }

  setEnabled(request: SetMemoryEnabledRequest): Promise<void> {
    return this.mutate(async (client) => {
      await client.memorySettings.update({
        where: { id: MEMORY_SETTINGS_ID },
        data: { enabled: request.enabled }
      })
    })
  }

  createCategory(request: CreateMemoryCategoryRequest): Promise<void> {
    const { name, nameKey, guidance } = validateMemoryCategory(request)
    return this.mutate(async (client) => {
      const count = await client.memoryCategory.count({ where: { systemKey: null } })
      if (count >= MEMORY_CUSTOM_CATEGORY_LIMIT) {
        throw new Error(`You can create up to ${MEMORY_CUSTOM_CATEGORY_LIMIT} memory categories.`)
      }
      try {
        await client.memoryCategory.create({
          data: {
            name,
            nameKey,
            guidance,
            autoRecall: request.autoRecall
          }
        })
      } catch (error) {
        duplicateCategoryNameError(error)
      }
    })
  }

  updateCategory(request: UpdateMemoryCategoryRequest): Promise<void> {
    const { name, nameKey, guidance } = validateMemoryCategory(request)
    return this.mutate(async (client) => {
      const current = await client.memoryCategory.findUnique({ where: { id: request.id } })
      if (!current) throw new Error('Memory category not found.')
      if (current.systemKey) throw new Error('The About you category cannot be edited.')
      try {
        const result = await client.memoryCategory.updateMany({
          where: { id: request.id, revision: request.expectedRevision, systemKey: null },
          data: {
            name,
            nameKey,
            guidance,
            autoRecall: request.autoRecall,
            revision: { increment: 1 }
          }
        })
        if (result.count === 0) throw new Error('Memory category changed. Refresh and try again.')
      } catch (error) {
        duplicateCategoryNameError(error)
      }
    })
  }

  deleteCategory(request: DeleteMemoryCategoryRequest): Promise<void> {
    return this.mutate(async (client) => {
      const current = await client.memoryCategory.findUnique({ where: { id: request.id } })
      if (!current) throw new Error('Memory category not found.')
      if (current.systemKey) throw new Error('The About you category cannot be deleted.')
      const result = await client.memoryCategory.deleteMany({
        where: { id: request.id, revision: request.expectedRevision, systemKey: null }
      })
      if (result.count === 0) throw new Error('Memory category changed. Refresh and try again.')
    })
  }

  createEntry(categoryId: string, contentInput: string): Promise<void> {
    const { content, contentKey } = validateMemoryContent(contentInput)
    return this.mutate(async (client) => {
      const category = await client.memoryCategory.findUnique({ where: { id: categoryId } })
      if (!category) throw new Error('Memory category not found.')
      await client.memoryEntry.create({
        data: {
          categoryId,
          content,
          contentKey,
          origin: 'user'
        }
      })
    })
  }

  async rememberEntry(
    categoryId: string,
    contentInput: string,
    context: MemoryAgentContext
  ): Promise<{ candidate: MemorySearchCandidate; changed: boolean }> {
    const { content, contentKey } = validateMemoryContent(contentInput)
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      await this.enableSecureDelete(transaction)
      const settings = await transaction.memorySettings.findUniqueOrThrow({
        where: { id: MEMORY_SETTINGS_ID }
      })
      if (!settings.enabled) throw new Error('Memory is turned off.')
      const category = await transaction.memoryCategory.findUnique({ where: { id: categoryId } })
      if (!category) throw new Error('Memory category not found.')
      const existing = await transaction.memoryEntry.findFirst({
        where: { categoryId, contentKey },
        include: { category: { select: { id: true, name: true, systemKey: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
      if (existing) return { candidate: existing, changed: false }
      const candidate = await transaction.memoryEntry.create({
        data: {
          categoryId,
          content,
          contentKey,
          origin: 'agent',
          sourceSessionId: context.sessionId,
          sourceAgentId: context.agentId
        },
        include: { category: { select: { id: true, name: true, systemKey: true } } }
      })
      await transaction.memorySettings.update({
        where: { id: MEMORY_SETTINGS_ID },
        data: { revision: { increment: 1 } }
      })
      return { candidate, changed: true }
    })
  }

  updateEntry(request: UpdateMemoryEntryRequest): Promise<void> {
    const { content, contentKey } = validateMemoryContent(request.content)
    return this.mutate(async (client) => {
      const result = await client.memoryEntry.updateMany({
        where: { id: request.id, revision: request.expectedRevision },
        data: { content, contentKey, revision: { increment: 1 } }
      })
      if (result.count === 0) throw new Error('Memory note changed or no longer exists.')
    })
  }

  deleteEntry(request: DeleteMemoryEntryRequest): Promise<void> {
    return this.mutate(async (client) => {
      const result = await client.memoryEntry.deleteMany({
        where: { id: request.id, revision: request.expectedRevision }
      })
      if (result.count === 0) throw new Error('Memory note changed or no longer exists.')
    })
  }

  clearAll(): Promise<void> {
    return this.mutate(async (client) => {
      await client.memoryEntry.deleteMany()
      await client.memoryCategory.deleteMany({ where: { systemKey: null } })
    })
  }

  async recentAutoRecallCandidates(): Promise<MemorySearchCandidate[]> {
    const client = await this.getClient()
    await this.enableSecureDelete(client)
    return client.memoryEntry.findMany({
      where: { category: { autoRecall: true } },
      include: { category: { select: { id: true, name: true, systemKey: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: MEMORY_SEARCH_CANDIDATE_LIMIT
    })
  }

  async searchCandidates(input: {
    categoryIds?: readonly string[]
    autoRecallOnly: boolean
    terms: readonly string[]
  }): Promise<MemorySearchCandidate[]> {
    if (input.categoryIds?.length === 0 || input.terms.length === 0) return []
    const client = await this.getClient()
    await this.enableSecureDelete(client)
    const indexedTerms = input.terms.filter((term) => Array.from(term).length >= 3)
    const shortTerms = input.terms.filter((term) => Array.from(term).length < 3)
    const findSubstringCandidates = (
      terms: readonly string[],
      take: number,
      excludeTerms: readonly string[] = []
    ): Promise<MemorySearchCandidate[]> =>
      client.memoryEntry.findMany({
        where: {
          categoryId: input.categoryIds ? { in: [...input.categoryIds] } : undefined,
          category: input.autoRecallOnly ? { autoRecall: true } : undefined,
          OR: terms.map((term) => ({ contentKey: { contains: term } })),
          NOT:
            excludeTerms.length > 0
              ? { OR: excludeTerms.map((term) => ({ contentKey: { contains: term } })) }
              : undefined
        },
        include: { category: { select: { id: true, name: true, systemKey: true } } },
        orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }],
        take
      })
    if (indexedTerms.length === 0) {
      return findSubstringCandidates(input.terms, MEMORY_SEARCH_CANDIDATE_LIMIT)
    }

    const indexedCandidateLimit =
      shortTerms.length === 0
        ? MEMORY_SEARCH_CANDIDATE_LIMIT
        : Math.ceil(MEMORY_SEARCH_CANDIDATE_LIMIT / 2)

    const where: string[] = ['"MemoryEntryFts" MATCH ?']
    const values: unknown[] = [
      indexedTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    ]
    if (input.categoryIds) {
      where.push(`e."categoryId" IN (${input.categoryIds.map(() => '?').join(', ')})`)
      values.push(...input.categoryIds)
    }
    if (input.autoRecallOnly) where.push('c."autoRecall" = true')
    values.push(indexedCandidateLimit)
    const rows = await migrationSqlExecutor.query<MemorySearchRow[]>(
      client,
      `SELECT e."id", e."categoryId", e."content", e."contentKey", e."origin",
              e."sourceSessionId", e."sourceAgentId", e."revision", e."createdAt", e."updatedAt",
              c."name" AS "categoryName", c."systemKey" AS "categorySystemKey"
       FROM "MemoryEntryFts"
       JOIN "MemoryEntry" e ON e."rowid" = "MemoryEntryFts"."rowid"
       JOIN "MemoryCategory" c ON c."id" = e."categoryId"
       WHERE ${where.join(' AND ')}
       ORDER BY bm25("MemoryEntryFts"), e."updatedAt" DESC, e."id" ASC
       LIMIT ?`,
      ...values
    )
    const indexedCandidates = rows.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      content: row.content,
      contentKey: row.contentKey,
      origin: row.origin,
      sourceSessionId: row.sourceSessionId,
      sourceAgentId: row.sourceAgentId,
      revision: Number(row.revision),
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
      category: {
        id: row.categoryId,
        name: row.categoryName,
        systemKey: row.categorySystemKey
      }
    }))
    if (shortTerms.length === 0) return indexedCandidates
    const seen = new Set(indexedCandidates.map(({ id }) => id))
    const substringCandidates = await findSubstringCandidates(
      shortTerms,
      MEMORY_SEARCH_CANDIDATE_LIMIT - indexedCandidateLimit,
      indexedTerms
    )
    const merged: MemorySearchCandidate[] = []
    const branchLength = Math.max(indexedCandidates.length, substringCandidates.length)
    for (let index = 0; index < branchLength; index += 1) {
      const indexed = indexedCandidates[index]
      if (indexed) merged.push(indexed)
      const substring = substringCandidates[index]
      if (substring && !seen.has(substring.id)) merged.push(substring)
    }
    return merged.slice(0, MEMORY_SEARCH_CANDIDATE_LIMIT)
  }
}

export { MemoryRepository, cleanMemoryCategoryName, memoryCategoryNameKey, memoryContentKey }
export type { MemorySearchCandidate }
