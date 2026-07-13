import { MAX_COMPOSER_ATTACHMENTS, MAX_UPLOAD_FILE_BYTES } from '../../../../shared/uploads'

// Result of applying the composer size/count limits to an incoming batch of files.
export type ComposerAttachmentIntake = {
  accepted: File[]
  error: string | null
}

const MB_LIMIT = MAX_UPLOAD_FILE_BYTES / (1024 * 1024)

// Applies per-file size and total count limits before any file is read or uploaded.
export const planComposerAttachmentIntake = (
  files: File[],
  currentAttachmentCount: number
): ComposerAttachmentIntake => {
  // Oversized files are dropped and reported by name; they are never read or staged.
  const oversized = files.filter((file) => file.size > MAX_UPLOAD_FILE_BYTES)
  const withinSize = files.filter((file) => file.size <= MAX_UPLOAD_FILE_BYTES)

  // The count check rejects the whole batch so the composer never partially accepts files.
  const remaining = MAX_COMPOSER_ATTACHMENTS - currentAttachmentCount
  if (withinSize.length > remaining) {
    return { accepted: [], error: `You can attach up to ${MAX_COMPOSER_ATTACHMENTS} files` }
  }

  const oversizedError =
    oversized.length > 0
      ? `${oversized.map((file) => file.name).join(', ')} exceeds the ${MB_LIMIT} MB limit`
      : null

  return { accepted: withinSize, error: oversizedError }
}
