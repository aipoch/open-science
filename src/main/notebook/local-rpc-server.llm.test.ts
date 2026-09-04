import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HostModelService,
  type HostLlmBatchItem,
  type HostLlmCallInput,
  type HostLlmResult
} from './host-model-service'
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

  it('keeps active-turn provenance out of single and batch Host LLM inputs', async () => {
    const hostLlmCall = vi.fn<
      (
        input: HostLlmCallInput,
        signal?: AbortSignal
      ) => Promise<HostLlmResult | readonly HostLlmBatchItem[]>
    >(async (input) =>
      'requests' in input
        ? input.requests.map((request) => ({
            text: typeof request === 'string' ? request : request.prompt,
            model: 'model-a',
            stopReason: 'end_turn' as const
          }))
        : { text: 'PONG', model: 'model-a', stopReason: 'end_turn' }
    )
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
      hostModel: hostLlm,
      inputRegistry: {
        registerTurn: vi.fn(async () => []),
        getTurnInputs: vi.fn(() => []),
        clearSession: vi.fn()
      }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    server.setArtifactTurnBinding('trusted-session', {
      ownerExecutionId: 'execution-1',
      projectId: 'trusted-project',
      provenanceContext: {
        rootFrameId: 'root-frame-trusted-session',
        agentFrameId: 'root-frame-trusted-session',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })
    await server.registerNotebookTurnInputs({
      projectId: 'trusted-project',
      appSessionId: 'trusted-session',
      promptMessageId: 'prompt-1',
      uploads: [],
      references: []
    })

    const single = await call(control.endpoint, control.token, { request: 'PING' })
    const batch = await call(control.endpoint, control.token, {
      requests: ['one', { prompt: 'two' }],
      options: { max_concurrency: 2 }
    })

    expect(single.status).toBe(200)
    expect(batch.status).toBe(200)
    expect(hostLlmCall.mock.calls.map(([input]) => input)).toEqual([
      { request: 'PING' },
      {
        requests: ['one', { prompt: 'two' }],
        options: { max_concurrency: 2 }
      }
    ])
    expect(hostLlmCall.mock.calls.every(([, signal]) => signal instanceof AbortSignal)).toBe(true)
  })

  it('preserves unknown user fields for strict Host LLM input validation', async () => {
    const captureTarget = vi.fn(async () => {
      throw new Error('inference should not start')
    })
    const hostModel = new HostModelService({
      captureTarget,
      captureSessionModel: () => undefined,
      captureModelCatalog: vi.fn(async () => ({ providers: [] })),
      runner: {
        run: vi.fn(),
        shutdown: vi.fn(async () => undefined),
        supportsTarget: vi.fn(() => true),
        sweepStaleProfiles: vi.fn(async () => undefined)
      } as never
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const response = await call(control.endpoint, control.token, {
      request: 'PING',
      model: 'forged-model'
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'host.llm single input must contain only request.'
    })
    expect(captureTarget).not.toHaveBeenCalled()
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
