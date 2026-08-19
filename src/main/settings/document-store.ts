import { join } from 'node:path'

import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'
import { sanitizeSettings } from './document-codec'
import { createEmptySettings, type StoredSettings } from './types'

const SETTINGS_FILE = 'settings.json'

// Owns the complete settings.json transaction: fresh read, serialized mutation, atomic publish and
// queue recovery. Callers sharing this instance cannot overwrite one another with stale snapshots.
class SettingsDocumentStore {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly storageDir: string) {}

  private get path(): string {
    return join(this.storageDir, SETTINGS_FILE)
  }

  async read(): Promise<StoredSettings> {
    const result = await readDurableJsonFile(this.path, (contents) =>
      sanitizeSettings(JSON.parse(contents) as unknown)
    )
    return result.status === 'found' ? result.value : createEmptySettings()
  }

  mutate(update: (settings: StoredSettings) => StoredSettings): Promise<StoredSettings> {
    const result = this.mutationTail.then(async () => {
      const next = update(await this.read())
      await this.write(next)
      return next
    })
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async write(settings: StoredSettings): Promise<void> {
    await writeDurableJsonFile(this.path, `${JSON.stringify(settings, null, 2)}\n`)
  }
}

export { SettingsDocumentStore }
