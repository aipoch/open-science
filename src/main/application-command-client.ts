import type { ApplicationCommandByNameDispatcher } from './application-command-composition-contract'
import type { CallerContext, CallerSurface } from './caller-context'
import { runtimePayloadTransfers } from './runtime-payload-transfers'
import type { RuntimePayloadOptions } from '../shared/runtime-payload-transfer'
import {
  ApplicationCallerLeaseRegistry,
  callerLeaseOwnershipKeyForContext
} from './caller-lifecycle'

type ActiveCaller = Readonly<{
  clientId: string
  surface: CallerSurface
  lease: ReturnType<ApplicationCallerLeaseRegistry['acquire']>
}>

type ApplicationCommandClient = Readonly<{
  invoke: (
    dispatcher: ApplicationCommandByNameDispatcher,
    commandName: string,
    callerContext: CallerContext,
    args: readonly unknown[],
    payloadOptions?: RuntimePayloadOptions
  ) => Promise<unknown>
  releaseClient: (surface: CallerSurface, clientId: string) => void
  dispose: () => void
}>

const createApplicationCommandClient = (): ApplicationCommandClient => {
  const registry = new ApplicationCallerLeaseRegistry()
  const callers = new Map<string, ActiveCaller>()
  let disposed = false

  const callerFor = (callerContext: CallerContext): ActiveCaller => {
    if (disposed) throw new Error('Application command client is disposed.')
    const key = callerLeaseOwnershipKeyForContext(callerContext)
    const existing = callers.get(key)
    if (existing?.lease.lease.isCurrent()) return existing

    const caller = Object.freeze({
      clientId: callerContext.clientId,
      surface: callerContext.surface,
      lease: registry.acquire(callerContext)
    })
    callers.set(key, caller)
    return caller
  }

  return Object.freeze({
    invoke: async (dispatcher, commandName, callerContext, args, payloadOptions = {}) => {
      const caller = callerFor(callerContext)
      const dispatch = (arguments_: readonly unknown[]): Promise<unknown> =>
        dispatcher.invoke(commandName, {
          callerContext,
          callerLease: caller.lease.lease,
          args: arguments_
        })
      if (payloadOptions.acceptPayload !== 1 && !payloadOptions.transfer) return dispatch(args)
      return runtimePayloadTransfers.invoke(
        commandName,
        args,
        callerContext,
        caller.lease.lease,
        payloadOptions,
        dispatch
      )
    },
    releaseClient: (surface, clientId): void => {
      for (const [key, caller] of callers) {
        if (caller.surface !== surface || caller.clientId !== clientId) continue
        callers.delete(key)
        caller.lease.release()
      }
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      callers.clear()
      registry.dispose()
    }
  })
}

export { createApplicationCommandClient }
export type { ApplicationCommandClient }
