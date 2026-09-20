import { uploadFileChunks } from '../pages/workspace/composer-upload-transfer'
import type { SpecialistPackageCandidatePreview } from '../../../shared/specialist-package'
import type { UploadTransferProgress } from '../../../shared/uploads'

export const canImportSpecialistPackage = (): boolean =>
  typeof window.api.specialist?.selectPackage === 'function' ||
  (typeof window.api.specialist?.beginPackageUpload === 'function' &&
    typeof window.api.specialist?.previewPackageUpload === 'function' &&
    typeof window.api.specialist?.abortPackageUpload === 'function' &&
    typeof window.api.specialist?.installPackage === 'function' &&
    typeof window.api.specialist?.cancelPackage === 'function' &&
    typeof window.api.uploads?.appendTransfer === 'function' &&
    typeof window.api.uploads?.getTransferStatus === 'function')

// Keep the picker synchronous with the user click so browser user activation is preserved.
export const chooseSpecialistZip = (signal: AbortSignal): Promise<File | undefined> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip'
    input.hidden = true
    const finish = (file?: File): void => {
      signal.removeEventListener('abort', cancel)
      input.remove()
      resolve(file)
    }
    const cancel = (): void => finish()
    signal.addEventListener('abort', cancel, { once: true })
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true })
    input.addEventListener('cancel', () => finish(), { once: true })
    document.body.appendChild(input)
    input.click()
  })

export const uploadSpecialistZip = async (
  file: File,
  signal: AbortSignal,
  onProgress: (progress: UploadTransferProgress) => void
): Promise<SpecialistPackageCandidatePreview> => {
  const transferId = crypto.randomUUID()
  const request = { transferId }
  const abortTransfer = (): void => {
    void window.api.specialist.abortPackageUpload(request).catch(() => undefined)
  }
  // Cancel server staging even while a chunk response is still pending.
  signal.addEventListener('abort', abortTransfer, { once: true })
  try {
    await uploadFileChunks(
      file,
      {
        beginTransfer: (input) => window.api.specialist.beginPackageUpload(input),
        appendTransfer: (input) => window.api.uploads.appendTransfer(input),
        getTransferStatus: (input) => window.api.uploads.getTransferStatus(input)
      },
      { transferId, name: file.name, signal, onProgress }
    )
    const preview = await window.api.specialist.previewPackageUpload(request)
    if (signal.aborted) {
      await window.api.specialist.cancelPackage({ candidateToken: preview.candidateToken })
      throw new DOMException('Upload cancelled.', 'AbortError')
    }
    return preview
  } catch (error) {
    // Retry cleanup after pending begin/preview operations have settled.
    await window.api.specialist.abortPackageUpload(request).catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', abortTransfer)
  }
}
