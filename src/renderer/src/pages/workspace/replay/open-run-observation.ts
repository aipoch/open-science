import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { RunObservationTarget } from '../../../../../shared/run-observation'
export const showRunObservation = (target: RunObservationTarget, title: string): void => {
  usePreviewWorkbenchStore.getState().upsertAndActivateItem({
    id: `tool:${target.sessionId}:replay-run:${target.runId ?? target.executionInvocationId ?? target.operationId}`,
    type: 'tool',
    toolKind: 'replay',
    projectId: target.projectId,
    sessionId: target.sessionId,
    title,
    replayRunTarget: { ...target }
  })
}

export const showRecordedObservation = (
  target: import('../../../../../shared/run-observation-recorded').RecordedObservationTarget,
  title: string,
  format?: 'run-observation' | 'project-recording' | 'web-recording'
): void => {
  usePreviewWorkbenchStore.getState().upsertAndActivateItem({
    id: `tool:${target.sessionId}:replay-recording:${target.artifactId}:${target.versionId}`,
    type: 'tool',
    toolKind: 'replay',
    projectId: target.projectId,
    sessionId: target.sessionId,
    title,
    replayRecordingTarget: { ...target },
    ...(format ? { replayRecordingFormat: format } : {})
  })
}
