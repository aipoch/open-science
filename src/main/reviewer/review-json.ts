import { z } from 'zod'
import type { ReviewerLogEntry, TurnScope } from '../../shared/reviewer'

const scopeSchema = z.object({
  turnMessageId: z.string(),
  agentFrameId: z.string().optional(),
  messageBranchId: z.string().optional(),
  blocks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['message', 'activity']),
      sourceId: z.string(),
      blockIndex: z.number().int().nonnegative(),
      contentHash: z.string()
    })
  ),
  artifactVersionIds: z.array(z.string()),
  sourceDocumentVersionIds: z.array(z.string()).optional()
})
const textLog = z.object({
  kind: z.enum(['thought', 'message']),
  text: z.string(),
  textTruncated: z.boolean().optional(),
  reviewLogTruncated: z.boolean().optional()
})
const toolLog = z.object({
  kind: z.literal('tool'),
  toolName: z.string(),
  title: z.string().optional(),
  rawInput: z.string().optional(),
  rawOutput: z.string().optional(),
  rawInputTruncated: z.boolean().optional(),
  rawOutputTruncated: z.boolean().optional(),
  reviewLogTruncated: z.boolean().optional(),
  evidenceKind: z.literal('media').optional(),
  status: z.enum(['ok', 'error']).optional(),
  exitCode: z.number().nullable().optional()
})
const logSchema = z.array(z.union([textLog, toolLog]))

const decode = <T>(json: string, schema: z.ZodType<T>): T | undefined => {
  try {
    const parsed = schema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const decodeReviewScope = (json: string): TurnScope | undefined => decode(json, scopeSchema)
export const decodeReviewLog = (json: string): ReviewerLogEntry[] | undefined =>
  decode(json, logSchema)

// Writes must never treat an unreadable historical scope as an empty, valid scope.
export const requireReviewScope = (json: string): TurnScope => {
  const scope = decodeReviewScope(json)
  if (!scope) throw new Error('Stored Review scope is invalid.')
  return scope
}
