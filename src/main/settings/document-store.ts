import { validateSettingsDocumentShape } from './document-shape'
import { settingsDocumentReadError } from './document-read-error'
import {
  assertCredentialAccessAllowed,
  credentialAccessInstalled
} from '../credential-identity/runtime'
import { renameSync } from 'node:fs'
import { join } from 'node:path'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import {
  readDurableJsonFile,
  readFileWithinLimit,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import { sanitizeSettings } from './document-codec'
import { createEmptySettings, type StoredSettings } from './types'
import { isRecord } from '../value-guards'
import { SETTINGS_RESOURCE_LIMITS } from './settings-resource-limits'

const SETTINGS_FILE = 'settings.json'

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
  validateSettingsDocumentShape(value)
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
    assertCredentialAccessAllowed()
    try {
      const result = await readDurableJsonFile(
        this.path,
        decodeSettingsDocument,
        {},
        { maxBytes: SETTINGS_RESOURCE_LIMITS.documentBytes }
      )
      return result.status === 'found' ? result.value : createEmptySettings()
    } catch (cause) {
      throw settingsDocumentReadError(this.path, cause)
    }
  }

  mutate(
    update: (settings: StoredSettings) => StoredSettings,
    beforePublish?: () => void,
    preserveDocumentExcept?: readonly (keyof StoredSettings)[]
  ): Promise<StoredSettings> {
    const result = this.mutationTail.then(async () => {
      const current = await this.read()
      // Startup backfills may change only named fields. Read after durable recovery and validate
      // the original document, retaining opaque fields that a newer or older client may own.
      const original = preserveDocumentExcept
        ? JSON.parse(await readFileWithinLimit(this.path, SETTINGS_RESOURCE_LIMITS.documentBytes))
        : undefined
      const next = update(
        original === undefined ? current : decodeSettingsDocument(JSON.stringify(original))
      )
      const document = original === undefined ? next : { ...original }
      if (preserveDocumentExcept) {
        for (const key of preserveDocumentExcept) document[key] = next[key]
      }
      await this.write(document, beforePublish)
      return next
    })
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async write(settings: StoredSettings, beforePublish?: () => void): Promise<void> {
    assertCredentialAccessAllowed()
    const contents = `${JSON.stringify(settings, null, 2)}\n`
    if (Buffer.byteLength(contents, 'utf8') > SETTINGS_RESOURCE_LIMITS.documentBytes) {
      throw new Error(
        `Settings document exceeds the ${SETTINGS_RESOURCE_LIMITS.documentBytes} byte limit.`
      )
    }
    await writeDurableJsonFile(
      this.path,
      contents,
      beforePublish || credentialAccessInstalled()
        ? {
            // Recheck on every atomic publish retry; a concurrent failed secret read must not allow an
            // already queued settings rewrite to discard the original encrypted values.
            rename: async (source, destination) => {
              assertCredentialAccessAllowed()
              beforePublish?.()
              renameSync(source, destination)
            }
          }
        : {}
    )
  }
}

export { SettingsDocumentStore }
