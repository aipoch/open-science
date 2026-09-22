import { describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from './conversation-graph'
import {
  applySessionConversationCommands,
  sanitizeSessionConversationCommands
} from './session-conversation-command'
import type { PersistedChatMessage, PersistedChatSession } from './session-persistence'

const prompt = (
  id: string,
  content: string,
  timestamp: number,
  extra: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  ...extra
})

const fixture = (): PersistedChatSession => {
  const first = prompt('prompt-1', 'First', 1)
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    revision: 1,
    status: 'idle',
    permissionProfile: 'ask',
    messages: [first],
    conversationGraph: createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [first],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    }),
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 1
  }
}

const rootBranchId = (session: PersistedChatSession): string =>
  session.conversationGraph!.frames.find(({ id }) => id === session.conversationGraph!.rootFrameId)!
    .activeBranchId

describe('Session conversation commands', () => {
  it('authorizes recovery with durable evidence and reuses its run across retries', () => {
    const initial = fixture()
    initial.resumeRecovery = {
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    }
    const commands = sanitizeSessionConversationCommands([
      {
        id: 'resume-1',
        kind: 'resume-run',
        timestamp: 10,
        run: { promptMessageId: 'prompt-1', startedAt: 10 }
      },
      {
        id: 'resume-2',
        kind: 'resume-run',
        timestamp: 20,
        run: { promptMessageId: 'prompt-1', startedAt: 20 }
      }
    ])
    const recovered = applySessionConversationCommands(initial, commands)
    expect(recovered.activeRun).toEqual({ promptMessageId: 'prompt-1', startedAt: 10 })
    expect(recovered.resumeRecovery).toEqual(initial.resumeRecovery)
    expect(recovered.runtimeConversationCommandIds).toEqual(['resume-1', 'resume-2'])
    const replayed = applySessionConversationCommands(recovered, commands)
    expect(replayed.activeRun).toEqual(recovered.activeRun)
    expect(replayed.runtimeConversationCommandIds).toEqual(recovered.runtimeConversationCommandIds)
    expect(replayed.messages).toEqual(recovered.messages)
    expect(() =>
      applySessionConversationCommands(recovered, [
        {
          id: 'ordinary-start',
          kind: 'start-run',
          timestamp: 30,
          run: { promptMessageId: 'prompt-1', startedAt: 30 }
        }
      ])
    ).toThrow('already has an active run')
  })

  it.each(['missing-marker', 'wrong-marker', 'other-run', 'settled-run', 'missing-prompt'])(
    'rejects recovery without valid authority: %s',
    (scenario) => {
      const initial = fixture()
      if (scenario !== 'missing-marker')
        initial.resumeRecovery = {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: scenario === 'wrong-marker' ? 'other' : 'prompt-1'
        }
      if (scenario === 'other-run') initial.activeRun = { promptMessageId: 'other', startedAt: 5 }
      if (scenario === 'settled-run')
        initial.runtimeTranscriptLastRun = { promptMessageId: 'prompt-1', startedAt: 10 }
      const before = structuredClone(initial)
      expect(() =>
        applySessionConversationCommands(initial, [
          {
            id: 'rejected-resume',
            kind: 'resume-run',
            timestamp: 10,
            run: {
              promptMessageId: scenario === 'missing-prompt' ? 'missing' : 'prompt-1',
              startedAt: 10
            }
          }
        ])
      ).toThrow()
      expect(initial).toEqual(before)
    }
  )

  it.each(['prompt-1', 'older-prompt'])(
    'retains recovery only for the prepared prompt: %s',
    (recoveryPromptId) => {
      const initial = fixture()
      initial.resumeRecovery = {
        kind: 'resume-required',
        cause: 'cancelled',
        promptMessageId: recoveryPromptId
      }
      const prepared = applySessionConversationCommands(initial, [
        {
          id: 'resume-run',
          kind: 'start-run',
          timestamp: 10,
          run: { promptMessageId: 'prompt-1', startedAt: 10 }
        }
      ])
      expect(prepared.resumeRecovery).toEqual(
        recoveryPromptId === 'prompt-1' ? initial.resumeRecovery : undefined
      )
    }
  )

  it('applies append, fork, select, segment, and run intents and replays them idempotently', () => {
    const initial = fixture()
    const firstBranch = rootBranchId(initial)
    const second = prompt('prompt-2', 'Second', 2)
    const appended = applySessionConversationCommands(initial, [
      {
        id: 'append-1',
        kind: 'append-user',
        timestamp: 2,
        branchId: firstBranch,
        parentMessageId: 'prompt-1',
        message: second
      }
    ])
    expect(appended.messages.map(({ id }) => id)).toEqual(['prompt-1', 'prompt-2'])

    const forked = applySessionConversationCommands(appended, [
      {
        id: 'fork-1',
        kind: 'fork-message',
        timestamp: 3,
        branchId: 'branch-edit',
        parentBranchId: firstBranch,
        messageId: 'prompt-2'
      }
    ])
    expect(rootBranchId(forked)).toBe('branch-edit')

    const selected = applySessionConversationCommands(forked, [
      {
        id: 'select-1',
        kind: 'select-branch',
        timestamp: 4,
        branchId: firstBranch,
        previousBranchId: 'branch-edit'
      }
    ])
    const opened = applySessionConversationCommands(selected, [
      {
        id: 'segment-1',
        kind: 'open-segment',
        timestamp: 5,
        segment: { id: 'segment-new', frameworkId: 'codex', startedAt: 5 }
      }
    ])
    expect(opened.pendingHistoryReplay).toEqual({ kind: 'all' })

    const running = applySessionConversationCommands(opened, [
      {
        id: 'run-1',
        kind: 'start-run',
        timestamp: 6,
        run: { promptMessageId: 'prompt-2', startedAt: 6 }
      }
    ])
    expect(running.activeRun).toEqual({ promptMessageId: 'prompt-2', startedAt: 6 })
    const replayed = applySessionConversationCommands(running, [
      {
        id: 'append-1',
        kind: 'append-user',
        timestamp: 2,
        branchId: firstBranch,
        parentMessageId: 'prompt-1',
        message: second
      },
      {
        id: 'fork-1',
        kind: 'fork-message',
        timestamp: 3,
        branchId: 'branch-edit',
        parentBranchId: firstBranch,
        messageId: 'prompt-2'
      },
      {
        id: 'select-1',
        kind: 'select-branch',
        timestamp: 4,
        branchId: firstBranch,
        previousBranchId: 'branch-edit'
      },
      {
        id: 'segment-1',
        kind: 'open-segment',
        timestamp: 5,
        segment: { id: 'segment-new', frameworkId: 'codex', startedAt: 5 }
      },
      {
        id: 'run-1',
        kind: 'start-run',
        timestamp: 6,
        run: { promptMessageId: 'prompt-2', startedAt: 6 }
      }
    ])
    expect(replayed.activeRun).toEqual(running.activeRun)
    expect(replayed.conversationGraph!.messages).toEqual(running.conversationGraph!.messages)
    expect(replayed.conversationGraph!.runtimeSegments).toEqual(
      running.conversationGraph!.runtimeSegments
    )
    expect(replayed.runtimeConversationCommandIds).toEqual(running.runtimeConversationCommandIds)
  })

  it('rejects duplicate command identities with different operations', () => {
    const session = fixture()
    const branchId = rootBranchId(session)
    expect(() =>
      applySessionConversationCommands(session, [
        {
          id: 'collision',
          kind: 'append-user',
          timestamp: 2,
          branchId,
          parentMessageId: 'prompt-1',
          message: prompt('prompt-2', 'Second', 2)
        },
        {
          id: 'collision',
          kind: 'open-segment',
          timestamp: 2,
          segment: { id: 'segment-2', frameworkId: 'codex', startedAt: 2 }
        }
      ])
    ).toThrow('command identity is already used')
  })

  it('requires the complete append payload and graph lineage for structural replay', () => {
    const session = fixture()
    const branchId = rootBranchId(session)
    const upload = {
      id: 'upload-1',
      versionId: 'version-1',
      sessionId: session.id,
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      size: 10
    }
    const message = prompt('prompt-2', 'Second', 2, { uploads: [upload] })
    const admitted = applySessionConversationCommands(session, [
      {
        id: 'append-old',
        kind: 'append-user',
        timestamp: 2,
        branchId,
        parentMessageId: 'prompt-1',
        message
      }
    ])
    const outsideRing = { ...admitted, runtimeConversationCommandIds: [] }
    expect(() =>
      applySessionConversationCommands(outsideRing, [
        {
          id: 'append-old',
          kind: 'append-user',
          timestamp: 2,
          branchId,
          parentMessageId: 'prompt-1',
          message: { ...message, uploads: [{ ...upload, versionId: 'version-2' }] }
        }
      ])
    ).toThrow('Message identity is already used')
    expect(() =>
      applySessionConversationCommands(outsideRing, [
        {
          id: 'append-old',
          kind: 'append-user',
          timestamp: 2,
          branchId: 'unknown-branch',
          parentMessageId: 'prompt-1',
          message
        }
      ])
    ).toThrow('Message identity is already used')
  })

  it('rejects a new user Message during an active run but permits exact admission replay', () => {
    const session = fixture()
    const branchId = rootBranchId(session)
    const running = {
      ...session,
      status: 'running' as const,
      activeRun: { promptMessageId: 'prompt-1', startedAt: 2 }
    }
    expect(() =>
      applySessionConversationCommands(running, [
        {
          id: 'append-during-run',
          kind: 'append-user',
          timestamp: 3,
          branchId,
          parentMessageId: 'prompt-1',
          message: prompt('prompt-2', 'Too soon', 3)
        }
      ])
    ).toThrow('while the Session run is active')
    expect(
      applySessionConversationCommands(running, [
        {
          id: 'replay-admission',
          kind: 'append-user',
          timestamp: 1,
          branchId,
          message: session.messages[0]
        }
      ]).activeRun
    ).toEqual(running.activeRun)
  })

  it('rejects stale branch commands and unknown branch proofs', () => {
    const session = fixture()
    const parentBranchId = rootBranchId(session)
    const newer = applySessionConversationCommands(session, [
      {
        id: 'fork-newer',
        kind: 'fork-message',
        timestamp: 5,
        branchId: 'newer',
        parentBranchId,
        messageId: 'prompt-1'
      }
    ])
    expect(() =>
      applySessionConversationCommands(newer, [
        {
          id: 'fork-stale',
          kind: 'fork-message',
          timestamp: 4,
          branchId: 'stale',
          parentBranchId,
          messageId: 'prompt-1'
        }
      ])
    ).toThrow('running or changed')
    expect(() =>
      applySessionConversationCommands(newer, [
        {
          id: 'select-unknown',
          kind: 'select-branch',
          timestamp: 6,
          branchId: 'missing',
          previousBranchId: 'newer'
        }
      ])
    ).toThrow('does not belong to the root Agent Frame')
  })

  it('rejects segment identity collisions and unsupported framework identities', () => {
    const session = fixture()
    const segment = session.conversationGraph!.runtimeSegments[0]
    expect(() =>
      applySessionConversationCommands(session, [
        {
          id: 'segment-collision',
          kind: 'open-segment',
          timestamp: 2,
          segment: { id: segment.id, frameworkId: 'codex', startedAt: segment.startedAt }
        }
      ])
    ).toThrow('Runtime Segment identity is already used')
    expect(() =>
      sanitizeSessionConversationCommands(
        [
          {
            id: 'segment-invalid',
            kind: 'open-segment',
            timestamp: 2,
            segment: { id: 'segment-2', frameworkId: 'unknown', startedAt: 2 }
          }
        ],
        session
      )
    ).toThrow()
  })

  it('preserves a narrower history replay proof when opening a replacement segment', () => {
    const session = {
      ...fixture(),
      pendingHistoryReplay: {
        kind: 'before-message' as const,
        messageId: 'prompt-1'
      }
    }
    const result = applySessionConversationCommands(session, [
      {
        id: 'segment-2',
        kind: 'open-segment',
        timestamp: 2,
        segment: { id: 'segment-2', frameworkId: 'opencode', startedAt: 2 }
      }
    ])
    expect(result.pendingHistoryReplay).toEqual(session.pendingHistoryReplay)
  })

  it('replays the exact settled run but rejects older and unrelated active runs', () => {
    const session = fixture()
    const settled = {
      ...session,
      runtimeTranscriptLastRun: {
        promptMessageId: 'prompt-1',
        startedAt: 10
      }
    }
    expect(
      applySessionConversationCommands(settled, [
        {
          id: 'run-replay',
          kind: 'start-run',
          timestamp: 10,
          run: { promptMessageId: 'prompt-1', startedAt: 10 }
        }
      ]).activeRun
    ).toBeUndefined()
    expect(() =>
      applySessionConversationCommands(settled, [
        {
          id: 'run-stale',
          kind: 'start-run',
          timestamp: 9,
          run: { promptMessageId: 'prompt-1', startedAt: 9 }
        }
      ])
    ).toThrow('already settled')
    expect(() =>
      applySessionConversationCommands(
        {
          ...session,
          activeRun: { promptMessageId: 'prompt-1', startedAt: 10 }
        },
        [
          {
            id: 'run-other',
            kind: 'start-run',
            timestamp: 11,
            run: { promptMessageId: 'prompt-1', startedAt: 11 }
          }
        ]
      )
    ).toThrow('already has an active run')
  })

  it('takes sanitized submitted Message data and strips graph ownership from renderer input', () => {
    const session = fixture()
    const branchId = rootBranchId(session)
    const canonical = prompt('prompt-2', 'Canonical', 2)
    const submitted = {
      ...session,
      messages: [...session.messages, canonical],
      conversationGraph: {
        ...session.conversationGraph!,
        messages: [
          ...session.conversationGraph!.messages,
          {
            ...canonical,
            agentFrameId: session.conversationGraph!.rootFrameId,
            introducedOnBranchId: branchId,
            parentMessageId: 'prompt-1',
            revisionRootMessageId: canonical.id,
            runtimeSegmentId: session.conversationGraph!.runtimeSegments[0].id
          }
        ]
      }
    }
    const [command] = sanitizeSessionConversationCommands(
      [
        {
          id: 'append-safe',
          kind: 'append-user',
          timestamp: 2,
          branchId,
          parentMessageId: 'prompt-1',
          message: { id: canonical.id, role: 'user', content: 'Untrusted', secret: 'do-not-copy' }
        }
      ],
      submitted
    )
    expect(command.kind).toBe('append-user')
    if (command.kind !== 'append-user') return
    expect(command.message).toEqual(canonical)
    expect(command.message).not.toHaveProperty('agentFrameId')
    expect(command.message).not.toHaveProperty('secret')
  })
})
