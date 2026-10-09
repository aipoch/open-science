import { callerContextForEvent, createCallerContext } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { RunObservationExternalPort } from '../run-observation-external-port'

export function registerRunObservationIpc(port: RunObservationExternalPort): void {
  for (const method of [
    'open',
    'openRecorded',
    'readRecorded',
    'readProjectRecording',
    'selectRecordedFile',
    'selectRecordingFile',
    'recordingFileSelection',
    'selection',
    'recordingSelection',
    'recordingStatus',
    'revoke'
  ] as const) {
    ipcMainHandle(`run-observation:${method}`, (event, request: unknown) => {
      const lease = callerLeaseForEvent(event)
      const caller = createCallerContext({
        ...callerContextForEvent(event),
        isAuthorizationCurrent: () => lease.isCurrent() && !lease.signal.aborted
      })
      return port.call(method, request, caller)
    })
  }
}
