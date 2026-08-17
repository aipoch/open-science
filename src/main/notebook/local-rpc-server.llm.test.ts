import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostLlmCallInput, HostLlmResult } from './host-model-service'
import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const call = async (
  endpoint: string,
  token: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> =>
  fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'llmCall', params }),
    signal
  })

describe('llmCall RPC', () => {
  it('routes only through a control capability and strips trusted identity fields', async () => {
    const hostLlmCall = vi.fn<
      (input: HostLlmCallInput, signal?: AbortSignal) => Promise<HostLlmResult>
    >(async () => ({ text: 'PONG', model: 'model-a', stopReason: 'end_turn' }))
    const hostLlm = {
      isLlmAvailable: vi.fn(async () => true),
      isCurrentModelAvailable: vi.fn(async () => true),
      isListModelsAvailable: vi.fn(async () => true),
      currentModel: vi.fn(async () => 'model-a'),
      listModels: vi.fn(async () => ['model-a']),
      call: hostLlmCall
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: hostLlm
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const response = await call(control.endpoint, control.token, {
      request: 'PING',
      sessionId: 'forged-session',
      projectId: 'forged-project'
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: { text: 'PONG', model: 'model-a', stopReason: 'end_turn' }
    })
    expect(hostLlmCall).toHaveBeenCalledOnce()
    expect(hostLlmCall.mock.calls[0]?.[0]).toEqual({ request: 'PING' })
    expect(hostLlmCall.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)

    const agent = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const forbidden = await call(agent.endpoint, agent.token, { request: 'PING' })
    expect(forbidden.status).toBe(403)
    await expect(forbidden.json()).resolves.toEqual({
      error: 'host.llm requires a control-plane REPL capability.'
    })

    const bootstrap = await server.ensureStarted()
    const unauthorized = await call(bootstrap.endpoint, bootstrap.token, { request: 'PING' })
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toEqual({
      error: 'A session-bound notebook RPC token is required.'
    })
  })

  it('aborts host inference when the RPC client disconnects', async () => {
    let observedSignal: AbortSignal | undefined
    const hostLlm = {
      isLlmAvailable: vi.fn(async () => true),
      isCurrentModelAvailable: vi.fn(async () => true),
      isListModelsAvailable: vi.fn(async () => true),
      currentModel: vi.fn(async () => 'model-a'),
      listModels: vi.fn(async () => ['model-a']),
      call: vi.fn(
        async (_input: unknown, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            observedSignal = signal
            signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true
            })
          })
      )
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: hostLlm
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const controller = new AbortController()
    const request = call(control.endpoint, control.token, { request: 'PING' }, controller.signal)

    await vi.waitFor(() => expect(hostLlm.call).toHaveBeenCalled())
    controller.abort()

    await expect(request).rejects.toThrow()
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true))
  })
})
