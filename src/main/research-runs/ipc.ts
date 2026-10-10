import { createCallerContext } from '../caller-context'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandHandlers,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { ResearchRunInspectionPort } from './inspection'

export const researchRunCommandGroup = defineApplicationCommandGroup('research-runs', [
  defineApplicationCommand<'research-runs:inspect', readonly unknown[], unknown>(
    'research-runs:inspect'
  )
])

export function createResearchRunHandlers(
  port: ResearchRunInspectionPort
): ApplicationCommandHandlers<typeof researchRunCommandGroup.commands> {
  return {
    'research-runs:inspect': ({ callerContext, callerLease: lease, args }) => {
      const caller = createCallerContext({
        ...callerContext,
        isAuthorizationCurrent: () =>
          callerContext.isAuthorizationCurrent() && lease.isCurrent() && !lease.signal.aborted
      })
      return port.inspect(args[0], caller, lease.signal)
    }
  }
}

export function registerResearchRunCommands(
  registrar: ApplicationCommandRegistrar,
  port: ResearchRunInspectionPort
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(researchRunCommandGroup, createResearchRunHandlers(port))
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
