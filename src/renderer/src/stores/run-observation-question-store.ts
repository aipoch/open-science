import type { BrowserRecordingMoment } from '../../../shared/browser-recording'
import { create } from 'zustand'
import type { RunObservationSelection } from '../../../shared/run-observation'
import type {
  RecordedRunObservationSelection,
  RecordedObservationFileSelection
} from '../../../shared/run-observation-recorded'
import type { ResearchDemoQuestion } from '../../../shared/research-demo'

export type ObservationQuestionDestination = {
  projectId: string
  sessionId?: string
  draftKey: string
}
export type ObservationQuestionSelection =
  | RunObservationSelection
  | RecordedRunObservationSelection
  | RecordedObservationFileSelection
  | BrowserRecordingMoment
type PendingQuestion = {
  destination: ObservationQuestionDestination
  selection: ObservationQuestionSelection
  demo?: Pick<ResearchDemoQuestion, 'source' | 'requestId' | 'purpose'>
  /** A guarded navigation can finish before its composer mounts. Never retain that intent
   * after another navigation has replaced the destination. */
  isCurrent?: () => boolean
}

export const sameObservationQuestionDestination = (
  left: ObservationQuestionDestination | undefined,
  right: ObservationQuestionDestination | undefined
): boolean =>
  Boolean(
    left &&
    right &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.draftKey === right.draftKey
  )

const acceptsSelection = (
  destination: ObservationQuestionDestination | undefined,
  selection: ObservationQuestionSelection
): boolean =>
  Boolean(
    destination &&
    ('snapshot' in selection
      ? destination.projectId === selection.identity.projectId &&
        destination.sessionId === selection.identity.sessionId
      : destination.projectId === selection.receiving.projectId)
  )

// A transient handoff to the existing composer. It never creates a Session or discussion link.
export const useRunObservationQuestionStore = create<{
  destination?: ObservationQuestionDestination
  pending?: PendingQuestion
  /** Published only after the active composer has actually accepted the frozen evidence. */
  lastAdded?: PendingQuestion
  ask(selection: RunObservationSelection): boolean
  askDemo(
    question: ResearchDemoQuestion,
    expectedDestination: ObservationQuestionDestination
  ): boolean
  askRecorded(
    selection:
      RecordedRunObservationSelection | RecordedObservationFileSelection | BrowserRecordingMoment,
    demo?: PendingQuestion['demo']
  ): boolean
  recover(
    selection: ObservationQuestionSelection,
    destination: ObservationQuestionDestination,
    isCurrent: () => boolean,
    demo?: PendingQuestion['demo']
  ): boolean
}>((set, get) => ({
  askDemo: (question, expectedDestination) => {
    const destination = get().destination
    if (
      !destination ||
      !sameObservationQuestionDestination(destination, expectedDestination) ||
      question.purpose !== 'offline-demo' ||
      question.destination.projectId !== destination.projectId ||
      question.destination.sessionId !== destination.sessionId ||
      question.source.projectId !== destination.projectId ||
      question.selection.identity.projectId !== destination.projectId
    )
      return false
    // This separate path accepts only the Main-validated demo handoff. Ordinary live evidence
    // keeps its exact-session admission above; the original carrier identity is never rewritten.
    set({
      pending: {
        destination: { ...destination },
        selection: structuredClone(question.selection),
        demo: {
          source: { ...question.source },
          requestId: question.requestId,
          purpose: question.purpose
        }
      }
    })
    return true
  },
  recover: (selection, destination, isCurrent, demo) => {
    if (
      !isCurrent() ||
      !acceptsSelection(destination, selection) ||
      (demo &&
        ('snapshot' in selection ||
          demo.purpose !== 'offline-demo' ||
          demo.source.projectId !== destination.projectId))
    )
      return false
    if (
      selection.selectionId &&
      [get().pending, get().lastAdded].some(
        (previous) =>
          previous &&
          previous.selection.selectionId === selection.selectionId &&
          sameObservationQuestionDestination(previous.destination, destination)
      )
    )
      return true
    set({
      pending: {
        destination: { ...destination },
        selection: structuredClone(selection),
        isCurrent,
        ...(demo ? { demo: structuredClone(demo) } : {})
      }
    })
    return true
  },
  askRecorded: (selection, demo) => {
    const destination = get().destination
    if (
      !destination ||
      !acceptsSelection(destination, selection) ||
      (demo &&
        (demo.purpose !== 'offline-demo' ||
          demo.source.projectId !== selection.receiving.projectId))
    )
      return false
    set({
      pending: {
        destination: { ...destination },
        selection: structuredClone(selection),
        ...(demo ? { demo: structuredClone(demo) } : {})
      }
    })
    return true
  },
  ask: (selection) => {
    const destination = get().destination
    if (!destination || !acceptsSelection(destination, selection)) return false
    set({ pending: { destination: { ...destination }, selection: structuredClone(selection) } })
    return true
  }
}))
