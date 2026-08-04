import type { AcpRuntimeEvent } from '../../src/shared/acp'
import type { ConversationSkillImportApprovalRequest } from '../../src/shared/settings'

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
} satisfies AcpRuntimeEvent

export const PUBLIC_TERMINAL_FIXTURE = { type: 'run.event', data: TERMINAL_EVENT_FIXTURE } as const

export const SKILL_IMPORT_APPROVAL_FIXTURE = {
  id: 'skill-approval',
  sessionId: 'session-1',
  source: { kind: 'github', label: 'research-tools' },
  previews: [
    {
      subPath: 'skills/research-tools',
      name: 'research-tools',
      description: 'Research helpers',
      metadata: {},
      body: '# Research tools',
      files: ['SKILL.md'],
      alreadyImported: false,
      githubUrl: 'https://github.com/example/research-tools'
    }
  ],
  skipped: []
} satisfies ConversationSkillImportApprovalRequest
