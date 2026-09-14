import {
  pendingInputCommandContract,
  type PendingInputCommand,
  type PendingInputResult
} from '../shared/pending-input'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from './application-command-router'
import type { PendingInputOwner } from './pending-input-owner'
import { withDataRootWrite } from './storage/migration-state'

const execute = defineApplicationCommand<
  'pending-inputs:execute',
  readonly [PendingInputCommand],
  PendingInputResult
>('pending-inputs:execute', pendingInputCommandContract)
export const pendingInputCommandGroup = defineApplicationCommandGroup('pending-inputs', [
  execute
] as const)

export const registerPendingInputCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: Pick<PendingInputOwner, 'execute'>
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(pendingInputCommandGroup, {
      'pending-inputs:execute': ({ args, callerLease }) =>
        withDataRootWrite(() => owner.execute(args[0], callerLease))
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
