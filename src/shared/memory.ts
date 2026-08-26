import { z } from 'zod'

import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

export const ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY = 'about-you' as const
export const ABOUT_YOU_MEMORY_CATEGORY_ID = 'memory-category-about-you' as const
export const MEMORY_SETTINGS_ID = 'memory-settings' as const
export const MEMORY_CUSTOM_CATEGORY_LIMIT = 10
export const MEMORY_CATEGORY_NAME_MAX_LENGTH = 64
export const MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH = 1_000
export const MEMORY_ENTRY_MAX_LENGTH = 4_000
export const MEMORY_AGENT_SEARCH_LIMIT = 20
export const MEMORY_SEARCH_CANDIDATE_LIMIT = 200
export const MEMORY_SEARCH_TERM_LIMIT = 24
export const MEMORY_AUTO_RECALL_CONTENT_LIMIT = 6_000
export const MEMORY_ANALYSIS_SUBJECT_MAX_LENGTH = 128
export const MEMORY_ANALYSIS_REASON_MAX_LENGTH = 1_000

const memoryEntryViewSchema = z
  .object({
    id: z.string().min(1),
    categoryId: z.string().min(1).nullable(),
    categoryName: z.string().min(1).nullable(),
    projectId: z.string().min(1).nullable(),
    projectName: z.string().min(1).nullable(),
    content: z.string().min(1).max(MEMORY_ENTRY_MAX_LENGTH),
    origin: z.enum(['user', 'agent']),
    revision: z.number().int().positive(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
  })
  .strict()

const memoryCategoryBaseSchema = z.object({
  id: z.string().min(1),
  autoRecall: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  entries: z.array(memoryEntryViewSchema)
})

const aboutYouMemoryCategoryViewSchema = memoryCategoryBaseSchema
  .extend({
    id: z.literal(ABOUT_YOU_MEMORY_CATEGORY_ID),
    systemKey: z.literal(ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY),
    autoRecall: z.literal(true)
  })
  .strict()

const customMemoryCategoryViewSchema = memoryCategoryBaseSchema
  .extend({
    name: z.string().min(1).max(MEMORY_CATEGORY_NAME_MAX_LENGTH),
    guidance: z.string().max(MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH)
  })
  .strict()

export const memoryCategoryViewSchema = z.union([
  aboutYouMemoryCategoryViewSchema,
  customMemoryCategoryViewSchema
])
export const memoryProjectViewSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    archived: z.boolean(),
    entries: z.array(memoryEntryViewSchema)
  })
  .strict()
export const memorySnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    categories: z.array(memoryCategoryViewSchema),
    projects: z.array(memoryProjectViewSchema)
  })
  .strict()

export const createMemoryCategoryRequestSchema = z
  .object({
    name: z.string().max(MEMORY_CATEGORY_NAME_MAX_LENGTH),
    guidance: z.string().max(MEMORY_CATEGORY_GUIDANCE_MAX_LENGTH),
    autoRecall: z.boolean()
  })
  .strict()
export const updateMemoryCategoryRequestSchema = createMemoryCategoryRequestSchema
  .extend({ id: z.string().min(1), expectedRevision: z.number().int().positive() })
  .strict()
export const deleteMemoryCategoryRequestSchema = z
  .object({ id: z.string().min(1), expectedRevision: z.number().int().positive() })
  .strict()
export const createMemoryEntryRequestSchema = z
  .object({
    categoryId: z.string().min(1).nullable().optional(),
    projectId: z.string().min(1).optional(),
    content: z.string().trim().min(1).max(MEMORY_ENTRY_MAX_LENGTH)
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.categoryId && !request.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'A category or project is required.'
      })
    }
  })
export const updateMemoryEntryRequestSchema = z
  .object({
    id: z.string().min(1),
    content: z.string().max(MEMORY_ENTRY_MAX_LENGTH),
    expectedRevision: z.number().int().positive()
  })
  .strict()
export const deleteMemoryEntryRequestSchema = z
  .object({ id: z.string().min(1), expectedRevision: z.number().int().positive() })
  .strict()
export const setMemoryEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict()

export const memoryAgentSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(MEMORY_ENTRY_MAX_LENGTH),
    categoryIds: z
      .array(z.string().min(1))
      .max(MEMORY_CUSTOM_CATEGORY_LIMIT + 1)
      .optional(),
    limit: z.number().int().min(1).max(MEMORY_AGENT_SEARCH_LIMIT).default(10)
  })
  .strict()
const memoryAgentAnalysisSchema = z
  .object({
    scope: z.literal('project'),
    durability: z.literal('cross-session'),
    evidence: z.enum(['user-stated', 'project-observed']),
    subject: z.string().trim().min(1).max(MEMORY_ANALYSIS_SUBJECT_MAX_LENGTH),
    reason: z.string().trim().min(1).max(MEMORY_ANALYSIS_REASON_MAX_LENGTH),
    categoryReason: z.string().trim().min(1).max(MEMORY_ANALYSIS_REASON_MAX_LENGTH).optional()
  })
  .strict()
export const memoryAgentRememberRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(MEMORY_ENTRY_MAX_LENGTH),
    categoryId: z.string().min(1).optional(),
    analysis: memoryAgentAnalysisSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (request.categoryId && !request.analysis.categoryReason) {
      context.addIssue({
        code: 'custom',
        path: ['analysis', 'categoryReason'],
        message: 'A category reason is required when a category is selected.'
      })
    }
    if (!request.categoryId && request.analysis.categoryReason) {
      context.addIssue({
        code: 'custom',
        path: ['analysis', 'categoryReason'],
        message: 'A category reason requires a selected category.'
      })
    }
  })
const memoryAgentProvenanceSchema = z.discriminatedUnion('origin', [
  z.object({ origin: z.literal('user') }).strict(),
  z.object({ origin: z.literal('agent'), agentId: z.string().min(1).optional() }).strict()
])
export const memoryAgentResultSchema = z
  .object({
    id: z.string().min(1),
    categoryId: z.string().min(1).nullable(),
    categoryName: z.string().min(1).nullable(),
    scope: z.enum(['global', 'project']),
    content: z.string().min(1).max(MEMORY_ENTRY_MAX_LENGTH),
    revision: z.number().int().positive(),
    provenance: memoryAgentProvenanceSchema,
    updatedAt: z.number().finite()
  })
  .strict()
const memoryAgentRememberSuccessSchema = z
  .object({
    status: z.enum(['created', 'existing']),
    memory: memoryAgentResultSchema
  })
  .strict()
const memoryAgentRememberRejectedSchema = z
  .object({
    status: z.literal('rejected'),
    retryable: z.literal(false),
    code: z.string().min(1).max(64),
    reason: z.string().min(1).max(MEMORY_ANALYSIS_REASON_MAX_LENGTH)
  })
  .strict()
export const memoryAgentRememberResultSchema = z.discriminatedUnion('status', [
  memoryAgentRememberSuccessSchema,
  memoryAgentRememberRejectedSchema
])

export type MemoryEntryView = z.infer<typeof memoryEntryViewSchema>
export type MemoryCategoryView = z.infer<typeof memoryCategoryViewSchema>
export type MemoryProjectView = z.infer<typeof memoryProjectViewSchema>
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>
export type CreateMemoryCategoryRequest = z.infer<typeof createMemoryCategoryRequestSchema>
export type UpdateMemoryCategoryRequest = z.infer<typeof updateMemoryCategoryRequestSchema>
export type DeleteMemoryCategoryRequest = z.infer<typeof deleteMemoryCategoryRequestSchema>
export type CreateMemoryEntryRequest = z.infer<typeof createMemoryEntryRequestSchema>
export type UpdateMemoryEntryRequest = z.infer<typeof updateMemoryEntryRequestSchema>
export type DeleteMemoryEntryRequest = z.infer<typeof deleteMemoryEntryRequestSchema>
export type SetMemoryEnabledRequest = z.infer<typeof setMemoryEnabledRequestSchema>
export type MemoryAgentSearchRequest = z.infer<typeof memoryAgentSearchRequestSchema>
export type MemoryAgentRememberRequest = z.infer<typeof memoryAgentRememberRequestSchema>
export type MemoryAgentResult = z.infer<typeof memoryAgentResultSchema>
export type MemoryAgentRememberResult = z.infer<typeof memoryAgentRememberResultSchema>
export type MemoryChangedEvent = Readonly<{ revision: number }>
export type MemoryAgentContext = Readonly<{
  projectId: string
  sessionId: string
  agentId?: string
  turnId?: string
}>

const snapshotResult = validationCodec(memorySnapshotSchema)
export const memoryApplicationCommandContracts = Object.freeze({
  snapshot: defineApplicationCommandContract(validationCodec(z.tuple([])), snapshotResult),
  setEnabled: defineApplicationCommandContract(
    validationCodec(z.tuple([setMemoryEnabledRequestSchema])),
    snapshotResult
  ),
  createCategory: defineApplicationCommandContract(
    validationCodec(z.tuple([createMemoryCategoryRequestSchema])),
    snapshotResult
  ),
  updateCategory: defineApplicationCommandContract(
    validationCodec(z.tuple([updateMemoryCategoryRequestSchema])),
    snapshotResult
  ),
  deleteCategory: defineApplicationCommandContract(
    validationCodec(z.tuple([deleteMemoryCategoryRequestSchema])),
    snapshotResult
  ),
  createEntry: defineApplicationCommandContract(
    validationCodec(z.tuple([createMemoryEntryRequestSchema])),
    snapshotResult
  ),
  updateEntry: defineApplicationCommandContract(
    validationCodec(z.tuple([updateMemoryEntryRequestSchema])),
    snapshotResult
  ),
  deleteEntry: defineApplicationCommandContract(
    validationCodec(z.tuple([deleteMemoryEntryRequestSchema])),
    snapshotResult
  ),
  clearAll: defineApplicationCommandContract(validationCodec(z.tuple([])), snapshotResult)
})
