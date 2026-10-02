import type { Annotation } from '../../../../shared/annotations'
import type { SessionReadingBinding } from '../../../../shared/session-reading'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import type { SessionDiscussionCapture } from './replay/replay-context'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'

// Called at Send/Enqueue, never from playback. The copy also freezes evidence while awaiting I/O.
export const captureDiscussionSendContext = (
  annotations: readonly Annotation[],
  binding?: SessionReadingBinding,
  receivingSessionId?: string
): SessionDiscussionCapture | undefined => {
  const draftSource = annotations.map(replayAnnotationTarget).filter(Boolean).at(-1)
  const source = draftSource ?? (binding && { ...binding, sourceSessionId: binding.sessionId })
  const playhead = useSessionReplayStore.getState().playhead
  if (
    !source ||
    !playhead ||
    source.sourceSessionId === receivingSessionId ||
    source.projectId !== playhead.projectId ||
    source.sourceSessionId !== playhead.sourceSessionId
  )
    return undefined
  return structuredClone({ ...playhead.capture(), scope: 'step' })
}

export const prepareDiscussionSendAnnotations = async (
  annotations: Annotation[],
  focus: SessionDiscussionCapture
): Promise<Annotation[]> => {
  const id = crypto.randomUUID()
  const annotation = createSessionDiscussionAnnotation(focus, id)
  if (!annotation) throw new Error('Replay step unavailable')
  await window.api.sessionReplay.saveSelectionSnapshot({
    projectId: focus.projectId,
    sourceSessionId: focus.sourceSessionId,
    context: { ...focus, id }
  })
  return [...annotations.filter((item) => !replayAnnotationTarget(item)), annotation]
}
