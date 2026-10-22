import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  AuthorizedDirectoryDiscovery,
  AUTHORIZED_DIRECTORIES_DESCRIPTION
} from '../local-fs/authorized-directories'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { createNotebookMcpServer } from './mcp-server'

let rpc: NotebookLocalRpcServer | undefined
let client: Client | undefined
let mcp: ReturnType<typeof createNotebookMcpServer> | undefined

afterEach(async () => {
  await client?.close()
  await mcp?.close()
  await rpc?.close()
})

describe('authorized directories through authenticated MCP', () => {
  it('queries records without a kernel, distinguishes failure, and refreshes after context loss', async () => {
    const records = {
      revision: 'revision-1',
      directories: [
        {
          path: '/not-on-disk',
          name: 'Research',
          access: 'ro' as const,
          grantedAt: '2026-10-21T00:00:00.000Z'
        }
      ]
    }
    const read = vi.fn().mockResolvedValue(records)
    const discovery = new AuthorizedDirectoryDiscovery(read)
    const query = vi.spyOn(discovery, 'query')
    // Any attempt to access the compute runtime fails this test.
    const runtime = new Proxy(
      {},
      {
        get() {
          throw new Error('must not touch the kernel')
        }
      }
    )
    rpc = new NotebookLocalRpcServer(runtime as never, {
      transport: 'tcp',
      authorizedDirectories: discovery
    })
    const connection = await rpc.issueSessionConnection('session-1', 'project-1', 'frame-1')
    mcp = createNotebookMcpServer({
      ...connection,
      sessionId: 'session-1',
      projectId: 'project-1',
      workspaceCwd: '/not-on-disk'
    })
    client = new Client({ name: 'authorized-directories-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === 'list_authorized_directories'
    )!
    expect(tool.description).toBe(AUTHORIZED_DIRECTORIES_DESCRIPTION)
    expect(tool.inputSchema.properties).toEqual({})
    const call = (): ReturnType<Client['callTool']> =>
      client!.callTool({ name: 'list_authorized_directories', arguments: {} })
    const success = await call()
    expect(success.isError).not.toBe(true)
    expect(success.structuredContent).toEqual(records)
    expect(query).toHaveBeenCalledWith('session-1')
    read.mockRejectedValueOnce(new Error('record query failed'))
    expect((await call()).isError).toBe(true)
    read.mockResolvedValue({ revision: 'revision-2', directories: [] })
    expect((await call()).structuredContent).toEqual({ revision: 'revision-2', directories: [] })
    // No backend cache survives a tool call made after context restoration or a denied access.
    read.mockResolvedValue(records)
    expect((await call()).structuredContent).toEqual(records)
    expect(read).toHaveBeenCalledTimes(4)
    const denied = await fetch(connection.endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'listAuthorizedDirectories',
        params: { sessionId: 'session-1' }
      })
    })
    expect(denied.status).toBe(401)
  })
})
