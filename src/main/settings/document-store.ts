import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sanitizeSettings } from './document-codec'
import { createEmptySettings, type StoredSettings } from './types'

const SETTINGS_FILE = 'settings.json'

// Owns the complete settings.json transaction: fresh read, serialized mutation, atomic publish and
// queue recovery. Callers sharing this instance cannot overwrite one another with stale snapshots.
class SettingsDocumentStore {
  private mutationTail: Promise<void> = Promise.resolve()
  private writeSequence = 0

  constructor(private readonly storageDir: string) {}

  private get path(): string {
    return join(this.storageDir, SETTINGS_FILE)
  }

  async read(): Promise<StoredSettings> {
    try {
      return sanitizeSettings(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch {
      return createEmptySettings()
    }
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
    await mkdir(this.storageDir, { recursive: true })
    const temporaryPath = `${this.path}.${Date.now()}-${++this.writeSequence}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.path)
  }
}

export { SettingsDocumentStore }
