import { expect, it } from 'vitest'
import { validateConversationGraph } from '../../src/shared/conversation-graph'
import {
  createSessionFile,
  decodeSessionFile,
  type PersistedChatSession
} from '../../src/shared/session-persistence'
import { createOfficialScienceContinuation } from './official-science-continuation'
import { createOfficialScienceFollowup } from './official-science-followups'
import { createRealisticSessionWorkload } from './realistic-session-workload'

const fixture = (): { source: PersistedChatSession; input: PersistedChatSession } => {
  const workload = createRealisticSessionWorkload({
    rounds: 2,
    replyBytes: 256,
    toolOutputBytes: 256
  })
  const source = workload.batches.reduce(
    (session, batch) => batch.apply(session),
    workload.initialSession
  )
  const control = createOfficialScienceContinuation(source)
  const input = control.batches.reduce((session, batch) => batch.apply(session), source)
  return { source, input }
}

it.each([10, 13])(
  'extends the controlled conversation to %i user turns while preserving all prior research',
  (targetTurns) => {
    const { source, input } = fixture()
    const originalSource = structuredClone(source)
    const originalInput = structuredClone(input)
    let current = input
    const templateTurns: number[] = []
    const allEventIds = new Set<string>()
    let previousTimestamp = input.updatedAt
    for (let turnNumber = 4; turnNumber <= targetTurns; turnNumber++) {
      const followup = createOfficialScienceFollowup(current, {
        templateSession: source,
        turnNumber
      })
      templateTurns.push(followup.metadata.templateTurnIndex)
      const before = structuredClone(current)
      expect(followup.metadata).toMatchObject({
        initialUserMessages: turnNumber - 1,
        expectedTotalUserMessages: turnNumber,
        expectedAddedUserMessages: 1,
        expectedAddedAgentMessages: 3,
        expectedAddedToolActivities: 6,
        expectedAddedModelCalls: 7,
        agentReplyBytes: 512 + 1024 + 256,
        batchIntervalMs: 500,
        messageBytesPerBatch: 192
      })
      expect(followup.batches.map(({ virtualTimeMs }) => virtualTimeMs)).toEqual(
        followup.batches.map((_, index) => (index + 1) * 500)
      )
      expect(followup.metadata.batchCount).toBe(followup.batches.length)
      expect(followup.metadata.virtualDurationMs).toBe(followup.batches.length * 500)
      expect(followup.metadata.startedAt).toBeGreaterThan(previousTimestamp)
      for (const batch of followup.batches) {
        for (const event of batch.events) {
          expect(allEventIds.has(event.id)).toBe(false)
          allEventIds.add(event.id)
          expect(event.timestamp).toBeGreaterThan(previousTimestamp)
          previousTimestamp = event.timestamp
        }
        current = batch.apply(current)
      }
      validateConversationGraph(current.conversationGraph!)
      expect(current.status).toBe('idle')
      expect(current.activeRun).toBeUndefined()
      expect(current.messages.filter(({ role }) => role === 'user')).toHaveLength(turnNumber)
      expect(
        current.conversationGraph!.messages.slice(0, before.conversationGraph!.messages.length)
      ).toEqual(before.conversationGraph!.messages)
      expect(
        current.conversationGraph!.activities.slice(0, before.conversationGraph!.activities.length)
      ).toEqual(before.conversationGraph!.activities)
      expect(current.artifacts).toEqual(before.artifacts)
      expect(current.conversationGraph!.frames).toEqual(before.conversationGraph!.frames)
      expect(current.conversationGraph!.branches.map(({ id }) => id)).toEqual(
        before.conversationGraph!.branches.map(({ id }) => id)
      )
      for (const expected of followup.expected.messages)
        expect(current.messages.find(({ id }) => id === expected.id)).toMatchObject({
          ...expected,
          role: 'agent',
          status: 'complete'
        })
      for (const expected of followup.expected.tools)
        expect(
          current.conversationGraph!.activities.find(({ id }) => id === expected.id)
        ).toMatchObject(expected)
      const newMessages = current.messages.slice(before.messages.length)
      expect(newMessages.flatMap((message) => message.modelCallUsage ?? [])).toHaveLength(7)
      const decoded = decodeSessionFile(JSON.parse(JSON.stringify(createSessionFile(current))), {
        preserveRuntimeState: true
      })
      expect(decoded.status).toBe('ok')
      if (decoded.status !== 'ok') throw new Error('Follow-up did not survive the public codec')
      for (const expected of followup.expected.messages)
        expect(decoded.session.messages.find(({ id }) => id === expected.id)).toMatchObject(
          expected
        )
    }
    expect(templateTurns).toEqual(Array.from({ length: targetTurns - 3 }, (_, index) => index % 2))
    expect(source).toEqual(originalSource)
    expect(input).toEqual(originalInput)
    expect(() =>
      createOfficialScienceFollowup(current, {
        templateSession: source,
        turnNumber: targetTurns + 2
      })
    ).toThrow('exactly one')
  }
)

it('uses only the original round sizes, keeps payload byte budgets and passes tools through real sanitization', () => {
  const { source, input } = fixture()
  const template = structuredClone(source)
  const tool = template.conversationGraph!.activities.find(
    ({ promptMessageId }) => promptMessageId === 'prompt-1'
  )!
  tool.rawInput = { command: '汉字\n"quoted"', controls: [true, 1, null] }
  tool.rawOutput = { stdout: 'a'.repeat(12_000) }
  tool.toolContent = [{ type: 'content', content: { type: 'text', text: 'x'.repeat(20_000) } }]
  tool.status = 'failed'
  const followup = createOfficialScienceFollowup(input, {
    templateSession: template,
    turnNumber: 4
  })
  const repeat = createOfficialScienceFollowup(input, { templateSession: template, turnNumber: 4 })
  expect(repeat.metadata).toEqual(followup.metadata)
  expect(repeat.batches.map(({ events }) => events)).toEqual(
    followup.batches.map(({ events }) => events)
  )
  expect(followup.metadata.providerRawInputJsonBytes).toBe(
    followup.metadata.sourceRawInputJsonBytes
  )
  expect(followup.metadata.providerRawOutputJsonBytes).toBe(
    followup.metadata.sourceRawOutputJsonBytes
  )
  expect(followup.metadata.providerToolContentJsonBytes).toBe(
    followup.metadata.sourceToolContentJsonBytes
  )
  expect(followup.metadata.omittedRawOutputCount).toBe(1)
  expect(followup.metadata.retainedRawOutputJsonBytes).toBeLessThan(
    followup.metadata.providerRawOutputJsonBytes
  )
  expect(followup.metadata.retainedToolContentJsonBytes).toBeLessThan(
    followup.metadata.providerToolContentJsonBytes
  )
  const expectedTool = followup.expected.tools.find(({ id }) => id.endsWith(':tool-1'))!
  expect(expectedTool.status).toBe('failed')
  expect(expectedTool.rawInput).not.toEqual(tool.rawInput)
  expect(expectedTool.rawOutput).toBeUndefined()
  const restored = followup.batches.reduce((session, batch) => batch.apply(session), input)
  expect(
    restored.conversationGraph!.activities.find(({ id }) => id === expectedTool.id)
  ).toMatchObject(expectedTool)
  // The preserved 32 KiB control response never becomes a template for later rounds.
  expect(followup.metadata.agentReplyBytes).toBe(512 + 1024 + 256)
  expect(followup.expected.messages.every(({ content }) => content.length < 32768)).toBe(true)
})

it('rejects wrong counts, imported targets, identity collisions and applying to a different Session', () => {
  const { source, input } = fixture()
  for (const turnNumber of [-1, 0, 3, 5, 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      createOfficialScienceFollowup(input, { templateSession: source, turnNumber })
    ).toThrow('exactly one')
  const imported = {
    ...input,
    packageOrigin: {
      importId: '11111111-1111-4111-8111-111111111111',
      sourceProjectId: 'source-project',
      sourceSessionId: 'source-session',
      importedAt: input.updatedAt,
      manifestChecksum: 'a'.repeat(64)
    }
  }
  expect(() =>
    createOfficialScienceFollowup(imported, { templateSession: source, turnNumber: 4 })
  ).toThrow('read-only')
  const followup = createOfficialScienceFollowup(input, { templateSession: source, turnNumber: 4 })
  expect(() => followup.batches[0].apply(imported)).toThrow('read-only')
  expect(() => followup.batches[1].apply({ ...input, id: 'another-session' })).toThrow(
    'cannot switch'
  )
  const collision = structuredClone(input)
  collision.conversationGraph!.activities[0].eventIds.push(
    'official-science-followup:turn-4:event-1'
  )
  expect(() =>
    createOfficialScienceFollowup(collision, { templateSession: source, turnNumber: 4 })
  ).toThrow('identity already exists')
  const admitted = followup.batches[0].apply(input)
  expect(() => followup.batches[0].apply(admitted)).toThrow('settled history')
})
