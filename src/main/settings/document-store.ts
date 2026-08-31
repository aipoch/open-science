import { join } from 'node:path'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import { sanitizeSettings } from './document-codec'
import { createEmptySettings, type StoredSettings } from './types'
import { isRecord } from '../value-guards'

const SETTINGS_FILE = 'settings.json'

class UnsupportedSettingsDocumentVersionError extends DurableJsonRecoveryBarrierError {
  constructor(version: number) {
    super(
      `Settings document version ${version} is newer than supported version ${SETTINGS_FILE_VERSION}.`
    )
  }
}

const migrateSettingsDocument = (value: unknown): StoredSettings | undefined => {
  if (!isRecord(value)) return undefined
  let migrated = value
  while (migrated.version !== SETTINGS_FILE_VERSION) {
    switch (migrated.version) {
      case 1:
        migrated = { ...migrated, version: 2 }
        break
      default:
        return undefined
    }
  }
  return sanitizeSettings(migrated)
}

const decodeSettingsDocument = (contents: string): StoredSettings => {
  const value: unknown = JSON.parse(contents)
  const version = isRecord(value) ? value.version : undefined
  if (Number.isSafeInteger(version) && Number(version) > SETTINGS_FILE_VERSION) {
    throw new UnsupportedSettingsDocumentVersionError(Number(version))
  }
  const migrated = migrateSettingsDocument(value)
  if (!migrated) throw new Error('Settings document is corrupt.')
  return migrated
}

// Owns the complete settings.json transaction: fresh read, serialized mutation, atomic publish and
// queue recovery. Callers sharing this instance cannot overwrite one another with stale snapshots.
class SettingsDocumentStore {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly storageDir: string) {}

  private get path(): string {
    return join(this.storageDir, SETTINGS_FILE)
  }

  async read(): Promise<StoredSettings> {
    const result = await readDurableJsonFile(this.path, decodeSettingsDocument)
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
