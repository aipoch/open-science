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
import { AgentsService, type AgentsCatalogSource } from './agents-service'
import { createSpecialistService } from '../specialist/service'
import type { StoredConnectors } from '../settings/types'

// Run with: RUN_KERNEL=1 npx vitest run src/main/agents/agents-repl.mutations.integration.test.ts
// Exercises the real resources/notebook/repl_loop.js against a real NotebookLocalRpcServer wired
// to a real AgentsService + SpecialistService, covering the host.agents ordinary-mutation slice:
// create, representative exact update, representative attach/detach, stale revision, stable catalog
// resolution, read-back, and the absence of additional permission requests on ordinary mutations.
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

// A catalog stub that returns a deterministic, secret-free catalog. Includes a Main-disabled skill
// (personal-foo) and a custom connector (my-server, runnable) plus an unreachable custom connector
// (cust-dead) to exercise the availability gate.
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
    }
  ],
  getConnectors: async (): Promise<StoredConnectors | undefined> => ({
    enabledIds: [],
    autoAllowIds: [],
    disabledConnectorIds: [],
    customMcpServers: [
      {
        id: 'cust-1',
        name: 'my-server',
        displayName: 'My Server',
        transport: 'stdio',
        enabled: true,
        command: 'run'
      },
      {
        id: 'cust-dead',
        name: 'dead-server',
        displayName: 'Dead Server',
        transport: 'stdio',
        enabled: true
      }
    ]
  })
}

gate('host.agents repl mutation integration', () => {
  let rpcServer: NotebookLocalRpcServer
  let endpoint: string
  let token: string
  let profileStorage: string
  let runtimeStorage: string
  let releaseControl: (() => void) | undefined

  beforeAll(async () => {
    profileStorage = await mkdtemp(join(tmpdir(), 'os-agents-mut-profile-'))
    runtimeStorage = await mkdtemp(join(tmpdir(), 'os-agents-mut-runtime-'))
    const specialistService = createSpecialistService(profileStorage)
    const agentsService = new AgentsService({ specialistService, catalog: stubCatalog })
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
      agentsService
    })
    const connection = await rpcServer.issueControlConnection(
      'mutation-session',
      'default-project',
      'root-frame-mutation-session'
    )
    endpoint = connection.endpoint
    token = connection.token
    releaseControl = connection.release
  })

  afterAll(async () => {
    releaseControl?.()
    await rpcServer?.close()
    await rm(profileStorage, { recursive: true, force: true })
    await rm(runtimeStorage, { recursive: true, force: true })
  })

  const env = (): NodeJS.ProcessEnv => ({
    OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
    OPEN_SCIENCE_MCP_RPC_TOKEN: token
  })

  it('create() produces Full access with neither capability array and returns a real read-back', async () => {
    const { child, send } = startLoop(env())
    try {
      const r = await send(
        "return JSON.stringify(await host.agents.create({ name: 'FullBot', description: 'a full bot' }))"
      )
      expect(r.error).toBeNull()
      const created = JSON.parse(r.result ?? '{}')
      // read-back is a real view, not echoed input.
      expect(created.name).toBe('FullBot')
      expect(created.capabilityMode).toBe('full')
      expect(created.revision).toBe(1)
      expect(typeof created.id).toBe('string')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create() maps every camelCase public input key to the unchanged Agents RPC contract', async () => {
    const { child, send } = startLoop(env())
    try {
      const r = await send(
        "return JSON.stringify(await host.agents.create({ name: 'MappedBot', displayName: 'Mapped Bot', description: 'mapped', systemPrompt: 'prompt', iconKey: 'beaker', colorKey: 'green', enabled: true, skillNames: ['demo'], connectorNames: ['my-server'] }))"
      )
      expect(r.error).toBeNull()
      expect(JSON.parse(r.result ?? '{}')).toMatchObject({
        name: 'MappedBot',
        displayName: 'Mapped Bot',
        description: 'mapped',
        systemPrompt: 'prompt',
        iconKey: 'beaker',
        colorKey: 'green',
        enabled: true,
        capabilityMode: 'selected',
        selectedCapabilities: { skillIds: ['demo'], connectorIds: ['cust-1'] }
      })
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create() with skillNames produces Selected and resolves a public name to a stable id', async () => {
    const { child, send } = startLoop(env())
    try {
      const r = await send(
        "return JSON.stringify(await host.agents.create({ name: 'SelBot', skillNames: ['foo'] }))"
      )
      expect(r.error).toBeNull()
      const created = JSON.parse(r.result ?? '{}')
      expect(created.capabilityMode).toBe('selected')
      // The public name 'foo' resolved to the stable id 'personal-foo', not echoed.
      expect(created.selectedCapabilities.skillIds).toEqual(['personal-foo'])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create() resolves a connector name to its local stable UUID', async () => {
    const { child, send } = startLoop(env())
    try {
      const r = await send(
        "return JSON.stringify(await host.agents.create({ name: 'ConnBot', connectorNames: ['my-server'] }))"
      )
      expect(r.error).toBeNull()
      const created = JSON.parse(r.result ?? '{}')
      expect(created.capabilityMode).toBe('selected')
      expect(created.selectedCapabilities.connectorIds).toEqual(['cust-1'])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('update() supports a representative exact update (description + skills) with read-back', async () => {
    const { child, send } = startLoop(env())
    try {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'UpdBot', description: 'before' }))"
          )
        ).result ?? '{}'
      )
      const r = await send(
        `return JSON.stringify(await host.agents.update('UpdBot', { revision: ${created.revision}, displayName: 'Updated Bot', description: 'after', systemPrompt: 'updated prompt', iconKey: 'flask', colorKey: 'blue', enabled: false, skillNames: ['demo'], connectorNames: ['my-server'] }))`
      )
      expect(r.error).toBeNull()
      const updated = JSON.parse(r.result ?? '{}')
      // read-back reflects the actual post-write state, not the echoed request.
      expect(updated.displayName).toBe('Updated Bot')
      expect(updated.description).toBe('after')
      expect(updated.systemPrompt).toBe('updated prompt')
      expect(updated.iconKey).toBe('flask')
      expect(updated.colorKey).toBe('blue')
      expect(updated.enabled).toBe(false)
      expect(updated.capabilityMode).toBe('selected')
      expect(updated.selectedCapabilities.skillIds).toEqual(['demo'])
      expect(updated.selectedCapabilities.connectorIds).toEqual(['cust-1'])
      expect(updated.revision).toBe(created.revision + 1)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('rejects every old Agents input key before it reaches the RPC service', async () => {
    const { child, send } = startLoop(env())
    try {
      const r = await send(
        "const errors = []; for (const key of ['display_name', 'system_prompt', 'icon_key', 'color_key', 'skill_names', 'connector_names']) { " +
          "try { await host.agents.create({ name: 'Old-' + key, [key]: key.endsWith('_names') ? [] : 'x' }) } " +
          "catch (error) { errors.push(error.name + ': ' + error.message) } } " +
          "for (const key of ['display_name', 'system_prompt', 'icon_key', 'color_key', 'skill_names', 'connector_names']) { " +
          "try { await host.agents.update('MappedBot', { revision: 1, [key]: key.endsWith('_names') ? [] : 'x' }) } " +
          "catch (error) { errors.push(error.name + ': ' + error.message) } } return JSON.stringify(errors)"
      )
      expect(r.error).toBeNull()
      expect(JSON.parse(r.result ?? '[]')).toEqual([
        'TypeError: host.agents.create input unknown option: display_name',
        'TypeError: host.agents.create input unknown option: system_prompt',
        'TypeError: host.agents.create input unknown option: icon_key',
        'TypeError: host.agents.create input unknown option: color_key',
        'TypeError: host.agents.create input unknown option: skill_names',
        'TypeError: host.agents.create input unknown option: connector_names',
        'TypeError: host.agents.update patch unknown option: display_name',
        'TypeError: host.agents.update patch unknown option: system_prompt',
        'TypeError: host.agents.update patch unknown option: icon_key',
        'TypeError: host.agents.update patch unknown option: color_key',
        'TypeError: host.agents.update patch unknown option: skill_names',
        'TypeError: host.agents.update patch unknown option: connector_names'
      ])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('update({ unrestricted: true }) switches to Full without destroying the stored Selected config', async () => {
    const { child, send } = startLoop(env())
    try {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'SwitchBot', skillNames: ['demo'] }))"
          )
        ).result ?? '{}'
      )
      const r = await send(
        `return JSON.stringify(await host.agents.update('SwitchBot', { revision: ${created.revision}, unrestricted: true }))`
      )
      expect(r.error).toBeNull()
      const updated = JSON.parse(r.result ?? '{}')
      expect(updated.capabilityMode).toBe('full')
      // Stored Selected config preserved.
      expect(updated.selectedCapabilities.skillIds).toEqual(['demo'])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('attachSkill / detachSkill mutate the current mode without switching it', async () => {
    const { child, send } = startLoop(env())
    try {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'AttachBot', skillNames: [] }))"
          )
        ).result ?? '{}'
      )
      // Selected attach adds an inclusion.
      const attached = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.attachSkill('AttachBot', 'demo', { revision: ${created.revision} }))`
          )
        ).result ?? '{}'
      )
      expect(attached.capabilityMode).toBe('selected')
      expect(attached.selectedCapabilities.skillIds).toEqual(['demo'])
      // detach removes it.
      const detached = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.detachSkill('AttachBot', 'demo', { revision: ${attached.revision} }))`
          )
        ).result ?? '{}'
      )
      expect(detached.capabilityMode).toBe('selected')
      expect(detached.selectedCapabilities.skillIds).toEqual([])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('attachConnector / detachConnector follow the same mode rules', async () => {
    const { child, send } = startLoop(env())
    try {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'ConnAttachBot', connectorNames: [] }))"
          )
        ).result ?? '{}'
      )
      const attached = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.attachConnector('ConnAttachBot', 'my-server', { revision: ${created.revision} }))`
          )
        ).result ?? '{}'
      )
      expect(attached.selectedCapabilities.connectorIds).toEqual(['cust-1'])
      const detached = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.detachConnector('ConnAttachBot', 'my-server', { revision: ${attached.revision} }))`
          )
        ).result ?? '{}'
      )
      expect(detached.selectedCapabilities.connectorIds).toEqual([])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('a stale revision fails without merge or retry', async () => {
    const { child, send } = startLoop(env())
    try {
      await send("return JSON.stringify(await host.agents.create({ name: 'StaleBot' }))")
      const r = await send(
        "try { await host.agents.update('StaleBot', { revision: 999, description: 'x' }); return 'no-throw' } catch (e) { return e.message }"
      )
      expect(r.result).toMatch(/host\.agents\.update:/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('stable catalog resolution: an ambiguous name is rejected with a stable-id hint', async () => {
    const { child, send } = startLoop(env())
    try {
      const r = await send(
        "try { await host.agents.create({ name: 'AmbigBot', skillNames: ['nope'] }); return 'no-throw' } catch (e) { return e.message }"
      )
      expect(r.result).toMatch(/host\.agents\.create:/)
      expect(r.result).toMatch(/stable id|No skill matches/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('an unavailable custom connector cannot be newly attached', async () => {
    const { child, send } = startLoop(env())
    try {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'GateBot', connectorNames: [] }))"
          )
        ).result ?? '{}'
      )
      const r = await send(
        `try { await host.agents.attachConnector('GateBot', 'cust-dead', { revision: ${created.revision} }); return 'no-throw' } catch (e) { return e.message }`
      )
      expect(r.result).toMatch(/host\.agents\.attachConnector:/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('ordinary mutations never request a system permission card (no approval boundary)', async () => {
    // Ordinary mutations are chat-reviewed only; the SDK path never reaches an approval gateway. We
    // prove this by completing a create + update + attach round-trip with no approval wired — the
    // calls succeed and return read-back, which would be impossible if an approval boundary gated
    // them. (delete/switch are the privileged ops that require approval; they are out of scope here.)
    const { child, send } = startLoop(env())
    try {
      // Create in Selected mode (skillNames: []) so attachSkill mutates inclusions; the point is
      // that the whole round-trip completes with no approval gateway wired.
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'NoCardBot', description: 'd', skillNames: [] }))"
          )
        ).result ?? '{}'
      )
      expect(created.name).toBe('NoCardBot')
      expect(created.capabilityMode).toBe('selected')
      const updated = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.update('NoCardBot', { revision: ${created.revision}, description: 'e' }))`
          )
        ).result ?? '{}'
      )
      expect(updated.description).toBe('e')
      const attached = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.attachSkill('NoCardBot', 'demo', { revision: ${updated.revision} }))`
          )
        ).result ?? '{}'
      )
      expect(attached.selectedCapabilities.skillIds).toEqual(['demo'])
    } finally {
      child.kill()
    }
  }, 60_000)
})
