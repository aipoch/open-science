import type { ChatMessage } from '../../stores/session-store'
import {
  buildHistoryReplay,
  type HistoryReplayDescriptor,
  type HistoryReplayTarget
} from '../../../../shared/history-preamble'
import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  type AcpMessageImage
} from '../../../../shared/acp'
import {
  MAX_COMPOSER_ATTACHMENTS,
  toRuntimeUploadedAttachment,
  type UploadedAttachment
} from '../../../../shared/uploads'
import {
  requiresChatCompletionsBridge,
  type AgentFrameworkId,
  type AgentFrameworkView,
  type ProviderView
} from '../../../../shared/settings'

export const resolveHistoryReplayTarget = (
  frameworkId: AgentFrameworkId | undefined,
  provider?: ProviderView,
  framework?: AgentFrameworkView
): HistoryReplayTarget => {
  if (frameworkId === 'opencode') return 'opencode'
  if (frameworkId !== 'codex') return 'claude-code'
  if (
    provider &&
    framework &&
    requiresChatCompletionsBridge(provider, {
      id: framework.id,
      supportedApiTypes: framework.supportedApiTypes ?? ['responses']
    })
  ) {
    return 'codex-bridge'
  }
  return 'codex-response'
}

export const buildHistoryReplayMedia = (
  messages: ChatMessage[],
  projectId?: string
): { attachments: UploadedAttachment[]; images: AcpMessageImage[] } => {
  const attachments: UploadedAttachment[] = []
  const images: AcpMessageImage[] = []
  let imageBytes = 0

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    for (let index = (message.uploads?.length ?? 0) - 1; index >= 0; index -= 1) {
      const upload = message.uploads?.[index]
      if (upload && attachments.length < MAX_COMPOSER_ATTACHMENTS) {
        attachments.unshift(toRuntimeUploadedAttachment(upload, projectId))
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

export const buildWorkspaceHistoryReplay = (
  messages: ChatMessage[],
  descriptor: HistoryReplayDescriptor,
  projectId?: string
):
  | {
      historyPreamble: string
      historyAttachments: UploadedAttachment[]
      historyImages: AcpMessageImage[]
    }
  | undefined => {
  const replay = buildHistoryReplay(
    messages.map((message) => ({
      ...message,
      hasReplayMedia: (message.images?.length ?? 0) > 0 || (message.uploads?.length ?? 0) > 0
    })),
    descriptor
  )
  if (!replay) return undefined

  const selected = replay.selectedMessageIndexes.map((index) => messages[index]).filter(Boolean)
  const media = buildHistoryReplayMedia(selected, projectId)
  return {
    historyPreamble: replay.preamble,
    historyAttachments: media.attachments,
    historyImages: media.images
  }
}

export {
  buildHistoryPreamble,
  buildHistoryReplay,
  estimateHistoryTokens,
  resolveHistoryReplayBudget
} from '../../../../shared/history-preamble'
export type {
  HistoryReplayDescriptor,
  HistoryReplayTarget
} from '../../../../shared/history-preamble'
