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
describe('research film user-only entry', () => {
  it('does not expose generation to conversation MCP or Codex tools', async () => {
    const { client } = await setup()
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    const bridge = createCodexBridgeMcpTools({ artifacts: true }).map((tool) => tool.name)
    expect(names).toContain('write_artifact_file')
    expect(bridge).toContain('write_artifact_file')
    for (const name of ['research_video_guide', 'generate_research_video']) {
      expect(names).not.toContain(name)
      expect(bridge).not.toContain(name)
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
    }
    expect(rpc).not.toHaveBeenCalled()
  })
})
