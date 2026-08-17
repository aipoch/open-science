import { afterEach, describe, expect, it } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = {
  endpoint: string
  token: string
}

const callCapabilities = async (
  connection: RpcConnection,
  token = connection.token,
  params: Record<string, unknown> = {}
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'capabilitiesCall', params })
  })
  return {
    response,
    payload: (await response.json()) as Record<string, unknown>
  }
}

const callHostSdkHelp = async (
  connection: RpcConnection,
  query: string
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'hostSdkHelp', params: { query } })
  })
  return {
    response,
    payload: (await response.json()) as Record<string, unknown>
  }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('capabilitiesCall RPC', () => {
  it('projects the exact configured host namespace bitmap from a control capability', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: {} as never,
      computeService: {} as never,
      agentsService: {} as never,
      skillsService: {} as never,
      hostArtifacts: {} as never,
      hostLineage: {} as never,
      hostFrames: {} as never,
      hostSessions: {} as never,
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const { response, payload } = await callCapabilities(connection, connection.token, {
      sessionId: 'forged-session',
      projectId: 'forged-project',
      mcp: false
    })

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      result: {
        mcp: true,
        compute: true,
        agents: true,
        skills: true,
        artifacts: true,
        lineage: true,
        frames: true,
        sessions: true,
        llm: true,
        currentModel: true,
        listModels: true,
        viewImage: false,
        delegate: false,
        children: false,
        collect: false,
        stopChild: false,
        sendFrameMessage: false,
        messageReceipt: false,
        resolveMessage: false,
        submitOutput: false
      }
    })
  })

  it('returns false for known namespaces whose server handler is not configured', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: {} as never
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: {
        result: {
          mcp: true,
          compute: false,
          agents: false,
          skills: false,
          artifacts: false,
          lineage: false,
          frames: false,
          llm: false,
          currentModel: false,
          listModels: false,
          viewImage: false
        }
      }
    })
  })

  it('does not advertise delegated work without the trusted origin required by its route', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: {
        delegate: async () => ({}) as never,
        sendMessage: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { delegate: false, sendFrameMessage: false } }
    })

    endInvocation()
  })

  it('does not advertise Host Frames to an ordinary non-control Session token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostFrames: {} as never
    })
    const connection = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { frames: false } }
    })
  })

  it('does not advertise Host Session diagnostics to ordinary or delegate control tokens', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostSessions: {} as never
    })
    const ordinary = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const delegate = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'delegate-frame',
      { role: 'delegate', attemptId: 'attempt-1' }
    )

    await expect(callCapabilities(ordinary)).resolves.toMatchObject({
      payload: { result: { sessions: false } }
    })
    await expect(callCapabilities(delegate)).resolves.toMatchObject({
      payload: { result: { sessions: false } }
    })
  })

  it('returns false when host.llm is configured but the active route is unavailable', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => false,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { llm: false, currentModel: true, listModels: true } }
    })
  })

  it('does not advertise host.llm through a non-control session capability', async () => {
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

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { llm: false, currentModel: false, listModels: false } }
    })
  })

  it('reports host.llm as available through authenticated host.help', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => false,
        isListModelsAvailable: async () => false,
        currentModel: async () => 'model-a',
        listModels: async () => [],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callHostSdkHelp(connection, 'llm')).resolves.toMatchObject({
      response: { status: 200 },
      payload: {
        result: {
          kind: 'operation',
          id: 'host.llm',
          availability: { status: 'available' }
        }
      }
    })
  })

  it('reports host.sessions as available through authenticated host.help', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostSessions: {} as never
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callHostSdkHelp(connection, 'sessions')).resolves.toMatchObject({
      response: { status: 200 },
      payload: {
        result: {
          kind: 'operation',
          id: 'host.sessions',
          availability: { status: 'available' }
        }
      }
    })
  })

  it('does not advertise host.viewImage without a trusted execution workspace', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => true,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { viewImage: false } }
    })

    endInvocation()
  })

  it('reports host.viewImage unavailable from host.help without a trusted execution workspace', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => true,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callHostSdkHelp(connection, 'viewImage')).resolves.toMatchObject({
      payload: { result: { availability: { status: 'unavailable' } } }
    })

    endInvocation()
  })

  it('advertises host.viewImage with an active invocation and trusted execution workspace', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => true,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session',
      { role: 'main' },
      '/trusted-workspace'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { viewImage: true } }
    })

    endInvocation()
  })

  it('does not advertise host.viewImage when its certified visual route is unavailable', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => false,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session',
      { role: 'main' },
      '/trusted-workspace'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { viewImage: false } }
    })

    endInvocation()
  })

  it('rejects bootstrap, invalid, and released tokens instead of returning an all-false bitmap', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp'
    })
    const bootstrap = await server.ensureStarted()
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const bootstrapAttempt = await callCapabilities(control, bootstrap.token)
    expect(bootstrapAttempt.response.status).toBe(401)
    expect(bootstrapAttempt.payload).toEqual({
      error: 'A session-bound notebook RPC token is required.'
    })

    const invalidAttempt = await callCapabilities(control, 'invalid-token')
    expect(invalidAttempt.response.status).toBe(401)
    expect(invalidAttempt.payload).toEqual({ error: 'Invalid notebook RPC token.' })

    control.release()
    const releasedAttempt = await callCapabilities(control)
    expect(releasedAttempt.response.status).toBe(401)
    expect(releasedAttempt.payload).toEqual({ error: 'Invalid notebook RPC token.' })
  })
})
