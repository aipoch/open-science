import { readFile, stat } from 'node:fs/promises'

import type { AcpMessageImage } from '../../shared/acp-image-contract'
import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  sanitizeAcpMessageImage
} from '../../shared/acp-image-contract'
import { imageAttachmentMimeType, type UploadedAttachment } from '../../shared/uploads'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import { MAX_AUTO_PROCESS_IMAGE_BYTES, prepareModelImageData } from '../uploads/attachment-media'
import type { UploadRepository } from '../uploads/repository'

export type LoadClassificationImagesInput = Readonly<{
  appSessionId: string
  projectId: string
  currentImages?: ReadonlyArray<AcpMessageImage>
  currentUploads: ReadonlyArray<UploadedAttachment>
  signal: AbortSignal
}>

type AcpClassificationImageLoaderOptions = Readonly<{
  uploadRepository?: UploadRepository
  managedFileVersions?: Pick<ManagedFileVersionService, 'openLatest'>
}>

export class AcpClassificationImageLoader {
  constructor(private readonly options: AcpClassificationImageLoaderOptions) {}

  async load(input: LoadClassificationImagesInput): Promise<AcpMessageImage[]> {
    const images: AcpMessageImage[] = []
    for (const candidate of input.currentImages ?? []) {
      input.signal.throwIfAborted()
      const image = sanitizeAcpMessageImage(candidate)
      if (!image) throw new Error('Invalid current image for classification.')
      images.push(image)
    }
    for (const attachment of input.currentUploads) {
      input.signal.throwIfAborted()
      if (!imageAttachmentMimeType(attachment.originalName, attachment.mimeType)) continue
      if (images.length >= MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE)
        throw new Error('Classification image count exceeds the request budget.')
      let bytes: Buffer
      if (attachment.versionId && this.options.managedFileVersions) {
        const identity = {
          source: 'upload' as const,
          projectId: input.projectId,
          fileId: attachment.id
        }
        const lease = await this.options.managedFileVersions.openLatest(identity)
        try {
          if (lease.size > MAX_AUTO_PROCESS_IMAGE_BYTES)
            throw new Error('Classification image exceeds the processing limit.')
          bytes = Buffer.from(await lease.readRange(0, lease.size))
          await lease.verifyUnchanged()
        } finally {
          await lease.close()
        }
      } else {
        if (!this.options.uploadRepository) throw new Error('Upload storage is not configured.')
        const filePath = await this.options.uploadRepository.resolveManagedUploadPath(
          { path: attachment.path },
          {
            projectId: input.projectId,
            sessionId: attachment.versionId ? attachment.sessionId : input.appSessionId
          }
        )
        const fileInfo = await stat(filePath)
        if (!fileInfo.isFile() || fileInfo.size > MAX_AUTO_PROCESS_IMAGE_BYTES)
          throw new Error('Classification image exceeds the processing limit.')
        bytes = await readFile(filePath)
      }
      input.signal.throwIfAborted()
      const prepared = await prepareModelImageData(bytes)
      images.push({
        mimeType: prepared.mimeType as AcpMessageImage['mimeType'],
        data: prepared.data,
        byteLength: Buffer.from(prepared.data, 'base64').byteLength
      })
    }
    if (images.length > MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE)
      throw new Error('Classification image count exceeds the request budget.')
    const totalBytes = images.reduce((total, image) => total + image.byteLength, 0)
    if (totalBytes > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE)
      throw new Error('Classification images exceed the request budget.')
    return images
  }
}
