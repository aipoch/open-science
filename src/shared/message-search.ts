import { z } from 'zod'

export const messageSearchRequestSchema = z
  .object({
    projectIds: z.array(z.string().min(1)).max(10000),
    excludedSessionIds: z.array(z.string().min(1)).optional(),
    query: z.string().max(1000),
    updatedAfter: z.number().int().nonnegative().optional(),
    role: z.enum(['user', 'agent']).optional(),
    sort: z.enum(['relevance', 'recent']).optional(),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative().optional()
  })
  .strict()
export type MessageSearchRequest = z.infer<typeof messageSearchRequestSchema>
export type MessageSearchItem = {
  projectId: string
  sessionId: string
  sessionTitle: string
  sessionNumber: number
  messageId: string
  role: 'user' | 'agent'
  content: string
  title?: string
  createdAt: number
}
export type MessageSearchPage = {
  items: MessageSearchItem[]
  totalCount: number
  nextOffset?: number
  isComplete: boolean
}
