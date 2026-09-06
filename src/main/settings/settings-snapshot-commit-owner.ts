import type { SettingsSnapshot } from '../../shared/settings'
import type { ApplicationEventPublisher } from '../application-events'

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
      console.warn('Settings operation completed, but snapshot publication failed.', error)
    }
    return result
  }

  readCurrentSnapshot(): Promise<SettingsSnapshot> {
    return this.enqueueCurrentSnapshot(false)
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
