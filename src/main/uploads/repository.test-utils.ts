import { randomUUID } from 'node:crypto'

import { MAX_UPLOAD_CHUNK_BYTES, type UploadedAttachment } from '../../shared/uploads'
import type { UploadRepository } from './repository'

type UploadFixture = {
  name: string
  content: string
  mimeType?: string
}

// Test-only fixture writer. Production callers have no whole-file/base64 staging API; tests feed
// their compact fixtures through the same bounded chunk protocol used by pathless browser Files.
export const stageUploadFixtures = async (
  repository: UploadRepository,
  request: { files: UploadFixture[] }
): Promise<UploadedAttachment[]> => {
  const attachments: UploadedAttachment[] = []

  for (const file of request.files) {
    const bytes = Buffer.from(file.content, 'base64')
    const transferId = randomUUID()
    await repository.beginTransfer({
      transferId,
      name: file.name,
      mimeType: file.mimeType,
      size: bytes.byteLength
    })

    for (let offset = 0; offset < bytes.byteLength; offset += MAX_UPLOAD_CHUNK_BYTES) {
      await repository.appendTransfer({
        transferId,
        offset,
        chunk: bytes.subarray(offset, offset + MAX_UPLOAD_CHUNK_BYTES)
      })
    }

    attachments.push(await repository.finishTransfer({ transferId }))
  }

  return attachments
}
