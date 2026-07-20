// Focused unit tests for the reviewer drive-loop guard: it must return on stop, time out if the
// reviewer never stops, and cap the number of updates so a fast-looping reviewer cannot pin the
// host/MCP servers open forever (finding: no timeout / turn cap on the reviewer session loop).

import { describe, it, expect } from 'vitest'

import { driveReviewerToStop } from './orchestrator'

type FakeUpdate = { kind: string; stopReason?: string; update?: { sessionUpdate?: string } }

describe('driveReviewerToStop', () => {
  it('returns the stop reason when the reviewer stops', async () => {
    const updates: FakeUpdate[] = [{ kind: 'chunk' }, { kind: 'stop', stopReason: 'end_turn' }]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    await expect(driveReviewerToStop(session, { timeoutMs: 1000, maxUpdates: 100 })).resolves.toBe(
      'end_turn'
    )
  })

  it('throws a timeout error if the reviewer never stops within the deadline', async () => {
    // nextUpdate never resolves — simulates a hung reviewer session.
    const session = { nextUpdate: (): Promise<FakeUpdate> => new Promise<FakeUpdate>(() => {}) }

    await expect(driveReviewerToStop(session, { timeoutMs: 20, maxUpdates: 100 })).rejects.toThrow(
      /timed out/i
    )
  })

  it('throws once the update cap is exceeded (fast-looping reviewer that never stops)', async () => {
    // Always resolves a non-stop discrete update immediately — would loop forever without the cap.
    const session = {
      nextUpdate: async (): Promise<FakeUpdate> => ({
        kind: 'session_update',
        update: { sessionUpdate: 'tool_call' }
      })
    }

    await expect(driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 5 })).rejects.toThrow(
      /max updates|too many updates/i
    )
  })

  it('does not count streaming content chunks toward the update cap', async () => {
    // A verbose reviewer streams many message/thought chunks before it stops. These are proportional
    // to output length, not work, so they must not trip the (much smaller) discrete-update cap.
    const chunkKinds = ['agent_message_chunk', 'agent_thought_chunk', 'agent_message_chunk']
    const updates: FakeUpdate[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        kind: 'session_update',
        update: { sessionUpdate: chunkKinds[i % chunkKinds.length] }
      })),
      { kind: 'stop', stopReason: 'end_turn' }
    ]
    let i = 0
    const session = { nextUpdate: async (): Promise<FakeUpdate> => updates[i++]! }

    await expect(driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 5 })).resolves.toBe(
      'end_turn'
    )
  })
})
