import type { ChatMessage } from '../../stores/session-store'

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

  return `${HEADER}\n\n${transcript}`
}
