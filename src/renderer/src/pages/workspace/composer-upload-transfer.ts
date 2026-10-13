import type { UploadTransferProgress } from '../../../../shared/uploads'
export { stageUploadFile as stageComposerFile, uploadFileChunks } from '../../lib/upload-transfer'
export type { UploadStagingApi } from '../../lib/upload-transfer'

export type ComposerUploadTransfer = UploadTransferProgress & {
  // Derived from this controller's in-memory File; never restored from persisted draft metadata.
  canRetry?: boolean
  recoveryReceipt?: string
  mimeType?: string
  pastedTextId?: string
  status: 'queued' | 'uploading' | 'cancelling' | 'error'
  error?: string
  errorDetail?: string
}
