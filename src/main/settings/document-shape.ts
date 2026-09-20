import { isAbsolute } from 'node:path'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { DurableJsonRecoveryBarrierError } from '../storage/durable-json-file'
import { isRecord } from '../value-guards'

class UnsupportedSettingsDocumentVersionError extends DurableJsonRecoveryBarrierError {
  constructor(version: number) {
    super(
      `Settings document version ${version} is newer than supported version ${SETTINGS_FILE_VERSION}.`
    )
  }
}

// Shared read-only validation, before any sanitizer or crash-recovery document promotion.
export const validateSettingsDocumentShape = (value: unknown): void => {
  // A damaged pointer must never sanitize to an unset pointer and start a second empty workspace.
  if (
    isRecord(value) &&
    value.dataRoot != null &&
    (typeof value.dataRoot !== 'string' ||
      (value.dataRoot.trim() !== '' && !isAbsolute(value.dataRoot)))
  ) {
    throw new DurableJsonRecoveryBarrierError(
      'The saved data location (dataRoot) is invalid. Restore its absolute path before restarting.'
    )
  }
  const version = isRecord(value) ? value.version : undefined
  if (Number.isSafeInteger(version) && Number(version) > SETTINGS_FILE_VERSION) {
    throw new UnsupportedSettingsDocumentVersionError(Number(version))
  }
  if (!isRecord(value) || (value.version !== 1 && value.version !== SETTINGS_FILE_VERSION)) {
    throw new Error('Settings document is corrupt.')
  }
}
