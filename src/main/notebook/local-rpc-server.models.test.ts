import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const call = async (
  connection: { endpoint: string; token: string },
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ method, params })
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('Host model introspection RPC', () => {
  it('resolves currentModel from the token-bound calling Session', async () => {
    const currentModel = vi.fn(async (sessionId: string) => `model-for:${sessionId}`)
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel,
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(call(connection, 'currentModelCall')).resolves.toEqual({
      status: 200,
      body: { result: 'model-for:trusted-session' }
    })
    expect(currentModel).toHaveBeenCalledWith('trusted-session')

    await expect(
      call(connection, 'currentModelCall', { sessionId: 'forged-session' })
    ).resolves.toEqual({
      status: 400,
      body: { error: 'host.currentModel RPC params must be empty.' }
    })
    expect(currentModel).toHaveBeenCalledOnce()
  })

  it('returns the configured Host LLM Provider catalog without caller identity input', async () => {
    const listModels = vi.fn(async () => Object.freeze(['model-a', 'model-b']))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels,
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(call(connection, 'listModelsCall')).resolves.toEqual({
      status: 200,
      body: { result: ['model-a', 'model-b'] }
    })
    expect(listModels).toHaveBeenCalledOnce()
  })

  it('rejects model introspection through an ordinary non-control Session token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(call(connection, 'currentModelCall')).resolves.toEqual({
      status: 403,
      body: { error: 'host.currentModel requires a control-plane REPL capability.' }
    })
    await expect(call(connection, 'listModelsCall')).resolves.toEqual({
      status: 403,
      body: { error: 'host.listModels requires a control-plane REPL capability.' }
    })
  })
})
