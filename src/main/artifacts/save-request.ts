import { z } from 'zod'
import { artifactLiteratureRequestSchema } from '../../shared/artifact-literature'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'

export const artifactSaveRequestSchema = z.object({
  projectId: z.string().min(1),
  appSessionId: z.string().min(1),
  artifactStorageSessionId: z.string().min(1),
  artifactRunId: z.string().min(1),
  writeOperationId: z.string().min(1),
  rootFrameId: z.string().min(1),
  agentFrameId: z.string().min(1),
  messageBranchId: z.string().min(1),
  runtimeSegmentId: z.string().min(1),
  promptMessageId: z.string().min(1),
  messageBranchAncestry: z.array(z.string()).optional(),
  messageAncestry: z.array(z.string()).optional(),
  agentName: z.string().optional(),
  notebookSessionId: z.string().optional(),
  producerRunId: z.string().min(1).optional(),
  filename: z.string().min(1),
  contentType: z.string().min(1).optional(),
  literature: artifactLiteratureRequestSchema.optional(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('localPath'), path: z.string().min(1) }),
    z.object({ kind: z.literal('inline'), content: z.string(), encoding: z.literal('base64') })
  ])
})

export const validateArtifactSaveSource = (source: unknown): void => {
  const parsed = artifactSaveRequestSchema.shape.source.parse(source)
  if (parsed.kind !== 'inline') return
  // Transport is canonical base64; validate before decoding or reserving file budget.
  const content = parsed.content
  if (
    content.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(content) ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(content)
  )
    throw new Error('Invalid Artifact inline base64 encoding.')
  const bytes =
    (content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0)
  assertWithinResourceBudget('file', bytes, LOCAL_RESOURCE_BUDGETS.artifactInlineBytes)
  if (Buffer.from(content, 'base64').toString('base64') !== content)
    throw new Error('Invalid Artifact inline base64 encoding.')
}
