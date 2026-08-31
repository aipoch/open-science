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
    await this.enqueueCurrentSnapshot(true)
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
