export type HistoryReplayTarget =
  'claude-code' | 'opencode' | 'codebuddy' | 'codex-response' | 'codex-bridge'

export type HistoryReplayDescriptor = {
  target: HistoryReplayTarget
  contextWindow?: number
  // Test/diagnostic override; production callers use the target policy above.
  budget?: number
}
