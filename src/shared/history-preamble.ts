export type HistoryReplayTarget = 'claude-code' | 'opencode' | 'codex-response' | 'codex-bridge'

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
  'codex-response': { contextShare: 0.1, cap: 16_000 },
  'codex-bridge': { contextShare: 0.05, cap: 8_000 }
}

const MIN_REPLAY_BUDGET = 2_000

const HEADER =
  'The conversation below happened earlier in this session, before you joined it. It is an ' +
  'application-generated handoff; continue from the new user message after it and do not reply to ' +
  'this history directly.'

const OMISSION_NOTE = '[…middle turns omitted for replay budget…]'
const RESPONSE_OMISSION_NOTE = '[…earlier response omitted for replay budget…]'
const MESSAGE_OMISSION_NOTE = '[…middle of this message omitted for replay budget…]'

export type HistoryMessage = {
  role: string
  content: string
  status?: string
  hasReplayMedia?: boolean
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
const speakerFor = (message: HistoryMessage): 'User' | 'Assistant' =>
  isUserMessage(message) ? 'User' : 'Assistant'
const formatMessage = (message: HistoryMessage): string =>
  `**${speakerFor(message)}:** ${message.content.trim() || '[media attached]'}`

// Stable conservative admission estimate: ASCII-heavy text gets the usual four-bytes-per-token
// approximation, while every non-ASCII code point costs at least one token.
export const estimateHistoryTokens = (text: string): number => {
  let asciiBytes = 0
  let nonAsciiCodePoints = 0

  for (const codePoint of text) {
    if (codePoint.codePointAt(0)! <= 0x7f) asciiBytes += 1
    else nonAsciiCodePoints += 1
  }

  return Math.ceil(asciiBytes / 4) + nonAsciiCodePoints
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
  const codePoints = Array.from(text)
  let low = 0
  let high = codePoints.length

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateHistoryTokens(codePoints.slice(0, middle).join('')) <= budget) low = middle
    else high = middle - 1
  }

  return codePoints.slice(0, low).join('')
}

const takeSuffixWithinTokens = (text: string, budget: number): string => {
  if (budget <= 0) return ''
  const codePoints = Array.from(text)
  let low = 0
  let high = codePoints.length

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateHistoryTokens(codePoints.slice(-middle).join('')) <= budget) low = middle
    else high = middle - 1
  }

  return codePoints.slice(-low).join('')
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
    if (isUserMessage(message)) {
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

const projectTurn = (turn: HistoryTurn, budget: number): ProjectedTurn | undefined => {
  const full = fullTurn(turn)
  if (estimateHistoryTokens(full.text) <= budget) return full

  const user = turn.messages[0]
  if (!user) return undefined
  const fullUser = formatMessage(user)
  const selectedMessageIndexes = [user.index]

  if (estimateHistoryTokens(fullUser) > budget) {
    const label = '**User:** '
    const contentBudget = budget - estimateHistoryTokens(label)
    if (contentBudget <= estimateHistoryTokens(MESSAGE_OMISSION_NOTE)) return undefined
    return {
      index: turn.index,
      text: `${label}${truncateTextToEstimatedTokens(user.content.trim(), contentBudget, 'both')}`,
      selectedMessageIndexes
    }
  }

  const assistant = turn.messages.at(-1)
  if (!assistant || isUserMessage(assistant))
    return { index: turn.index, text: fullUser, selectedMessageIndexes }

  const assistantPrefix = `**Assistant:** ${RESPONSE_OMISSION_NOTE}\n`
  const assistantBudget =
    budget - estimateHistoryTokens(fullUser) - estimateHistoryTokens(assistantPrefix) - 2
  if (assistantBudget <= 0) return { index: turn.index, text: fullUser, selectedMessageIndexes }

  const tail = truncateTextToEstimatedTokens(assistant.content.trim(), assistantBudget, 'end')
  if (!tail) return { index: turn.index, text: fullUser, selectedMessageIndexes }

  return {
    index: turn.index,
    text: `${fullUser}\n\n${assistantPrefix}${tail}`,
    selectedMessageIndexes: [...selectedMessageIndexes, assistant.index]
  }
}

const renderLongPacket = (
  anchor: ProjectedTurn,
  recent: ProjectedTurn[],
  totalTurns: number
): string => {
  if (totalTurns === 1) return `${HEADER}\n\n## Conversation\n${anchor.text}`

  const sections = [`${HEADER}\n\n## Original task\n${anchor.text}`]
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
  const fullConversation = `${HEADER}\n\n## Conversation\n${turns
    .map((turn) => fullTurn(turn).text)
    .join('\n\n')}`
  if (estimateHistoryTokens(fullConversation) <= budget) {
    return {
      preamble: fullConversation,
      selectedMessageIndexes: turns.flatMap((turn) =>
        turn.messages.map((message) => message.index)
      ),
      budget,
      estimatedTokens: estimateHistoryTokens(fullConversation)
    }
  }

  if (turns.length === 1) {
    const anchor = fitTurnForPacket(turns[0], budget, (projection) =>
      renderLongPacket(projection, [], 1)
    )
    if (!anchor) return undefined
    const preamble = renderLongPacket(anchor, [], 1)
    return {
      preamble,
      selectedMessageIndexes: anchor.selectedMessageIndexes,
      budget,
      estimatedTokens: estimateHistoryTokens(preamble)
    }
  }

  const anchorTurn = turns[0]
  const anchorProjectionBudget = Math.max(1, Math.floor(budget * 0.3))
  const anchor =
    projectTurn(anchorTurn, anchorProjectionBudget) ??
    fitTurnForPacket(anchorTurn, budget, (projection) =>
      renderLongPacket(projection, [], turns.length)
    )
  if (!anchor) return undefined

  const recent: ProjectedTurn[] = []
  const latestTurn = turns.at(-1)!
  const latestFull = fullTurn(latestTurn)
  const latestCandidate = renderLongPacket(anchor, [latestFull], turns.length)
  if (estimateHistoryTokens(latestCandidate) <= budget) {
    recent.unshift(latestFull)
  } else {
    const latest = fitTurnForPacket(latestTurn, budget, (projection) =>
      renderLongPacket(anchor, [projection], turns.length)
    )
    if (latest) recent.unshift(latest)
  }

  for (let index = turns.length - 2; index > 0; index -= 1) {
    const turn = fullTurn(turns[index])
    const candidate = renderLongPacket(anchor, [turn, ...recent], turns.length)
    if (estimateHistoryTokens(candidate) > budget) break
    recent.unshift(turn)
  }

  const preamble = renderLongPacket(anchor, recent, turns.length)
  return {
    preamble,
    selectedMessageIndexes: [
      ...anchor.selectedMessageIndexes,
      ...recent.flatMap((turn) => turn.selectedMessageIndexes)
    ],
    budget,
    estimatedTokens: estimateHistoryTokens(preamble)
  }
}

// Compatibility wrapper for non-workspace consumers that need text only. New workspace replay paths
// use buildHistoryReplay() so media selection follows the admitted message indexes.
export const buildHistoryPreamble = (
  messages: HistoryMessage[],
  descriptor: HistoryReplayDescriptor | number = { target: 'claude-code' }
): string | undefined =>
  buildHistoryReplay(
    messages,
    typeof descriptor === 'number' ? { target: 'claude-code', budget: descriptor } : descriptor
  )?.preamble
