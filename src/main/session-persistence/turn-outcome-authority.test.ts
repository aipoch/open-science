import { describe, expect, it } from 'vitest'
import {
  INTERRUPTED_SESSION_ERROR,
  latestOutcomePrompt,
  materializeSessionConversationGraph,
  normalizeSessionAfterRestore,
  resolveTurnOutcome,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { recordRestartTurnOutcome } from './turn-outcome-authority'

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  overrides: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

// The provider died while a permission continuation was running, after an in-turn steering reply.
const crashedDuringContinuingPermission = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'running',
    activeRun: { promptMessageId: 'prompt-1', startedAt: 2 },
    runtimeTranscriptOwner: 'main',
    messages: [
      message('prompt-1', 'user'),
      message('agent-1', 'agent', { responseToMessageId: 'prompt-1', status: 'streaming' }),
      message('steering-1', 'user', { responseToMessageId: 'prompt-1', createdAt: 3 })
    ],
    runtimeContext: {
      version: 1,
      revision: 4,
      permission: {
        state: 'continuing',
        request: {
          requestId: 'permission-1',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          title: 'Run npm test',
          isMcp: true,
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'a'.repeat(64),
        createdAt: 2
      }
    },
    createdAt: 1,
    updatedAt: 5
  })

describe('restart turn outcome after an in-turn reply', () => {
  it('persists the interrupted outcome on the admitted prompt through the real restore path', () => {
    const authority = crashedDuringContinuingPermission()
    const restored = normalizeSessionAfterRestore(authority)
    expect(restored.error).toBe(INTERRUPTED_SESSION_ERROR)
    expect(restored.resumeRecovery?.promptMessageId).toBe('prompt-1')

    const committed = recordRestartTurnOutcome(restored, authority)

    expect(resolveTurnOutcome(committed, 'prompt-1')).toMatchObject({
      kind: 'interrupted',
      cause: 'app-restart',
      recovery: 'resume'
    })
    expect(committed.messages.find(({ id }) => id === 'steering-1')?.turnOutcome).toBeUndefined()
    expect(committed.resumeRecovery?.promptMessageId).toBe(latestOutcomePrompt(committed)?.id)
  })
})
