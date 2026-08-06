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
  imageAttachmentMimeType,
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
import { resolveModelContextWindow } from '../../../../shared/provider-registry'

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

export const resolveSessionHistoryReplayDescriptor = (
  session: {
    agentFrameworkId?: AgentFrameworkId
    agentBackendId?: string
    agentModel?: string
  },
  providers: ProviderView[],
  frameworks: AgentFrameworkView[]
): HistoryReplayDescriptor => {
  const frameworkId = session.agentFrameworkId
  const provider = providers.find(
    (candidate) => session.agentBackendId === `${frameworkId}:${candidate.id}`
  )
  const framework = frameworks.find((candidate) => candidate.id === frameworkId)
  const target =
    frameworkId === 'codex' && (!provider || !framework)
      ? 'codex-bridge'
      : resolveHistoryReplayTarget(frameworkId, provider, framework)

  return {
    target,
    contextWindow: provider?.vendorId
      ? resolveModelContextWindow(
          provider.vendorId,
          session.agentModel ?? provider.model ?? provider.models[0]
        )
      : provider?.contextWindow
  }
}

export const buildHistoryReplayMedia = (
  messages: ChatMessage[],
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

export const buildWorkspaceHistoryReplay = (
  messages: ChatMessage[],
  descriptor: HistoryReplayDescriptor,
  projectId?: string,
  supportsImageInput?: boolean
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
  const media = buildHistoryReplayMedia(selected, projectId, supportsImageInput)
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
