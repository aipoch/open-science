import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArtifactMcpServer } from '../artifacts/mcp-server'
import { ArtifactRepository } from '../artifacts/repository'
import { createCodexBridgeMcpTools } from '../settings/codex-bridge-tools'
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../local-rpc-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-rpc-transport')>()),
  fetchLocalRpc: rpc
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  rpc.mockReset()
})
async function setup(): Promise<{
  client: Client
  currentRunFile: string
  context: Record<string, string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'video-mcp-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const currentRunFile = join(root, 'current-run.json')
  const context = {
    artifactRunId: 'run',
    appSessionId: 'session',
    rootFrameId: 'frame',
    agentFrameId: 'frame',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt',
    rpcCapabilityToken: 'token',
    notebookDataDir: root
  }
  await writeFile(currentRunFile, JSON.stringify(context))
  vi.stubEnv('OPEN_SCIENCE_APPLICATION_PATH', root)
  const server = createArtifactMcpServer(new ArtifactRepository(root), {
    storageRoot: root,
    projectId: 'project',
    sessionId: 'session',
    currentRunFile,
    allowedImportRoots: [root],
    rpcEndpoint: 'http://localhost',
    rpcSocketPath: join(root, 'runtime.sock')
  })
  const client = new Client({ name: 'video-contract', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(right), client.connect(left)])
  cleanup.push(
    () => server.close(),
    () => client.close()
  )
  return { client, currentRunFile, context }
}
describe('research video Agent contract', () => {
  it('exposes matching MCP and Codex declarations with an authoring guide', async () => {
    const { client } = await setup()
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'research_video_guide',
        'generate_research_video',
        'write_artifact_file'
      ])
    )
    const bridge = createCodexBridgeMcpTools({ artifacts: true }).map((tool) => tool.name)
    expect(bridge).toEqual(expect.arrayContaining(names))
    const guide = await client.callTool({ name: 'research_video_guide', arguments: {} })
    expect(JSON.stringify(guide)).toContain('active conversation branch')
    expect(rpc).not.toHaveBeenCalled()
  })
  it('delegates generation to the run-bound primary runtime and returns only its Artifact receipts', async () => {
    const { client, currentRunFile, context } = await setup()
    rpc.mockImplementation(async (_connection, request) => {
      const body = JSON.parse(request.body)
      expect(body).toMatchObject({
        method: 'researchVideoGenerate',
        params: {
          projectId: 'project',
          appSessionId: 'session',
          artifactRunId: 'run',
          messageBranchId: 'branch',
          specPath: 'video.json'
        }
      })
      expect(request.headers.authorization).toBe('Bearer token')
      expect(body.params).not.toHaveProperty('sourceScope')
      await writeFile(
        currentRunFile,
        JSON.stringify({ ...context, messageBranchId: 'another-branch' })
      )
      return new Response(
        JSON.stringify({
          result: {
            player: {
              artifactId: 'player',
              versionId: 'v1',
              versionNumber: 1,
              name: 'explanation.html',
              size: 20
            },
            sources: {
              artifactId: 'sources',
              versionId: 'v2',
              versionNumber: 1,
              name: 'sources.zip',
              size: 10
            },
            duration: 5,
            preparationMs: 100
          }
        })
      )
    })
    const result = await client.callTool({
      name: 'generate_research_video',
      arguments: { specPath: 'video.json' }
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain('v1')
    expect(JSON.stringify(result)).toContain('v2')
    expect(rpc).toHaveBeenCalledOnce()
  })
})
