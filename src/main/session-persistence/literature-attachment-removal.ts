import {
  literatureDeletionError,
  type LiteratureDeletionReference
} from '../../shared/literature-deletion'
import type { PersistedChatSession, SessionLoadWarning } from '../../shared/session-persistence'

// Called synchronously inside the Catalog transaction with its actual cascade targets. The
// coordinator holds the session barrier from this scan through the transaction's completion.
export function assertLiteratureAttachmentsUnreferenced(
  scan: {
    isComplete: boolean
    result: { sessions: PersistedChatSession[] }
    warnings?: SessionLoadWarning[]
  },
  attachmentIds: readonly string[]
): void {
  if (!attachmentIds.length) return
  if (!scan.isComplete)
    throw literatureDeletionError({
      reason: 'scan-incomplete',
      references: [],
      issues: (scan.warnings ?? []).slice(0, 100),
      truncated: (scan.warnings?.length ?? 0) > 100
    })
  const ids = new Set(attachmentIds)
  const references: LiteratureDeletionReference[] = []
  let truncated = false
  for (const session of scan.result.sessions) {
    const locations = [
      { location: 'runtime-context' as const, context: session.runtimeContext?.pdfContext },
      // The graph includes inactive branches; the messages projection does not.
      ...(session.conversationGraph?.messages ?? session.messages).map((message) => ({
        location: 'message-history' as const,
        context: message.pdfContext,
        messageId: message.id,
        ...('agentFrameId' in message ? { frameId: message.agentFrameId as string } : {}),
        ...('introducedOnBranchId' in message
          ? { branchId: message.introducedOnBranchId as string }
          : {})
      }))
    ]
    for (const { context, ...location } of locations)
      for (const binding of context?.bindings ?? []) {
        if (
          binding.sourceKind !== 'literature-attachment-version' ||
          !ids.has(binding.sourceFileId)
        )
          continue
        if (references.length === 100) {
          truncated = true
          continue
        }
        references.push({
          ...location,
          projectId: session.projectId,
          sessionId: session.id,
          sessionTitle: session.title,
          attachmentId: binding.sourceFileId,
          versionId: binding.sourceVersionId
        })
      }
  }
  if (references.length)
    throw literatureDeletionError({ reason: 'referenced', references, issues: [], truncated })
}
