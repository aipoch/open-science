import type { AcpAgentRuntimeUpdate, AcpRuntimeEvent } from '../../src/shared/acp'
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

export const AGENT_RUNTIME_UPDATE_FIXTURE = {
  scope: {
    projectId: 'project-1',
    sessionId: 'session-1',
    agentFrameId: 'agent-frame-1',
    attemptId: 'attempt-1',
    runtimeSegmentId: 'runtime-segment-1',
    promptMessageId: 'prompt-message-1'
  },
  event: {
    id: 'agent-runtime-event-1',
    timestamp: 1_700_000_000_456,
    kind: 'tool',
    level: 'info',
    toolCallId: 'tool-call-1',
    title: 'Read evidence',
    status: 'in_progress'
  }
} satisfies AcpAgentRuntimeUpdate

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
