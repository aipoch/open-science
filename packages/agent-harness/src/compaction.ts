export type ContextItem = Readonly<
  { id: string; text: string } & (
    | { kind: 'message'; role: 'user' | 'assistant' }
    | { kind: 'summary' }
    | { kind: 'tool-call' | 'tool-result'; callId: string }
  )
>

export type ContextSnapshot = Readonly<{
  scope: Readonly<{
    sessionId: string
    frameId: string
    branchId: string
    generation: string
    routeId: string
  }>
  revision: number
  items: readonly ContextItem[]
}>

export type CompactionProposal = Readonly<{
  expected: ContextSnapshot
  sourceIds: readonly string[]
  replacement: ContextItem
  preserved: readonly ContextItem[]
  items: readonly ContextItem[]
  beforeTokens: number
  afterTokens: number
}>

export type CompactionOutcome =
  | Readonly<{ status: 'within-budget' | 'uncompactable' | 'not-smaller' | 'stale' }>
  | Readonly<{ status: 'committed'; tokens: number; fitsBudget: boolean }>

export type CompactionOptions = Readonly<{
  snapshot: ContextSnapshot
  summaryId: string
  inputBudget: number
  keepRecentItems: number
  keepRecentTokens?: number
  /** Session policy; low-level callers must be able to persist the preserved messages. */
  preserveLatestUser?: boolean
  signal: AbortSignal
  /** Price the complete request, including trusted instructions, schemas and summary framing. */
  measure: (items: readonly ContextItem[]) => number
  /** No business tools. Return untrusted summary text, never authority or permissions. */
  summarize: (source: readonly ContextItem[], signal: AbortSignal) => Promise<string>
  /** Atomic scope/revision/cancellation check + durable commit. False means no write. */
  commit: (proposal: CompactionProposal, signal: AbortSignal) => Promise<boolean>
}>

const integer = (value: number, minimum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error('Invalid context budget or revision')
}

/** Single attempt only. The host owns storage, route binding, measurement and summary admission. */
export async function compactContext(options: CompactionOptions): Promise<CompactionOutcome> {
  const { signal, inputBudget, keepRecentItems, summaryId, measure, summarize, commit } = options
  signal.throwIfAborted()
  integer(inputBudget, 1)
  integer(keepRecentItems, 1)
  integer(options.snapshot.revision, 0)
  const expected: ContextSnapshot = Object.freeze({
    scope: Object.freeze({ ...options.snapshot.scope }),
    revision: options.snapshot.revision,
    items: Object.freeze(options.snapshot.items.map((item) => Object.freeze({ ...item })))
  })
  for (const value of [
    summaryId,
    expected.scope.sessionId,
    expected.scope.frameId,
    expected.scope.branchId,
    expected.scope.generation,
    expected.scope.routeId
  ]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Missing context identity')
  }
  const ids = new Set<string>()
  const calls = new Set<string>()
  const pending = new Set<string>()
  let boundary = 0
  const boundaries: number[] = []
  expected.items.forEach((item, index) => {
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id) ||
      item.id === summaryId ||
      typeof item.text !== 'string'
    )
      throw new Error('Invalid context item')
    ids.add(item.id)
    if (item.kind === 'tool-call' || item.kind === 'tool-result') {
      if (typeof item.callId !== 'string' || !item.callId) throw new Error('Missing tool identity')
      if (item.kind === 'tool-call') {
        if (calls.has(item.callId)) throw new Error('Duplicate tool call')
        calls.add(item.callId)
        pending.add(item.callId)
      } else if (!pending.delete(item.callId)) throw new Error('Orphan tool result')
    } else if (
      item.kind !== 'summary' &&
      (item.kind !== 'message' || !['user', 'assistant'].includes(item.role))
    ) {
      throw new Error('Unsupported context item')
    }
    if (!pending.size && index + 1 <= expected.items.length - keepRecentItems) {
      boundary = index + 1
      boundaries.push(boundary)
    }
  })
  const price = (items: readonly ContextItem[]): number => {
    const tokens = measure(items)
    integer(tokens, 0)
    return tokens
  }
  const beforeTokens = price(expected.items)
  if (beforeTokens <= inputBudget) return { status: 'within-budget' }
  if (!boundary) return { status: 'uncompactable' }
  if (options.keepRecentTokens !== undefined) {
    integer(options.keepRecentTokens, 1)
    const envelope = price([])
    let low = 0,
      high = boundaries.length - 1
    boundary = boundaries[0]
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (price(expected.items.slice(boundaries[middle])) - envelope >= options.keepRecentTokens) {
        boundary = boundaries[middle]
        low = middle + 1
      } else high = middle - 1
    }
  }
  const isUser = (item: ContextItem): boolean => item.kind === 'message' && item.role === 'user'
  const latestUser = expected.items.findLastIndex(isUser)
  let userStart = latestUser
  while (userStart > 0 && isUser(expected.items[userStart - 1])) userStart--
  const preserved = Object.freeze(
    !options.preserveLatestUser || latestUser < 0
      ? []
      : expected.items.slice(userStart, Math.min(boundary, latestUser + 1))
  )
  const source = Object.freeze(expected.items.slice(0, boundary))
  signal.throwIfAborted()
  const text = await summarize(source, signal)
  signal.throwIfAborted()
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty summary')
  const replacement: ContextItem = Object.freeze({ id: summaryId, kind: 'summary', text })
  const items = Object.freeze([replacement, ...preserved, ...expected.items.slice(boundary)])
  const afterTokens = price(items)
  if (afterTokens >= beforeTokens) return { status: 'not-smaller' }
  const proposal: CompactionProposal = Object.freeze({
    expected,
    sourceIds: Object.freeze(source.map((item) => item.id)),
    replacement,
    preserved,
    items,
    beforeTokens,
    afterTokens
  })
  signal.throwIfAborted()
  // No post-commit abort check: an acknowledged durable write must never be reported as rolled back.
  if (!(await commit(proposal, signal))) return { status: 'stale' }
  return { status: 'committed', tokens: afterTokens, fitsBudget: afterTokens <= inputBudget }
}
