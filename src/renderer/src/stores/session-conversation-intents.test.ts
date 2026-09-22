import { beforeEach, describe, expect, it } from 'vitest'

import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../../shared/session-persistence'
import { applySessionConversationCommands } from '../../../shared/session-conversation-command'
import {
  acknowledgeSessionConversationCommands,
  captureSessionConversationIntents,
  pendingSessionConversationCommands,
  recordSessionConversationAuthority,
  resetSessionConversationIntentsForTests
} from './session-conversation-intents'

const prompt = (id: string, content: string, timestamp: number): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: timestamp,
  updatedAt: timestamp
})

const fixture = (): PersistedChatSession => {
  const first = prompt('prompt-1', 'First', 1)
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    permissionProfile: 'ask',
    messages: [first],
    conversationGraph: createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [first],
      createdAt: 1,
      updatedAt: 1
    }),
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Session conversation intents', () => {
  beforeEach(resetSessionConversationIntentsForTests)

  it('captures append and run admission while keeping stable identities until acknowledgement', () => {
    const before = fixture()
    const message = prompt('prompt-2', 'Second', 2)
    const conversationGraph = synchronizeActiveConversationMessages(
      before.conversationGraph!,
      [...before.messages, message],
      2
    )
    const after: PersistedChatSession = {
      ...before,
      messages: [...before.messages, message],
      conversationGraph,
      activeRun: { promptMessageId: message.id, startedAt: 3 },
      status: 'running',
      updatedAt: 3
    }
    captureSessionConversationIntents(before, after)
    const pending = pendingSessionConversationCommands(before.id)
    expect(pending.map(({ kind }) => kind)).toEqual(['append-user', 'start-run'])
    expect(pendingSessionConversationCommands(before.id)).toEqual(pending)

    acknowledgeSessionConversationCommands({
      ...after,
      runtimeConversationCommandIds: [pending[0].id]
    })
    expect(pendingSessionConversationCommands(before.id)).toEqual([pending[1]])
  })

  it('captures a fork before its branch selection', () => {
    const before = fixture()
    const root = before.conversationGraph!.frames[0]
    const branchId = 'edited-branch'
    const conversationGraph = activateConversationBranch(
      forkEditedConversationMessage(before.conversationGraph!, 'prompt-1', branchId, 2),
      branchId
    )
    const after = { ...before, conversationGraph, updatedAt: 2 }
    captureSessionConversationIntents(before, after)
    const commands = pendingSessionConversationCommands(before.id)
    expect(commands.map(({ kind }) => kind)).toEqual(['fork-message', 'select-branch'])
    expect(commands[1]).toMatchObject({ previousBranchId: root.activeBranchId, branchId })
  })

  it('reselects a retained local Branch before forking it against newer authority', () => {
    const authority = fixture()
    const retainedBranchId = 'retained-edit'
    const retainedGraph = forkEditedConversationMessage(
      authority.conversationGraph!,
      'prompt-1',
      retainedBranchId,
      2
    )
    const revised = {
      ...prompt('prompt-2', 'Revised', 2),
      supersedesMessageId: 'prompt-1'
    }
    const before = {
      ...authority,
      messages: [revised],
      conversationGraph: synchronizeActiveConversationMessages(retainedGraph, [revised], 2),
      updatedAt: 2
    }
    const authorityWithBranches = {
      ...authority,
      conversationGraph: activateConversationBranch(
        before.conversationGraph,
        authority.conversationGraph!.frames[0].activeBranchId
      )
    }
    recordSessionConversationAuthority(before, authorityWithBranches)
    const capturedBefore = structuredClone(before)
    const nextBranchId = 'next-edit'
    const after = {
      ...capturedBefore,
      conversationGraph: forkEditedConversationMessage(
        capturedBefore.conversationGraph,
        revised.id,
        nextBranchId,
        3
      ),
      messages: [],
      updatedAt: 3
    }

    captureSessionConversationIntents(capturedBefore, after)
    const commands = pendingSessionConversationCommands(before.id)
    expect(commands.map(({ kind }) => kind)).toEqual([
      'select-branch',
      'fork-message',
      'select-branch'
    ])
    expect(commands[0]).toMatchObject({
      previousBranchId: authority.conversationGraph!.frames[0].activeBranchId,
      branchId: retainedBranchId
    })
    const replayed = applySessionConversationCommands(authorityWithBranches, commands)
    expect(
      replayed.conversationGraph?.frames.find(
        ({ id }) => id === replayed.conversationGraph?.rootFrameId
      )?.activeBranchId
    ).toBe(nextBranchId)
  })

  it('replays consecutive local mutations before the retained Branch selection is acknowledged', () => {
    const authority = fixture()
    const authorityBranchId = authority.conversationGraph!.frames[0].activeBranchId
    const retainedBranchId = 'retained-edit'
    const retainedGraph = forkEditedConversationMessage(
      authority.conversationGraph!,
      'prompt-1',
      retainedBranchId,
      2
    )
    const revised = {
      ...prompt('prompt-2', 'Revised', 2),
      supersedesMessageId: 'prompt-1'
    }
    const retained = {
      ...authority,
      messages: [revised],
      conversationGraph: synchronizeActiveConversationMessages(retainedGraph, [revised], 2),
      updatedAt: 2
    }
    const authorityWithBranches = {
      ...authority,
      conversationGraph: activateConversationBranch(retained.conversationGraph, authorityBranchId)
    }
    recordSessionConversationAuthority(retained, authorityWithBranches)

    const nextBranchId = 'next-edit'
    const first = {
      ...retained,
      conversationGraph: forkEditedConversationMessage(
        retained.conversationGraph,
        revised.id,
        nextBranchId,
        3
      ),
      messages: [],
      updatedAt: 3
    }
    captureSessionConversationIntents(retained, first)

    const followUp = prompt('prompt-3', 'Follow up', 4)
    const second = {
      ...first,
      messages: [followUp],
      conversationGraph: synchronizeActiveConversationMessages(
        first.conversationGraph,
        [followUp],
        4
      ),
      updatedAt: 4
    }
    captureSessionConversationIntents(first, second)

    const commands = pendingSessionConversationCommands(authority.id)
    expect(commands.map(({ kind }) => kind)).toEqual([
      'select-branch',
      'fork-message',
      'select-branch',
      'select-branch',
      'append-user'
    ])
    const replayed = applySessionConversationCommands(authorityWithBranches, commands)
    expect(replayed.messages.at(-1)).toMatchObject({ id: followUp.id, content: followUp.content })
    expect(
      replayed.conversationGraph?.frames.find(
        ({ id }) => id === replayed.conversationGraph?.rootFrameId
      )?.activeBranchId
    ).toBe(nextBranchId)
  })

  it('opens a new runtime segment before appending a message that uses it', () => {
    const before = fixture()
    const graph = structuredClone(before.conversationGraph!)
    const segment = {
      id: 'segment-2',
      agentFrameId: graph.rootFrameId,
      frameworkId: 'opencode' as const,
      startedAt: 2
    }
    graph.runtimeSegments.push(segment)
    const message = {
      ...prompt('prompt-2', 'Second', 3),
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: graph.branches[0].id,
      parentMessageId: 'prompt-1',
      runtimeSegmentId: segment.id
    }
    graph.messages.push(message)
    graph.branches[0].headMessageId = message.id

    captureSessionConversationIntents(before, {
      ...before,
      messages: [...before.messages, message],
      conversationGraph: graph,
      updatedAt: 3
    })

    expect(pendingSessionConversationCommands(before.id).map(({ kind }) => kind)).toEqual([
      'open-segment',
      'append-user'
    ])
  })

  it('does not infer intents from passive runtime changes or legacy sessions', () => {
    const before = fixture()
    const after = { ...before, status: 'running' as const, updatedAt: 2 }
    captureSessionConversationIntents(before, after)
    captureSessionConversationIntents(
      { ...before, runtimeTranscriptOwner: undefined },
      { ...after, runtimeTranscriptOwner: undefined }
    )
    expect(pendingSessionConversationCommands(before.id)).toEqual([])
  })
})
