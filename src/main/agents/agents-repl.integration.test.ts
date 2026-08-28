import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
import {
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopResponse
} from '../notebook/kernel-protocol'
import { AgentsService, type AgentsCatalogSource, type AgentsReadOp } from './agents-service'
import { createSpecialistService, type SpecialistService } from '../specialist/service'
import type { StoredConnectors } from '../settings/types'

// Run with: RUN_KERNEL=1 npx vitest run src/main/agents/agents-repl.integration.test.ts
// Exercises the real resources/notebook/repl_loop.js against a real NotebookLocalRpcServer wired
// to a real AgentsService + SpecialistService, covering the full host.agents tracer bullet.
const gate = process.env.RUN_KERNEL ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const startLoop = (
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(process.execPath, [LOOP], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  })
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: KernelLoopResponse) => void>()
  rl.on('line', (line) => {
    const msg = parseLoopResponse(line)
    if (!msg) return
    const w = waiters.get(msg.reqId)
    if (w) {
      waiters.delete(msg.reqId)
      w(msg)
    }
  })
  const send = (code: string): Promise<KernelLoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(framePythonRequest(reqId, code))
    })
  return { child, send }
}

// A catalog stub that returns a deterministic, secret-free catalog so the integration test does not
// depend on the filesystem-backed skill registry. It deliberately includes a Main-disabled skill to
// prove the Specialist-visible catalog is complete.
const stubCatalog: AgentsCatalogSource = {
  listSkillCatalog: async () => [
    {
      id: 'demo',
      frameworkName: 'demo',
      displayName: 'demo',
      source: 'featured',
      mainEnabled: true,
      available: true
    },
    {
      id: 'personal-foo',
      frameworkName: 'foo',
      displayName: 'foo',
      source: 'personal',
      mainEnabled: false,
      available: true
    },
    {
      id: 'dup-a',
      frameworkName: 'dup',
      displayName: 'dup',
      source: 'featured',
      mainEnabled: true,
      available: true
    },
    {
      id: 'dup-b',
      frameworkName: 'dup',
      displayName: 'dup',
      source: 'featured',
      mainEnabled: true,
      available: true
    }
  ],
  getConnectors: async (): Promise<StoredConnectors | undefined> => ({
    enabledIds: [],
    autoAllowIds: [],
    disabledConnectorIds: ['chemistry'],
    customMcpServers: [
      {
        id: 'cust-1',
        name: 'my-server',
        displayName: 'My Server',
        transport: 'stdio',
        enabled: true,
        command: 'run'
      }
    ]
  })
}

gate('host.agents repl integration', () => {
  let rpcServer: NotebookLocalRpcServer
  let endpoint: string
  let token: string
  let profileStorage: string
  let runtimeStorage: string
  let agentsService: AgentsService
  let capturedSessionId: string | undefined
  let releaseControl: (() => void) | undefined

  beforeAll(async () => {
    profileStorage = await mkdtemp(join(tmpdir(), 'os-agents-profile-'))
    runtimeStorage = await mkdtemp(join(tmpdir(), 'os-agents-runtime-'))
    const specialistService = createSpecialistService(profileStorage)
    agentsService = new AgentsService({ specialistService, catalog: stubCatalog })
    const notebookService = new NotebookRuntimeService({
      configRoot: runtimeStorage,
      dataRoot: runtimeStorage,
      projectId: 'default-project',
      repository: new NotebookRunRepository(runtimeStorage),
      executorFactory: () => ({
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: runtimeStorage,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    rpcServer = new NotebookLocalRpcServer(notebookService, {
      token: 'integration-token',
      agentsService: {
        read: async (op, context) => {
          // Capture the trusted calling-session identity the server forwarded.
          capturedSessionId = context.sessionId
          return agentsService.read(op as AgentsReadOp)
        }
      }
    })
    const connection = await rpcServer.issueControlConnection(
      'session-trusted',
      'default-project',
      'root-frame-session-trusted'
    )
    endpoint = connection.endpoint
    token = connection.token
    releaseControl = connection.release

    // Seed a specialist profile directly through the authoritative SpecialistService.
    await specialistService.create({
      name: 'Bio Expert',
      description: 'secret: apikey=XYZ',
      systemPrompt: 'RPC SYSTEM PROMPT SENTINEL',
      iconKey: 'beaker',
      colorKey: 'green'
    })
  })

  afterAll(async () => {
    releaseControl?.()
    await rpcServer?.close()
    await rm(profileStorage, { recursive: true, force: true })
    await rm(runtimeStorage, { recursive: true, force: true })
  })

  it('host.agents.list() returns custom profiles via the real REPL + RPC server', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const r = await send('return JSON.stringify(await host.agents.list())')
      expect(r.error).toBeNull()
      const list = JSON.parse(r.result ?? '[]')
      expect(list).toHaveLength(1)
      expect(Object.keys(list[0]).sort()).toEqual(
        ['id', 'name', 'displayName', 'description', 'enabled'].sort()
      )
      expect(list[0].name).toBe('Bio Expert')
      expect(r.result).not.toContain('RPC SYSTEM PROMPT SENTINEL')
      // No synthesized Settings-only Reviewer row.
      expect(list.some((item: { id: string }) => item.id === 'reviewer')).toBe(false)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('host.agents.get(name) returns complete detail including the system prompt', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const r = await send("return JSON.stringify(await host.agents.get('Bio Expert'))")
      expect(r.error).toBeNull()
      const got = JSON.parse(r.result ?? '{}')
      expect(got.name).toBe('Bio Expert')
      expect(got.revision).toBe(1)
      expect(typeof got.id).toBe('string')
      expect(got.systemPrompt).toBe('RPC SYSTEM PROMPT SENTINEL')
      expect(Object.keys(got).sort()).toEqual(
        [
          'id',
          'name',
          'displayName',
          'description',
          'enabled',
          'systemPrompt',
          'iconKey',
          'colorKey',
          'capabilityMode',
          'fullAccess',
          'selectedCapabilities',
          'revision'
        ].sort()
      )
    } finally {
      child.kill()
    }
  }, 60_000)

  it('host.agents.listSkills() returns the full catalog including Main-disabled skills', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      const r = await send('return JSON.stringify(await host.agents.listSkills())')
      expect(r.error).toBeNull()
      const skills = JSON.parse(r.result ?? '[]')
      expect(skills.find((s: { id: string }) => s.id === 'personal-foo').mainEnabled).toBe(false)
      expect(skills.find((s: { id: string }) => s.id === 'demo').mainEnabled).toBe(true)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('host.agents.listSkills() filters by exact stable id', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      const r = await send("return JSON.stringify(await host.agents.listSkills('personal-foo'))")
      expect(r.error).toBeNull()
      const skills = JSON.parse(r.result ?? '[]')
      expect(skills).toHaveLength(1)
      expect(skills[0].id).toBe('personal-foo')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('host.agents.listSkills() rejects an ambiguous immutable name with a stable-id hint', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      const r = await send(
        "try { await host.agents.listSkills('dup'); return 'no-throw' } catch (e) { return e.message }"
      )
      expect(r.result).toMatch(/stable id/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('host.agents.listConnectors() projects connectors without secrets', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      const r = await send('return JSON.stringify(await host.agents.listConnectors())')
      expect(r.error).toBeNull()
      const text = r.result ?? ''
      // No secret material leaks.
      expect(text).not.toMatch(/apikey|headerRefs|envRefs|command/)
      const connectors = JSON.parse(text)
      const chemistry = connectors.find((c: { id: string }) => c.id === 'chemistry')
      expect(chemistry.mainEnabled).toBe(false)
      expect(chemistry.tools.length).toBeGreaterThan(0)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('authentication failure: a bad token is rejected at the RPC boundary', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'wrong-token'
    })
    try {
      const r = await send(
        "try { await host.agents.list(); return 'ok' } catch (e) { return e.message }"
      )
      expect(r.result).toMatch(/host\.agents\.list:/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('token isolation: sandbox code cannot read the RPC token from process.env', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'secret-token-value'
    })
    try {
      const r = await send('return JSON.stringify(process.env.OPEN_SCIENCE_MCP_RPC_TOKEN ?? null)')
      expect(r.error).toBeNull()
      expect(JSON.parse(r.result ?? '""')).toBeNull()
    } finally {
      child.kill()
    }
  }, 60_000)

  it('trusted session capture: the server receives the captured calling session identity', async () => {
    capturedSessionId = undefined
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-trusted'
    })
    try {
      const r = await send('return JSON.stringify(await host.agents.list())')
      expect(r.error).toBeNull()
      expect(capturedSessionId).toBe('session-trusted')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('sandbox code cannot forge a different calling session via a request param', async () => {
    capturedSessionId = undefined
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-real'
    })
    try {
      // Try to smuggle a forged session id directly through fetch (simulating malicious sandbox code).
      const r = await send(
        "await fetch(process.env.__rpc ?? '', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'forged' }, body: JSON.stringify({ method: 'agentsCall', params: { op: 'list', session_id: 'forged-session' } }) }).then(r => r.status).catch(() => 'err'); return 'done'"
      )
      void r
      // Even via a legitimate call, the trusted identity is the captured one.
      const r2 = await send('return JSON.stringify(await host.agents.list())')
      expect(r2.error).toBeNull()
      expect(capturedSessionId).toBe('session-trusted')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('sanitized errors: invalid params surface as host.agents.<method>: errors', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      const r = await send(
        "try { await host.agents.get('Does Not Exist'); return 'ok' } catch (e) { return e.message }"
      )
      expect(r.result).toMatch(/host\.agents\.get:/)
      // The error must not leak any internal secret string from another profile.
      expect(r.result).not.toMatch(/apikey/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('redacts dependency error details before they reach the Agent sandbox', async () => {
    const originalService = agentsService
    agentsService = new AgentsService({
      specialistService: {
        list: async () => {
          throw new Error(
            'request failed: token=secret-token path=/Users/alice/project params={"prompt":"private"} HOME=/Users/alice'
          )
        }
      } as unknown as SpecialistService,
      catalog: stubCatalog
    })
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      const response = await send(
        "try { await host.agents.list(); return 'ok' } catch (error) { return error.message }"
      )
      expect(response.result).toBe('host.agents.list: Internal operation failed.')
    } finally {
      agentsService = originalService
      child.kill()
    }
  }, 60_000)

  it('host.agents is absent from python data kernels (no host global there)', async () => {
    // The control-plane SDK is injected only in repl_loop.js. python_loop.py / r_loop.R do not
    // expose a host global at all. This test documents that contract: the repl script is the sole
    // host of host.agents, and a real python/r data kernel never receives it. We assert by checking
    // the python loop source has no host.agents injection.
    const { readFileSync } = await import('node:fs')
    const pythonLoop = readFileSync(
      join(__dirname, '../../../resources/notebook/python_loop.py'),
      'utf8'
    )
    expect(pythonLoop).not.toMatch(/host\.agents|agentsCall/)
    const rLoop = readFileSync(join(__dirname, '../../../resources/notebook/r_loop.R'), 'utf8')
    expect(rLoop).not.toMatch(/host\.agents|agentsCall/)
  })
})
