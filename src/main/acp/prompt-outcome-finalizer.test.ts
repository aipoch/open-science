import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { ContextWindowTurnHandle } from './context-usage-tracker'
import {
  AcpPromptOutcomeFinalizer,
  type AcpPromptFinalizationHandles,
  type AcpPromptFinalizationOutcome
} from './prompt-outcome-finalizer'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'

type MutableHandles = {
  -readonly [Key in keyof AcpPromptFinalizationHandles]: AcpPromptFinalizationHandles[Key]
}

const deferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const createHarness = (
  options: { now?: () => number } = {}
): {
  context: ContextWindowTurnHandle
  events: Array<Partial<AcpRuntimeEvent>>
  handles: MutableHandles
  interaction: AcpPromptSessionInteractionScope
  interactions: AcpSessionInteractionOwner
  journal: string[]
} => {
  const journal: string[] = []
  const events: Array<Partial<AcpRuntimeEvent>> = []
  const interactions = new AcpSessionInteractionOwner({ now: options.now })
  const interaction = interactions.claim({ sessionId: 's1', kind: 'prompt' })
  const context = {
    captureTerminal: vi.fn((providerResponseObserved = false) => ({
      contextWindow: { used: 12, size: 128_000 },
      source: providerResponseObserved
        ? ('provider-response' as const)
        : ('local-estimate' as const)
    })),
    complete: vi.fn(() => {
      journal.push('context:complete')
      return true
    }),
    fail: vi.fn(() => journal.push('context:fail')),
    supersede: vi.fn(() => journal.push('context:supersede'))
  } as unknown as ContextWindowTurnHandle
  const handles = {
    sessionId: 's1',
    promptMessageId: 'prompt-1',
    interaction,
    interactions,
    permission: {
      clearCorrelationsForSession: vi.fn(() => journal.push('permission:clear'))
    },
    prepared: { close: vi.fn(() => journal.push('prepared:close')) },
    context,
    skill: {
      reloadDecision: { kind: 'continue' },
      close: vi.fn((outcome) => journal.push(`skill:${outcome}`))
    },
    model: 'test-model',
    emitUserMessage: vi.fn(() => journal.push('user')),
    emitArtifact: vi.fn(async (onPublished) => {
      journal.push('artifact:publish')
      onPublished()
    }),
    disposeArtifact: vi.fn(async () => {
      journal.push('artifact:dispose')
    }),
    failPendingSkillActivities: vi.fn(() => journal.push('skills:fail')),
    recordContextUsed: vi.fn((used) => {
      journal.push(`context:used:${used}`)
      return true
    }),
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    errorKind: (error) => (error as { data?: { errorKind?: string } } | undefined)?.data?.errorKind,
    pushEvent: vi.fn((event) => {
      events.push(event)
      journal.push(`event:${event.kind}`)
    }),
    emitState: vi.fn(() => journal.push('state')),
    beforeInteractionRelease: vi.fn(() => journal.push('interaction:before-release')),
    afterInteractionRelease: vi.fn(async () => {
      journal.push('interaction:after-release')
    }),
    onPromptEnded: vi.fn(() => journal.push('prompt:end')),
    generationActivityChanged: vi.fn(() => journal.push('activity')),
    autoCompactIfNeeded: vi.fn(async () => {
      journal.push('compact')
    })
  } satisfies AcpPromptFinalizationHandles
  return { context, events, handles, interaction, interactions, journal }
}

const stopped = (
  response: PromptResponse = { stopReason: 'end_turn' }
): AcpPromptFinalizationOutcome => ({
  kind: 'stopped',
  response,
  facts: {
    turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3 },
    modelTurnCount: 4,
    contextUsedTokens: 12,
    lastModelStepUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3 }
  }
})

describe('AcpPromptOutcomeFinalizer', () => {
  it('sequences provider facts, context, Artifact, stop publication, and cleanup', async () => {
    const harness = createHarness({ now: () => 1234 })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())
    ).resolves.toEqual({ stopReason: 'end_turn' })

    expect(harness.events).toEqual([
      expect.objectContaining({
        kind: 'stop',
        timestamp: 1234,
        turnUsage: {
          inputTokens: 10,
          cacheTokens: 2,
          outputTokens: 3,
          turnCount: 4
        },
        terminalContextWindow: {
          termination: { kind: 'stop', stopReason: 'end_turn' },
          contextWindow: { used: 12, size: 128_000 },
          modelStepUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3 },
          source: 'provider-response'
        }
      })
    ])
    expect(harness.journal).toEqual([
      'context:used:12',
      'context:complete',
      'state',
      'artifact:publish',
      'event:stop',
      'compact',
      'prepared:close',
      'artifact:dispose',
      'interaction:before-release',
      'permission:clear',
      'context:supersede',
      'interaction:after-release',
      'prompt:end',
      'state',
      'skill:completed',
      'activity'
    ])
    expect(harness.interactions.current('s1')).toBeUndefined()
  })

  it('does not mark rejected context reconciliation as a provider response', async () => {
    const harness = createHarness()
    harness.handles.recordContextUsed = vi.fn(() => false)
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())

    expect(harness.context.captureTerminal).toHaveBeenCalledWith(false)
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        terminalContextWindow: expect.objectContaining({ source: 'local-estimate' })
      })
    )
  })

  it('keeps the captured terminal timestamp while Artifact publication is slow', async () => {
    let now = 100
    const harness = createHarness({ now: () => now })
    const artifactStarted = deferred()
    const releaseArtifact = deferred()
    harness.handles.emitArtifact = vi.fn(async (onPublished) => {
      artifactStarted.resolve()
      await releaseArtifact.promise
      onPublished()
    })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    const finalization = new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())
    await artifactStarted.promise
    now = 999
    releaseArtifact.resolve()
    await finalization

    expect(harness.events).toContainEqual(expect.objectContaining({ kind: 'stop', timestamp: 100 }))
  })

  it('does not rewrite an observed stop when its callback throws and still cleans up once', async () => {
    const harness = createHarness()
    const callbackError = new Error('stop callback failed')
    harness.handles.pushEvent = vi.fn((event) => {
      harness.events.push(event)
      throw callbackError
    })
    harness.handles.onPromptEnded = vi.fn(() => {
      throw new Error('prompt-end callback failed')
    })
    harness.handles.prepared = {
      close: vi.fn(() => {
        throw new Error('prompt preparation cleanup failed')
      })
    }
    harness.handles.skill = {
      ...harness.handles.skill,
      close: vi.fn(() => {
        throw new Error('prompt skill cleanup failed')
      })
    }
    const clearPermission = harness.handles.permission.clearCorrelationsForSession
    harness.handles.permission = {
      clearCorrelationsForSession: vi.fn((sessionId) => {
        clearPermission(sessionId)
        throw new Error('permission cleanup failed')
      })
    }
    harness.handles.context = {
      ...harness.context,
      supersede: vi.fn(() => {
        harness.context.supersede()
        throw new Error('context cleanup failed')
      })
    }
    harness.handles.interactions = {
      captureTerminal: harness.interactions.captureTerminal.bind(harness.interactions),
      current: harness.interactions.current.bind(harness.interactions),
      settle: harness.interactions.settle.bind(harness.interactions),
      release: vi.fn((scope) => {
        harness.interactions.release(scope)
        throw new Error('interaction cleanup failed')
      })
    }
    harness.handles.beforeInteractionRelease = vi.fn(() => {
      throw new Error('interaction pre-release failed')
    })
    harness.handles.afterInteractionRelease = vi.fn(async () => {
      throw new Error('interaction post-release failed')
    })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())).rejects.toBe(
      callbackError
    )

    expect(harness.events.map((event) => event.kind)).toEqual(['stop'])
    expect(harness.handles.prepared.close).toHaveBeenCalledOnce()
    expect(harness.handles.disposeArtifact).toHaveBeenCalledOnce()
    expect(harness.handles.beforeInteractionRelease).toHaveBeenCalledOnce()
    expect(harness.handles.afterInteractionRelease).toHaveBeenCalledOnce()
    expect(harness.handles.permission.clearCorrelationsForSession).toHaveBeenCalledOnce()
    expect(harness.context.supersede).toHaveBeenCalledOnce()
    expect(harness.handles.onPromptEnded).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledOnce()
    expect(harness.handles.generationActivityChanged).toHaveBeenCalledOnce()
  })

  it('retries Artifact publication before the observed stop', async () => {
    const harness = createHarness()
    const artifactError = new Error('temporary Artifact failure')
    harness.handles.emitArtifact = vi
      .fn<(onPublished: () => void) => Promise<void>>()
      .mockRejectedValueOnce(artifactError)
      .mockImplementationOnce(async (onPublished) => {
        harness.journal.push('event:artifact')
        onPublished()
      })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())).rejects.toBe(
      artifactError
    )

    expect(harness.handles.emitArtifact).toHaveBeenCalledTimes(2)
    expect(harness.journal.indexOf('event:artifact')).toBeLessThan(
      harness.journal.indexOf('event:stop')
    )
  })

  it('does not replay an Artifact appended before its callback failed', async () => {
    const harness = createHarness()
    const callbackError = new Error('artifact callback failed')
    harness.handles.emitArtifact = vi.fn(async (onPublished) => {
      harness.journal.push('event:artifact')
      onPublished()
      throw callbackError
    })
    expect(harness.interactions.captureTerminal(harness.interaction, 'stop')).toBe(true)

    await expect(new AcpPromptOutcomeFinalizer().finalize(harness.handles, stopped())).rejects.toBe(
      callbackError
    )

    expect(harness.handles.emitArtifact).toHaveBeenCalledOnce()
    expect(harness.journal.filter((entry) => entry === 'event:artifact')).toHaveLength(1)
    expect(harness.journal.indexOf('event:artifact')).toBeLessThan(
      harness.journal.indexOf('event:stop')
    )
  })

  it.each([
    {
      name: 'context overflow',
      error: Object.assign(new Error('Internal error'), {
        data: { errorKind: 'request_too_large' }
      }),
      recoverable: 'context-overflow',
      providerError: false
    },
    {
      name: 'provider error',
      error: Object.assign(new Error('Invalid API key'), { data: { errorName: 'APIError' } }),
      recoverable: undefined,
      providerError: true
    },
    {
      name: 'Claude Code provider 4xx with an unknown error kind',
      error: Object.assign(
        new Error(
          'Internal error: API Error: 400 Authentication Fails, Your api key: ****e52d is invalid'
        ),
        {
          code: -32603,
          data: { errorKind: 'unknown' },
          name: 'RequestError'
        }
      ),
      recoverable: undefined,
      providerError: true
    },
    {
      name: 'ACP error',
      error: new Error('protocol failed'),
      recoverable: undefined,
      providerError: false
    }
  ])('classifies a fresh $name and cleans up once', async (testCase) => {
    const harness = createHarness({ now: () => 321 })
    harness.handles.failPendingSkillActivities = vi.fn(() => {
      throw new Error('skill activity callback failed')
    })

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'failed',
        error: testCase.error
      })
    ).rejects.toBe(testCase.error)

    expect(harness.events).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        timestamp: 321,
        recoverable: testCase.recoverable,
        providerError: testCase.providerError,
        terminalContextWindow: {
          termination: { kind: 'error' },
          contextWindow: { used: 12, size: 128_000 },
          source: 'local-estimate'
        }
      })
    )
    expect(harness.context.fail).toHaveBeenCalledOnce()
    expect(harness.handles.failPendingSkillActivities).toHaveBeenCalledOnce()
    expect(harness.context.supersede).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledWith('failed')
    expect(harness.handles.prepared?.close).toHaveBeenCalledOnce()
  })

  it('keeps a replacement interaction current when the old provider outcome is superseded', async () => {
    const harness = createHarness()
    harness.interactions.supersede(harness.interaction)
    const replacement = harness.interactions.claim({ sessionId: 's1', kind: 'prompt' })

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'superseded',
        response: { stopReason: 'cancelled' }
      })
    ).resolves.toEqual({ stopReason: 'cancelled' })

    expect(harness.interactions.current('s1')).toBe(replacement)
    expect(harness.events).toEqual([])
    expect(harness.handles.permission.clearCorrelationsForSession).not.toHaveBeenCalled()
    expect(harness.handles.onPromptEnded).not.toHaveBeenCalled()
    expect(harness.context.supersede).toHaveBeenCalledOnce()
    expect(harness.handles.prepared?.close).toHaveBeenCalledOnce()
  })

  it('publishes a cancelled stop for a current prompt that was not dispatched', async () => {
    const harness = createHarness({ now: () => 456 })

    await expect(
      new AcpPromptOutcomeFinalizer().finalize(harness.handles, {
        kind: 'not-dispatched'
      })
    ).resolves.toEqual({ stopReason: 'cancelled' })

    expect(harness.handles.emitUserMessage).toHaveBeenCalledOnce()
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        kind: 'stop',
        timestamp: 456,
        text: 'cancelled',
        terminalContextWindow: {
          termination: { kind: 'stop', stopReason: 'cancelled' },
          contextWindow: { used: 12, size: 128_000 },
          source: 'local-estimate'
        }
      })
    )
    expect(harness.context.fail).toHaveBeenCalledOnce()
    expect(harness.handles.skill.close).toHaveBeenCalledWith('cancelled')
    expect(harness.handles.prepared?.close).toHaveBeenCalledOnce()
  })
})
