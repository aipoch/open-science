import { z } from 'zod'
import { saveResearchExecutionProfileRequestSchema } from '../../shared/research-execution-profile'

// Pure codec: startup credential inventory must validate the original document before loading
// the store or binding Electron's cipher. Keep both readers on the same unchanged v1 schema.
export const storedResearchExecutionProfileSchema = saveResearchExecutionProfileRequestSchema
  .omit({ sessionId: true, credentials: true })
  .extend({
    profileId: z.string().uuid(),
    credentialRefs: z.record(
      z.string(),
      z
        .string()
        .min(1)
        .max(64 * 1024)
    ),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
export const researchExecutionProfileDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(storedResearchExecutionProfileSchema).max(128)
  })
  .strict()
