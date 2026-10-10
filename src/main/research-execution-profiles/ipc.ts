import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandHandlers,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar,
  type ApplicationInvocation
} from '../application-command-router'
import type { ManagedExecutionService } from '../notebook/managed-execution-service'

export type ResearchExecutionProfileCommands = Pick<
  ManagedExecutionService,
  | 'preflight'
  | 'saveExecutionProfile'
  | 'removeExecutionProfile'
  | 'pendingConfigurations'
  | 'resolveConfiguration'
>

const methods = {
  'research-execution-profiles:pending': 'pendingConfigurations',
  'research-execution-profiles:resolve': 'resolveConfiguration',
  'research-execution-profiles:inspect': 'preflight',
  'research-execution-profiles:save': 'saveExecutionProfile',
  'research-execution-profiles:remove': 'removeExecutionProfile'
} as const

type ProfileChannel = keyof typeof methods
export const researchExecutionProfileCommandGroup = defineApplicationCommandGroup(
  'research-execution-profiles',
  (Object.keys(methods) as ProfileChannel[]).map((channel) =>
    defineApplicationCommand<ProfileChannel, readonly unknown[], unknown>(channel)
  )
)

// The owner runs in Node. Only a live local desktop document may write private configuration;
// the authenticated local automation API remains limited to public configuration requests.
export function createResearchExecutionProfileHandlers(
  service: ResearchExecutionProfileCommands
): ApplicationCommandHandlers<typeof researchExecutionProfileCommandGroup.commands> {
  const invoke = async (
    method: (typeof methods)[ProfileChannel],
    { callerContext: caller, callerLease: lease, args }: ApplicationInvocation<readonly unknown[]>
  ): Promise<unknown> => {
    const assertCurrent = (): void => {
      if (
        caller.location !== 'local' ||
        caller.surface !== 'electron' ||
        !caller.isAuthorizationCurrent() ||
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
          : await service[method](args[0], lease.signal)
      assertCurrent()
      return result
    } catch {
      // Neither diagnostics nor replies may include schema errors carrying credential values.
      throw new Error('research-profile-operation-failed')
    }
  }
  return Object.fromEntries(
    Object.entries(methods).map(([channel, method]) => [
      channel,
      (invocation: ApplicationInvocation<readonly unknown[]>) => invoke(method, invocation)
    ])
  ) as ApplicationCommandHandlers<typeof researchExecutionProfileCommandGroup.commands>
}

export function registerResearchExecutionProfileCommands(
  registrar: ApplicationCommandRegistrar,
  service: ResearchExecutionProfileCommands
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(
      researchExecutionProfileCommandGroup,
      createResearchExecutionProfileHandlers(service)
    )
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
