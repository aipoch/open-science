// Dev-only streaming pipeline counters for before/after perf comparisons. Counting is a few
// integer increments per call, so it runs everywhere; only the `window.__streamingMetrics`
// handle is DEV-gated (tree-shaken out of production renderer builds).
const streamingMetrics = {
  // Assistant chunk events applied to the session store (workspace-events.ts).
  acpChunkEventsReceived: 0,
  // zustand commits performed by the presentation-tick applier (appendAgentMessageChunk(s)).
  agentMessageChunkCommits: 0,
  // Individual chunks applied across those commits; chunks/commit is the tick-batching win.
  agentMessageChunksCommitted: 0
}

export const recordAcpChunkEventReceived = (): void => {
  streamingMetrics.acpChunkEventsReceived += 1
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
