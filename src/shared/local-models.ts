import type { DownloadProgress } from './download-progress'

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
  downloadProgress?: DownloadProgress
  updateAvailable: boolean
  error?: 'download' | 'integrity' | 'storage' | 'incompatible'
}>

export const localModelDownloadProgress = (snapshot: LocalModelSnapshot): DownloadProgress =>
  snapshot.downloadProgress ?? {
    phase: 'downloading',
    transferred: snapshot.transferredBytes,
    total: snapshot.downloadBytes,
    percent:
      snapshot.downloadBytes > 0
        ? Math.min(100, Math.round((snapshot.transferredBytes / snapshot.downloadBytes) * 100))
        : undefined,
    bytesPerSecond: 0,
    attempt: 0
  }
export const LOCAL_MODEL_NOT_INSTALLED = 'Local model is not installed.'
export const PDF_MODEL_CHANGED =
  'PDF_MODEL_CHANGED: The active model changed while parsing was queued. Retry with the current revision.'
