import { createCallerContext } from '../caller-context'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandHandlers,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation,
  type ApplicationInvocation
} from '../application-command-router'
import type { BrowserRecordingExternalPort } from './external-port'
import { BROWSER_RECORDING_EXTERNAL_METHODS } from './external-port'

const methods = BROWSER_RECORDING_EXTERNAL_METHODS
export const browserRecordingCommandGroup = defineApplicationCommandGroup(
  'project-recording',
  methods.map((method) =>
    defineApplicationCommand<`project-recording:${typeof method}`, readonly unknown[], unknown>(
      `project-recording:${method}`
    )
  )
)

export function createBrowserRecordingHandlers(
  port: BrowserRecordingExternalPort
): ApplicationCommandHandlers<typeof browserRecordingCommandGroup.commands> {
  return Object.fromEntries(
    methods.map((method) => [
      `project-recording:${method}`,
      async (invocation: ApplicationInvocation<readonly unknown[]>): Promise<unknown> => {
        const { callerContext, callerLease, args } = invocation
        const caller = createCallerContext({
          ...callerContext,
          isAuthorizationCurrent: () =>
            callerContext.isAuthorizationCurrent() &&
            callerLease.isCurrent() &&
            !callerLease.signal.aborted
        })
        if (!caller.isAuthorizationCurrent())
          throw new Error('Observation caller authorization ended.')
        const result = await port.call(method, args[0], caller)
        if (!caller.isAuthorizationCurrent())
          throw new Error('Observation caller authorization ended.')
        return result
      }
    ])
  ) as ApplicationCommandHandlers<typeof browserRecordingCommandGroup.commands>
}

export function registerBrowserRecordingCommands(
  registrar: ApplicationCommandRegistrar,
  port: BrowserRecordingExternalPort
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(browserRecordingCommandGroup, createBrowserRecordingHandlers(port))
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
