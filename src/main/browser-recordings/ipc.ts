import { callerContextForEvent, createCallerContext } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import {
  BROWSER_RECORDING_EXTERNAL_METHODS,
  type BrowserRecordingExternalPort
} from './external-port'

export function registerBrowserRecordingIpc(port: BrowserRecordingExternalPort): void {
  for (const method of BROWSER_RECORDING_EXTERNAL_METHODS) {
    ipcMainHandle(`project-recording:${method}`, (event, request: unknown) => {
      const lease = callerLeaseForEvent(event)
      return port.call(
        method,
        request,
        createCallerContext({
          ...callerContextForEvent(event),
          isAuthorizationCurrent: () => lease.isCurrent() && !lease.signal.aborted
        })
      )
    })
  }
}
