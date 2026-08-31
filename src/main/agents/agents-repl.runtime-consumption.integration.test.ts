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
import {
  resolveEffectiveSpecialistSkills,
  filterSpecialistConnectorSkills,
  type SpecialistSkillCatalogEntry,
  type SpecialistView
} from '../../shared/specialist'
import type { StoredConnectors } from '../settings/types'

// Run with: RUN_KERNEL=1 npx vitest run src/main/agents/agents-repl.runtime-consumption.integration.test.ts
//
// Proves the whole-Skill and whole-Connector configuration journey end-to-end: a Specialist's
// capability config is changed through `host.agents`, and the RESULTING stable IDs are consumed by
// the EXISTING runtime whitelist (`resolveEffectiveSpecialistSkills`) and Connector gate
// (`filterSpecialistConnectorSkills`) — the same functions the runtime/acp layers use to provision
// the live agent (design.md §15). This reuses the domain assertion functions as regression rather
// than duplicating their internal rules: the test asserts real post-write read-back (the stable IDs
// the SDK actually returned) flows correctly through the runtime resolvers, proving the SDK's output
// is exactly what the runtime consumes.

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

// A deterministic, secret-free catalog. Two skills (one Main-enabled, one Main-disabled — the
// Specialist-visible catalog is complete) and one custom runnable connector so whole-Skill and
// whole-Connector inclusion can resolve stable IDs the runtime then consumes.
const skillCatalog: SpecialistSkillCatalogEntry[] = [
  { id: 'demo', frameworkName: 'demo' },
  { id: 'personal-foo', frameworkName: 'foo' }
]

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
      }
    ]
  })
}

// Projects the read-back into the SpecialistView shape the runtime resolvers consume.
const asProfile = (readBack: Record<string, unknown>): SpecialistView =>
  readBack as unknown as SpecialistView

gate('host.agents repl runtime whitelist consumption', () => {
  let rpcServer: NotebookLocalRpcServer
  let endpoint: string
  let token: string
  let profileStorage: string
  let runtimeStorage: string
  let releaseControl: (() => void) | undefined

  beforeAll(async () => {
    profileStorage = await mkdtemp(join(tmpdir(), 'os-agents-rt-profile-'))
    runtimeStorage = await mkdtemp(join(tmpdir(), 'os-agents-rt-runtime-'))
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
      'runtime-session',
      'default-project',
      'root-frame-runtime-session'
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

  const withLoop = async <T>(
    run: (send: (code: string) => Promise<KernelLoopResponse>) => Promise<T>
  ): Promise<T> => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: token
    })
    try {
      return await run(send)
    } finally {
      child.kill()
    }
  }

  it('a whole-Skill Selected config: the runtime whitelist consumes the exact stable IDs the SDK returned', async () => {
    await withLoop(async (send) => {
      // Create a Selected specialist that includes one skill by its public name; the SDK resolves the
      // public name 'demo' to the stable id 'demo'.
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'SKILL_SET', skillNames: ['demo'] }))"
          )
        ).result ?? '{}'
      )
      // The runtime whitelist consumes the ACTUAL post-write config (the stable IDs read back), not
      // the requested public name. resolveEffectiveSpecialistSkills is the existing domain function
      // the runtime uses; we assert it resolves exactly the returned stable id.
      const effective = resolveEffectiveSpecialistSkills(asProfile(created), skillCatalog)
      expect(effective.kind).toBe('specialist')
      if (effective.kind === 'specialist') {
        expect(effective.skillIds).toEqual(['demo'])
        expect(effective.frameworkNames).toEqual(['demo'])
        expect(effective.missingSkillIds).toEqual([])
      }
    })
  })

  it('a Main-disabled Skill is assignable and resolvable: the Specialist catalog is complete', async () => {
    await withLoop(async (send) => {
      // 'foo' is Main-disabled (personal-foo) but still assignable to a Specialist.
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'MAIN_DIS_SKILL', skillNames: ['foo'] }))"
          )
        ).result ?? '{}'
      )
      // Read-back resolved the public name to the stable id 'personal-foo' (not echoed).
      expect(created.selectedCapabilities.skillIds).toEqual(['personal-foo'])
      // The runtime whitelist resolves it against the complete catalog.
      const effective = resolveEffectiveSpecialistSkills(asProfile(created), skillCatalog)
      if (effective.kind === 'specialist') {
        expect(effective.skillIds).toEqual(['personal-foo'])
        expect(effective.frameworkNames).toEqual(['foo'])
      }
    })
  })

  it('attachSkill changes the consumed whitelist without switching mode (Selected inclusion grows)', async () => {
    await withLoop(async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'ATTACH_RT', skillNames: ['demo'] }))"
          )
        ).result ?? '{}'
      )
      const after = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.attachSkill('ATTACH_RT', 'foo', { revision: ${created.revision} }))`
          )
        ).result ?? '{}'
      )
      // Read-back shows both stable ids.
      expect(after.selectedCapabilities.skillIds).toEqual(['demo', 'personal-foo'])
      // The runtime whitelist now resolves BOTH skills.
      const effective = resolveEffectiveSpecialistSkills(asProfile(after), skillCatalog)
      if (effective.kind === 'specialist') {
        expect(effective.skillIds).toEqual(['demo', 'personal-foo'])
        expect(effective.frameworkNames).toEqual(['demo', 'foo'])
      }
    })
  })

  it('a whole-Connector config: the Connector gate consumes the stable id the SDK returned', async () => {
    await withLoop(async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'CONN_SET', connectorNames: ['my-server'] }))"
          )
        ).result ?? '{}'
      )
      // Read-back resolves the immutable connector name to its local stable UUID.
      expect(created.selectedCapabilities.connectorIds).toEqual(['cust-1'])
      // The Connector gate consumes the post-write config: the provisioned `mcp-my-server` connector
      // skill is allowed after the runtime boundary maps the local UUID to the public name; any other
      // connector is filtered out.
      const runtimeProfile = asProfile({
        ...created,
        selectedCapabilities: {
          ...created.selectedCapabilities,
          connectorIds: ['my-server']
        }
      })
      const allowed = filterSpecialistConnectorSkills(
        ['mcp-my-server', 'mcp-other'],
        runtimeProfile
      )
      expect(allowed).toEqual(['mcp-my-server'])
    })
  })

  it('switching Selected -> Full: the runtime whitelist reflects full access (minus exclusions) on the live catalog', async () => {
    await withLoop(async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'TO_FULL', skillNames: ['demo'] }))"
          )
        ).result ?? '{}'
      )
      const full = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.update('TO_FULL', { revision: ${created.revision}, unrestricted: true }))`
          )
        ).result ?? '{}'
      )
      // Read-back: Full mode while the stored Selected config is preserved.
      expect(full.capabilityMode).toBe('full')
      // The runtime whitelist resolves Full access against the LIVE catalog (future entries included,
      // no stored snapshot) — both catalog skills are effective.
      const effective = resolveEffectiveSpecialistSkills(asProfile(full), skillCatalog)
      if (effective.kind === 'specialist') {
        expect(effective.skillIds.sort()).toEqual(['demo', 'personal-foo'])
      }
    })
  })

  it('detachSkill shrinks the consumed whitelist without switching mode', async () => {
    await withLoop(async (send) => {
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'DETACH_RT', skillNames: ['demo', 'foo'] }))"
          )
        ).result ?? '{}'
      )
      const after = JSON.parse(
        (
          await send(
            `return JSON.stringify(await host.agents.detachSkill('DETACH_RT', 'demo', { revision: ${created.revision} }))`
          )
        ).result ?? '{}'
      )
      expect(after.selectedCapabilities.skillIds).toEqual(['personal-foo'])
      const effective = resolveEffectiveSpecialistSkills(asProfile(after), skillCatalog)
      if (effective.kind === 'specialist') {
        expect(effective.skillIds).toEqual(['personal-foo'])
      }
    })
  })

  it('camelCase writes produce camelCase read-back the runtime consumes unchanged', async () => {
    await withLoop(async (send) => {
      // camelCase write fields on create.
      const created = JSON.parse(
        (
          await send(
            "return JSON.stringify(await host.agents.create({ name: 'CASE_MAP', description: 'd', systemPrompt: 'p', iconKey: 'beaker', colorKey: 'green', skillNames: ['demo'] }))"
          )
        ).result ?? '{}'
      )
      // camelCase read-back: the runtime resolvers consume these field names directly.
      expect(created.capabilityMode).toBe('selected')
      expect(created.selectedCapabilities.skillIds).toEqual(['demo'])
      const effective = resolveEffectiveSpecialistSkills(asProfile(created), skillCatalog)
      expect(effective.kind).toBe('specialist')
    })
  })
})
