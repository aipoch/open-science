import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_COMPOSER_ATTACHMENTS,
  uploadApplicationCommandContracts,
  type FinalizeUploadSessionRequest,
  type UploadedAttachment
} from '../../../../shared/uploads'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatMessage
} from '../../stores/session-store'
import {
  branchWorkspaceSessionFromMessage,
  reconcileBranchedAttachments
} from './workspace-runtime-session-branch-owner'

describe('branchWorkspaceSessionFromMessage', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a fresh provider branch from replay-pending persisted history', async () => {
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
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'source-session'
          ? { ...session, pendingHistoryReplay: { kind: 'all' as const } }
          : session
      )
    }))
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

  it('finalizes legacy branch history in bounded requests', async () => {
    const uploads = Array.from({ length: MAX_COMPOSER_ATTACHMENTS + 1 }, (_, index) => ({
      id: `legacy-upload-${index}`,
      sessionId: 'source-session',
      name: `legacy-${index}.txt`,
      originalName: `legacy-${index}.txt`,
      path: `/legacy/uploads/legacy-${index}.txt`,
      mimeType: 'text/plain',
      size: index + 1
    }))
    const messages: ChatMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        content: 'Review the first legacy upload batch',
        status: 'complete',
        eventIds: [],
        uploads: uploads.slice(0, MAX_COMPOSER_ATTACHMENTS),
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'message-2',
        role: 'user',
        content: 'Review one more legacy upload',
        status: 'complete',
        eventIds: [],
        uploads: uploads.slice(MAX_COMPOSER_ATTACHMENTS),
        createdAt: 2,
        updatedAt: 2
      }
    ]
    const finalizeSession = vi.fn(
      async (request: FinalizeUploadSessionRequest): Promise<UploadedAttachment[]> => {
        const [parsed] = uploadApplicationCommandContracts.finalizeSession.args.parse([request])
        return parsed.attachments.map((attachment) => ({
          ...attachment,
          versionId: `version-${attachment.id}`,
          versionNumber: 1,
          path: `upload-version:project-1/source-session/version-${attachment.id}`
        }))
      }
    )
    vi.stubGlobal('window', { api: { uploads: { finalizeSession } } })

    await reconcileBranchedAttachments('source-session', 'child-session', messages, 'project-1')

    expect(finalizeSession).toHaveBeenCalledTimes(2)
    expect(finalizeSession.mock.calls.map(([request]) => request.attachments.length)).toEqual([
      MAX_COMPOSER_ATTACHMENTS,
      1
    ])
  })
})
