import type {
  PermissionGrantDefaultsRestoreView,
  PermissionGrantMutationView,
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantSnapshot,
  PermissionGrantUndoExtendRequest,
  PermissionGrantUndoReceipt
} from '../../shared/permission-grants'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { PermissionGrantProjection } from './projection-controller'

// Composition injects one projection owner. Command registration deliberately does not subscribe,
// publish permissions:changed, or dispose the owner, so Electron and application adapters cannot
// create competing revision controllers.
const permissionGrantApplicationCommands = Object.freeze({
  list: defineApplicationCommand<'permissions:list', readonly [], PermissionGrantSnapshot>(
    'permissions:list'
  ),
  restoreDefaults: defineApplicationCommand<
    'permissions:restore-defaults',
    readonly [],
    PermissionGrantDefaultsRestoreView
  >('permissions:restore-defaults'),
  revoke: defineApplicationCommand<
    'permissions:revoke',
    readonly [request: PermissionGrantRevokeRequest],
    PermissionGrantMutationView
  >('permissions:revoke'),
  extendUndo: defineApplicationCommand<
    'permissions:extend-undo',
    readonly [request: PermissionGrantUndoExtendRequest],
    PermissionGrantUndoReceipt | undefined
  >('permissions:extend-undo'),
  restore: defineApplicationCommand<
    'permissions:restore',
    readonly [request: PermissionGrantRestoreRequest],
    PermissionGrantMutationView
  >('permissions:restore')
})

const permissionGrantApplicationCommandGroup = defineApplicationCommandGroup('permission-grants', [
  permissionGrantApplicationCommands.extendUndo,
  permissionGrantApplicationCommands.list,
  permissionGrantApplicationCommands.restoreDefaults,
  permissionGrantApplicationCommands.restore,
  permissionGrantApplicationCommands.revoke
] as const)

const registerPermissionGrantApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: PermissionGrantProjection
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(permissionGrantApplicationCommandGroup, {
      'permissions:list': () => owner.list(),
      'permissions:restore-defaults': () => owner.restoreDefaults(),
      'permissions:revoke': ({ args }) => owner.revoke(args[0]),
      'permissions:extend-undo': ({ args }) => owner.extendUndo(args[0]),
      'permissions:restore': ({ args }) => owner.restore(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  permissionGrantApplicationCommandGroup,
  permissionGrantApplicationCommands,
  registerPermissionGrantApplicationCommands
}
