import { renameSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import { sanitizeSettings } from './document-codec'
import { createEmptySettings, type StoredSettings } from './types'
import { isRecord } from '../value-guards'
import { SETTINGS_RESOURCE_LIMITS } from './settings-resource-limits'

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
  // A damaged pointer must never sanitize to an unset pointer and start a second empty workspace.
  if (
    isRecord(value) &&
    value.dataRoot !== undefined &&
    (typeof value.dataRoot !== 'string' || !isAbsolute(value.dataRoot) || !value.dataRoot.trim())
  ) {
    throw new DurableJsonRecoveryBarrierError(
      'The saved data location (dataRoot) is invalid. Restore its absolute path before restarting.'
    )
  }
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
    try {
      const result = await readDurableJsonFile(
        this.path,
        decodeSettingsDocument,
        {},
        { maxBytes: SETTINGS_RESOURCE_LIMITS.documentBytes }
      )
      return result.status === 'found' ? result.value : createEmptySettings()
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      const error = new Error(
        `Cannot read application configuration: ${this.path}\n${reason}\nRestore this file from a verified backup, correct its dataRoot or access permissions, or use an application version that supports it, then restart. Preserve the original file and recovery files; no new configuration or data was initialized.`,
        { cause }
      )
      error.name = 'SettingsDocumentReadError'
      throw Object.assign(error, { path: this.path })
    }
  }

  mutate(
    update: (settings: StoredSettings) => StoredSettings,
    beforePublish?: () => void
  ): Promise<StoredSettings> {
    const result = this.mutationTail.then(async () => {
      const next = update(await this.read())
      await this.write(next, beforePublish)
      return next
    })
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async write(settings: StoredSettings, beforePublish?: () => void): Promise<void> {
    const contents = `${JSON.stringify(settings, null, 2)}\n`
    if (Buffer.byteLength(contents, 'utf8') > SETTINGS_RESOURCE_LIMITS.documentBytes) {
      throw new Error(
        `Settings document exceeds the ${SETTINGS_RESOURCE_LIMITS.documentBytes} byte limit.`
      )
    }
    await writeDurableJsonFile(
      this.path,
      contents,
      beforePublish
        ? {
            // Run after queueing, reading, staging and fsync, on every replacement retry. No JS await
            // separates the target guard from the atomic rename; aborted writes remove their temp file.
            rename: async (source, destination) => {
              beforePublish()
              renameSync(source, destination)
            }
          }
        : {}
    )
  }
}

export { SettingsDocumentStore }
