import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { branchWorkspaceSessionFromMessage } from './workspace-runtime-session-branch-owner'

describe('branchWorkspaceSessionFromMessage', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
  })

  it('creates the provider branch with the inherited conversation Memory preference', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'first question',
      cwd: '/workspace/project',
      projectId: 'project-1'
    })
    const answer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'answer-stream',
      eventId: 'answer-event',
      content: 'first answer'
    })
    useSessionStore.getState().finishRun('source-session')
    useSessionStore.getState().setMemoryEnabled('source-session', false)
    const failure = new Error('stop after provider request')
    const createSession = vi.fn(async () => {
      throw failure
    })

    await expect(
      branchWorkspaceSessionFromMessage(
        { createSession },
        {
          sourceSessionId: 'source-session',
          sourceMessageId: answer?.messageId ?? ''
        }
      )
    ).rejects.toBe(failure)

    expect(createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      undefined,
      undefined,
      false
    )
  })
})
