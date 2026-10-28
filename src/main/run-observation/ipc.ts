import { createCallerContext } from '../caller-context'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandHandlers,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation,
  type ApplicationInvocation
} from '../application-command-router'
import type { RunObservationExternalPort } from '../run-observation-external-port'

const methods = [
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
] as const
export const runObservationCommandGroup = defineApplicationCommandGroup(
  'run-observation',
  methods.map((method) =>
    defineApplicationCommand<`run-observation:${typeof method}`, readonly unknown[], unknown>(
      `run-observation:${method}`
    )
  )
)

export function createRunObservationHandlers(
  port: RunObservationExternalPort
): ApplicationCommandHandlers<typeof runObservationCommandGroup.commands> {
  return Object.fromEntries(
    methods.map((method) => [
      `run-observation:${method}`,
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
  ) as ApplicationCommandHandlers<typeof runObservationCommandGroup.commands>
}

export function registerRunObservationCommands(
  registrar: ApplicationCommandRegistrar,
  port: RunObservationExternalPort
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(runObservationCommandGroup, createRunObservationHandlers(port))
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
