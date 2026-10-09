import { callerContextForEvent, createCallerContext } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { ResearchDemoOwner } from './owner'

export function registerResearchDemoIpc(owner: ResearchDemoOwner): void {
  for (const [channel, method] of [
    ['research-demos:inspect', 'inspect'],
    ['research-demos:start', 'start'],
    ['research-demos:list', 'list'],
    ['research-demos:read-history', 'readHistory'],
    ['research-demos:read-receipt', 'readReceipt'],
    ['research-demos:get', 'get'],
    ['research-demos:stop', 'stop'],
    ['research-demos:carriers', 'carriers'],
    ['research-demos:question', 'question']
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
          throw new Error('research-demo-unauthorized')
      }
      assertCurrent()
      try {
        const result =
          method === 'question'
            ? await owner.question(
                request,
                createCallerContext({
                  ...caller,
                  isAuthorizationCurrent: () => lease.isCurrent() && !lease.signal.aborted
                })
              )
            : method === 'inspect' || method === 'start'
              ? await owner[method](request, lease.signal)
              : await owner[method](request)
        assertCurrent()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        throw new Error(
          [
            'research-demo-already-running',
            'research-demo-not-ready',
            'research-demo-request-conflict'
          ].includes(message)
            ? message
            : 'research-demo-operation-failed'
        )
      }
    })
  }
}
