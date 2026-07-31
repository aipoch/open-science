import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPermissionGrantRegistry,
  type PermissionGrantRegistry
} from '../permission-grants/registry'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { AcpPermissionBroker, projectRegistrySessionGrants } from './permission-broker'
import { withTrustedMcpToolIdentity } from './permission-policy'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const shellRequest = (sessionId: string): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${sessionId}`,
    title: 'Inspect repository status',
    status: 'pending',
    kind: 'execute',
    rawInput: { command: 'git status' }
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const secretShellRequest = (sessionId: string): RequestPermissionRequest => ({
  ...shellRequest(sessionId),
  toolCall: {
    ...shellRequest(sessionId).toolCall,
    rawInput: { command: 'TOKEN=secret python upload.py' }
  }
})

const registeredToolRequest = (toolName: string): RequestPermissionRequest => ({
  sessionId: 'session-registered',
  toolCall: {
    toolCallId: `tool-${toolName}`,
    title: toolName,
    status: 'pending',
    _meta: { toolName }
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const titleOnlyRequest = (title: string): RequestPermissionRequest => ({
  sessionId: `session-title-${title}`,
  toolCall: {
    toolCallId: `tool-title-${title}`,
    title,
    status: 'pending'
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const providerBuiltInRequest = (
  sessionId: string,
  toolName: 'WebFetch' | 'WebSearch'
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${sessionId}-${toolName}`,
    title: toolName,
    status: 'pending',
    rawInput:
      toolName === 'WebFetch'
        ? { url: 'https://www.ncbi.nlm.nih.gov/' }
        : { query: 'tumor immunology' },
    _meta: { claudeCode: { toolName } }
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const mcpRequest = (
  sessionId: string,
  reportedName: string,
  title = reportedName
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${sessionId}`,
    title,
    status: 'pending',
    _meta: { toolName: reportedName },
    rawInput: {}
  },
  options: [
    { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'provider-reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

describe('ACP permission broker with durable grants', () => {
  it('cancels a request while its durable grant lookup is still pending', async () => {
    let finishResolve: (() => void) | undefined
    const registry = {
      resolve: vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            finishResolve = () => resolve(undefined)
          })
      ),
      remember: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const response = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    broker.cancelForSession('session-1')
    finishResolve?.()

    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(emitted).toEqual([])
    expect(broker.hasPendingForSession('session-1')).toBe(false)
  })

  it('fails closed and reports when a remembered approval cannot be persisted', async () => {
    const registry = {
      resolve: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn().mockRejectedValue(new Error('database locked')),
      list: vi.fn().mockResolvedValue([]),
      listCached: vi.fn().mockReturnValue([]),
      revoke: vi.fn(),
      extendUndo: vi.fn(),
      restore: vi.fn(),
      prune: vi.fn(),
      finalizeOwnerDeletion: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => undefined)
    } satisfies PermissionGrantRegistry
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const providerResponse = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const projectOption = emitted[0].options.find((option) => option.scope === 'project')
    const rendererResponse = broker.respond({
      requestId: emitted[0].requestId,
      optionId: projectOption?.optionId
    })

    await expect(rendererResponse).rejects.toThrow(
      'Permission approval could not be saved; the tool call was cancelled.'
    )
    await expect(providerResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('commits a Global grant before returning only the provider one-call decision', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-registry-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const first = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    const globalOption = emitted[0].options.find((option) => option.scope === 'global')
    broker.respond({ requestId: emitted[0].requestId, optionId: globalOption?.optionId })

    await expect(first).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    const [grant] = await registry.list()
    expect(grant).toMatchObject({
      capability: {
        kind: 'execution',
        key: 'exec:agent/shell',
        qualifier: { mode: 'exact', value: expect.stringMatching(/^sha256:v1:[a-f0-9]{64}$/) }
      },
      scope: { kind: 'global' }
    })
    expect(JSON.stringify(grant)).not.toContain('git status')

    await expect(
      broker.requestPermission(shellRequest('session-2'), {
        profile: 'ask',
        projectId: 'project-1'
      })
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    expect(emitted).toHaveLength(1)
  })

  it('offers only provider Once for a secret-bearing exact request', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-secret-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const pending = broker.requestPermission(secretShellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
    broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    await expect(registry.list()).resolves.toEqual([])
  })

  it('offers only provider Once for a command that executes a mutable script', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-mutable-script-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const request = shellRequest('session-1')
    request.toolCall.rawInput = { command: 'python analyze.py --input data.csv' }

    const pending = broker.requestPermission(request, {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
    broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    await expect(registry.list()).resolves.toEqual([])
  })

  it.each(['WebFetch', 'WebSearch'] as const)(
    'keeps provider-native %s Once-only and prompts again on the next call',
    async (toolName) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-built-in-'))
      client = createProjectDbClient(storageRoot)
      await ensureProjectSchema(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
      const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
      const broker = new AcpPermissionBroker(
        (request) => emitted.push(request),
        undefined,
        registry
      )
      const context = { profile: 'ask' as const, projectId: 'project-1' }

      const first = broker.requestPermission(
        providerBuiltInRequest('session-built-in', toolName),
        context
      )
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
      await broker.respond({
        requestId: emitted[0].requestId,
        optionId: 'provider-allow-once'
      })
      await expect(first).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })

      const second = broker.requestPermission(
        providerBuiltInRequest('session-built-in', toolName),
        context
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(emitted).toHaveLength(2)
      await broker.respond({ requestId: emitted[1].requestId, cancelled: true })
      await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      await expect(registry.list()).resolves.toEqual([])
    }
  )

  it.each(['agent_create', 'Skill', 'mcp__open_science_notebook__notebook_execute'])(
    'never creates durable authority from the display-only title %s',
    async (title) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-title-only-'))
      client = createProjectDbClient(storageRoot)
      await ensureProjectSchema(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
      const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
      const broker = new AcpPermissionBroker(
        (request) => emitted.push(request),
        undefined,
        registry
      )

      const pending = broker.requestPermission(titleOnlyRequest(title), {
        profile: 'ask',
        projectId: 'project-1',
        mcpServerNames: ['open_science_notebook']
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
      broker.respond({
        requestId: emitted[0].requestId,
        optionId: 'provider-allow-once'
      })
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })
      await expect(registry.list()).resolves.toEqual([])
    }
  )

  it('routes every registered customization and local executor identity into durable scopes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-registered-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const toolNames = [
      'agent_create',
      'agent_update',
      'skill_publish',
      'skill_edit',
      'agent_attach_skill',
      'agent_detach_skill',
      'agent_attach_connector',
      'agent_detach_connector',
      'local_exec_python',
      'local_exec_bash'
    ]

    for (const toolName of toolNames) {
      const pending = broker.requestPermission(registeredToolRequest(toolName), {
        profile: 'ask',
        projectId: 'project-1'
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const request = emitted.at(-1)!
      broker.respond({
        requestId: request.requestId,
        optionId: request.options.find((option) => option.scope === 'global')?.optionId
      })
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
      })
    }

    await expect(registry.list()).resolves.toHaveLength(10)
    expect((await registry.list()).map((grant) => grant.capability.key).sort()).toEqual(
      [
        'customize:agent_create',
        'customize:agent_update',
        'customize:skill_publish',
        'customize:skill_edit',
        'customize:agent_attach_skill',
        'customize:agent_detach_skill',
        'customize:agent_attach_connector',
        'customize:agent_detach_connector',
        'exec:local/python',
        'exec:local/bash'
      ].sort()
    )
  })

  it('reuses one app MCP grant across Claude Code, Codex, OpenCode, and runtime-trusted sparse requests', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-acp-mcp-aliases-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const context = {
      profile: 'ask' as const,
      projectId: 'project-1',
      mcpServerNames: ['open-science-notebook']
    }

    const first = broker.requestPermission(
      mcpRequest('session-claude', 'mcp__open_science_notebook__manage_packages'),
      context
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'global')?.optionId
    })
    await expect(first).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    for (const [sessionId, reportedName] of [
      ['session-codex', 'mcp.open-science-notebook.manage_packages'],
      ['session-opencode', 'open_science_notebook_manage_packages']
    ] as const) {
      await expect(
        broker.requestPermission(mcpRequest(sessionId, reportedName), context)
      ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })
    }

    await expect(
      broker.requestPermission(
        withTrustedMcpToolIdentity(
          mcpRequest('session-sparse', 'manage_packages', 'Manage packages'),
          'open-science-notebook/manage_packages'
        ),
        context
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'provider-allow-once' } })

    expect(emitted).toHaveLength(1)
    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({
        capability: {
          kind: 'mcp_tool',
          key: 'mcp:open-science-notebook/manage_packages'
        },
        scope: { kind: 'global' }
      })
    ])
  })

  it('uses runtime-trusted identity to align sparse dynamic MCP requests', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-dynamic-mcp-aliases-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const context = {
      profile: 'ask' as const,
      projectId: 'project-1',
      mcpServerNames: ['custom-server']
    }

    const first = broker.requestPermission(
      mcpRequest('session-claude', 'mcp__custom_server__lookup'),
      context
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'global')?.optionId
    })
    await first

    const sparseCodex = withTrustedMcpToolIdentity(
      mcpRequest('session-codex', 'lookup', 'Lookup records'),
      'custom-server/lookup'
    )
    await expect(broker.requestPermission(sparseCodex, context)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })
    await expect(
      broker.requestPermission(mcpRequest('session-opencode', 'custom_server_lookup'), context)
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'provider-allow-once' }
    })

    expect(emitted).toHaveLength(1)
    expect((await registry.list())[0].capability).toEqual({
      kind: 'mcp_tool',
      key: 'mcp:custom-server/lookup'
    })
  })

  it('rejects a trusted MCP identity outside the configured server set', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-mismatched-mcp-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)
    const pending = broker.requestPermission(
      withTrustedMcpToolIdentity(
        mcpRequest('session-mismatch', 'lookup', 'Lookup records'),
        'other-server/lookup'
      ),
      {
        profile: 'ask',
        projectId: 'project-1',
        mcpServerNames: ['custom-server']
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
    broker.respond({ requestId: emitted[0].requestId, optionId: 'provider-allow-once' })
    await pending
    await expect(registry.list()).resolves.toEqual([])
  })

  it('projects and revokes a durable Session grant through the composer seam', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-broker-composer-'))
    client = createProjectDbClient(storageRoot)
    await ensureProjectSchema(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client! })
    const emitted: Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0][] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request), undefined, registry)

    const pending = broker.requestPermission(shellRequest('session-1'), {
      profile: 'ask',
      projectId: 'project-1'
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find((option) => option.scope === 'session')?.optionId
    })
    await pending

    const [composerGrant] = broker.listGrants('session-1')
    expect(composerGrant).toMatchObject({
      categoryKey: expect.any(String),
      kind: 'shell',
      label: 'Shell · Specific input',
      scope: 'session'
    })
    expect(projectRegistrySessionGrants(await registry.list())).toEqual({
      'session-1': [composerGrant]
    })
    await broker.revokeGrant('session-1', composerGrant.categoryKey)

    expect(broker.listGrants('session-1')).toEqual([])
    await expect(registry.list()).resolves.toEqual([])
  })
})
