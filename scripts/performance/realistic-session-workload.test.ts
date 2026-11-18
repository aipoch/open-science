import { describe, expect, it } from 'vitest'
import type { ToolCallContent } from '@agentclientprotocol/sdk'
import { decodeSessionFile, type PersistedChatSession } from '../../src/shared/session-persistence'
import { validateConversationGraph } from '../../src/shared/conversation-graph'
import { sessionUsageRuns } from '../../src/shared/session-usage'
import { createRealisticSessionWorkload } from './realistic-session-workload'

const replay = (
  workload: ReturnType<typeof createRealisticSessionWorkload>
): PersistedChatSession =>
  workload.batches.reduce((session, batch) => batch.apply(session), workload.initialSession)

describe('realistic Session persistence workload', () => {
  it('produces deterministic 500 ms batches with fixed save counts for both payload profiles', () => {
    const standard = createRealisticSessionWorkload({ toolOutputBytes: 8192 })
    const heavy = createRealisticSessionWorkload({ toolOutputBytes: 65536, replyBytes: 32768 })
    for (const workload of [standard, heavy]) {
      expect(workload.batches).toHaveLength(495)
      expect(workload.metadata).toMatchObject({
        rounds: 15,
        batchesPerRound: 33,
        virtualDurationMs: 247500,
        expectedUserMessages: 15,
        expectedAgentMessages: 45,
        expectedToolActivities: 90,
        expectedUsageOwners: 15,
        expectedModelCalls: 105,
        expectedRunRows: 15
      })
      expect(workload.batches.map(({ virtualTimeMs }) => virtualTimeMs)).toEqual(
        Array.from({ length: 495 }, (_, index) => (index + 1) * 500)
      )
      expect(
        workload.batches
          .filter(({ kind }) => kind === 'message')
          .every(({ events }) => events.length === 4)
      ).toBe(true)
    }
    const repeated = createRealisticSessionWorkload({ toolOutputBytes: 8192 })
    expect(standard.initialSession).toEqual(repeated.initialSession)
    expect(
      standard.batches.map(({ kind, round, virtualTimeMs, events }) => ({
        kind,
        round,
        virtualTimeMs,
        events
      }))
    ).toEqual(
      repeated.batches.map(({ kind, round, virtualTimeMs, events }) => ({
        kind,
        round,
        virtualTimeMs,
        events
      }))
    )
    expect(standard.metadata).toEqual(repeated.metadata)
  })

  it('replays complete turns through the real runtime projection with tools, usage and stable prior states', () => {
    const workload = createRealisticSessionWorkload({ toolOutputBytes: 1024, rounds: 2 })
    const initial = structuredClone(workload.initialSession)
    let session = workload.initialSession
    let previousRound: PersistedChatSession | undefined
    let previousRoundSnapshot: PersistedChatSession | undefined
    for (const batch of workload.batches) {
      session = batch.apply(session)
      validateConversationGraph(session.conversationGraph!)
      if (batch.round === 1 && batch.kind === 'terminal') {
        previousRound = session
        previousRoundSnapshot = structuredClone(session)
      }
    }
    expect(workload.initialSession).toEqual(initial)
    expect(previousRound).toEqual(previousRoundSnapshot)
    expect(session.status).toBe('idle')
    expect(session.activeRun).toBeUndefined()
    expect(session.messages.filter(({ role }) => role === 'user')).toHaveLength(2)
    const responses = session.messages.filter(({ role }) => role === 'agent')
    expect(responses).toHaveLength(6)
    expect(responses.map(({ content }) => Buffer.byteLength(content))).toEqual([
      512, 1024, 8192, 512, 1024, 8192
    ])
    expect(responses.every(({ status }) => status === 'complete')).toBe(true)
    const usageOwners = responses.filter(({ turnUsage }) => turnUsage !== undefined)
    expect(usageOwners).toHaveLength(2)
    expect(usageOwners.map(({ modelCallUsage }) => modelCallUsage?.length)).toEqual([7, 7])
    for (const response of usageOwners) {
      expect(response.turnUsage?.outputTokens).toBe(
        response.modelCallUsage!.reduce((sum, call) => sum + call.outputTokens, 0)
      )
      expect(response.turnUsage?.turnCount).toBe(7)
    }
    expect(sessionUsageRuns(session)).toHaveLength(2)
    expect(session.activities).toHaveLength(12)
    expect(
      session.activities!.every(
        ({ status, rawOutput }) => status === 'completed' && rawOutput !== undefined
      )
    ).toBe(true)
    expect(
      session.conversationGraph!.activities.map(({ promptMessageId }) => promptMessageId)
    ).toEqual([...Array<string>(6).fill('prompt-1'), ...Array<string>(6).fill('prompt-2')])
    const restored = decodeSessionFile(JSON.parse(JSON.stringify({ version: 2, session })))
    expect(restored.status).toBe('ok')
    if (restored.status !== 'ok')
      throw new Error('Fixture must survive the legacy Session decoder.')
    expect(restored.session.messages).toHaveLength(8)
    expect(restored.session.activities).toHaveLength(12)
    expect(
      restored.session.messages.filter(({ modelCallUsage }) => modelCallUsage !== undefined)
    ).toHaveLength(2)
  })

  it.each([8192, 65536])(
    'uses actual provider sanitization for %i-byte tool results instead of bypassing storage caps',
    (toolOutputBytes) => {
      const workload = createRealisticSessionWorkload({ toolOutputBytes, rounds: 1 })
      const session = replay(workload)
      expect(workload.metadata.providerToolOutputBytesTotal).toBe(toolOutputBytes * 6)
      expect(workload.metadata.omittedRawOutputCount).toBe(6)
      expect(workload.metadata.retainedRawOutputJsonBytesTotal).toBe(0)
      expect(session.activities!.every(({ rawOutput }) => rawOutput === undefined)).toBe(true)
      const textBytes = session.activities!.map(({ toolContent }) => {
        const first = toolContent![0] as ToolCallContent
        if (first.type !== 'content' || first.content.type !== 'text')
          throw new Error('Expected text tool output.')
        return Buffer.byteLength(first.content.text)
      })
      expect(new Set(textBytes).size).toBe(1)
      expect(textBytes[0]).toBe(toolOutputBytes === 8192 ? 8192 : 16004)
      expect(workload.metadata.retainedToolContentTextBytesTotal).toBe(
        textBytes.reduce((sum, bytes) => sum + bytes, 0)
      )
      expect(workload.metadata.maxRetainedToolContentTextBytes).toBe(textBytes[0])
      expect(session.artifacts ?? []).toHaveLength(0)
    }
  )
})
