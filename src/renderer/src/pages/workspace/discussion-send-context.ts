import { toSessionDiscussionSnapshot } from './replay/replay-context'
import type { Annotation } from '../../../../shared/annotations'
import type { SessionDiscussionCapture } from './replay/replay-context'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'

// Older queued messages may carry a send-time capture. New messages retain the immutable
// annotation saved by Ask; a legacy capture must never replace that explicit selection.
export const prepareDiscussionSendAnnotations = async (
  annotations: Annotation[],
  focus: SessionDiscussionCapture
): Promise<Annotation[]> => {
  if (annotations.some(replayAnnotationTarget)) return annotations
  const frozen = structuredClone(focus)
  const id = crypto.randomUUID()
  const annotation = createSessionDiscussionAnnotation(frozen, id)
  if (!annotation) throw new Error('Replay step unavailable')
  await window.api.sessionReplay.saveSelectionSnapshot({
    projectId: frozen.projectId,
    sourceSessionId: frozen.sourceSessionId,
    context: toSessionDiscussionSnapshot(frozen, id)
  })
  return [...annotations, annotation]
}
