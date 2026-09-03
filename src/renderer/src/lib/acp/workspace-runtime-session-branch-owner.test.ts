import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_COMPOSER_ATTACHMENTS,
  uploadApplicationCommandContracts,
  type FinalizeUploadSessionRequest,
  type UploadedAttachment
} from '../../../../shared/uploads'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
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

  it('relinks the immutable PDF snapshot when branching from a message', async () => {
    const pdfContext = {
      version: 1 as const,
      bindings: [
        {
          version: 1 as const,
          bindingId: 'source-binding',
          sourceKind: 'upload-version' as const,
          sourceFileId: 'file-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session',
          name: 'paper.pdf',
          mimeType: 'application/pdf' as const,
          sizeBytes: 1024,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ],
      activeBindingId: 'source-binding',
      readingPosition: { pageNumber: 17, pageCount: 40 }
    }
    useSessionStore.getState().appendUserMessage({
      sessionId: 'source-session',
      content: 'Summarize the linked paper',
      cwd: '/workspace/project',
      projectId: 'project-1',
      pdfContext
    })
    const answer = useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'source-session',
      streamId: 'answer-stream',
      eventId: 'answer-event',
      content: 'The paper discusses reproducibility.'
    })
    useSessionStore.getState().finishRun('source-session')

    const linkedRuntimeContext = {
      version: 1 as const,
      revision: 1,
      pdfContext: {
        version: 1 as const,
        bindings: [{ ...pdfContext.bindings[0], bindingId: 'child-binding' }]
      }
    }
    let materialized!: PersistedChatSession
    const saveSession = vi.fn(async (session: PersistedChatSession) => {
      materialized = session
      return session
    })
    const setDelegationPolicy = vi.fn(async () => materialized)
    const linkPdfContext = vi.fn().mockResolvedValue(linkedRuntimeContext)
    vi.stubGlobal('window', {
      api: { sessions: { saveSession, setDelegationPolicy, linkPdfContext } }
    })
    const createSession = vi.fn().mockResolvedValue({
      sessionId: 'branched-session',
      cwd: '/workspace/project'
    })

    await expect(
      branchWorkspaceSessionFromMessage(
        { createSession },
        {
          sourceSessionId: 'source-session',
          sourceMessageId: answer?.messageId ?? ''
        }
      )
    ).resolves.toEqual({
      sessionId: 'branched-session',
      messageId: answer?.messageId
    })

    expect(createSession).toHaveBeenCalledWith(
      '/workspace/project',
      'project-1',
      'ask',
      undefined,
      undefined,
      true,
      true
    )
    expect(linkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'branched-session',
      expectedRevision: 0,
      sources: [
        {
          sourceKind: 'upload-version',
          sourceFileId: 'file-1',
          sourceVersionId: 'version-1'
        }
      ]
    })
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === 'branched-session')
        ?.runtimeContext
    ).toEqual(linkedRuntimeContext)
  })
})
