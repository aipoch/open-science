import { describe, expect, it } from 'vitest'
import { materializeSessionConversationGraph } from '../session-conversation-graph-materialization'
import { createSessionFile, decodeSessionFile, persistedChatSessionCodec } from './file-codec'
import { sanitizePromptPreparation } from './prompt-preparation'
import type { PersistedChatSession } from './session'

const baseSession = (): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'idle',
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 5,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })

const marker = (): Record<string, unknown> => ({
  id: 'prep-1',
  projectId: 'p',
  sessionId: 's',
  promptMessageId: 'prompt',
  mode: 'resume',
  preparedAt: 4,
  previousState: {
    status: 'error',
    error: 'Interrupted',
    errorReportable: false,
    resumeRecovery: { kind: 'resume-required', cause: 'app-restart', promptMessageId: 'prompt' }
  },
  expectedState: { status: 'idle' }
})

describe('Prompt Preparation marker decoding', () => {
  it('strips unknown fields at every level instead of dropping the marker', () => {
    const raw = {
      ...marker(),
      futureTop: { nested: true },
      previousState: {
        ...(marker().previousState as object),
        futureState: 1,
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt',
          futureRecovery: 'x'
        }
      },
      expectedState: { status: 'idle', futureState: 2 },
      noticeBaseline: {
        messageBranchId: 'branch',
        promptMessageId: 'prompt',
        futureBaseline: true,
        state: { status: 'idle', futureState: 3 }
      }
    }
    expect(sanitizePromptPreparation(raw, baseSession())).toEqual({
      ...marker(),
      noticeBaseline: {
        messageBranchId: 'branch',
        promptMessageId: 'prompt',
        state: { status: 'idle' }
      }
    })
  })

  it('does not alias or retain unknown fields of the submitted object', () => {
    const raw = { ...marker(), expectedState: { status: 'idle', futureState: 2 } }
    const result = sanitizePromptPreparation(raw, baseSession())
    expect(result?.expectedState).not.toBe(raw.expectedState)
    expect(Object.keys(result?.expectedState ?? {})).toEqual(['status'])
  })

  it('treats an unknown recovery kind or cause as no recovery, like the Session decoder', () => {
    const raw = {
      ...marker(),
      previousState: {
        status: 'error',
        resumeRecovery: { kind: 'resume-required', cause: 'future-cause' }
      },
      expectedState: {
        status: 'error',
        resumeRecovery: { kind: 'future-kind', cause: 'cancelled' }
      }
    }
    const result = sanitizePromptPreparation(raw, baseSession())
    expect(result?.previousState).toEqual({ status: 'error' })
    expect(result?.expectedState).toEqual({ status: 'error' })
  })

  it.each([
    ['unknown status', { previousState: { status: 'paused' } }],
    ['non-record recovery', { previousState: { status: 'error', resumeRecovery: 'resume' } }],
    [
      'oversized recovery prompt',
      {
        previousState: {
          status: 'error',
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'cancelled',
            promptMessageId: 'x'.repeat(257)
          }
        }
      }
    ],
    ['non-string error', { expectedState: { status: 'error', error: 4 } }],
    ['unknown mode', { mode: 'future' }],
    ['foreign Session', { sessionId: 'other' }],
    ['foreign Project', { projectId: 'other' }],
    ['negative timestamp', { preparedAt: -1 }]
  ])('still rejects an invalid known field: %s', (_name, patch) => {
    expect(sanitizePromptPreparation({ ...marker(), ...patch }, baseSession())).toBeUndefined()
  })

  it('omits an invalid noticeBaseline without invalidating the marker', () => {
    const result = sanitizePromptPreparation(
      { ...marker(), noticeBaseline: { messageBranchId: 'b', state: { status: 'paused' } } },
      baseSession()
    )
    expect(result).toBeDefined()
    expect(result?.noticeBaseline).toBeUndefined()
  })

  it('keeps the activeRun cross-check strict for a marker with extra fields', () => {
    const session = { ...baseSession(), activeRun: { promptMessageId: 'prompt', startedAt: 9 } }
    const raw = { ...marker(), futureTop: 1 }
    expect(sanitizePromptPreparation(raw, session)).toBeUndefined()
    expect(sanitizePromptPreparation({ ...raw, runStartedAt: 9 }, session)).toMatchObject({
      runStartedAt: 9
    })
    expect(sanitizePromptPreparation({ ...raw, runStartedAt: 8 }, session)).toBeUndefined()
  })
})

describe('Session files written by a future version', () => {
  const futureFile = (): Record<string, unknown> => {
    const session = baseSession()
    const file = JSON.parse(
      JSON.stringify(createSessionFile({ ...session, promptPreparation: marker() as never }))
    ) as {
      session: Record<string, unknown> & {
        messages: Record<string, unknown>[]
        conversationGraph: { messages: Record<string, unknown>[] }
        promptPreparation: Record<string, unknown>
      }
    }
    const outcome = { kind: 'failed', settledAt: 3, error: 'Bad', futureOutcomeField: { a: 1 } }
    for (const message of [...file.session.messages, ...file.session.conversationGraph.messages])
      message.turnOutcome = outcome
    file.session.promptPreparation = {
      ...file.session.promptPreparation,
      futureTop: true,
      expectedState: { status: 'idle', futureState: 1 }
    }
    return file as unknown as Record<string, unknown>
  }

  it('loads as found, keeping historical outcomes and the preparation witness', () => {
    const decoded = decodeSessionFile(futureFile(), { preserveRuntimeState: true })
    expect(decoded.status).toBe('ok')
    if (decoded.status !== 'ok') throw new Error('Expected Session decode')
    const outcome = { kind: 'failed', settledAt: 3, error: 'Bad' }
    expect(decoded.session.messages[0].turnOutcome).toEqual(outcome)
    expect(decoded.session.conversationGraph?.messages[0].turnOutcome).toEqual(outcome)
    expect(decoded.session.promptPreparation?.id).toBe('prep-1')
    expect(decoded.session.promptPreparation?.expectedState).toEqual({ status: 'idle' })
    expect(decoded.session.promptPreparation).not.toHaveProperty('futureTop')
  })

  it('also loads through the restart path without invalidating the file', () => {
    expect(decodeSessionFile(futureFile()).status).toBe('ok')
  })

  it('canonicalizes the wire payload so extra fields cannot ride into Main authority', () => {
    const file = futureFile() as { session: unknown }
    const parsed = persistedChatSessionCodec.parse(file.session)
    expect(JSON.stringify(parsed)).not.toContain('futureOutcomeField')
    expect(JSON.stringify(parsed)).not.toContain('futureTop')
    expect(JSON.stringify(parsed)).not.toContain('futureState')
  })
})
