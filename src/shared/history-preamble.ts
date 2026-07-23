// Character budget for the replayed transcript. Kept modest so a long conversation cannot blow the new
// agent's context window on its first turn after a framework switch or unresumable restart.
const DEFAULT_PREAMBLE_BUDGET = 12_000

const HEADER =
  'The conversation below happened earlier in this session, before you joined it. Treat it as prior' +
  ' context — do not reply to it directly; continue from the user message that follows.'

const OMISSION_NOTE = '[…earlier turns omitted for length…]'

type HistoryMessage = {
  role: string
  content: string
  status?: string
}

const formatMessage = (message: HistoryMessage): string => {
  const speaker = message.role === 'user' ? 'User' : 'Assistant'
  return `**${speaker}:** ${message.content.trim()}`
}

// Builds a bounded text-only transcript. Tool effects already live on disk and are intentionally omitted.
export const buildHistoryPreamble = (
  messages: HistoryMessage[],
  budget: number = DEFAULT_PREAMBLE_BUDGET
): string | undefined => {
  const usable = messages.filter(
    (message) => message.status !== 'error' && message.content.trim().length > 0
  )

  if (usable.length === 0) return undefined

  const kept: HistoryMessage[] = []
  let used = 0

  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const line = formatMessage(usable[index])
    const cost = line.length + 2

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
