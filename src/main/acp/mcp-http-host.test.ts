import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository } from '../artifacts/repository'

describe('AgentMcpHttpHost', () => {
  let host: AgentMcpHttpHost | undefined
  let rpcServer: Server | undefined
  let root: string | undefined

  afterEach(async () => {
    await host?.close()
    host = undefined
    if (rpcServer) {
      rpcServer.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        rpcServer?.close((error) => (error ? reject(error) : resolve()))
      )
      rpcServer = undefined
    }

    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('serves the artifact MCP tools over http and writes a file for the active run', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-http-host-'))
    const projectId = 'default-project'
    const artifactSessionId = 'artifact-session-1'
    const runId = 'artifact-run-1'
    // The artifact tool reads the active run id from this main-process-owned handoff file.
    const currentRunFile = join(root, 'current-run.json')
    await writeFile(currentRunFile, JSON.stringify({ runId }), 'utf8')

    host = new AgentMcpHttpHost()
    const { endpoint, token } = await host.ensureStarted()
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    host.registerArtifact(artifactSessionId, {
      storageRoot: root,
      projectId,
      sessionId: artifactSessionId,
      currentRunFile,
      allowedImportRoots: [root]
    })

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(host.urlFor('artifact', artifactSessionId)),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }
    )
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('write_artifact_file')

    const result = await client.callTool({
      name: 'write_artifact_file',
      arguments: {
        filename: 'note.txt',
        source: { kind: 'inline', content: 'hello http mcp', encoding: 'utf8' }
      }
    })
    expect(JSON.stringify(result.content)).toContain('note.txt')

    await client.close()

    // The file landed in the pending run through the same repository the stdio path uses.
    const files = await new ArtifactRepository(root).listPendingRunFiles({
      projectId,
      sessionId: artifactSessionId,
      runId
    })
    expect(files.map((file) => file.name)).toContain('note.txt')
  })

  it('accepts a JSON-stringified artifact source from an MCP model call', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-http-host-'))
    const projectId = 'default-project'
    const artifactSessionId = 'artifact-session-1'
    const runId = 'artifact-run-1'
    const currentRunFile = join(root, 'current-run.json')
    await writeFile(currentRunFile, JSON.stringify({ runId }), 'utf8')

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerArtifact(artifactSessionId, {
      storageRoot: root,
      projectId,
      sessionId: artifactSessionId,
      currentRunFile,
      allowedImportRoots: [root]
    })

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(host.urlFor('artifact', artifactSessionId)),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }
    )
    await client.connect(transport)

    const result = await client.callTool({
      name: 'write_artifact_file',
      arguments: {
        filename: 'report.md',
        mimeType: 'text/markdown',
        source: JSON.stringify({ kind: 'inline', content: '# Report' })
      }
    })
    expect(JSON.stringify(result.content)).toContain('report.md')

    await client.close()

    const files = await new ArtifactRepository(root).listPendingRunFiles({
      projectId,
      sessionId: artifactSessionId,
      runId
    })
    expect(files.map((file) => file.name)).toContain('report.md')
  })

  it('serves the conversation Skill import tool over http', async () => {
    const routingId = 'skill-import-session-1'
    const rpcRequest: { authorization?: string; body?: unknown } = {}
    rpcServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        }
        rpcRequest.authorization = request.headers.authorization
        rpcRequest.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ result: { status: 'cancelled', skills: [] } }))
      })()
    })
    await new Promise<void>((resolve, reject) => {
      rpcServer?.once('error', reject)
      rpcServer?.listen(0, '127.0.0.1', resolve)
    })
    const rpcAddress = rpcServer.address()
    if (typeof rpcAddress !== 'object' || rpcAddress === null) {
      throw new Error('Test Skill RPC server did not return a TCP address.')
    }

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerSkillImport(routingId, {
      endpoint: `http://127.0.0.1:${rpcAddress.port}/skill-import`,
      token: 'rpc-token',
      sessionId: routingId
    })

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const skillImportUrl = host.urlFor('skill-import', routingId)
    const transport = new StreamableHTTPClientTransport(new URL(skillImportUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('request_skill_import')

    const result = await client.callTool({
      name: 'request_skill_import',
      arguments: {
        github_url: 'https://github.com/acme/skills/tree/main/slide-master'
      }
    })
    expect(JSON.stringify(result.content)).toContain('cancelled')
    expect(rpcRequest).toEqual({
      authorization: 'Bearer rpc-token',
      body: {
        method: 'skillImport',
        params: {
          sessionId: routingId,
          githubUrl: 'https://github.com/acme/skills/tree/main/slide-master'
        }
      }
    })

    await client.close()

    host.unregister(routingId)
    const removed = await fetch(skillImportUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{}'
    })
    expect(removed.status).toBe(404)
  })

  it('keeps Plan execution identity stable across stateless HTTP requests and revokes the route', async () => {
    const routingId = 'plan-session-1'
    const rpcBodies: unknown[] = []
    rpcServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          params?: { operation?: string }
        }
        rpcBodies.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            result:
              body.params?.operation === 'approve'
                ? { projection: { artifactVersionId: 'version-1', lifecycle: 'approved' } }
                : { projection: { artifactVersionId: 'version-1', lifecycle: 'completed' } }
          })
        )
      })()
    })
    await new Promise<void>((resolve, reject) => {
      rpcServer?.once('error', reject)
      rpcServer?.listen(0, '127.0.0.1', resolve)
    })
    const rpcAddress = rpcServer.address()
    if (typeof rpcAddress !== 'object' || rpcAddress === null) {
      throw new Error('Test Plan RPC server did not return a TCP address.')
    }

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerPlan(routingId, {
      endpoint: `http://127.0.0.1:${rpcAddress.port}/plan`,
      token: 'plan-rpc-token',
      projectId: 'project-1',
      sessionId: routingId
    })
    const planUrl = host.urlFor('plan', routingId)
    const client = new Client({ name: 'plan-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(planUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'generate_plan',
      'update_step_status'
    ])
    await client.callTool({ name: 'generate_plan', arguments: { approve: true } })
    await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'completed' }
    })
    expect(rpcBodies).toEqual([
      {
        method: 'planCall',
        params: {
          projectId: 'project-1',
          sessionId: routingId,
          operation: 'approve'
        }
      },
      {
        method: 'planCall',
        params: {
          projectId: 'project-1',
          sessionId: routingId,
          operation: 'updateStepStatus',
          input: {
            title: 'Analyze the data',
            status: 'completed',
            expectedArtifactVersionId: 'version-1'
          }
        }
      }
    ])

    await client.close()
    host.unregister(routingId)
    const removed = await fetch(planUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(removed.status).toBe(404)
  })

  it('serves the linked Literature reader over its bound route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const readDocument = vi.fn(async () => ({ content: 'page text', nextCursor: null }))
    host.registerLiterature('literature-session-1', { readDocument })
    const client = new Client({ name: 'literature-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(host.urlFor('literature', 'literature-session-1')),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }
      )
    )

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_document'])
    await client.callTool({ name: 'read_document', arguments: {} })
    expect(readDocument).toHaveBeenCalledWith({})
    await client.close()
  })

  it('rejects requests without the bearer token', async () => {
    host = new AgentMcpHttpHost()
    const { endpoint } = await host.ensureStarted()

    const response = await fetch(`${endpoint}/mcp/artifact/whatever`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })

    expect(response.status).toBe(401)
  })

  it('rejects an authenticated request body above the host budget', async () => {
    host = new AgentMcpHttpHost({ requestBytes: 2 })
    const { endpoint, token } = await host.ensureStarted()
    host.registerHostMessage('bounded', { sendMessage: vi.fn() })

    const response = await fetch(`${endpoint}/mcp/host-message/bounded`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{} '
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
  })

  it('serves one trusted side-chat host-message handler over its bound route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const sendMessage = vi.fn().mockResolvedValue({
      status: 'queued',
      messageId: 'side-chat-message-1',
      targetState: 'idle',
      delivery: 'next-user-turn',
      persisted: true,
      systemHint: 'Wait for the next user turn.'
    })
    host.registerHostMessage('side-routing-1', { sendMessage })
    const client = new Client({ name: 'host-message-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor('host-message', 'side-routing-1')), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    const result = await client.callTool({
      name: 'send_message',
      arguments: { target: 'main', text: 'Use black.' }
    })

    expect(sendMessage).toHaveBeenCalledWith({ target: 'main', text: 'Use black.' })
    expect(result.structuredContent).toMatchObject({ messageId: 'side-chat-message-1' })
    await client.close()
  })
})
