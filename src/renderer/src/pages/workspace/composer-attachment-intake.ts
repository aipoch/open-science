import type { TFunction } from 'i18next'
import { isDesktopRuntimeConnectionError } from '../../../../shared/desktop-runtime-recovery'
import { unwrapIpcErrorDetail } from '../../../../shared/failure/messages'
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_UPLOAD_FILE_BYTES,
  formatUploadSizeLimit
} from '../../../../shared/uploads'

// Result of applying the composer size/count limits to an incoming batch of files.
export type ComposerAttachmentIntake = {
  accepted: File[]
  error: string | null
}

// Applies per-file size and total count limits before any file is read or uploaded.
export const planComposerAttachmentIntake = (
  files: File[],
  currentAttachmentCount: number,
  t: TFunction
): ComposerAttachmentIntake => {
  // Oversized files are dropped and reported by name; they are never read or staged.
  const oversized = files.filter((file) => file.size > MAX_UPLOAD_FILE_BYTES)
  const withinSize = files.filter((file) => file.size <= MAX_UPLOAD_FILE_BYTES)

  // The count check rejects the whole batch so the composer never partially accepts files.
  const remaining = MAX_COMPOSER_ATTACHMENTS - currentAttachmentCount
  if (withinSize.length > remaining) {
    return {
      accepted: [],
      error: t('You can attach up to {{limit}} files.', { limit: MAX_COMPOSER_ATTACHMENTS })
    }
  }

  const oversizedError =
    oversized.length > 0
      ? t('Choose a smaller file. The per-file limit is {{limit}}. ({{files}})', {
          limit: formatUploadSizeLimit(MAX_UPLOAD_FILE_BYTES),
          files: oversized.map((file) => file.name).join(', ')
        })
      : null

  return { accepted: withinSize, error: oversizedError }
}

export const attachmentStagingGuidance = (
  error: unknown,
  detail: string,
  t: TFunction
): string | undefined => {
  const message = unwrapIpcErrorDetail(detail).replace(/^ApplicationCommandError:\s*/, '')
  if (
    isDesktopRuntimeConnectionError(error) ||
    /^DesktopRuntime(?:Disconnected|WriteNotSubmitted)Error:/.test(message)
  )
    return t('Reconnect to the local service, then try attaching the file again.')
  if (
    /^Upload source changed (?:before it could be staged|while it was being staged):/.test(message)
  )
    return t('The file changed. Wait for it to finish saving, then select it again.')
  if (/^Upload source is not a file:/.test(message)) return t('Select a file to attach.')
  const limit = /^Upload exceeds the (\d+(?:\.\d+)? (?:B|KB|MB|GB)) per-file limit:/.exec(message)
  if (limit)
    return t('Choose a smaller file. The per-file limit is {{limit}}.', { limit: limit[1] })
  if (
    (error && typeof error === 'object' && 'code' in error && error.code === 'ENOSPC') ||
    /^(?:ENOSPC\b|disk full$|no space left on device(?:$|,))/i.test(message)
  )
    return t('Free up space on the device running Open Science, then try again.')
  return undefined
}
