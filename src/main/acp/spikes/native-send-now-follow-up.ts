// Spike-only model of a host that can consume two overlapping `session/prompt`
// RPCs on one `ActiveSession.nextUpdate()` queue.
//
// Claude Agent ACP settles the previous prompt with `end_turn` when the next
// user echo is promoted, then writes later `session/update`s. The client SDK
// enqueues that JSON-RPC result as `stop` on the same queue. Adopt-after-stop
// starts a new host turn at each `stop` and does not send a third prompt.

export type FollowUpStreamEvent =
  Readonly<{ kind: 'update'; text: string }> | Readonly<{ kind: 'stop' }>

export type AdoptedTurn = Readonly<{
  texts: readonly string[]
  stopped: boolean
}>

export const attributeByAdoptAfterStop = (
  events: readonly FollowUpStreamEvent[]
): readonly AdoptedTurn[] => {
  const turns: Array<{ texts: string[]; stopped: boolean }> = [{ texts: [], stopped: false }]
  for (const event of events) {
    const current = turns.at(-1)
    if (!current) continue
    if (event.kind === 'update') {
      current.texts.push(event.text)
      continue
    }
    current.stopped = true
    turns.push({ texts: [], stopped: false })
  }
  if (turns.at(-1)?.texts.length === 0 && turns.at(-1)?.stopped === false) turns.pop()
  return turns.map((turn) =>
    Object.freeze({ texts: Object.freeze([...turn.texts]), stopped: turn.stopped })
  )
}

export const attributeBySingleCurrent = (
  events: readonly FollowUpStreamEvent[]
): readonly string[] =>
  Object.freeze(events.flatMap((event) => (event.kind === 'update' ? [event.text] : [])))

export const CLAUDE_HANDOFF_ORDER = Object.freeze([
  { kind: 'update', text: 'one' },
  { kind: 'stop' },
  { kind: 'update', text: 'two' },
  { kind: 'stop' }
] as const satisfies readonly FollowUpStreamEvent[])

// Residual risk: if follow-up chunks are flushed before the previous prompt's
// JSON-RPC result, adopt-after-stop would still stamp them on the first turn.
export const INTERLEAVED_FOLLOW_UP_ORDER = Object.freeze([
  { kind: 'update', text: 'one' },
  { kind: 'update', text: 'two' },
  { kind: 'stop' },
  { kind: 'stop' }
] as const satisfies readonly FollowUpStreamEvent[])
