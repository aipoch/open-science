import * as acp from '@agentclientprotocol/sdk'
import { expect, it, vi } from 'vitest'

import { createOpenCodeCompactionStream } from './opencode-compaction-stream'
import { AcpProviderPromptExecutor, type ProviderPromptOutcome } from './provider-prompt-executor'
import { AcpSessionInteractionOwner } from './session-interaction-owner'

const chunk = (messageId: string, text: string): acp.AnyMessage => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'session',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text }
    }
  }
})

it('drains an acknowledged cancellation before the real runtime deadline and reuses the SDK connection', async () => {
  const abort = new AbortController()
  const outgoing: acp.AnyMessage[] = []
  const routed: acp.SessionNotification[] = []
  let source!: ReadableStreamDefaultController<acp.AnyMessage>
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const messageId = new URL(String(url)).pathname.split('/').at(-1)
    if (messageId === 'recovered') {
      return Response.json({
        info: { id: messageId, sessionID: 'session', role: 'assistant', summary: false },
        parts: []
      })
    }
    const signal = init?.signal
    if (!signal) throw new Error('Classification must supply an abort signal')
    return new Promise<Response>((_resolve, reject) => {
      const rejectAborted = (): void => reject(signal.reason)
      if (signal.aborted) rejectAborted()
      else signal.addEventListener('abort', rejectAborted, { once: true })
    })
  })
  const stream = createOpenCodeCompactionStream(
    {
      readable: new ReadableStream({
        start(controller) {
          source = controller
        }
      }),
      writable: new WritableStream({
        write(message) {
          outgoing.push(message)
          if ('method' in message && 'id' in message && message.method === 'session/new') {
            source.enqueue({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session' } })
          }
        }
      })
    },
    {
      api: { baseUrl: 'http://localhost:1', authorization: 'Basic test' },
      resolveSessionCwd: () => '/workspace',
      signal: abort.signal,
      fetchImpl
    }
  )
  const connection = acp.client().connect(stream)
  let closed = false
  void connection.closed.then(() => {
    closed = true
    abort.abort()
  })
  const session = await connection.agent.buildSession('/workspace').start()
  // Keep the production 5,000 ms cancellation deadline and real timers. A shorter
  // injected deadline would not catch the retry-budget/runtime integration mismatch.
  const interactions = new AcpSessionInteractionOwner()
  const timedOut = vi.fn(() => connection.close())
  const executor = new AcpProviderPromptExecutor({
    backendGeneration: {
      openCodeUsageApi: () => undefined,
      current: { adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false } }
    }
  })
  const executions: Promise<ProviderPromptOutcome>[] = []
  const execute = (): Promise<ProviderPromptOutcome> => {
    const interaction = interactions.claim({ sessionId: 'session', kind: 'prompt' })
    const execution = executor
      .execute({
        session,
        content: 'Continue',
        cwd: '/workspace',
        frameworkId: 'opencode',
        isCurrent: () => interactions.current('session') === interaction,
        beforeDispatch: async () => 'active',
        captureStop: (response) =>
          interactions.captureTerminal(
            interaction,
            response.stopReason === 'cancelled' ? 'cancelled' : 'stop'
          ),
        onAccepted: () => {},
        routeNotification: (notification) => routed.push(notification)
      })
      .finally(() => interactions.release(interaction))
    executions.push(execution)
    return execution
  }
  const promptRequestId = async (index: number): Promise<acp.JsonRpcId> => {
    const prompts = (): acp.AnyMessage[] =>
      outgoing.filter((message) => 'method' in message && message.method === 'session/prompt')
    await vi.waitFor(() => expect(prompts().length).toBeGreaterThan(index))
    const request = prompts()[index]
    if (!request || !('id' in request)) throw new Error('Expected a prompt request ID')
    return request.id
  }

  try {
    const first = execute()
    // Observe rejection immediately, before awaiting the real cancellation deadline.
    const firstOutcome = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    const firstId = await promptRequestId(0)
    source.enqueue(chunk('slow', 'Unclassified private output'))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())

    await interactions.cancelPrompt({
      sessionId: 'session',
      notify: async () => {
        await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: 'session' })
        // Model bytes may already be queued when Stop arrives. The agent then
        // acknowledges cancellation immediately, without waiting for auxiliary HTTP.
        source.enqueue(chunk('queued', 'More unclassified private output'))
        source.enqueue({ jsonrpc: '2.0', id: firstId, result: { stopReason: 'cancelled' } })
      },
      onAccepted: () => {},
      // Mirrors runtime.cancelPrompt's shared-connection teardown on timeout.
      onTimeout: timedOut
    })

    const outcome = await firstOutcome
    expect(timedOut).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      value: { kind: 'stopped', response: { stopReason: 'cancelled' } }
    })
    expect(closed).toBe(false)
    expect(interactions.current('session')).toBeUndefined()
    expect(routed).toEqual([])
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)

    const recovery = execute()
    const recovered = recovery.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    const recoveryId = await promptRequestId(1)
    source.enqueue(chunk('recovered', 'Recovered on the same connection'))
    source.enqueue({ jsonrpc: '2.0', id: recoveryId, result: { stopReason: 'end_turn' } })
    expect(await recovered).toMatchObject({
      value: { kind: 'stopped', response: { stopReason: 'end_turn' } }
    })
    expect(routed).toEqual([
      {
        sessionId: 'session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'recovered',
          content: { type: 'text', text: 'Recovered on the same connection' }
        }
      }
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(timedOut).not.toHaveBeenCalled()
    expect(closed).toBe(false)
    expect(interactions.current('session')).toBeUndefined()
  } finally {
    interactions.supersedeAll()
    session.dispose()
    connection.close()
    abort.abort()
    await Promise.allSettled(executions)
  }
}, 15_000)
