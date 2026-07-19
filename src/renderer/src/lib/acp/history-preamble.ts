import type { ChatMessage } from '../../stores/session-store'
import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  type AcpMessageImage
} from '../../../../shared/acp'
import { MAX_COMPOSER_ATTACHMENTS, type UploadedAttachment } from '../../../../shared/uploads'

// Character budget for the replayed transcript. Kept modest so a long conversation cannot blow the new
// agent's context window on its very first turn; older turns past the budget are summarized as omitted.
const DEFAULT_PREAMBLE_BUDGET = 12_000

const HEADER =
  'The conversation below happened earlier in this session, before you joined it. Treat it as prior' +
  ' context — do not reply to it directly; continue from the user message that follows.'

const OMISSION_NOTE = '[…earlier turns omitted for length…]'

// Renders one message as a labelled transcript line, collapsing trailing whitespace.
const formatMessage = (message: ChatMessage): string => {
  const speaker = message.role === 'user' ? 'User' : 'Assistant'

  return `**${speaker}:** ${message.content.trim()}`
}

// Builds a bounded transcript of prior turns to replay into the next prompt after an agent-side context
// reset (framework switch or unresumable restart). Only completed text turns are included; tool activity
// is intentionally omitted because its effects already live on disk. Keeps the most recent turns within a
// character budget and prepends an omission marker when older turns are dropped. Returns undefined when
// there is nothing meaningful to replay, so the caller can skip the field entirely.
export const buildHistoryPreamble = (
  messages: ChatMessage[],
  budget: number = DEFAULT_PREAMBLE_BUDGET
): string | undefined => {
  const usable = messages.filter(
    (message) => message.status !== 'error' && message.content.trim().length > 0
  )

  if (usable.length === 0) return undefined

  // Walk newest-first, accepting turns until the budget is spent, then restore chronological order.
  const kept: ChatMessage[] = []
  let used = 0

  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const line = formatMessage(usable[index])
    const cost = line.length + 2 // account for the blank line joiner

    if (kept.length > 0 && used + cost > budget) break

    kept.unshift(usable[index])
    used += cost
  }

  const omittedSome = kept.length < usable.length
  const body = kept.map(formatMessage).join('\n\n')
  const transcript = omittedSome ? `${OMISSION_NOTE}\n\n${body}` : body
  const omissionPrefix = `${OMISSION_NOTE}\n\n`
  const boundedTranscript =
    transcript.length <= budget
      ? transcript
      : `${omissionPrefix}${transcript.slice(-Math.max(0, budget - omissionPrefix.length))}`

  return `${HEADER}\n\n${boundedTranscript}`
}

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
