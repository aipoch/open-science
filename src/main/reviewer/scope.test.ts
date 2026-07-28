import { describe, expect, it } from 'vitest'

import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { isTurnScopeStale, resolveTurnScope } from './scope'

// Builds a persisted message with sensible defaults; callers override only what a case cares about.
const message = (
  id: string,
  role: 'user' | 'agent',
  createdAt: number,
  overrides: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: `${role} ${id}`,
  status: 'complete',
  eventIds: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides
})

// Builds a persisted tool activity with defaults.
const activity = (
  id: string,
  createdAt: number,
  sortIndex: number,
  overrides: Partial<PersistedToolActivity> = {}
): PersistedToolActivity => ({
  id,
  kind: 'tool',
  title: `tool ${id}`,
  status: 'completed',
  sortIndex,
  eventIds: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides
})

// Two-turn session: turn 1 interleaves u1 → act1 → a1 by createdAt; turn 2 is u2 → a2.
const buildSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/tmp',
  status: 'idle',
  messages: [
    message('u1', 'user', 1000),
    message('a1', 'agent', 1002, { artifactIds: ['art-1'] }),
    message('u2', 'user', 2000),
    message('a2', 'agent', 2001)
  ],
  activities: [activity('act1', 1001, 5, { rawOutput: { rows: 33 } })],
  createdAt: 1000,
  updatedAt: 2001
})

const buildBranchedSession = (): PersistedChatSession => {
  const session = buildSession()
  const graph = createLinearConversationGraph({
    sessionId: session.id,
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  })
  const frame = graph.frames[0]
  const originalBranch = graph.branches[0]
  const runtimeSegment = graph.runtimeSegments[0]
  const editedBranchId = 'message-branch-edited'
  const editedUser = message('u2-edited', 'user', 2000, { content: 'edited user turn' })
  const editedAgent = message('a2-edited', 'agent', 2002, { content: 'edited agent answer' })

  frame.activeBranchId = editedBranchId
  graph.branches.push({
    id: editedBranchId,
    agentFrameId: frame.id,
    parentBranchId: originalBranch.id,
    forkMessageId: 'a1',
    supersededMessageId: 'u2',
    headMessageId: editedAgent.id,
    createdAt: 2000,
    updatedAt: 2002
  })
  graph.messages.push(
    {
      ...editedUser,
      agentFrameId: frame.id,
      introducedOnBranchId: editedBranchId,
      parentMessageId: 'a1',
      revisionRootMessageId: 'u2',
      supersedesMessageId: 'u2',
      runtimeSegmentId: runtimeSegment.id
    },
    {
      ...editedAgent,
      agentFrameId: frame.id,
      introducedOnBranchId: editedBranchId,
      parentMessageId: editedUser.id,
      runtimeSegmentId: runtimeSegment.id
    }
  )
  graph.activities.push(
    {
      ...activity('old-branch-activity', 2001, 1),
      agentFrameId: frame.id,
      messageBranchId: originalBranch.id,
      promptMessageId: 'u2',
      runtimeSegmentId: runtimeSegment.id
    },
    {
      ...activity('edited-branch-activity', 2001, 1),
      agentFrameId: frame.id,
      messageBranchId: editedBranchId,
      promptMessageId: editedUser.id,
      runtimeSegmentId: runtimeSegment.id
    }
  )

  // Deliberately leave the flat compatibility projection on the original Branch. Review scope must
  // use the graph authority so a delayed persistence projection cannot leak sibling evidence.
  session.conversationGraph = graph
  session.activities = [activity('old-branch-activity', 2001, 1)]
  return session
}

describe('resolveTurnScope', () => {
  it('returns only the target turn as ordered, interleaved blocks', () => {
    const scope = resolveTurnScope(buildSession(), 'a1')

    expect(scope.turnMessageId).toBe('a1')
    expect(
      scope.blocks.map((block) => ({
        kind: block.kind,
        sourceId: block.sourceId,
        blockIndex: block.blockIndex
      }))
    ).toEqual([
      { kind: 'message', sourceId: 'u1', blockIndex: 0 },
      { kind: 'activity', sourceId: 'act1', blockIndex: 1 },
      { kind: 'message', sourceId: 'a1', blockIndex: 2 }
    ])
  })

  it('resolves the same turn whether given the user or the agent message id', () => {
    const fromUser = resolveTurnScope(buildSession(), 'u1')
    const fromAgent = resolveTurnScope(buildSession(), 'a1')

    expect(fromUser.blocks.map((block) => block.sourceId)).toEqual(['u1', 'act1', 'a1'])
    expect(fromUser.blocks.map((block) => block.sourceId)).toEqual(
      fromAgent.blocks.map((block) => block.sourceId)
    )
  })

  it('excludes adjacent turns', () => {
    const scope = resolveTurnScope(buildSession(), 'a2')

    expect(scope.blocks.map((block) => block.sourceId)).toEqual(['u2', 'a2'])
    // Nothing from turn 1 leaks in.
    expect(scope.blocks.some((block) => block.sourceId === 'act1')).toBe(false)
  })

  it('resolves the active Branch from the conversation graph instead of the flat projection', () => {
    const scope = resolveTurnScope(buildBranchedSession(), 'a2-edited')

    expect(scope).toMatchObject({
      turnMessageId: 'a2-edited',
      agentFrameId: 'root-frame-session-1',
      messageBranchId: 'message-branch-edited'
    })
    expect(scope.blocks.map((block) => block.sourceId)).toEqual([
      'u2-edited',
      'edited-branch-activity',
      'a2-edited'
    ])
    expect(scope.blocks.some((block) => block.sourceId === 'old-branch-activity')).toBe(false)
    expect(scope.blocks.some((block) => block.sourceId === 'u2')).toBe(false)
  })

  it('collects artifact version ids produced in the turn', () => {
    expect(resolveTurnScope(buildSession(), 'a1').artifactVersionIds).toEqual(['art-1'])
    expect(resolveTurnScope(buildSession(), 'a2').artifactVersionIds).toEqual([])
  })

  it('excludes Upload Version ids duplicated into legacy artifact references', () => {
    const session = buildSession()
    const agentMessage = session.messages.find((candidate) => candidate.id === 'a1')!
    agentMessage.artifactIds = ['art-1', 'upload-version-1']
    agentMessage.uploads = [
      {
        id: 'upload-file-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: session.id,
        name: 'input.csv',
        originalName: 'input.csv',
        mimeType: 'text/csv',
        size: 12
      }
    ]

    expect(resolveTurnScope(session, 'a1').artifactVersionIds).toEqual(['art-1'])
  })

  it('produces stable content hashes across repeated calls', () => {
    const first = resolveTurnScope(buildSession(), 'a1')
    const second = resolveTurnScope(buildSession(), 'a1')

    expect(first.blocks.map((block) => block.contentHash)).toEqual(
      second.blocks.map((block) => block.contentHash)
    )
    // Every block carries a non-empty hash.
    expect(first.blocks.every((block) => block.contentHash.length > 0)).toBe(true)
  })

  it('changes a block hash when that block content changes', () => {
    const base = resolveTurnScope(buildSession(), 'a1')

    const edited = buildSession()
    const agentMessage = edited.messages.find((message) => message.id === 'a1')
    if (agentMessage) agentMessage.content = 'agent a1 (edited)'
    const editedScope = resolveTurnScope(edited, 'a1')

    const baseAgentHash = base.blocks.find((block) => block.sourceId === 'a1')?.contentHash
    const editedAgentHash = editedScope.blocks.find((block) => block.sourceId === 'a1')?.contentHash
    const baseUserHash = base.blocks.find((block) => block.sourceId === 'u1')?.contentHash
    const editedUserHash = editedScope.blocks.find((block) => block.sourceId === 'u1')?.contentHash

    expect(editedAgentHash).not.toBe(baseAgentHash)
    // Untouched blocks keep their hash.
    expect(editedUserHash).toBe(baseUserHash)
  })

  it('folds an artifact content digest into the block hash so external edits invalidate it', () => {
    const withV1 = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:aaa']]))
    const withV1Again = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:aaa']]))
    const withV2 = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:bbb']]))

    const hashOf = (scope: ReturnType<typeof resolveTurnScope>): string | undefined =>
      scope.blocks.find((block) => block.sourceId === 'a1')?.contentHash

    // Same digest → same hash; a changed digest (external byte edit) → different hash.
    expect(hashOf(withV1Again)).toBe(hashOf(withV1))
    expect(hashOf(withV2)).not.toBe(hashOf(withV1))
  })

  it('does not change hashes of messages without artifacts when digests are supplied', () => {
    const withoutDigests = resolveTurnScope(buildSession(), 'a1')
    const withDigests = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:aaa']]))

    // u1 has no artifacts, so its hash is identical with or without a digest map — existing locators
    // on artifact-free blocks stay valid across this change.
    const u1 = (scope: ReturnType<typeof resolveTurnScope>): string | undefined =>
      scope.blocks.find((block) => block.sourceId === 'u1')?.contentHash
    expect(u1(withDigests)).toBe(u1(withoutDigests))
  })

  it('returns an empty scope for an unknown turn message id', () => {
    const scope = resolveTurnScope(buildSession(), 'does-not-exist')

    expect(scope).toEqual({
      turnMessageId: 'does-not-exist',
      blocks: [],
      artifactVersionIds: []
    })
  })
})

describe('isTurnScopeStale', () => {
  it('is false for the identical scope recomputed twice', () => {
    const scope = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:aaa']]))
    const again = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:aaa']]))

    expect(isTurnScopeStale(scope, again)).toBe(false)
  })

  it('is true when a block the stored review audited has changed since (e.g. artifact edit)', () => {
    const stored = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:aaa']]))
    // The artifact was edited outside the app after the review ran — its digest changes.
    const current = resolveTurnScope(buildSession(), 'a1', new Map([['art-1', 'sha256:bbb']]))

    expect(isTurnScopeStale(stored, current)).toBe(true)
  })

  it("is true when the turn's own message content changed after the review ran", () => {
    const stored = resolveTurnScope(buildSession(), 'a1')

    const edited = buildSession()
    const agentMessage = edited.messages.find((message) => message.id === 'a1')
    if (agentMessage) agentMessage.content = 'agent a1 (edited)'
    const current = resolveTurnScope(edited, 'a1')

    expect(isTurnScopeStale(stored, current)).toBe(true)
  })
})
