import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository } from '../artifacts/repository'

describe('AgentMcpHttpHost', () => {
  let host: AgentMcpHttpHost | undefined
  let root: string | undefined

  afterEach(async () => {
    await host?.close()
    host = undefined

    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('serves the artifact MCP tools over http and writes a file for the active run', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-http-host-'))
    const projectName = 'default-project'
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
      projectName,
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
      projectName,
      sessionId: artifactSessionId,
      runId
    })
    expect(files.map((file) => file.name)).toContain('note.txt')
  })

  it('accepts a JSON-stringified artifact source from an MCP model call', async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-http-host-'))
    const projectName = 'default-project'
    const artifactSessionId = 'artifact-session-1'
    const runId = 'artifact-run-1'
    const currentRunFile = join(root, 'current-run.json')
    await writeFile(currentRunFile, JSON.stringify({ runId }), 'utf8')

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerArtifact(artifactSessionId, {
      storageRoot: root,
      projectName,
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

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === 'write_artifact_file'
    )
    expect(tool?.inputSchema.properties?.source).toMatchObject({
      anyOf: [{ type: 'object' }, { type: 'object' }]
    })

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
      projectName,
      sessionId: artifactSessionId,
      runId
    })
    expect(files.map((file) => file.name)).toContain('report.md')
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
})
