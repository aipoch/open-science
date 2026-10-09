import { callerContextForEvent } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { ManagedExecutionService } from '../notebook/managed-execution-service'

export function registerResearchExecutionProfileIpc(
  service: Pick<
    ManagedExecutionService,
    | 'preflight'
    | 'saveExecutionProfile'
    | 'removeExecutionProfile'
    | 'pendingConfigurations'
    | 'resolveConfiguration'
  >
): void {
  for (const [channel, method] of [
    ['research-execution-profiles:pending', 'pendingConfigurations'],
    ['research-execution-profiles:resolve', 'resolveConfiguration'],
    ['research-execution-profiles:inspect', 'preflight'],
    ['research-execution-profiles:save', 'saveExecutionProfile'],
    ['research-execution-profiles:remove', 'removeExecutionProfile']
  ] as const) {
    ipcMainHandle(channel, async (event, request: unknown) => {
      const caller = callerContextForEvent(event)
      const lease = callerLeaseForEvent(event)
      const assertCurrent = (): void => {
        if (
          caller.location !== 'local' ||
          caller.surface !== 'electron' ||
          !lease.isCurrent() ||
          lease.signal.aborted
        )
          throw new Error('research-profile-unauthorized')
      }
      assertCurrent()
      try {
        const result =
          method === 'pendingConfigurations'
            ? await service.pendingConfigurations()
            : await service[method](request, lease.signal)
        assertCurrent()
        return result
      } catch {
        // Do not include a payload or schema parser error: the request may contain secrets.
        throw new Error('research-profile-operation-failed')
      }
    })
  }
}
