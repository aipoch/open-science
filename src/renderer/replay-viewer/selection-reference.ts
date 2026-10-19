import type { RunObservationSelection } from '../../shared/run-observation'

export const selectionReference = (viewerId: string, selection: RunObservationSelection): string =>
  JSON.stringify(
    {
      kind: 'open-science-run-observation',
      viewerId,
      selectionId: selection.selectionId,
      runId: selection.identity.runId,
      stepId: selection.stepId,
      cursor: selection.cursor
    },
    null,
    2
  )

export const recordedSelectionReference = (
  viewerId: string,
  selection:
    | import('../../shared/run-observation-recorded').RecordedRunObservationSelection
    | import('../../shared/run-observation-recorded').RecordedObservationFileSelection
): string =>
  JSON.stringify(
    {
      kind:
        selection.kind === 'recorded-observation-file'
          ? 'open-science-recorded-file'
          : 'open-science-recorded-observation',
      selectionId: selection.selectionId,
      viewerId,
      receiving: selection.receiving,
      recordingId: selection.recordingId,
      ...(selection.kind === 'recorded-observation-file'
        ? { mediaKey: selection.mediaKey, resource: selection.resource }
        : { stepKey: selection.stepKey })
    },
    null,
    2
  )
