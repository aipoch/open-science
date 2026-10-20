import { ApplicationCommandError } from '../../shared/application-command-contract'
import { CredentialIdentityError } from '../credential-identity/selection'
import { startDiagnosticOperation } from '@aipoch/diagnostics/node'
import type { SettingsSnapshot } from '../../shared/settings'
import type { ApplicationEventPublisher } from '../application-events'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

const log = createLogger('settings')

type SettingsSnapshotStore = {
  getSettingsView(): Promise<SettingsSnapshot>
}

class SettingsSnapshotCommitOwner {
  private tail = Promise.resolve()
  private revision = 0

  constructor(
    private readonly settings: SettingsSnapshotStore,
    private readonly events: ApplicationEventPublisher
  ) {}

  async currentSnapshotAfter(pending: Promise<unknown>): Promise<SettingsSnapshot> {
    await pending
    return this.enqueueCurrentSnapshot(true)
  }

  async projectAfter<Result>(pending: Promise<Result>): Promise<Result> {
    const result = await pending
    try {
      await this.enqueueCurrentSnapshot(true)
    } catch (error) {
      // The operation has already committed. A projection failure cannot undo it or turn
      // its authoritative result into a failed save. Explicit snapshot reads remain retryable.
      log.warn(
        'Settings operation completed, but snapshot publication failed.',
        diagnosticErrorFields(error)
      )
    }
    return result
  }

  async readCurrentSnapshot(): Promise<SettingsSnapshot> {
    const operation = startDiagnosticOperation(log, { operation: 'settings-snapshot-read' })
    try {
      const snapshot = await this.enqueueCurrentSnapshot(false)
      operation.complete({ revision: snapshot.revision })
      return snapshot
    } catch (error) {
      operation.fail(error)
      if (error instanceof ApplicationCommandError) throw error
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      throw new ApplicationCommandError(
        error instanceof CredentialIdentityError
          ? 'settings-credential-unavailable'
          : ['EACCES', 'EPERM', 'EIO', 'ENOENT', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE'].includes(
                String(code)
              )
            ? 'settings-storage-unavailable'
            : error instanceof Error && error.name === 'SettingsDocumentReadError'
              ? 'settings-invalid'
              : 'command-failed',
        'Open-Science could not load settings. Retry to continue.'
      )
    }
  }

  private enqueueCurrentSnapshot(publish: boolean): Promise<SettingsSnapshot> {
    const current = this.tail.then(async () => {
      const snapshot = await this.settings.getSettingsView()
      if (publish) this.revision += 1
      snapshot.revision = this.revision
      if (publish) this.events.publish('settings:changed', snapshot)
      return snapshot
    })
    this.tail = current.then(
      () => undefined,
      () => undefined
    )
    return current
  }
}

export { SettingsSnapshotCommitOwner }
export type { SettingsSnapshotStore }
