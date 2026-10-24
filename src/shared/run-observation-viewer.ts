import type { RunObservationTarget } from './run-observation'

export type OpenRunObservationViewer = {
  target: RunObservationTarget
  allowInteraction?: boolean
  allowCancel?: boolean
  allowCapture?: boolean
  allowRecording?: boolean
}
export type RunObservationViewerAccess = {
  viewerId: string
  target: RunObservationTarget
  expiresAt: number
  url: string
}
export type RunObservationViewerReference = { viewerId: string }

export type OpenRecordedObservationViewer = {
  target: import('./run-observation-recorded').RecordedObservationTarget
  format?: import('./run-observation-recorded').RecordedEvidenceFormat
}
export type RecordedObservationViewerAccess = {
  mode: 'recorded'
  format?: import('./run-observation-recorded').RecordedEvidenceFormat
  viewerId: string
  target: import('./run-observation-recorded').RecordedObservationTarget
  expiresAt: number
  url: string
}
