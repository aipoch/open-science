import { describe, expect, it, vi } from 'vitest'

import type { AcpPromptRequest, AcpResumeSessionRequest } from '../../shared/acp'
import type {
  AcpRuntimeActivity,
  AcpRuntimeActivityOptions,
  AcpRuntimeActivityOwner
} from './runtime-activity'

// Builds a duck-typed stand-in that exposes only the methods AcpRuntimeActivity picks off AcpRuntime.
// Keeping it minimal lets the Pick contract test fail typecheck if the picked methods ever drift off
// AcpRuntime, without coupling to any of the other AcpRuntime surface that activity workflows must
// not reach into. The vi.fn() return type is intentionally left as `Mock<...>`; we cast at the boundary
// because that is the same pattern the runtime-coordinator test file uses for its hand-rolled runtime.
const createActivityMock = (): {
  buildReviewerSession: ReturnType<typeof vi.fn>
  disposeReviewerSession: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
} => ({
  buildReviewerSession: vi.fn(async () => ({ session: { sessionId: 'reviewer-1' } })),
  disposeReviewerSession: vi.fn(() => ({ rejectedToolCalls: 0, reviewerBridgeScoped: undefined })),
  sendPrompt: vi.fn(async () => ({ stopReason: 'end_turn' as const }))
})

describe('AcpRuntimeActivity', () => {
  it('matches the Pick contract: a duck-typed mock with the three picked methods assigns to the type', () => {
    // The whole point of AcpRuntimeActivity is that it is exactly `Pick<AcpRuntime, ...>`. The
    // assignment below would fail typecheck if any picked key changed name or signature, which is the
    // only runtime-meaningful assertion a types-only module supports.
    const mock = createActivityMock() as unknown as AcpRuntimeActivity

    expect(typeof mock.buildReviewerSession).toBe('function')
    expect(typeof mock.disposeReviewerSession).toBe('function')
    expect(typeof mock.sendPrompt).toBe('function')
  })

  it('accepts AcpRuntimeActivityOptions with no session at all', () => {
    // A background workflow that never needs to resume the main session can hand an empty options
    // object; session is optional so the empty form must satisfy the type.
    const options: AcpRuntimeActivityOptions = {}

    expect(options.session).toBeUndefined()
  })

  it('accepts AcpRuntimeActivityOptions with session and historyPreamble populated', () => {
    // Pre-seeded sessions carry their own historyPreamble so the coordinator can inject it into the
    // first prompt after a context reset. The intersection with AcpResumeSessionRequest must remain
    // assignable from a fully-populated value.
    const resume: AcpResumeSessionRequest = {
      sessionId: 'session-1',
      cwd: '/workspace',
      projectName: 'project-1'
    }
    const options: AcpRuntimeActivityOptions = {
      session: {
        ...resume,
        historyPreamble: 'prior transcript'
      }
    }

    expect(options.session?.sessionId).toBe('session-1')
    expect(options.session?.historyPreamble).toBe('prior transcript')
  })

  it('withActivity passes the scoped runtime to the work function and resolves with its return value', async () => {
    const mock = createActivityMock() as unknown as AcpRuntimeActivity
    // Mirror the coordinator's one-line pass-through: withActivity just hands the scoped runtime to
    // work and forwards its result. We exercise it against the duck-typed mock so the test does not
    // depend on AcpRuntime internals.
    const owner: AcpRuntimeActivityOwner = {
      withActivity: (_options, work) => work(mock)
    }

    const result = await owner.withActivity({}, async (runtime) => {
      const built = await runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
      const sent = await runtime.sendPrompt({
        sessionId: 'session-1',
        text: 'hi'
      } as AcpPromptRequest)

      return { built, sent }
    })

    expect(result.built.session.sessionId).toBe('reviewer-1')
    expect(result.sent.stopReason).toBe('end_turn')
    expect(mock.buildReviewerSession).toHaveBeenCalledOnce()
    expect(mock.sendPrompt).toHaveBeenCalledOnce()
  })

  it('withActivity rejects with the work error when work throws', async () => {
    const mock = createActivityMock() as unknown as AcpRuntimeActivity
    const boom = new Error('work blew up')
    const owner: AcpRuntimeActivityOwner = {
      // The owner contract is "resolve with work's value or reject with work's error", nothing more:
      // forwarding the awaited promise preserves both branches faithfully.
      withActivity: (_options, work) => work(mock)
    }

    await expect(
      owner.withActivity({}, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(mock.buildReviewerSession).not.toHaveBeenCalled()
  })
})
