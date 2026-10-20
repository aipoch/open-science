// SDK wire response fixture; host protocol compatibility is tested outside this package.
export const TERMINAL_EVENT_FIXTURE = {
  id: 'terminal-certification',
  timestamp: 1_700_000_000_123,
  kind: 'stop',
  level: 'info',
  sessionId: 'session-1',
  promptMessageId: 'prompt-message',
  terminalOutput: 'analysis complete',
  terminalExitCode: 0,
  turnUsage: {
    inputTokens: 17,
    cacheTokens: 5,
    cachedReadTokens: 3,
    cachedWriteTokens: 2,
    outputTokens: 9,
    turnCount: 4
  }
} as const

export const PUBLIC_TERMINAL_FIXTURE = { type: 'run.event', data: TERMINAL_EVENT_FIXTURE } as const
