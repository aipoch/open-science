import { expect, it } from 'vitest'
import { validateConversationGraph } from '../../src/shared/conversation-graph'
import { createSessionFile, decodeSessionFile } from '../../src/shared/session-persistence'
import type { PersistedChatSession } from '../../src/shared/session-persistence'
import { createOfficialScienceContinuation } from './official-science-continuation'
import { createRealisticSessionWorkload } from './realistic-session-workload'

const forkFixture = (): PersistedChatSession => {
  const workload = createRealisticSessionWorkload({
    rounds: 1,
    replyBytes: 256,
    toolOutputBytes: 256
  })
  const session = workload.batches.reduce(
    (value, batch) => batch.apply(value),
    workload.initialSession
  )
  return {
    ...session,
    branchContextResetRequired: true,
    forkOrigin: {
      importId: '11111111-1111-4111-8111-111111111111',
      sourceProjectId: 'original-project',
      sourceSessionId: 'original-session',
      importedAt: session.updatedAt,
      manifestChecksum: 'a'.repeat(64)
    }
  }
}

it('adds exactly one 32 KiB response in 194 deterministic batches without changing historical research', () => {
  const input = forkFixture()
  const before = structuredClone(input)
  const continuation = createOfficialScienceContinuation(input)
  expect(continuation.metadata).toMatchObject({
    expectedAddedUserMessages: 1,
    expectedAddedAgentMessages: 1,
    expectedAddedToolActivities: 0,
    expectedAddedModelCalls: 1,
    replyBytes: 32768,
    messageBatches: 192,
    batchCount: 194,
    batchIntervalMs: 500,
    virtualDurationMs: 97000
  })
  expect(continuation.batches).toHaveLength(194)
  expect(continuation.batches.map(({ virtualTimeMs }) => virtualTimeMs)).toEqual(
    Array.from({ length: 194 }, (_, index) => (index + 1) * 500)
  )
  const textBatches = continuation.batches.filter(({ kind }) => kind === 'message')
  expect(textBatches).toHaveLength(192)
  expect(textBatches.every(({ events }) => events.length === 4)).toBe(true)
  expect(continuation.metadata.startedAt).toBeGreaterThan(input.updatedAt)
  expect(createOfficialScienceContinuation(input).metadata).toEqual(continuation.metadata)
  expect(createOfficialScienceContinuation(input).batches.map(({ events }) => events)).toEqual(
    continuation.batches.map(({ events }) => events)
  )
  let session = input
  for (const batch of continuation.batches) {
    session = batch.apply(session)
    validateConversationGraph(session.conversationGraph!)
  }
  expect(input).toEqual(before)
  expect(session.status).toBe('idle')
  expect(session.activeRun).toBeUndefined()
  expect(session.messages).toHaveLength(input.messages.length + 2)
  expect(
    session.conversationGraph!.messages.slice(0, before.conversationGraph!.messages.length)
  ).toEqual(before.conversationGraph!.messages)
  expect(session.conversationGraph!.activities).toEqual(before.conversationGraph!.activities)
  expect(session.conversationGraph!.activityGroups).toEqual(
    before.conversationGraph!.activityGroups
  )
  expect(session.forkOrigin).toEqual(before.forkOrigin)
  expect(session.packageOrigin).toBeUndefined()
  const prompt = session.messages.at(-2)!
  const response = session.messages.at(-1)!
  expect(prompt).toMatchObject({ id: continuation.metadata.promptMessageId, role: 'user' })
  expect(response).toMatchObject({
    id: continuation.metadata.responseMessageId,
    role: 'agent',
    responseToMessageId: prompt.id,
    status: 'complete',
    turnUsage: { inputTokens: 4096, outputTokens: 8192, turnCount: 1 }
  })
  expect(response.modelCallUsage).toHaveLength(1)
  expect(Buffer.byteLength(response.content)).toBe(32768)
  expect(response.content.length).toBe(32768)
  const decoded = decodeSessionFile(JSON.parse(JSON.stringify(createSessionFile(session))), {
    preserveRuntimeState: true
  })
  expect(decoded.status).toBe('ok')
  if (decoded.status !== 'ok') throw new Error('Continuation did not survive the public codec')
  expect(decoded.session.messages.at(-1)!.content).toBe(response.content)
  expect(decoded.session.conversationGraph!.activities).toEqual(
    session.conversationGraph!.activities
  )
})

it('uses the existing graph helper to open a new segment after a fork context reset', () => {
  const input = forkFixture()
  const previous = structuredClone(input.conversationGraph!)
  const continuation = createOfficialScienceContinuation(input)
  const admitted = continuation.batches[0].apply(input)
  const graph = admitted.conversationGraph!
  validateConversationGraph(graph)
  expect(graph.activeFrameId).toBe(previous.activeFrameId)
  expect(graph.frames).toEqual(previous.frames)
  expect(graph.runtimeSegments).toHaveLength(previous.runtimeSegments.length + 1)
  expect(graph.runtimeSegments.at(-1)).toMatchObject({
    id: 'official-science-benchmark:runtime',
    agentFrameId: previous.rootFrameId,
    startedAt: continuation.metadata.startedAt
  })
  expect(graph.messages.at(-1)?.runtimeSegmentId).toBe(graph.runtimeSegments.at(-1)?.id)
  expect(input.conversationGraph).toEqual(previous)
})

it('refuses imported history both at construction and when applying a prepared continuation', () => {
  const fork = forkFixture()
  const imported = { ...fork, packageOrigin: fork.forkOrigin }
  const before = structuredClone(imported)
  expect(() => createOfficialScienceContinuation(imported)).toThrow('read-only')
  const continuation = createOfficialScienceContinuation(fork)
  expect(() => continuation.batches[0].apply(imported)).toThrow('read-only')
  expect(() => continuation.batches[1].apply(imported)).toThrow('read-only')
  expect(imported).toEqual(before)
})

it('rejects reserved identities and a different Session rather than overwriting existing history', () => {
  const input = forkFixture()
  const continuation = createOfficialScienceContinuation(input)
  const colliding = structuredClone(input)
  colliding.conversationGraph!.activities[0].eventIds.push('official-science-benchmark:event-1')
  expect(() => createOfficialScienceContinuation(colliding)).toThrow('identity already exists')
  expect(() => continuation.batches[0].apply({ ...input, id: 'another-session' })).toThrow(
    'cannot switch Session identity'
  )
  const admitted = continuation.batches[0].apply(input)
  expect(() => continuation.batches[0].apply(admitted)).toThrow('settled history')
})

it('starts after the latest historical message even when its timestamp is newer than the Session', () => {
  const input = forkFixture()
  input.conversationGraph!.messages[0].updatedAt = input.updatedAt + 20_000
  expect(createOfficialScienceContinuation(input).metadata.startedAt).toBe(input.updatedAt + 20_500)
})
