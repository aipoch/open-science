export * from '@aipoch/pdf-translation/contracts'
import { z } from 'zod'
import {
  pdfTranslationAgentModelSchema as packageAgentModelSchema,
  type PdfTranslationBeginRequest as PackageBeginRequest
} from '@aipoch/pdf-translation/contracts'

// Application-supported frameworks are host policy. The standalone package accepts adapter IDs.
export const pdfTranslationAgentModelSchema = packageAgentModelSchema.extend({
  frameworkId: z.enum(['claude-code', 'opencode', 'codex', 'codebuddy'])
})
export type PdfTranslationAgentModel = Readonly<z.infer<typeof pdfTranslationAgentModelSchema>>
export type PdfTranslationBeginRequest = Omit<PackageBeginRequest, 'agentModel'> & {
  readonly agentModel?: PdfTranslationAgentModel
}
