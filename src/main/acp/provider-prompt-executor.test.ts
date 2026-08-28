import type { ActiveSession, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

const { claudeBegin } = vi.hoisted(() => ({ claudeBegin: vi.fn() }))

vi.mock('./claude-turn-adapter', () => ({
  claudeCodeTurnAdapter: { begin: (...args: unknown[]) => claudeBegin(...args) }
}))

import {
  AcpProviderPromptExecutor,
  type ProviderPromptExecutionInput
} from './provider-prompt-executor'
import type { AcpProviderTurnAdapter, AcpProviderTurnProbe } from './provider-turn-adapter'

type NextUpdate = Awaited<ReturnType<ActiveSession['nextUpdate']>>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const notification: SessionNotification = {
  sessionId: 'provider-1',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello' }
  }
}

const update = (): NextUpdate => ({
  kind: 'session_update',
  notification,
  update: notification.update
})
const stop = (response: PromptResponse): NextUpdate => ({ kind: 'stop', response }) as NextUpdate

const setup = (
  messages: NextUpdate[] = []
): {
  executor: AcpProviderPromptExecutor
  input: ProviderPromptExecutionInput
  session: ProviderPromptExecutionInput['session']
  probe: AcpProviderTurnProbe & {
    observe: ReturnType<typeof vi.fn>
    finalize: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  adapter: AcpProviderTurnAdapter & { begin: ReturnType<typeof vi.fn> }
  accepted: ReturnType<typeof vi.fn>
  captureStop: ReturnType<typeof vi.fn>
  routeNotification: ReturnType<typeof vi.fn>
  report: ReturnType<typeof vi.fn>
} => {
  const queue = [...messages]
  const session = {
    sessionId: 'provider-1',
    prompt: vi.fn(async () => undefined),
    nextUpdate: vi.fn(async () => {
      const message = queue.shift()
      if (!message) return new Promise<never>(() => undefined)
      return message
    })
  } as unknown as ProviderPromptExecutionInput['session']
  const probe = {
    observe: vi.fn(),
    finalize: vi.fn(async () => ({})),
    cancel: vi.fn(async () => undefined)
  } as AcpProviderTurnProbe & {
    observe: ReturnType<typeof vi.fn>
    finalize: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  const adapter = {
    begin: vi.fn(async () => probe)
  } as AcpProviderTurnAdapter & { begin: ReturnType<typeof vi.fn> }
  const accepted = vi.fn()
  const captureStop = vi.fn(() => true)
  const routeNotification = vi.fn()
  const report = vi.fn()
  const executor = new AcpProviderPromptExecutor({
    backendGeneration: { openCodeUsageApi: () => undefined }
  })
  claudeBegin.mockImplementation((input) => adapter.begin(input))
  return {
    executor,
    session,
    probe,
    adapter,
    accepted,
    captureStop,
    routeNotification,
    report,
    input: {
      session,
      content: 'prompt',
      cwd: '/workspace',
      frameworkId: 'claude-code',
      isCurrent: () => true,
      beforeDispatch: async () => 'active',
      captureStop,
      onAccepted: accepted,
      routeNotification,
      reportBestEffortFailure: report
    }
  }
}

describe('AcpProviderPromptExecutor', () => {
  it('captures one OpenCode generation API for both usage snapshots', async () => {
    const api = { baseUrl: 'https://usage.example/v1', authorization: 'Bearer generation-1' }
    const openCodeUsageApi = vi.fn(() => api)
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              info: {
                id: 'assistant-1',
                role: 'assistant',
                tokens: { input: 4, output: 2, cache: { read: 1, write: 0 } }
              }
            }
          ]),
          { status: 200 }
        )
      )
    const response: PromptResponse = { stopReason: 'end_turn' }
    const session = {
      sessionId: 'provider-1',
      prompt: vi.fn(async () => undefined),
      nextUpdate: vi.fn(async () => stop(response))
    } as unknown as ProviderPromptExecutionInput['session']
    const executor = new AcpProviderPromptExecutor({
      backendGeneration: { openCodeUsageApi },
      opencodeUsageFetch: fetchImpl
    })

    const outcome = await executor.execute({
      session,
      content: 'prompt',
      cwd: '/workspace',
      frameworkId: 'opencode',
      isCurrent: () => true,
      beforeDispatch: async () => 'active',
      captureStop: () => true,
      onAccepted: () => undefined,
      routeNotification: () => undefined
    })

    expect(openCodeUsageApi).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { authorization: 'Bearer generation-1' },
      { authorization: 'Bearer generation-1' }
    ])
    expect(outcome).toMatchObject({
      kind: 'stopped',
      facts: {
        turnUsage: {
          inputTokens: 4,
          cacheTokens: 1,
          cachedReadTokens: 1,
          cachedWriteTokens: 0,
          outputTokens: 2
        },
        modelTurnCount: 1,
        modelCalls: [
          {
            sourceInvocationId: 'assistant-1',
            inputTokens: 4,
            cacheTokens: 1,
            cachedReadTokens: 1,
            cachedWriteTokens: 0,
            outputTokens: 2,
            contextUsedTokens: 5
          }
        ],
        contextUsedTokens: 5,
        lastModelStepUsage: {
          inputTokens: 4,
          cacheTokens: 1,
          cachedReadTokens: 1,
          cachedWriteTokens: 0,
          outputTokens: 2
        }
      }
    })
  })

  it('accepts once, routes updates in order, captures stop, and returns raw normalized facts', async () => {
    const response: PromptResponse = {
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }
    }
    const fixture = setup([update(), update(), stop(response)])
    fixture.probe.finalize = vi.fn(async () => ({ modelTurnCount: 2 }))

    const outcome = await fixture.executor.execute(fixture.input)

    expect(outcome).toEqual({
      kind: 'stopped',
      response,
      facts: {
        turnUsage: { inputTokens: 12, cacheTokens: 0, outputTokens: 3 },
        modelTurnCount: 2
      }
    })
    if (outcome.kind !== 'stopped') throw new Error('expected stopped outcome')
    expect(outcome.response).toBe(response)
    expect(fixture.adapter.begin).toHaveBeenCalledWith({
      providerSessionId: 'provider-1',
      cwd: '/workspace'
    })
    expect(fixture.accepted).toHaveBeenCalledOnce()
    expect(fixture.routeNotification.mock.calls).toEqual([[notification], [notification]])
    expect(fixture.captureStop).toHaveBeenCalledOnce()
    expect(fixture.probe.finalize).toHaveBeenCalledWith({ response })
    expect(fixture.probe.cancel).not.toHaveBeenCalled()
  })

  it('preserves an adapter last-model-step snapshot without inferring one from generic ACP usage', async () => {
    const response: PromptResponse = {
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }
    }
    const fixture = setup([stop(response)])
    fixture.probe.finalize = vi.fn(async () => ({
      lastModelStepUsage: { inputTokens: 7, cacheTokens: 2, outputTokens: 1 }
    }))

    await expect(fixture.executor.execute(fixture.input)).resolves.toEqual({
      kind: 'stopped',
      response,
      facts: {
        turnUsage: { inputTokens: 12, cacheTokens: 0, outputTokens: 3 },
        lastModelStepUsage: { inputTokens: 7, cacheTokens: 2, outputTokens: 1 }
      }
    })
  })

  it('routes CodeBuddy usage updates into exact per-call facts', async () => {
    const codeBuddyUsage: SessionNotification = {
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 0,
        size: 128_000,
        _meta: {
          'codebuddy.ai/messageId': 'codebuddy-call-1',
          usage: {
            prompt_tokens: 120,
            prompt_tokens_details: { cached_tokens: 20 },
            completion_tokens: 10
          }
        }
      }
    }
    const response: PromptResponse = { stopReason: 'end_turn' }
    const fixture = setup([
      {
        kind: 'session_update',
        notification: codeBuddyUsage,
        update: codeBuddyUsage.update
      },
      stop(response)
    ])

    await expect(
      fixture.executor.execute({ ...fixture.input, frameworkId: 'codebuddy' })
    ).resolves.toEqual({
      kind: 'stopped',
      response,
      facts: {
        turnUsage: {
          inputTokens: 100,
          cacheTokens: 20,
          cachedReadTokens: 20,
          cachedWriteTokens: 0,
          outputTokens: 10
        },
        modelTurnCount: 1,
        modelCalls: [
          {
            inputTokens: 100,
            cacheTokens: 20,
            cachedReadTokens: 20,
            cachedWriteTokens: 0,
            outputTokens: 10,
            sourceInvocationId: 'codebuddy-call-1'
          }
        ],
        contextUsedTokens: 120,
        lastModelStepUsage: {
          inputTokens: 100,
          cacheTokens: 20,
          cachedReadTokens: 20,
          cachedWriteTokens: 0,
          outputTokens: 10
        }
      }
    })
    expect(fixture.routeNotification).toHaveBeenCalledWith(codeBuddyUsage)
  })

  it('includes a semantic Skill selector call in CodeBuddy turn totals but keeps main-call context', async () => {
    const codeBuddyUsage: SessionNotification = {
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 0,
        size: 128_000,
        _meta: {
          'codebuddy.ai/messageId': 'codebuddy-call-1',
          usage: { prompt_tokens: 120, completion_tokens: 10 }
        }
      }
    }
    const fixture = setup([
      { kind: 'session_update', notification: codeBuddyUsage, update: codeBuddyUsage.update },
      stop({ stopReason: 'end_turn' })
    ])

    const outcome = await fixture.executor.execute({
      ...fixture.input,
      frameworkId: 'codebuddy',
      preDispatchModelCalls: [
        {
          inputTokens: 40,
          cacheTokens: 5,
          cachedReadTokens: 5,
          cachedWriteTokens: 0,
          outputTokens: 3,
          sourceInvocationId: 'selector-call-1',
          contextUsedTokens: 45
        }
      ]
    })

    expect(outcome).toMatchObject({
      kind: 'stopped',
      facts: {
        turnUsage: {
          inputTokens: 160,
          cacheTokens: 5,
          cachedReadTokens: 5,
          cachedWriteTokens: 0,
          outputTokens: 13
        },
        modelTurnCount: 2,
        modelCalls: [
          expect.objectContaining({ sourceInvocationId: 'selector-call-1' }),
          expect.objectContaining({ sourceInvocationId: 'codebuddy-call-1' })
        ],
        contextUsedTokens: 120,
        lastModelStepUsage: expect.objectContaining({ inputTokens: 120, outputTokens: 10 })
      }
    })
  })

  it('preserves prompt rejection before acceptance and cancels its probe once', async () => {
    const fixture = setup()
    const rejection = new Error('provider rejected')
    ;(fixture.session.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(rejection)

    await expect(fixture.executor.execute(fixture.input)).rejects.toBe(rejection)

    expect(fixture.accepted).not.toHaveBeenCalled()
    expect(fixture.routeNotification).not.toHaveBeenCalled()
    expect(fixture.captureStop).not.toHaveBeenCalled()
    expect(fixture.probe.finalize).not.toHaveBeenCalled()
    expect(fixture.probe.cancel).toHaveBeenCalledOnce()
  })

  it('dispatches no prompt when superseded during asynchronous probe begin', async () => {
    const fixture = setup()
    const probeGate = deferred<AcpProviderTurnProbe>()
    ;(fixture.adapter.begin as ReturnType<typeof vi.fn>).mockReturnValueOnce(probeGate.promise)
    let current = true
    const pending = fixture.executor.execute({ ...fixture.input, isCurrent: () => current })
    await vi.waitFor(() => expect(fixture.adapter.begin).toHaveBeenCalledOnce())

    current = false
    probeGate.resolve(fixture.probe)
    await expect(pending).resolves.toEqual({ kind: 'not-dispatched' })

    expect(fixture.session.prompt).not.toHaveBeenCalled()
    expect(fixture.probe.cancel).toHaveBeenCalledOnce()
  })

  it('suppresses stale updates while draining the old provider through raw stop', async () => {
    const response: PromptResponse = { stopReason: 'cancelled' }
    const fixture = setup([update(), stop(response)])

    const outcome = await fixture.executor.execute({ ...fixture.input, isCurrent: () => false })

    expect(outcome).toEqual({ kind: 'not-dispatched' })
    expect(fixture.session.prompt).not.toHaveBeenCalled()

    let current = true
    const acceptedThenStale = setup([update(), update(), stop(response)])
    acceptedThenStale.routeNotification.mockImplementationOnce(() => {
      current = false
    })
    await expect(
      acceptedThenStale.executor.execute({
        ...acceptedThenStale.input,
        isCurrent: () => current
      })
    ).resolves.toEqual({ kind: 'superseded', response })
    expect(acceptedThenStale.accepted).toHaveBeenCalledOnce()
    expect(acceptedThenStale.routeNotification).toHaveBeenCalledOnce()
    expect(acceptedThenStale.captureStop).not.toHaveBeenCalled()
    expect(acceptedThenStale.probe.finalize).not.toHaveBeenCalled()
    expect(acceptedThenStale.probe.cancel).toHaveBeenCalledOnce()
  })

  it('treats a lost terminal capture race as superseded', async () => {
    const response: PromptResponse = { stopReason: 'end_turn' }
    const fixture = setup([stop(response)])
    fixture.captureStop.mockReturnValueOnce(false)

    await expect(fixture.executor.execute(fixture.input)).resolves.toEqual({
      kind: 'superseded',
      response
    })
    expect(fixture.accepted).toHaveBeenCalledOnce()
    expect(fixture.probe.finalize).not.toHaveBeenCalled()
    expect(fixture.probe.cancel).toHaveBeenCalledOnce()
  })

  it('captures stop before slow finalization and falls back when finalization fails', async () => {
    const response: PromptResponse = {
      stopReason: 'end_turn',
      usage: { inputTokens: 7, cachedReadTokens: 2, outputTokens: 1, totalTokens: 10 }
    }
    const fixture = setup([stop(response)])
    const finalizeGate = deferred<never>()
    fixture.probe.finalize = vi.fn(() => finalizeGate.promise)
    const pending = fixture.executor.execute(fixture.input)
    await vi.waitFor(() => expect(fixture.captureStop).toHaveBeenCalledOnce())

    finalizeGate.reject(new Error('usage unavailable'))
    await expect(pending).resolves.toEqual({
      kind: 'stopped',
      response,
      facts: {
        turnUsage: { inputTokens: 7, cacheTokens: 2, outputTokens: 1 }
      }
    })
    expect(fixture.report).toHaveBeenCalledWith('finalize', expect.any(Error))
    expect(fixture.probe.cancel).not.toHaveBeenCalled()
  })

  it('keeps begin and acceptance failures best-effort', async () => {
    const response: PromptResponse = { stopReason: 'end_turn' }
    const fixture = setup([update(), stop(response)])
    ;(fixture.adapter.begin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('probe unavailable')
    )
    fixture.accepted.mockImplementationOnce(() => {
      throw new Error('accept callback failed')
    })

    await expect(fixture.executor.execute(fixture.input)).resolves.toMatchObject({
      kind: 'stopped',
      response
    })
    expect(fixture.routeNotification).toHaveBeenCalledOnce()
    expect(fixture.report.mock.calls.map(([stage]) => stage)).toEqual(['begin', 'accepted'])
  })

  it('routes provider observations only while the matching probe owns the attempt', async () => {
    const response: PromptResponse = { stopReason: 'end_turn' }
    const fixture = setup()
    const nextUpdate = deferred<NextUpdate>()
    ;(fixture.session.nextUpdate as ReturnType<typeof vi.fn>).mockReturnValue(nextUpdate.promise)
    const pending = fixture.executor.execute(fixture.input)
    await vi.waitFor(() => expect(fixture.session.prompt).toHaveBeenCalledOnce())

    const providerMessage = { sessionId: 'provider-1', message: { type: 'result' } }
    fixture.executor.observeProviderMessage(providerMessage)
    fixture.executor.observeProviderMessage({ sessionId: 'other-provider' })
    expect(fixture.probe.observe).toHaveBeenCalledWith(providerMessage)
    expect(fixture.probe.observe).toHaveBeenCalledOnce()

    nextUpdate.resolve(stop(response))
    await pending
    fixture.executor.observeProviderMessage(providerMessage)
    expect(fixture.probe.observe).toHaveBeenCalledOnce()
  })
})
