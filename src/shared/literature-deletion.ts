import { z } from 'zod'

const referenceSchema = z.object({
  attachmentId: z.string(),
  versionId: z.string(),
  projectId: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  location: z.enum(['runtime-context', 'message-history']),
  messageId: z.string().optional(),
  frameId: z.string().optional(),
  branchId: z.string().optional()
})
const issueSchema = z.object({
  kind: z.enum([
    'corrupt',
    'unreadable',
    'unsupported-version',
    'too-large',
    'manifest-corrupt',
    'manifest-unreadable'
  ]),
  projectId: z.string().optional(),
  fileName: z.string(),
  recovered: z.boolean()
})
const diagnosticSchema = z.object({
  reason: z.enum(['referenced', 'scan-incomplete']),
  references: z.array(referenceSchema).max(100),
  issues: z.array(issueSchema).max(100),
  truncated: z.boolean()
})
export type LiteratureDeletionDiagnostic = z.infer<typeof diagnosticSchema>
export type LiteratureDeletionReference = z.infer<typeof referenceSchema>
const marker = '\nLITERATURE_DELETION_DETAILS:'

// Electron and Web RPC preserve Error.message, not custom Error properties. Keep the existing
// rejection contract and success receipts; carry only validated, bounded, transient diagnostics.
export function literatureDeletionError(diagnostic: LiteratureDeletionDiagnostic): Error {
  const message =
    diagnostic.reason === 'referenced'
      ? 'LITERATURE_ATTACHMENT_IN_USE'
      : 'Cannot remove an attachment without a complete Session catalog.'
  return new Error(message + marker + JSON.stringify(diagnosticSchema.parse(diagnostic)))
}

export function parseLiteratureDeletionError(
  error: unknown
): LiteratureDeletionDiagnostic | undefined {
  if (!(error instanceof Error)) return undefined
  const offset = error.message.indexOf(marker)
  if (offset >= 0) {
    try {
      return diagnosticSchema.parse(JSON.parse(error.message.slice(offset + marker.length)))
    } catch {
      // Preserve a useful reason even if a transport truncates diagnostics.
    }
  }
  const reason = error.message.includes('LITERATURE_ATTACHMENT_IN_USE')
    ? 'referenced'
    : error.message.includes('Cannot remove an attachment without a complete Session catalog.')
      ? 'scan-incomplete'
      : undefined
  return reason ? { reason, references: [], issues: [], truncated: true } : undefined
}
