import { describe, expect, it, vi } from 'vitest'

import type { AcpPromptRequest, AcpResumeSessionRequest } from '../../shared/acp'
import type { AcpRuntime } from './runtime'
import type {
  AcpRuntimeActivity,
  AcpRuntimeActivityOptions,
  AcpRuntimeActivityOwner
} from './runtime-activity'

// Builds a duck-typed stand-in that exposes only the methods AcpRuntimeActivity picks off AcpRuntime.
// The return type is anchored to `Pick<AcpRuntime, …>`, so the literal below is structurally checked
// against AcpRuntime's real method signatures — any drift in argument shape or return type fails
// typecheck here, which is exactly the contract the Pick<AcpRuntime, …> type exists to enforce.
const createActivityMock = (): Pick<
  AcpRuntime,
  'buildReviewerSession' | 'disposeReviewerSession' | 'sendPrompt'
> => ({
  buildReviewerSession: vi.fn(async (req: Parameters<AcpRuntime['buildReviewerSession']>[0]) => {
    // The parameter is required by the Pick<AcpRuntime, …> signature; the test body does not
    // inspect it. Read it once to keep @typescript-eslint/no-unused-vars happy without changing
    // the contract shape.
    void req
    return { role: 'reviewer', session: { sessionId: 'reviewer-1' } } as Awaited<
      ReturnType<AcpRuntime['buildReviewerSession']>
    >
  }),
  disposeReviewerSession: vi.fn((session: Parameters<AcpRuntime['disposeReviewerSession']>[0]) => {
    // Same rationale as buildReviewerSession above: the parameter exists for type-check only.
    void session
    return {
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined
    } as ReturnType<AcpRuntime['disposeReviewerSession']>
  }),
  sendPrompt: vi.fn(async (req: Parameters<AcpRuntime['sendPrompt']>[0]) => {
    void req
    return { stopReason: 'end_turn' as const } as Awaited<ReturnType<AcpRuntime['sendPrompt']>>
  })
})

describe('AcpRuntimeActivity', () => {
  it('matches the Pick contract: a duck-typed mock with the three picked methods assigns to the type', () => {
    // The whole point of AcpRuntimeActivity is that it is exactly `Pick<AcpRuntime, ...>`. The
    // satisfies below fails typecheck if any picked key changes name or signature — that is the only
    // runtime-meaningful assertion a types-only module supports. Do NOT cast through `unknown` here;
    // that would silently swallow structural drift and defeat the contract check.
    const mock = createActivityMock() satisfies AcpRuntimeActivity

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
    // Keep the mock typed as AcpRuntimeActivity so the call below (`work(mock)`) requires the mock to
    // actually be assignable to the runtime the owner passes to work — no `as unknown` bypass.
    const mock = createActivityMock() satisfies AcpRuntimeActivity
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
    expect(result.built.role).toBe('reviewer')
    expect(result.sent.stopReason).toBe('end_turn')
    expect(mock.buildReviewerSession).toHaveBeenCalledOnce()
    expect(mock.sendPrompt).toHaveBeenCalledOnce()
  })

  it('withActivity rejects with the work error when work throws', async () => {
    const mock = createActivityMock() satisfies AcpRuntimeActivity
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
