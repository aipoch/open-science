import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  type AcpMessageImage
} from './acp'
import { buildHistoryReplay, type HistoryReplayDescriptor } from './history-preamble'
import type { PersistedChatMessage } from './session-persistence'
import {
  imageAttachmentMimeType,
  MAX_COMPOSER_ATTACHMENTS,
  toRuntimeUploadedAttachment,
  type UploadedAttachment
} from './uploads'

export type SessionHistoryReplay = {
  historyPreamble: string
  historyAttachments: UploadedAttachment[]
  historyImages: AcpMessageImage[]
}

const buildSessionHistoryReplayMedia = (
  messages: PersistedChatMessage[],
  projectId?: string,
  supportsImageInput?: boolean
): { attachments: UploadedAttachment[]; images: AcpMessageImage[] } => {
  const images: AcpMessageImage[] = []
  let imageBytes = 0

  const uploads = messages.flatMap((message) => message.uploads ?? [])
  const newestUploads = [...uploads].reverse()
  const imageUploads = newestUploads.filter((upload) =>
    imageAttachmentMimeType(upload.name, upload.mimeType)
  )
  const fileUploads = newestUploads.filter(
    (upload) => !imageAttachmentMimeType(upload.name, upload.mimeType)
  )
  const selectedUploads = (
    supportsImageInput === false ? fileUploads : [...imageUploads, ...fileUploads]
  ).slice(0, MAX_COMPOSER_ATTACHMENTS)
  const selectedUploadSet = new Set(selectedUploads)
  const attachments = uploads
    .filter((upload) => selectedUploadSet.has(upload))
    .map((upload) => toRuntimeUploadedAttachment(upload, projectId))

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (supportsImageInput === false) continue
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

export const buildSessionHistoryReplay = (
  messages: PersistedChatMessage[],
  descriptor: HistoryReplayDescriptor,
  projectId?: string,
  supportsImageInput?: boolean
): SessionHistoryReplay | undefined => {
  const replay = buildHistoryReplay(
    messages.map((message) => ({
      ...message,
      hasReplayMedia: (message.images?.length ?? 0) > 0 || (message.uploads?.length ?? 0) > 0
    })),
    descriptor
  )
  if (!replay) return undefined

  const selected = replay.selectedMessageIndexes.map((index) => messages[index]).filter(Boolean)
  const media = buildSessionHistoryReplayMedia(selected, projectId, supportsImageInput)
  return {
    historyPreamble: replay.preamble,
    historyAttachments: media.attachments,
    historyImages: media.images
  }
}
