import type { ChatMessage } from '../../stores/session-store'
import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  type AcpMessageImage
} from '../../../../shared/acp'
import { MAX_COMPOSER_ATTACHMENTS, type UploadedAttachment } from '../../../../shared/uploads'
export { buildHistoryPreamble } from '../../../../shared/history-preamble'

export const buildHistoryReplayMedia = (
  messages: ChatMessage[]
): { attachments: UploadedAttachment[]; images: AcpMessageImage[] } => {
  const attachments: UploadedAttachment[] = []
  const images: AcpMessageImage[] = []
  let imageBytes = 0

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    for (let index = (message.uploads?.length ?? 0) - 1; index >= 0; index -= 1) {
      const upload = message.uploads?.[index]
      if (upload?.mimeType?.startsWith('image/') && attachments.length < MAX_COMPOSER_ATTACHMENTS) {
        attachments.unshift(upload)
      }
    }
    for (let index = (message.images?.length ?? 0) - 1; index >= 0; index -= 1) {
      const image = message.images?.[index]
      if (
        image &&
        images.length < MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE &&
        imageBytes + image.byteLength <= MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE
      ) {
        images.unshift(image)
        imageBytes += image.byteLength
      }
    }
  }

  return { attachments, images }
}
