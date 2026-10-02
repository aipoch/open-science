import { describe, expect, it } from 'vitest'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { clearUnanchoredAttachmentRecovery } from './runtime-attachment-recovery'

const fixture = (): PersistedChatSession => ({
  id: 'session',
  projectId: 'project',
  title: 'Legacy',
  cwd: '/workspace',
  status: 'error',
  error: 'Interrupted',
  errorReportable: false,
  resumeRecovery: { kind: 'resume-required', cause: 'app-restart' },
  messages: [],
  createdAt: 1,
  updatedAt: 2
})

describe('successful attachment recovery', () => {
  it('releases an old attachment-only notice without changing history', () => {
    const session = fixture()
    const recovered = clearUnanchoredAttachmentRecovery(session)
    expect(recovered).toMatchObject({ status: 'idle', messages: [] })
    expect(recovered.resumeRecovery).toBeUndefined()
    expect(recovered.error).toBeUndefined()
    expect(recovered.messages).toBe(session.messages)
    expect(session.error).toBe('Interrupted')
  })

  it('preserves recovery and outcomes when a real prompt exists, including hidden controls', () => {
    const session = materializeSessionConversationGraph({
      ...fixture(),
      messages: [
        {
          id: 'prompt',
          role: 'user',
          content: 'Save as skill',
          status: 'complete',
          turnIntent: 'save-as-skill',
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          turnOutcome: {
            kind: 'interrupted',
            cause: 'app-restart',
            recovery: 'resume',
            settledAt: 2
          }
        }
      ]
    })
    expect(clearUnanchoredAttachmentRecovery(session)).toBe(session)
  })

  it('preserves active admission and unrelated errors', () => {
    const running = { ...fixture(), activeRun: { promptMessageId: 'prompt', startedAt: 2 } }
    expect(clearUnanchoredAttachmentRecovery(running)).toBe(running)
    const unrelated = { ...fixture(), resumeRecovery: undefined, error: 'Storage unavailable' }
    expect(clearUnanchoredAttachmentRecovery(unrelated)).toBe(unrelated)
  })
})
