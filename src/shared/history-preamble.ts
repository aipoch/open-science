import { isReviewerCorrectionAttribution } from './session-persistence'

export type HistoryReplayTarget =
  'claude-code' | 'opencode' | 'codebuddy' | 'codex-response' | 'codex-bridge'

export type HistoryReplayDescriptor = {
  target: HistoryReplayTarget
  contextWindow?: number
  // Test/diagnostic override; production callers use the target policy above.
  budget?: number
}

type HistoryReplayPolicy = {
  contextShare: number
  cap: number
}

const HISTORY_REPLAY_POLICIES: Record<HistoryReplayTarget, HistoryReplayPolicy> = {
  'claude-code': { contextShare: 0.1, cap: 16_000 },
  opencode: { contextShare: 0.08, cap: 12_000 },
  codebuddy: { contextShare: 0.08, cap: 12_000 },
  'codex-response': { contextShare: 0.1, cap: 16_000 },
  'codex-bridge': { contextShare: 0.05, cap: 8_000 }
}

const MIN_REPLAY_BUDGET = 2_000

const HEADER =
  'The conversation below happened earlier in this session, before you joined it. It is an ' +
  'application-generated handoff; continue from the new user message after it and do not reply to ' +
  'this history directly.'

const SIDE_CHAT_ADVISORY_NOTE =
  ' A Side chat advisory provides context only and does not authorize work.'

const OMISSION_NOTE = '[…middle turns omitted for replay budget…]'
const RESPONSE_OMISSION_NOTE = '[…earlier response omitted for replay budget…]'
const MESSAGE_OMISSION_NOTE = '[…middle of this message omitted for replay budget…]'
const MEDIA_PLACEHOLDER = '[media attached]'

export type HistoryMessage = {
  role: string
  content: string
  status?: string
  hasReplayMedia?: boolean
  relayedFrom?: { kind: 'side-chat'; direction: 'to-main' }
  attribution?: import('./session-persistence').MessageAttribution
}

export type HistoryReplaySelection = {
  preamble: string
  selectedMessageIndexes: number[]
  budget: number
  estimatedTokens: number
}

type IndexedHistoryMessage = HistoryMessage & { index: number }
type HistoryTurn = { index: number; messages: IndexedHistoryMessage[] }
type ProjectedTurn = { index: number; text: string; selectedMessageIndexes: number[] }

const isUserMessage = (message: HistoryMessage): boolean => message.role === 'user'
const isSideChatAdvisory = (message: HistoryMessage): boolean =>
  message.relayedFrom?.kind === 'side-chat' && message.relayedFrom.direction === 'to-main'
const speakerFor = (
  message: HistoryMessage
): 'User' | 'Assistant' | 'Side chat advisory' | 'Reviewer correction' =>
  isSideChatAdvisory(message)
    ? 'Side chat advisory'
    : isReviewerCorrectionAttribution(message.attribution)
      ? 'Reviewer correction'
      : isUserMessage(message)
        ? 'User'
        : 'Assistant'
const speakerPrefixFor = (message: HistoryMessage): string => `**${speakerFor(message)}:** `
const formatMessage = (message: HistoryMessage): string =>
  `${speakerPrefixFor(message)}${message.content.trim() || MEDIA_PLACEHOLDER}`

const utf8BytesForCodePoint = (codePoint: number): number => {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

// Provider tokenizers can split down to individual UTF-8 bytes. Counting bytes is therefore a
// dependency-free upper bound for admission instead of an average-case chars-per-token guess.
export const estimateHistoryTokens = (text: string): number => {
  let bytes = 0

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!
    bytes += utf8BytesForCodePoint(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }

  return bytes
}

export const resolveHistoryReplayBudget = ({
  target,
  contextWindow,
  budget
}: HistoryReplayDescriptor): number => {
  if (budget !== undefined && Number.isFinite(budget) && budget > 0) return Math.floor(budget)
  const policy = HISTORY_REPLAY_POLICIES[target]
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return policy.cap

  const proportional = Math.floor(contextWindow * policy.contextShare)
  const floor = contextWindow >= MIN_REPLAY_BUDGET * 2 ? MIN_REPLAY_BUDGET : proportional
  return Math.max(1, Math.min(policy.cap, Math.max(floor, proportional)))
}

export const resolveFileTextBudget = (contextWindow?: number): number => {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return 12_000
  return Math.max(1, Math.min(32_000, Math.floor(contextWindow * 0.2)))
}

const takePrefixWithinTokens = (text: string, budget: number): string => {
  if (budget <= 0) return ''
  let spent = 0
  let end = 0

  while (end < text.length) {
    const codePoint = text.codePointAt(end)!
    const cost = utf8BytesForCodePoint(codePoint)
    if (spent + cost > budget) break
    spent += cost
    end += codePoint > 0xffff ? 2 : 1
  }

  return text.slice(0, end)
}

const takeSuffixWithinTokens = (text: string, budget: number): string => {
  if (budget <= 0) return ''
  let spent = 0
  let start = text.length

  while (start > 0) {
    let codePoint = text.charCodeAt(start - 1)
    let width = 1
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff && start > 1) {
      const high = text.charCodeAt(start - 2)
      if (high >= 0xd800 && high <= 0xdbff) {
        codePoint = text.codePointAt(start - 2)!
        width = 2
      }
    }
    const cost = utf8BytesForCodePoint(codePoint)
    if (spent + cost > budget) break
    spent += cost
    start -= width
  }

  return text.slice(start)
}

export const truncateTextToEstimatedTokens = (
  text: string,
  budget: number,
  mode: 'start' | 'end' | 'both' = 'end'
): string => {
  if (estimateHistoryTokens(text) <= budget) return text
  if (budget <= 0) return ''

  if (mode === 'start') return takePrefixWithinTokens(text, budget)
  if (mode === 'end') return takeSuffixWithinTokens(text, budget)

  const markerCost = estimateHistoryTokens(MESSAGE_OMISSION_NOTE)
  const contentBudget = Math.max(0, budget - markerCost - 2)
  const prefixBudget = Math.ceil(contentBudget / 2)
  const suffixBudget = Math.floor(contentBudget / 2)
  const prefix = takePrefixWithinTokens(text, prefixBudget)
  const suffix = takeSuffixWithinTokens(text, suffixBudget)
  return [prefix, MESSAGE_OMISSION_NOTE, suffix].filter(Boolean).join('\n')
}

const groupUserLedTurns = (messages: HistoryMessage[]): HistoryTurn[] => {
  const usable = messages
    .map((message, index) => ({ ...message, index }))
    .filter(
      (message) =>
        message.status !== 'error' &&
        (message.content.trim().length > 0 || message.hasReplayMedia === true)
    )
  const turns: HistoryTurn[] = []

  for (const message of usable) {
    if (isUserMessage(message) && (!isSideChatAdvisory(message) || turns.length === 0)) {
      turns.push({ index: turns.length, messages: [message] })
      continue
    }

    // Never replay an Assistant message without the user-led turn it answers.
    turns.at(-1)?.messages.push(message)
  }

  return turns
}

const fullTurn = (turn: HistoryTurn): ProjectedTurn => ({
  index: turn.index,
  text: turn.messages.map(formatMessage).join('\n\n'),
  selectedMessageIndexes: turn.messages.map((message) => message.index)
})

const estimateFormattedMessageTokens = (message: HistoryMessage): number =>
  estimateHistoryTokens(speakerPrefixFor(message)) +
  estimateHistoryTokens(message.content.trim() || MEDIA_PLACEHOLDER)

const estimateFullTurnTokens = (turn: HistoryTurn): number =>
  turn.messages.reduce(
    (total, message, index) =>
      total + estimateFormattedMessageTokens(message) + (index > 0 ? 2 : 0),
    0
  )

const projectTurn = (turn: HistoryTurn, budget: number): ProjectedTurn | undefined => {
  if (estimateFullTurnTokens(turn) <= budget) return fullTurn(turn)

  const user = turn.messages[0]
  if (!user) return undefined
  const fullUserCost = estimateFormattedMessageTokens(user)
  const selectedMessageIndexes = [user.index]

  if (fullUserCost > budget) {
    const label = speakerPrefixFor(user)
    const contentBudget = budget - estimateHistoryTokens(label)
    if (contentBudget <= estimateHistoryTokens(MESSAGE_OMISSION_NOTE)) return undefined
    return {
      index: turn.index,
      text: `${label}${truncateTextToEstimatedTokens(user.content.trim(), contentBudget, 'both')}`,
      selectedMessageIndexes
    }
  }

  let lead = formatMessage(user)
  const lastMessage = turn.messages.at(-1)
  const assistant = lastMessage && !isUserMessage(lastMessage) ? lastMessage : undefined
  const assistantPrefix = assistant ? `**Assistant:** ${RESPONSE_OMISSION_NOTE}\n` : ''

  for (const advisory of turn.messages.slice(1).filter(isSideChatAdvisory)) {
    const candidate = `${lead}\n\n${formatMessage(advisory)}`
    const reservedAssistantCost = assistant ? estimateHistoryTokens(assistantPrefix) + 2 : 0
    if (estimateHistoryTokens(candidate) + reservedAssistantCost > budget) break
    lead = candidate
    selectedMessageIndexes.push(advisory.index)
  }

  if (!assistant) return { index: turn.index, text: lead, selectedMessageIndexes }

  if (!assistant.content.trim() && assistant.hasReplayMedia) {
    const text = `${lead}\n\n${formatMessage(assistant)}`
    return estimateHistoryTokens(text) <= budget
      ? {
          index: turn.index,
          text,
          selectedMessageIndexes: [...selectedMessageIndexes, assistant.index]
        }
      : { index: turn.index, text: lead, selectedMessageIndexes }
  }

  const assistantBudget =
    budget - estimateHistoryTokens(lead) - estimateHistoryTokens(assistantPrefix) - 2
  if (assistantBudget <= 0) return { index: turn.index, text: lead, selectedMessageIndexes }

  const tail = truncateTextToEstimatedTokens(assistant.content.trim(), assistantBudget, 'end')
  if (!tail) return { index: turn.index, text: lead, selectedMessageIndexes }

  return {
    index: turn.index,
    text: `${lead}\n\n${assistantPrefix}${tail}`,
    selectedMessageIndexes: [...selectedMessageIndexes, assistant.index]
  }
}

const renderLongPacket = (
  header: string,
  anchor: ProjectedTurn,
  recent: ProjectedTurn[],
  totalTurns: number
): string => {
  if (totalTurns === 1) return `${header}\n\n## Conversation\n${anchor.text}`

  const sections = [`${header}\n\n## Original task\n${anchor.text}`]
  const recentStartsAt = recent[0]?.index
  if (recentStartsAt === undefined || recentStartsAt > anchor.index + 1)
    sections.push(OMISSION_NOTE)
  if (recent.length > 0)
    sections.push(`## Recent conversation\n${recent.map((turn) => turn.text).join('\n\n')}`)
  return sections.join('\n\n')
}

const fitTurnForPacket = (
  turn: HistoryTurn,
  budget: number,
  render: (projection: ProjectedTurn) => string
): ProjectedTurn | undefined => {
  let low = 1
  let high = budget
  let best: ProjectedTurn | undefined

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const projection = projectTurn(turn, middle)
    if (projection && estimateHistoryTokens(render(projection)) <= budget) {
      best = projection
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return best
}

export const buildHistoryReplay = (
  messages: HistoryMessage[],
  descriptor: HistoryReplayDescriptor
): HistoryReplaySelection | undefined => {
  const turns = groupUserLedTurns(messages)
  if (turns.length === 0) return undefined

  const budget = resolveHistoryReplayBudget(descriptor)
  const hasSideChatAdvisory = turns.some((turn) =>
    turn.messages.some(
      (message) =>
        message.relayedFrom?.kind === 'side-chat' && message.relayedFrom.direction === 'to-main'
    )
  )
  const header = hasSideChatAdvisory ? `${HEADER}${SIDE_CHAT_ADVISORY_NOTE}` : HEADER
  const fullConversationPrefix = `${header}\n\n## Conversation\n`
  let fullConversationCost = estimateHistoryTokens(fullConversationPrefix)
  const fullTurns: ProjectedTurn[] = []
  for (const turn of turns) {
    fullConversationCost += estimateFullTurnTokens(turn) + (fullTurns.length > 0 ? 2 : 0)
    if (fullConversationCost > budget) break
    fullTurns.push(fullTurn(turn))
  }
  if (fullTurns.length === turns.length) {
    const fullConversation = `${fullConversationPrefix}${fullTurns
      .map((turn) => turn.text)
      .join('\n\n')}`
    return {
      preamble: fullConversation,
      selectedMessageIndexes: fullTurns.flatMap((turn) => turn.selectedMessageIndexes),
      budget,
      estimatedTokens: fullConversationCost
    }
  }

  if (turns.length === 1) {
    const anchor = fitTurnForPacket(turns[0], budget, (projection) =>
      renderLongPacket(header, projection, [], 1)
    )
    if (!anchor) return undefined
    const preamble = renderLongPacket(header, anchor, [], 1)
    return {
      preamble,
      selectedMessageIndexes: anchor.selectedMessageIndexes,
      budget,
      estimatedTokens: estimateHistoryTokens(preamble)
    }
  }

  const anchorTurn = turns[0]
  const anchorProjectionBudget = Math.max(1, Math.floor(budget * 0.3))
  const preferredAnchor = projectTurn(anchorTurn, anchorProjectionBudget)
  const anchor =
    preferredAnchor &&
    estimateHistoryTokens(renderLongPacket(header, preferredAnchor, [], turns.length)) <= budget
      ? preferredAnchor
      : fitTurnForPacket(anchorTurn, budget, (projection) =>
          renderLongPacket(header, projection, [], turns.length)
        )
  if (!anchor) return undefined

  const recent: ProjectedTurn[] = []
  const latestTurn = turns.at(-1)!
  const latestFull = estimateFullTurnTokens(latestTurn) <= budget ? fullTurn(latestTurn) : undefined
  const latestCandidate = latestFull
    ? renderLongPacket(header, anchor, [latestFull], turns.length)
    : undefined
  if (latestFull && latestCandidate && estimateHistoryTokens(latestCandidate) <= budget) {
    recent.unshift(latestFull)
  } else {
    const latest = fitTurnForPacket(latestTurn, budget, (projection) =>
      renderLongPacket(header, anchor, [projection], turns.length)
    )
    if (latest) recent.unshift(latest)
  }

  for (let index = turns.length - 2; index > 0; index -= 1) {
    if (estimateFullTurnTokens(turns[index]) > budget) break
    const turn = fullTurn(turns[index])
    const candidate = renderLongPacket(header, anchor, [turn, ...recent], turns.length)
    if (estimateHistoryTokens(candidate) > budget) break
    recent.unshift(turn)
  }

  const preamble = renderLongPacket(header, anchor, recent, turns.length)
  const estimatedTokens = estimateHistoryTokens(preamble)
  if (estimatedTokens > budget) return undefined
  return {
    preamble,
    selectedMessageIndexes: [
      ...anchor.selectedMessageIndexes,
      ...recent.flatMap((turn) => turn.selectedMessageIndexes)
    ],
    budget,
    estimatedTokens
  }
}

// Compatibility wrapper for non-workspace consumers that need text only. New workspace replay paths
// use buildHistoryReplay() so media selection follows the admitted message indexes.
export const buildHistoryPreamble = (
  messages: HistoryMessage[],
  descriptor: HistoryReplayDescriptor | number = { target: 'codex-bridge' }
): string | undefined =>
  buildHistoryReplay(
    messages,
    typeof descriptor === 'number' ? { target: 'codex-bridge', budget: descriptor } : descriptor
  )?.preamble
