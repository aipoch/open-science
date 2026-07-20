import { describe, expect, it } from 'vitest'

import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'
import { resolveTurnScope } from './scope'

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

  it('collects artifact version ids produced in the turn', () => {
    expect(resolveTurnScope(buildSession(), 'a1').artifactVersionIds).toEqual(['art-1'])
    expect(resolveTurnScope(buildSession(), 'a2').artifactVersionIds).toEqual([])
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
