import type {
  BrowserRecordingInspection,
  BrowserRecordingStatus,
  BrowserRecordingControlRequest,
  BrowserRecordingMoment,
  RecordedBrowserPayload
} from '../browser-recording'
import type {
  RecordedRunObservationSelection,
  RecordedObservationPayload,
  RecordedProjectPayload,
  RecordedObservationTarget,
  RecordedObservationFileSelection,
  RecordedFileRequest
} from '../run-observation-recorded'
import type { RunObservationSelection, RunObservationTarget } from '../run-observation'
import type { RunObservationRecordingStatus } from '../run-observation-recording-status'
import type {
  OpenRecordedObservationViewer,
  RecordedObservationViewerAccess,
  OpenRunObservationViewer,
  RunObservationViewerAccess,
  RunObservationViewerReference
} from '../run-observation-viewer'
import { callable, ELECTRON } from './definition'

// The scoped observation IPC adapter owns validation and caller leases. These are not
// ApplicationCommand router methods; marking them as such installs a second owner.
export const contracts = {
  'projectRecordings.inspect': callable<
    (request: RunObservationViewerReference) => Promise<BrowserRecordingInspection>
  >()('run-observation', ['project-recording:inspect', ELECTRON]),
  'projectRecordings.status': callable<
    (request: RunObservationViewerReference) => Promise<BrowserRecordingStatus>
  >()('run-observation', ['project-recording:status', ELECTRON]),
  'projectRecordings.read': callable<
    (request: { target: RecordedObservationTarget }) => Promise<RecordedBrowserPayload>
  >()('run-observation', ['project-recording:read', ELECTRON]),
  'projectRecordings.openRecorded': callable<
    (request: { target: RecordedObservationTarget }) => Promise<RecordedObservationViewerAccess>
  >()('run-observation', ['project-recording:openRecorded', ELECTRON]),
  'projectRecordings.selection': callable<
    (request: RunObservationViewerReference) => Promise<BrowserRecordingMoment | null>
  >()('run-observation', ['project-recording:selection', ELECTRON]),
  'projectRecordings.selectMoment': callable<
    (
      request: RunObservationViewerReference & { offsetMs: number }
    ) => Promise<BrowserRecordingMoment>
  >()('run-observation', ['project-recording:selectMoment', ELECTRON]),
  'projectRecordings.start': callable<
    (
      request: RunObservationViewerReference & { request: BrowserRecordingControlRequest }
    ) => Promise<BrowserRecordingStatus>
  >()('run-observation', ['project-recording:start', ELECTRON]),
  'projectRecordings.pause': callable<
    (
      request: RunObservationViewerReference & { request: BrowserRecordingControlRequest }
    ) => Promise<BrowserRecordingStatus>
  >()('run-observation', ['project-recording:pause', ELECTRON]),
  'projectRecordings.resume': callable<
    (
      request: RunObservationViewerReference & { request: BrowserRecordingControlRequest }
    ) => Promise<BrowserRecordingStatus>
  >()('run-observation', ['project-recording:resume', ELECTRON]),
  'projectRecordings.stop': callable<
    (
      request: RunObservationViewerReference & { request: BrowserRecordingControlRequest }
    ) => Promise<BrowserRecordingStatus>
  >()('run-observation', ['project-recording:stop', ELECTRON]),
  'observations.selectRecordingFile': callable<
    (
      request: RunObservationViewerReference & { mediaKey: string }
    ) => Promise<RecordedObservationFileSelection>
  >()('run-observation', ['run-observation:selectRecordingFile', ELECTRON]),
  'observations.recordingFileSelection': callable<
    (request: RunObservationViewerReference) => Promise<RecordedObservationFileSelection | null>
  >()('run-observation', ['run-observation:recordingFileSelection', ELECTRON]),
  'observations.readRecorded': callable<
    (request: { target: RecordedObservationTarget }) => Promise<RecordedObservationPayload>
  >()('run-observation', ['run-observation:readRecorded', ELECTRON]),
  'observations.readProjectRecording': callable<
    (request: { target: RecordedObservationTarget }) => Promise<RecordedProjectPayload>
  >()('run-observation', ['run-observation:readProjectRecording', ELECTRON]),
  'observations.selectRecordedFile': callable<
    (request: RecordedFileRequest) => Promise<RecordedObservationFileSelection>
  >()('run-observation', ['run-observation:selectRecordedFile', ELECTRON]),
  'observations.recordingStatus': callable<
    (request: { target: RunObservationTarget }) => Promise<RunObservationRecordingStatus>
  >()('run-observation', ['run-observation:recordingStatus', ELECTRON]),
  'observations.openRecorded': callable<
    (request: OpenRecordedObservationViewer) => Promise<RecordedObservationViewerAccess>
  >()('run-observation', ['run-observation:openRecorded', ELECTRON]),
  'observations.recordingSelection': callable<
    (request: RunObservationViewerReference) => Promise<RecordedRunObservationSelection | null>
  >()('run-observation', ['run-observation:recordingSelection', ELECTRON]),
  'observations.open': callable<
    (request: OpenRunObservationViewer) => Promise<RunObservationViewerAccess>
  >()('run-observation', ['run-observation:open', ELECTRON]),
  'observations.selection': callable<
    (request: RunObservationViewerReference) => Promise<RunObservationSelection | null>
  >()('run-observation', ['run-observation:selection', ELECTRON]),
  'observations.revoke': callable<(request: RunObservationViewerReference) => Promise<void>>()(
    'run-observation',
    ['run-observation:revoke', ELECTRON]
  )
} as const
