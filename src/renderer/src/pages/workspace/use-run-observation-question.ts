import { useEffect, useLayoutEffect } from 'react'
import {
  sameObservationQuestionDestination,
  useRunObservationQuestionStore
} from '@/stores/run-observation-question-store'
import { observationQuestionText } from './replay/observation-question'
import { requestComposerFocus } from './composer-focus-events'

export const useRunObservationQuestion = ({
  projectId,
  sessionId,
  draftKey,
  editable,
  appendText
}: {
  projectId?: string
  sessionId?: string
  draftKey: string
  editable: boolean
  appendText(draftKey: string, text: string): boolean
}): void => {
  const pending = useRunObservationQuestionStore((state) => state.pending)
  useLayoutEffect(() => {
    const destination = editable && projectId ? { projectId, sessionId, draftKey } : undefined
    const pending = useRunObservationQuestionStore.getState().pending
    useRunObservationQuestionStore.setState({
      destination,
      lastAdded: undefined,
      pending:
        sameObservationQuestionDestination(pending?.destination, destination) &&
        pending?.isCurrent?.() !== false
          ? pending
          : undefined
    })
    return () => {
      const state = useRunObservationQuestionStore.getState()
      if (state.destination === destination)
        useRunObservationQuestionStore.setState({
          destination: undefined,
          // A navigation continuation may already have staged the next draft's evidence.
          pending:
            sameObservationQuestionDestination(state.pending?.destination, destination) ||
            state.pending?.isCurrent?.() === false
              ? undefined
              : state.pending,
          lastAdded: undefined
        })
    }
  }, [projectId, sessionId, draftKey, editable])
  useEffect(() => {
    if (!pending || useRunObservationQuestionStore.getState().pending !== pending) return
    if (
      !editable ||
      pending.destination.projectId !== projectId ||
      pending.destination.sessionId !== sessionId ||
      pending.destination.draftKey !== draftKey
    )
      return
    useRunObservationQuestionStore.setState({ pending: undefined })
    if (pending.isCurrent?.() === false) return
    if (!appendText(draftKey, observationQuestionText(pending.selection, pending.demo))) return
    useRunObservationQuestionStore.setState({ lastAdded: pending })
    requestComposerFocus()
  }, [pending, projectId, sessionId, draftKey, editable, appendText])
}
