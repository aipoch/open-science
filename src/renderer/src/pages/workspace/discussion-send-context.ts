import type { ComposerSessionContext } from './composer-contract'
import type { Annotation } from '../../../../shared/annotation-contract'
import { replayAnnotationTarget } from '../../../../shared/replay-reference'

// Older child discussions could unlink reading while retaining the sidebar parent. Reuse
// the saved message reference to restore that same parent on the next turn.
export function discussionDraftAnnotations(
  session: ComposerSessionContext | null | undefined,
  annotations: Annotation[]
): Annotation[] {
  if (session?.deletedDiscussionSourceId)
    return annotations.filter((item) => {
      const target = replayAnnotationTarget(item)
      return !(
        target?.sourceSessionId === session.deletedDiscussionSourceId &&
        target?.projectId === session.projectId
      )
    })
  if (!session?.parentSessionId) return annotations
  const belongsToParent = (item: Annotation): boolean => {
    const target = replayAnnotationTarget(item)
    return (
      target?.projectId === session.projectId && target?.sourceSessionId === session.parentSessionId
    )
  }
  const retained = annotations.filter(
    (item) => !replayAnnotationTarget(item) || belongsToParent(item)
  )
  if (
    retained.some(belongsToParent) ||
    session.runtimeContext?.sessionContext?.bindings.some(
      (binding) =>
        binding.projectId === session.projectId && binding.sessionId === session.parentSessionId
    )
  )
    return retained
  const messages = session.messages?.length
    ? session.messages
    : (session.conversationGraph?.messages ?? [])
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const saved = message.role === 'user' && message.annotations?.find(belongsToParent)
    if (saved) return [...retained, saved]
  }
  return retained
}
