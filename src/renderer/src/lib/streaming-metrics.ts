// Dev-only streaming pipeline counters for before/after perf comparisons. Counting is a few
// integer increments per call, so it runs everywhere; only the `window.__streamingMetrics`
// handle is DEV-gated (tree-shaken out of production renderer builds).
const streamingMetrics = {
  // Assistant chunk events applied to the session store (workspace-events.ts).
  acpChunkEventsReceived: 0,
  // zustand commits performed by the presentation-tick applier (appendAgentMessageChunk(s)).
  agentMessageChunkCommits: 0,
  // Individual chunks applied across those commits; chunks/commit is the tick-batching win.
  agentMessageChunksCommitted: 0,
  // Ring buffer of recent apply-order events for diagnosing text/tool ordering in real
  // sessions: read window.__streamingMetrics.events in a dev build after a misordered turn.
  events: [] as Array<{
    t: number
    kind: string
    id: string
    len?: number
    title?: string
  }>
}

const MAX_TIMELINE_EVENTS = 200

const pushTimelineEvent = (event: {
  kind: string
  id: string
  len?: number
  title?: string
}): void => {
  streamingMetrics.events.push({ t: Date.now(), ...event })
  if (streamingMetrics.events.length > MAX_TIMELINE_EVENTS) {
    streamingMetrics.events.splice(0, streamingMetrics.events.length - MAX_TIMELINE_EVENTS)
  }
}

export const recordAcpChunkEventReceived = (): void => {
  streamingMetrics.acpChunkEventsReceived += 1
}

export const recordTextEventApplied = (streamId: string, textLength: number): void => {
  pushTimelineEvent({ kind: 'text', id: streamId, len: textLength })
}

export const recordToolEventApplied = (toolCallId: string, title?: string): void => {
  pushTimelineEvent({ kind: 'tool', id: toolCallId, title })
}

export const recordAgentMessageChunkCommit = (chunkCount: number): void => {
  streamingMetrics.agentMessageChunkCommits += 1
  streamingMetrics.agentMessageChunksCommitted += chunkCount
}

export const getStreamingMetrics = (): Readonly<typeof streamingMetrics> => ({
  ...streamingMetrics
})

export const resetStreamingMetrics = (): void => {
  streamingMetrics.acpChunkEventsReceived = 0
  streamingMetrics.agentMessageChunkCommits = 0
  streamingMetrics.agentMessageChunksCommitted = 0
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // Live reference: reading window.__streamingMetrics in the console always shows current values.
  ;(window as unknown as { __streamingMetrics: typeof streamingMetrics }).__streamingMetrics =
    streamingMetrics
}
