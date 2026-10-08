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
  it('projects an unexpected ACP close as a resumable, non-reportable interruption without provider wording', () => {
    const { session, scope } = fixture()
    const result = applyRuntimeSessionEvents(session, scope, [
      event('message', {
        id: 'partial',
        timestamp: 2,
        messageId: 'output',
        role: 'assistant',
        text: 'Partial output'
      }),
      event('tool', {
        id: 'tool',
        timestamp: 3,
        toolCallId: 'open-tool',
        title: 'Tool',
        status: 'in_progress'
      }),
      event('error', {
        id: 'close',
        timestamp: 4,
        text: 'ACP connection closed',
        providerError: false,
        interruptionCause: 'connection-lost'
      })
    ])
    expect(result.activeRun).toBeUndefined()
    expect(result.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'connection-lost',
      promptMessageId: scope.promptMessageId
    })
    expect(result.errorReportable).toBe(false)
    expect(result.messages.find(({ id }) => id === scope.promptMessageId)?.interrupted).toBe(true)
    expect(result.activities?.[0].status).toBe('failed')
  })

  it.each([
    ['The attached image is invalid.', false],
    ['unknown app invariant failed', true]
  ])('classifies Main-authored %s independently of providerError', (text, reportable) => {
    const { session, scope } = fixture()
    const result = applyRuntimeSessionEvents(session, scope, [
      event('error', { id: 'main-error', timestamp: 2, text })
    ])
    expect(result.errorReportable).toBe(reportable)
  })

  it('attributes a post-terminal Artifact cleanup failure without altering a newer active run', () => {
    const { session, scope } = fixture()
    const stopped = applyRuntimeSessionEvents(session, scope, [
      event('stop', { id: 'stop', timestamp: 2, text: 'end_turn' })
    ])
    const cleanup = event('error', {
      id: 'cleanup',
      timestamp: 3,
      text: 'cleanup failed',
      artifactFailure: true
    })
    expect(applyRuntimeSessionEvents(stopped, scope, [cleanup]).error).toBe('cleanup failed')
    const newer = {
      ...stopped,
      status: 'running' as const,
      activeRun: { promptMessageId: 'new-prompt', startedAt: 3 }
    }
    const projected = applyRuntimeSessionEvents(newer, scope, [cleanup])
    expect(projected.activeRun).toEqual(newer.activeRun)
    expect(projected.status).toBe('running')
  })

  it('rejects a delayed live release for an older execution of the same prompt', () => {
    const { session, scope } = fixture()
    session.activeRun!.startedAt = 10
    const result = applyRuntimeSessionEvents(session, scope, [
      event('error', {
        id: 'late',
        timestamp: 20,
        text: 'interrupted',
        interruptionCause: 'terminal-commit-failed',
        terminalCommitFailure: 'storage',
        terminalScope: { ...scope, projectId: session.projectId, executionId: 'old', startedAt: 1 }
      })
    ])
    expect(result.activeRun).toEqual(session.activeRun)
    expect(result.status).toBe('running')
    expect(result.messages[0].interrupted).toBeUndefined()
  })
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
      event('message', { id: 'off-1', timestamp: 4, role: 'assistant', text: 'hidden' }),
      event('tool', {
        id: 'off-review',
        timestamp: 5,
        toolCallId: 'app-approval:off-branch',
        appOwned: true,
        status: 'completed'
      })
    ])
    expect(projected.conversationGraph!.frames[0].activeBranchId).toBe(originalBranchId)
    expect(projected.messages.some(({ content }) => content === 'hidden')).toBe(false)
    expect(projected.activities?.some(({ id }) => id === 'app-approval:off-branch')).not.toBe(true)
    projected.conversationGraph = activateConversationBranch(
      projected.conversationGraph!,
      branch.id
    )
    const switched = applyRuntimeSessionEvents(projected, offBranchScope, [])
    expect(switched.activities?.find(({ id }) => id === 'app-approval:off-branch')).toMatchObject({
      appOwned: true
    })
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
    expect(replayed.status).toBe('idle')
    expect(replayed.messages[0]).toMatchObject({ interrupted: true })
    expect(replayed.messages[1]).toMatchObject({ status: 'error', content: 'partial' })
    expect(replayed.messages).toHaveLength(2)
  })
})

describe('Main terminal Turn Outcome attribution', () => {
  it.each(['ordinary', 'hidden', 'application', 'plan-first'] as const)(
    'settles the exact %s anchor',
    (source) => {
      const { session, scope } = fixture()
      for (const message of [session.messages[0], session.conversationGraph!.messages[0]]) {
        if (source === 'hidden') message.turnIntent = 'save-as-skill'
        if (source === 'plan-first') message.turnIntent = 'plan-first'
        if (source === 'application')
          message.attribution = {
            kind: 'application',
            feature: 'background-results',
            purpose: 'agent-result-delivery',
            deliveryKey: 'settlement',
            deliveryIds: ['result']
          }
      }
      const completed = applyRuntimeSessionEvents(session, scope, [
        event('stop', { id: 'done', timestamp: 4, text: 'end_turn' })
      ])
      expect(completed.messages[0].turnOutcome).toEqual({ kind: 'completed', settledAt: 4 })
      expect(completed.conversationGraph?.messages[0].turnOutcome).toEqual(
        completed.messages[0].turnOutcome
      )
      const failed = applyRuntimeSessionEvents(session, scope, [
        event('error', {
          id: 'failure',
          timestamp: 4,
          text: 'Provider rejected',
          providerError: true
        })
      ])
      expect(failed.messages[0].turnOutcome).toEqual({
        kind: 'failed',
        settledAt: 4,
        error: 'Provider rejected',
        errorReportable: false
      })
    }
  )

  it.each(['permission', 'plan', 'user-choice'] as const)(
    'does not settle a parked %s turn',
    (wait) => {
      const { session, scope } = fixture()
      session.error = 'Previous failure'
      session.errorReportable = true
      session.resumeRecovery = {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: scope.promptMessageId
      }
      if (wait === 'plan')
        session.runtimeContext = {
          version: 1,
          revision: 1,
          plan: {
            artifactId: 'plan',
            artifactVersionId: 'version',
            artifactChecksum: 'a'.repeat(64),
            approval: 'pending',
            originatingPromptMessageId: scope.promptMessageId,
            stepStatuses: {}
          }
        }
      if (wait === 'permission')
        session.runtimeContext = {
          version: 1,
          revision: 1,
          permission: { state: 'pending' } as never
        }
      const events =
        wait === 'user-choice'
          ? [
              event('tool', {
                id: 'question',
                timestamp: 2,
                title: 'Question',
                toolCallId: 'ask',
                status: 'in_progress',
                elicitation: {
                  state: 'pending',
                  durable: {
                    kind: 'agent-user-choice',
                    questions: [{ question: 'Choice?', options: [{ label: 'A' }, { label: 'B' }] }],
                    sequence: 1,
                    askedAt: 2
                  }
                }
              } as never)
            ]
          : []
      const waiting = applyRuntimeSessionEvents(session, scope, [
        ...events,
        event('stop', { id: 'stop', timestamp: 3, text: 'end_turn' })
      ])
      expect(waiting.messages[0].turnOutcome).toBeUndefined()
      expect(waiting.status).toBe(
        wait === 'permission'
          ? 'waiting-permission'
          : wait === 'plan'
            ? 'waiting-plan-approval'
            : 'waiting-for-user'
      )
      expect(waiting.activeRun).toBeUndefined()
      expect(waiting.error).toBeUndefined()
      expect(waiting.errorReportable).toBeUndefined()
      expect(waiting.resumeRecovery).toBeUndefined()
    }
  )

  it('records Artifact publication failure and interrupted causes on the anchored turn', () => {
    const { session, scope } = fixture()
    const attached = attachRuntimeSessionArtifacts(session, scope, {
      eventId: 'artifact-reference',
      runId: 'artifact-run',
      timestamp: 2,
      artifacts: [
        {
          id: 'pending-file',
          projectId: session.projectId,
          sessionId: session.id,
          name: 'result.csv',
          path: '/managed/session/.pending/artifact-run/result.csv',
          fileUrl: 'file:///managed/session/.pending/artifact-run/result.csv',
          size: 3,
          mtimeMs: 2,
          createdAt: '1970-01-01T00:00:00.002Z'
        }
      ]
    })
    const publication = applyRuntimeSessionEvents(attached.session, scope, [
      event('error', {
        id: 'artifacts',
        timestamp: 4,
        text: 'Artifacts failed',
        artifactFailure: true,
        errorReportable: false
      })
    ])
    expect(publication.messages[0].turnOutcome).toMatchObject({
      kind: 'failed',
      recovery: 'retry-artifact-publication',
      errorReportable: false
    })
    const cleanup = applyRuntimeSessionEvents(session, scope, [
      event('error', {
        id: 'cleanup',
        timestamp: 4,
        text: 'Artifact cleanup failed',
        artifactFailure: true
      })
    ])
    expect(cleanup.messages[0].turnOutcome).toMatchObject({ kind: 'failed' })
    expect(cleanup.messages[0].turnOutcome).not.toHaveProperty('recovery')
    for (const cause of ['app-restart', 'connection-lost', 'terminal-commit-failed'] as const) {
      const interrupted = applyRuntimeSessionEvents(session, scope, [
        event('error', { id: cause, timestamp: 4, text: 'Interrupted', interruptionCause: cause })
      ])
      expect(interrupted.messages[0].turnOutcome).toMatchObject({
        kind: 'interrupted',
        cause,
        recovery: 'resume',
        errorReportable: false
      })
    }
  })
})

it('retains host provenance in both durable activity projections', () => {
  const { session, scope } = fixture()
  const result = applyRuntimeSessionEvents(session, scope, [
    event('tool', {
      id: 'review-start',
      timestamp: 2,
      toolCallId: 'app-approval:review',
      appOwned: true,
      providerToolName: 'Open-Science',
      title: 'Review code',
      status: 'in_progress'
    }),
    event('tool', {
      id: 'review-end',
      timestamp: 3,
      toolCallId: 'app-approval:review',
      appOwned: true,
      status: 'completed'
    })
  ])
  expect(result.activities?.[0]).toMatchObject({ appOwned: true, status: 'completed' })
  expect(result.conversationGraph?.activities[0]).toMatchObject({
    appOwned: true,
    messageBranchId: scope.messageBranchId
  })
})
