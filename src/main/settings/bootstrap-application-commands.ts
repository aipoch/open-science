import type { BootstrapRequest, BootstrapResult } from '../../shared/bootstrap'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from '../application-command-router'
import type { SettingsService } from './service'
import type { ClaudeInstallEvent } from '../../shared/settings'
import type { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'

const bootstrapCommand = defineApplicationCommand<
  'settings:bootstrap',
  readonly [BootstrapRequest],
  BootstrapResult
>('settings:bootstrap')
export const bootstrapApplicationCommandGroup = defineApplicationCommandGroup(
  'settings-bootstrap',
  [bootstrapCommand] as const
)

export const registerBootstrapApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: {
    service: Pick<SettingsService, 'bootstrap'>
    emitInstallEvent: (event: ClaudeInstallEvent) => void
    snapshotCommits: SettingsSnapshotCommitOwner
  }
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(bootstrapApplicationCommandGroup, {
      'settings:bootstrap': ({ args, callerContext }) => {
        if (callerContext.location !== 'local') return { ok: false, code: 'invalid_request' }
        const pending = dependencies.service.bootstrap(args[0], dependencies.emitInstallEvent)
        return args[0]?.action === 'status'
          ? pending
          : dependencies.snapshotCommits.projectAfter(pending)
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
