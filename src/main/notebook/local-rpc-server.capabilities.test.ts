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
      hostLlm: { isAvailable: async () => true, call: async () => ({}) as never }
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
        llm: true
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
          llm: false
        }
      }
    })
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

  it('returns false when host.llm is configured but the active route is unavailable', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostLlm: { isAvailable: async () => false, call: async () => ({}) as never }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { llm: false } }
    })
  })

  it('does not advertise host.llm through a non-control session capability', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostLlm: { isAvailable: async () => true, call: async () => ({}) as never }
    })
    const connection = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { llm: false } }
    })
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
