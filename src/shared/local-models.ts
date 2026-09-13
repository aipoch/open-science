export type LocalModelAvailability = 'notInstalled' | 'installing' | 'ready' | 'error'

export type LocalModelSnapshot = Readonly<{
  availability: LocalModelAvailability
  recommendedRevision: string
  installedRevision?: string
  downloadBytes: number
  installedBytes: number
  hasFiles: boolean
  inUse: boolean
  transferredBytes: number
  updateAvailable: boolean
  error?: 'download' | 'integrity' | 'storage' | 'incompatible'
}>
export const LOCAL_MODEL_NOT_INSTALLED = 'Local model is not installed.'
export const PDF_MODEL_CHANGED =
  'PDF_MODEL_CHANGED: The active model changed while parsing was queued. Retry with the current revision.'
