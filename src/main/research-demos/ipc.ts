import { createCallerContext } from '../caller-context'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandHandlers,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar,
  type ApplicationInvocation
} from '../application-command-router'
import type { ResearchDemoOwner } from './owner'

const methods = [
  ['research-demos:inspect', 'inspect'],
  ['research-demos:start', 'start'],
  ['research-demos:list', 'list'],
  ['research-demos:read-history', 'readHistory'],
  ['research-demos:read-receipt', 'readReceipt'],
  ['research-demos:get', 'get'],
  ['research-demos:stop', 'stop'],
  ['research-demos:carriers', 'carriers'],
  ['research-demos:question', 'question']
] as const
type Channel = (typeof methods)[number][0]
export const researchDemoCommandGroup = defineApplicationCommandGroup(
  'research-demos',
  methods.map(([channel]) =>
    defineApplicationCommand<Channel, readonly unknown[], unknown>(channel)
  )
)
export function createResearchDemoHandlers(
  owner: ResearchDemoOwner
): ApplicationCommandHandlers<typeof researchDemoCommandGroup.commands> {
  return Object.fromEntries(
    methods.map(([channel, method]) => [
      channel,
      async ({
        callerContext: caller,
        callerLease: lease,
        args
      }: ApplicationInvocation<readonly unknown[]>) => {
        const request = args[0]
        const assertCurrent = (): void => {
          if (
            caller.location !== 'local' ||
            caller.surface !== 'electron' ||
            !caller.isAuthorizationCurrent() ||
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
                    isAuthorizationCurrent: () =>
                      caller.isAuthorizationCurrent() && lease.isCurrent() && !lease.signal.aborted
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
      }
    ])
  ) as ApplicationCommandHandlers<typeof researchDemoCommandGroup.commands>
}
export function registerResearchDemoCommands(
  registrar: ApplicationCommandRegistrar,
  owner: ResearchDemoOwner
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(researchDemoCommandGroup, createResearchDemoHandlers(owner))
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
