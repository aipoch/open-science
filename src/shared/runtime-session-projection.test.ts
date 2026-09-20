import { describe, expect, it } from 'vitest'

import { MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE, type AcpRuntimeEvent } from './acp'
import type { ArtifactFile } from './artifacts'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage
} from './conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from './session-persistence'
import {
  applyRuntimeSessionEvents,
  attachRuntimeSessionArtifacts,
  type RuntimeSessionScope
} from './runtime-session-projection'

const prompt = (id = 'prompt-1', timestamp = 1): PersistedChatMessage => ({
  id,
  role: 'user',
  content: 'Do the work',
  status: 'complete',
  eventIds: [],
  createdAt: timestamp,
  updatedAt: timestamp
})

const fixture = (): { session: PersistedChatSession; scope: RuntimeSessionScope } => {
  const message = prompt()
  const conversationGraph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages: [message],
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 1
  })
  const scope = {
    promptMessageId: message.id,
    agentFrameId: conversationGraph.rootFrameId,
    messageBranchId: conversationGraph.branches[0].id,
    runtimeSegmentId: conversationGraph.runtimeSegments[0].id
  }
  return {
    scope,
    session: {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd: '/workspace',
      status: 'running',
      permissionProfile: 'ask',
      messages: [message],
      conversationGraph,
      activeRun: { promptMessageId: message.id, startedAt: 1 },
      createdAt: 1,
      updatedAt: 1
    }
  }
}

const event = <Kind extends AcpRuntimeEvent['kind']>(
  kind: Kind,
  fields: Omit<Extract<AcpRuntimeEvent, { kind: Kind }>, 'kind' | 'level' | 'sessionId'>
): Extract<AcpRuntimeEvent, { kind: Kind }> =>
  ({ kind, level: 'info', sessionId: 'session-1', ...fields }) as Extract<
    AcpRuntimeEvent,
    { kind: Kind }
  >

describe('runtime Session projection', () => {
  it('appends partial chunks by stream, deduplicates events, and separates streams', () => {
    const { session, scope } = fixture()
    const events = [
      event('message', {
        id: 'e1',
        timestamp: 2,
        role: 'assistant',
        messageId: 'stream-a',
        text: 'a'
      }),
      event('message', {
        id: 'e2',
        timestamp: 3,
        role: 'assistant',
        messageId: 'stream-a',
        text: 'b'
      }),
      event('message', {
        id: 'e2',
        timestamp: 3,
        role: 'assistant',
        messageId: 'stream-a',
        text: 'b'
      }),
      event('message', {
        id: 'e3',
        timestamp: 4,
        role: 'assistant',
        messageId: 'stream-a',
        text: 'c'
      }),
      event('message', {
        id: 'e4',
        timestamp: 5,
        role: 'assistant',
        messageId: 'stream-b',
        text: 'other',
        image: { mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
      })
    ]
    const projected = applyRuntimeSessionEvents(session, scope, events)
    expect(projected.messages.slice(1).map(({ content }) => content)).toEqual(['abc', 'other'])
    expect(projected.messages[1].eventIds).toEqual(['e1', 'e2', 'e3'])
    expect(projected.messages[2].images).toEqual([
      { id: 'e4', mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }
    ])
  })

  it('routes events to an inactive branch without changing branch selection', () => {
    const { session, scope } = fixture()
    const originalBranchId = scope.messageBranchId
    const forked = forkEditedConversationMessage(
      session.conversationGraph!,
      scope.promptMessageId,
      'edited-branch',
      2
    )
    session.conversationGraph = activateConversationBranch(forked, originalBranchId)
    const editedPrompt = prompt('edited-prompt', 3)
    editedPrompt.content = 'Edited'
    const branch = session.conversationGraph.branches.find(({ id }) => id === 'edited-branch')!
    session.conversationGraph.messages.push({
      ...editedPrompt,
      agentFrameId: scope.agentFrameId,
      introducedOnBranchId: branch.id,
      parentMessageId: branch.headMessageId,
      runtimeSegmentId: scope.runtimeSegmentId,
      revisionRootMessageId: scope.promptMessageId,
      supersedesMessageId: scope.promptMessageId
    })
    branch.headMessageId = editedPrompt.id
    const offBranchScope = {
      ...scope,
      promptMessageId: editedPrompt.id,
      messageBranchId: branch.id
    }
    const projected = applyRuntimeSessionEvents(session, offBranchScope, [
      event('message', { id: 'off-1', timestamp: 4, role: 'assistant', text: 'hidden' })
    ])
    expect(projected.conversationGraph!.frames[0].activeBranchId).toBe(originalBranchId)
    expect(projected.messages.some(({ content }) => content === 'hidden')).toBe(false)
    expect(projected.conversationGraph!.messages.some(({ content }) => content === 'hidden')).toBe(
      true
    )
  })

  it('preserves tool metadata, elicitation, and activity group membership', () => {
    const { session, scope } = fixture()
    const projected = applyRuntimeSessionEvents(session, scope, [
      event('tool', {
        id: 'group-start',
        timestamp: 2,
        toolCallId: 'group-1',
        providerToolName: 'mcp__open-science-activity__begin_activity_group',
        rawInput: { title: 'Research phase' }
      }),
      event('tool', {
        id: 'tool-start',
        timestamp: 3,
        toolCallId: 'tool-1',
        title: 'Ask',
        status: 'in_progress',
        providerToolName: 'ask_user',
        rawInput: { question: '?' },
        toolLocations: [{ path: '/tmp/a', line: 4 }],
        elicitation: {
          state: 'pending',
          message: 'Choose an approach',
          fields: [],
          durable: {
            kind: 'agent-user-choice',
            requestId: 'request-1',
            promptMessageId: scope.promptMessageId
          }
        }
      }),
      event('tool', {
        id: 'tool-end',
        timestamp: 4,
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { answer: 'yes' }
      }),
      event('compaction', {
        id: 'compact',
        timestamp: 4.5,
        toolCallId: 'compaction-tool',
        title: 'Compact context',
        status: 'completed'
      }),
      event('message', { id: 'answer', timestamp: 5, role: 'assistant', text: 'Done' })
    ])
    expect(projected.activities?.[0]).toMatchObject({
      id: 'tool-1',
      status: 'completed',
      activityGroupId: 'group-1',
      rawInput: { question: '?' },
      rawOutput: { answer: 'yes' }
    })
    expect(projected.activities?.[0].elicitation?.state).toBe('pending')
    expect(projected.activities?.[1]).toMatchObject({
      id: 'compaction-tool',
      status: 'completed',
      providerToolName: 'ContextCompaction',
      toolKind: 'other'
    })
    expect(projected.activityGroups?.[0]).toMatchObject({
      id: 'group-1',
      activityIds: ['tool-1'],
      completedAt: 4.5
    })
  })

  it('synthesizes an artifact-only owner and records terminal usage on it', () => {
    const { session, scope } = fixture()
    const artifact: ArtifactFile = {
      id: 'version-1',
      versionId: 'version-1',
      projectId: 'project-1',
      sessionId: session.id,
      name: 'result.csv',
      path: '/managed/result.csv',
      fileUrl: 'file:///managed/result.csv',
      size: 3,
      mtimeMs: 10,
      isPublished: true,
      artifactId: 'artifact-1',
      versionNumber: 2,
      checksum: 'sha256-value',
      createdAt: '1970-01-01T00:00:01.000Z'
    }
    const attached = attachRuntimeSessionArtifacts(session, scope, {
      eventId: 'artifact-1',
      runId: 'run-1',
      artifacts: [artifact],
      timestamp: 2
    })
    const projected = applyRuntimeSessionEvents(attached.session, scope, [
      event('stop', {
        id: 'stop-1',
        timestamp: 3,
        turnUsage: { inputTokens: 2, cacheTokens: 0, outputTokens: 3, turnCount: 1 }
      })
    ])
    expect(projected.messages[1]).toMatchObject({
      id: attached.messageId,
      artifactIds: ['version-1'],
      turnUsage: { inputTokens: 2, cacheTokens: 0, outputTokens: 3 }
    })
    expect(projected.artifacts?.[0]).toEqual({
      id: 'version-1',
      kind: 'managed-file',
      path: '/managed/result.csv',
      fileUrl: 'file:///managed/result.csv',
      name: 'result.csv',
      mimeType: undefined,
      size: 3,
      createdAt: 1_000,
      mtimeMs: 10,
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 2,
      sha256: 'sha256-value'
    })
    const replay = attachRuntimeSessionArtifacts(attached.session, scope, {
      eventId: 'artifact-1',
      runId: 'run-1',
      artifacts: [artifact],
      timestamp: 9
    })
    expect(replay.session.filesRevision).toBe(attached.session.filesRevision)
    const changed = attachRuntimeSessionArtifacts(attached.session, scope, {
      eventId: 'artifact-2',
      runId: 'run-1',
      artifacts: [{ ...artifact, checksum: 'changed' }],
      timestamp: 10
    })
    expect(changed.session.filesRevision).toBe((attached.session.filesRevision ?? 0) + 1)
  })

  it('rejects an explicitly incompatible Artifact owner', () => {
    const { session, scope } = fixture()
    expect(() =>
      attachRuntimeSessionArtifacts(session, scope, {
        messageId: 'missing-owner',
        eventId: 'artifact',
        runId: 'run',
        artifacts: [],
        timestamp: 2
      })
    ).toThrow('outside the supplied Session scope')
  })

  it('adds image identities, enforces per-message limits, and normalizes Claude refusals', () => {
    const { session, scope } = fixture()
    session.agentFrameworkId = 'claude-code'
    const events: AcpRuntimeEvent[] = Array.from(
      { length: MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE + 1 },
      (_, index) =>
        event('message', {
          id: `image-${index}`,
          timestamp: index + 2,
          role: 'assistant',
          messageId: 'image-stream',
          text:
            index === 0
              ? 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).'
              : '',
          image: { mimeType: 'image/png', data: 'YQ==', byteLength: 1 }
        })
    )
    const projected = applyRuntimeSessionEvents(session, scope, events)
    expect(projected.messages[1].images).toHaveLength(MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE)
    expect(projected.messages[1].images?.[0].id).toBe('image-0')
    expect(projected.messages[1].content).toContain('selected model declined')
  })

  it('keeps pending elicitation waiting and does not clear an unrelated active run', () => {
    const { session, scope } = fixture()
    const waiting = applyRuntimeSessionEvents(session, scope, [
      event('tool', {
        id: 'question',
        timestamp: 2,
        toolCallId: 'question-tool',
        status: 'in_progress',
        elicitation: {
          state: 'pending',
          message: 'Choose an approach',
          fields: [],
          durable: {
            kind: 'agent-user-choice',
            requestId: 'r',
            promptMessageId: scope.promptMessageId
          }
        }
      }),
      event('stop', { id: 'stop', timestamp: 3 })
    ])
    expect(waiting.status).toBe('waiting-for-user')
    expect(waiting.activeRun).toBeUndefined()

    const unrelated = fixture()
    unrelated.session.activeRun = { promptMessageId: 'different-prompt', startedAt: 8 }
    const late = applyRuntimeSessionEvents(unrelated.session, unrelated.scope, [
      event('stop', { id: 'late-stop', timestamp: 9 })
    ])
    expect(late.activeRun).toEqual({ promptMessageId: 'different-prompt', startedAt: 8 })
    expect(late.status).toBe('running')
  })

  it('does not duplicate a retained-away replay after a successful terminal message', () => {
    const { session, scope } = fixture()
    const completed = applyRuntimeSessionEvents(session, scope, [
      event('message', {
        id: 'chunk',
        timestamp: 2,
        role: 'assistant',
        messageId: 'stream',
        text: 'once'
      }),
      event('stop', { id: 'stop', timestamp: 3 })
    ])
    const withLateSuccess = applyRuntimeSessionEvents(completed, scope, [
      event('message', {
        id: 'late-success',
        timestamp: 4,
        role: 'assistant',
        messageId: 'stream',
        text: ' late'
      })
    ])
    expect(withLateSuccess.conversationGraph!.messages[1]).toMatchObject({
      content: 'once late',
      status: 'complete'
    })
    withLateSuccess.conversationGraph!.messages[1].eventIds = []
    const retainedAwayLateReplay = applyRuntimeSessionEvents(withLateSuccess, scope, [
      event('message', {
        id: 'late-success',
        timestamp: 4,
        role: 'assistant',
        messageId: 'stream',
        text: ' late'
      })
    ])
    expect(retainedAwayLateReplay.conversationGraph!.messages[1].content).toBe('once late')
    completed.conversationGraph!.messages[1].eventIds = []
    const replayed = applyRuntimeSessionEvents(completed, scope, [
      event('message', {
        id: 'chunk',
        timestamp: 2,
        role: 'assistant',
        messageId: 'stream',
        text: 'once'
      })
    ])
    expect(replayed.conversationGraph!.messages[1].content).toBe('once')
    expect(replayed.conversationGraph!.messages[1].status).toBe('complete')
  })

  it('marks cancellation terminal and ignores a duplicate late terminal event', () => {
    const { session, scope } = fixture()
    const streamed = applyRuntimeSessionEvents(session, scope, [
      event('message', { id: 'chunk', timestamp: 2, role: 'assistant', text: 'partial' }),
      event('stop', { id: 'cancel', timestamp: 3, text: 'cancelled' })
    ])
    const replayed = applyRuntimeSessionEvents(streamed, scope, [
      event('stop', { id: 'cancel', timestamp: 3, text: 'cancelled' }),
      event('thought', { id: 'late-thought', timestamp: 4, text: 'private' }),
      event('message', {
        id: 'late-message',
        timestamp: 5,
        role: 'assistant',
        text: 'must not revive the turn'
      })
    ])
    expect(replayed.status).toBe('error')
    expect(replayed.messages[0]).toMatchObject({ interrupted: true })
    expect(replayed.messages[1]).toMatchObject({ status: 'error', content: 'partial' })
    expect(replayed.messages).toHaveLength(2)
  })
})
