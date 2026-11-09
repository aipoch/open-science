import { resourceRecordingContract } from '../../shared/resource-recording'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
import { resourceRecording } from '../resource-diagnostics/recording'

export const resourceRecordingCommands = {
  getState: defineApplicationCommand('resource-recording:get-state', resourceRecordingContract),
  start: defineApplicationCommand('resource-recording:start', resourceRecordingContract),
  stop: defineApplicationCommand('resource-recording:stop', resourceRecordingContract)
}
export const resourceRecordingCommandGroup = defineApplicationCommandGroup(
  'resource-recording',
  Object.values(resourceRecordingCommands)
)
export function registerResourceRecordingCommands(
  registrar: ApplicationCommandRegistrar,
  owner = resourceRecording
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  scope.registerGroup(resourceRecordingCommandGroup, {
    'resource-recording:get-state': ({ callerContext }) => {
      requireDesktopCaller(callerContext)
      return owner.getState()
    },
    'resource-recording:start': ({ callerContext }) => {
      requireDesktopCaller(callerContext)
      return owner.start()
    },
    'resource-recording:stop': ({ callerContext }) => {
      requireDesktopCaller(callerContext)
      return owner.stop()
    }
  })
  return scope.complete()
}
