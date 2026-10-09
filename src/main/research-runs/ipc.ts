import { callerContextForEvent, createCallerContext } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { ResearchRunInspectionPort } from './inspection'

export function registerResearchRunInspectionIpc(port: ResearchRunInspectionPort): void {
  ipcMainHandle('research-runs:inspect', (event, request: unknown) => {
    const lease = callerLeaseForEvent(event)
    const caller = createCallerContext({
      ...callerContextForEvent(event),
      isAuthorizationCurrent: () => lease.isCurrent() && !lease.signal.aborted
    })
    return port.inspect(request, caller, lease.signal)
  })
}
