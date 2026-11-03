import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { getAgentFramework, opencodeFramework } from '../agent-framework'
import { seedDefaultPermissionGrants } from '../permission-grants/defaults'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AcpPermissionContext, HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import type { PiPermissionState } from './pi-permission-correlation'

// Regression for report 7: native web reading was Once-only even under Auto.
it.each([
  ['opencode', 'WebFetch'],
  ['claude-code', 'WebFetch'],
  ['claude-code', 'WebSearch']
] as const)('offers and reuses conversation approval for %s %s', async (framework, tool) => {
  const search = tool === 'WebSearch'
  const input = search
    ? { query: 'p63 squamous cell carcinoma tumor suppressor oncogene role' }
    : { url: 'https://www.resurchify.com/impact/details/20982' }
  const root = await mkdtemp(join(tmpdir(), 'permission-web-frequency-'))
  const client = createProjectDbClient(root)
  let broker: AcpPermissionContext | undefined
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-web', name: 'Web permission' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    const emit = vi.fn()
    const createContext = (
      emitPermissionRequest: () => void,
      permissionGrantRegistry: PermissionGrantRegistry,
      owner = 'parent-session'
    ): AcpPermissionContext =>
      new AcpPermissionContext({
        emitPermissionRequest,
        permissionGrantRegistry,
        permissionGrantContext: { projectId: 'project-web', sessionId: owner },
        routing: {
          resolveAppSessionId: (id) => id,
          sessionSnapshot: () => ({
            cwd: root,
            frameworkId: framework,
            permissionProfile: { selectedProfile: 'auto', autoReviewStrategy: 'conservative' }
          }),
          hasActivePrimarySession: () => true,
          capturePrompt: () => ({ sequence: 1, isCancellationAccepted: () => false }),
          currentInteractionSequence: () => 1,
          mcpServerNamesFor: () => [],
          reviewerContextFor: () => undefined,
          resolveReviewerPermission: () => undefined,
          currentFramework: () => getAgentFramework(framework),
          resolveProjectId: () => 'project-web'
        }
      })
    const run = (
      context: AcpPermissionContext,
      req: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> => {
      context.observeToolCall(
        {
          sessionId: req.sessionId,
          update: {
            toolCallId: req.toolCall.toolCallId,
            kind: 'fetch',
            rawInput: req.toolCall.rawInput,
            ...(framework === 'claude-code' ? { _meta: { claudeCode: { toolName: tool } } } : {}),
            title: req.toolCall.title ?? '',
            sessionUpdate: 'tool_call',
            status: 'pending'
          }
        },
        {
          sessionId: req.sessionId,
          framework,
          mcpServerNames: []
        }
      )
      return context.handleProviderRequest(req)
    }
    broker = createContext(emit, registry)
    const request = {
      sessionId: 'child-rct5-10-round2',
      toolCall: {
        toolCallId: 'webfetch-1',
        title: 'https://www.resurchify.com/impact/details/20982',
        kind: 'fetch' as const,
        rawInput: input
      },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' as const },
        { optionId: 'always', name: 'Always', kind: 'allow_always' as const },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const }
      ]
    }
    const parallelEmit = vi.fn()
    const parallelContext = createContext(parallelEmit, registry)
    const parallel = search
      ? run(parallelContext, {
          ...request,
          sessionId: 'parallel-child',
          toolCall: { ...request.toolCall, toolCallId: 'parallel-search' }
        })
      : undefined
    const first = run(broker, request)
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    expect(
      broker
        .getPendingRequests()[0]
        .options.map((option) => option.scope)
        .filter(Boolean)
    ).toEqual(['once', 'session'])
    const pending = broker.getPendingRequests()[0]
    expect(pending.providerToolName).toBe(tool)
    await broker.respondToPermission(
      {
        requestId: pending.requestId,
        optionId: pending.options.find(({ scope }) => scope === 'session')!.optionId
      },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await expect(first).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    if (parallel)
      await expect(parallel).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'once' }
      })
    parallelContext.dispose()
    const [grant] = await registry.list()
    expect(grant).toMatchObject({
      capability: {
        kind: 'builtin_tool',
        key: search ? 'builtin:web_search' : 'builtin:web_fetch'
      },
      scope: { kind: 'session', projectId: 'project-web', sessionId: 'parent-session' }
    })
    expect(JSON.stringify(grant)).not.toContain('resurchify')
    expect(JSON.stringify(grant)).not.toContain('squamous')

    // Another delegated runtime must resolve the same app-conversation grant, even after registry
    // recreation. Later pages on other websites are included; this is not a hostname grant.
    const restoredRegistry = await createPermissionGrantRegistry({ getClient: async () => client })
    const siblingEmit = vi.fn()
    const sibling = createContext(siblingEmit, restoredRegistry)
    const next = {
      ...request,
      sessionId: 'another-child',
      toolCall: {
        ...request.toolCall,
        toolCallId: 'webfetch-2',
        title: 'https://example.org/',
        rawInput: search ? { query: 'another search' } : { url: 'https://example.org/' }
      }
    }
    try {
      await expect(run(sibling, next)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'once' }
      })
      expect(siblingEmit).not.toHaveBeenCalled()
      const foreign = createContext(siblingEmit, restoredRegistry, 'other-conversation')
      const isolated = run(foreign, next)
      await vi.waitFor(() => expect(siblingEmit).toHaveBeenCalledOnce())
      await foreign.respondToPermission(
        {
          requestId: foreign.getPendingRequests()[0].requestId,
          cancelled: true
        },
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      foreign.dispose()
      await expect(isolated).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      await restoredRegistry.revoke({ grants: [{ id: grant.id, revision: grant.revision }] })
      const afterRevoke = run(sibling, next)
      await vi.waitFor(() => expect(siblingEmit).toHaveBeenCalledTimes(2))
      await sibling.respondToPermission(
        {
          requestId: sibling.getPendingRequests()[0].requestId,
          optionId: 'once'
        },
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      await expect(afterRevoke).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'once' }
      })
      const afterOnce = run(sibling, next)
      await vi.waitFor(() => expect(siblingEmit).toHaveBeenCalledTimes(3))
      await sibling.respondToPermission(
        {
          requestId: sibling.getPendingRequests()[0].requestId,
          optionId: 'deny'
        },
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      await expect(afterOnce).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' }
      })
    } finally {
      sibling.dispose()
    }
  } finally {
    broker?.dispose()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

// Reconstruct the reported provider boundary, not an exact ACP capture: the attachment contains
// Notebook code and normalized audit identities but does not contain the original ACP envelopes.
it('hands OpenCode REPL calls to host admission without conversation grants under Auto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'permission-frequency-'))
  const client = createProjectDbClient(root)
  let context: AcpPermissionContext | undefined
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Permission frequency' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    await seedDefaultPermissionGrants(registry, client)
    const emit = vi.fn()
    context = new AcpPermissionContext({
      permissionGrantRegistry: registry,
      emitPermissionRequest: emit,
      routing: {
        resolveAppSessionId: (id) => id,
        sessionSnapshot: () => ({
          cwd: root,
          frameworkId: 'opencode',
          permissionProfile: { selectedProfile: 'auto', autoReviewStrategy: 'conservative' }
        }),
        hasActivePrimarySession: () => true,
        capturePrompt: () => ({ sequence: 1, isCancellationAccepted: () => false }),
        currentInteractionSequence: () => 1,
        mcpServerNamesFor: () => ['open-science-notebook'],
        reviewerContextFor: () => undefined,
        resolveReviewerPermission: () => undefined,
        currentFramework: () => opencodeFramework,
        resolveProjectId: () => 'project-1'
      }
    })
    const request = (
      tool: string,
      callId: string,
      input: Record<string, unknown>
    ): Promise<RequestPermissionResponse> => {
      const toolCall = {
        toolCallId: callId,
        title: `open_science_notebook_${tool}`,
        kind: 'other' as const,
        status: 'pending' as const,
        rawInput: input
      }
      context!.observeToolCall(
        { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', ...toolCall } },
        { sessionId: 'session-1', framework: 'opencode', mcpServerNames: ['open-science-notebook'] }
      )
      return context!.handleProviderRequest({
        sessionId: 'session-1',
        toolCall,
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
      })
    }
    const first = request('repl_execute', 'repl-1', {
      code: 'const caps = await host.capabilities(); caps;'
    })
    await expect(first).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    await expect(
      request('repl_execute', 'repl-2', { code: "const h = await host.help('delegate'); h;" })
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
    await expect(request('notebook_state', 'state-1', {})).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
    expect(emit).not.toHaveBeenCalled()
  } finally {
    context?.dispose()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['grant-before-enqueue', 'dispose-during-lookup', 'cancel-during-lookup'] as const)(
  'handles the search authorization race: %s',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'search-permission-race-'))
    const client = createProjectDbClient(root)
    let context: AcpPermissionContext | undefined
    try {
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-web', name: 'Search' } })
      const registry = await createPermissionGrantRegistry({ getClient: async () => client })
      const unsubscribe = vi.fn()
      const subscribe = registry.subscribe.bind(registry)
      vi.spyOn(registry, 'subscribe').mockImplementation((listener) => {
        const stop = subscribe(listener)
        return () => {
          unsubscribe()
          stop()
        }
      })
      let release!: (value: undefined) => void
      const lookup = vi.spyOn(registry, 'resolve').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const emit = vi.fn()
      context = new AcpPermissionContext({
        emitPermissionRequest: emit,
        permissionGrantRegistry: registry,
        permissionGrantContext: { projectId: 'project-web', sessionId: 'parent' },
        routing: {
          resolveAppSessionId: (id) => id,
          sessionSnapshot: () => ({
            cwd: root,
            frameworkId: 'claude-code',
            permissionProfile: { selectedProfile: 'ask' }
          }),
          hasActivePrimarySession: () => true,
          capturePrompt: () => ({ sequence: 1, isCancellationAccepted: () => false }),
          currentInteractionSequence: () => 1,
          mcpServerNamesFor: () => [],
          reviewerContextFor: () => undefined,
          resolveReviewerPermission: () => undefined,
          currentFramework: () => getAgentFramework('claude-code'),
          resolveProjectId: () => 'project-web'
        }
      })
      // Derived from claude-agent-acp 0.70.0: notification carries native metadata;
      // the root request_permission carries kind=fetch + rawInput, without a tool name.
      const toolCall = {
        toolCallId: 'search-race',
        title: 'Search',
        kind: 'fetch' as const,
        rawInput: { query: 'p63 carcinoma' }
      }
      context.observeToolCall(
        {
          sessionId: 'child',
          update: {
            ...toolCall,
            sessionUpdate: 'tool_call',
            status: 'pending',
            _meta: { claudeCode: { toolName: 'WebSearch' } }
          }
        },
        { sessionId: 'child', framework: 'claude-code', mcpServerNames: [] }
      )
      const result = context.handleProviderRequest({
        sessionId: 'child',
        toolCall,
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
      })
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())
      if (scenario === 'dispose-during-lookup') context.dispose()
      if (scenario === 'cancel-during-lookup') context.cancelForSession('child')
      await registry.remember({
        capability: { kind: 'builtin_tool', key: 'builtin:web_search' },
        scope: { kind: 'session', projectId: 'project-web', sessionId: 'parent' }
      })
      release(undefined)
      await expect(result).resolves.toEqual(
        scenario === 'grant-before-enqueue'
          ? { outcome: { outcome: 'selected', optionId: 'once' } }
          : { outcome: { outcome: 'cancelled' } }
      )
      expect(context.getPendingRequests()).toEqual([])
      if (scenario !== 'grant-before-enqueue') expect(emit).not.toHaveBeenCalled()
      context.dispose()
      expect(unsubscribe).toHaveBeenCalled()
      const calls = lookup.mock.calls.length
      await registry.remember({
        capability: { kind: 'builtin_tool', key: 'builtin:web_fetch' },
        scope: { kind: 'session', projectId: 'project-web', sessionId: 'parent' }
      })
      expect(lookup).toHaveBeenCalledTimes(calls)
    } finally {
      context?.dispose()
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

// Regression: Pi released ordinary tools one call at a time and ignored app-owned grants, so a
// default global grant and a remembered conversation grant both prompted again.
it('honors app-owned grants for Pi tools while answering with provider allow_once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-permission-frequency-'))
  const client = createProjectDbClient(root)
  const contexts: AcpPermissionContext[] = []
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-pi', name: 'Pi permissions' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    await seedDefaultPermissionGrants(registry, client)
    const servers = ['open-science-notebook', 'pubmed']
    const allowedToolIdentities = new Set([
      'open-science-notebook/list_authorized_directories',
      'open-science-notebook/repl_execute',
      'pubmed/search_articles'
    ])
    const capabilityRevision = {}
    const piState = (appSessionId: string): PiPermissionState => ({
      appSessionId,
      providerSessionId: `pi-${appSessionId}`,
      promptMessageId: `prompt-${appSessionId}`,
      interactionSequence: 1,
      capabilityRevision,
      mcpServerNames: servers,
      allowedToolIdentities,
      cancelled: false
    })
    const connect = (
      emit: () => void,
      grants: PermissionGrantRegistry = registry
    ): AcpPermissionContext => {
      const context = new AcpPermissionContext({
        emitPermissionRequest: emit,
        permissionGrantRegistry: grants,
        routing: {
          resolveAppSessionId: (id) => id.replace(/^pi-/, ''),
          sessionSnapshot: () => ({
            cwd: root,
            frameworkId: 'pi',
            permissionProfile: { selectedProfile: 'ask', autoReviewStrategy: 'conservative' }
          }),
          hasActivePrimarySession: () => true,
          capturePrompt: (id) => ({
            sequence: 1,
            promptMessageId: `prompt-${id}`,
            isCancellationAccepted: () => false
          }),
          currentInteractionSequence: () => 1,
          mcpServerNamesFor: () => servers,
          reviewerContextFor: () => undefined,
          resolveReviewerPermission: () => undefined,
          currentFramework: () => getAgentFramework('pi'),
          resolveProjectId: () => 'project-pi',
          piPermissionContextFor: (appSessionId) => {
            const state = piState(appSessionId)
            return { ...state, readCurrent: () => state }
          }
        }
      })
      contexts.push(context)
      return context
    }
    const call = (
      context: AcpPermissionContext,
      appSessionId: string,
      callId: string,
      name: string,
      rawInput: Record<string, unknown>
    ): Promise<RequestPermissionResponse> => {
      const toolCall = { toolCallId: callId, name, title: name, kind: 'other' as const, rawInput }
      context.observeProviderUpdate({
        sessionId: `pi-${appSessionId}`,
        update: { sessionUpdate: 'tool_call', status: 'pending', ...toolCall }
      } as SessionNotification)
      return context.handleProviderRequest({
        sessionId: `pi-${appSessionId}`,
        toolCall,
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
      } as RequestPermissionRequest)
    }
    const allowed = { outcome: { outcome: 'selected', optionId: 'once' } }
    const search = (
      context: AcpPermissionContext,
      session: string,
      id: string
    ): Promise<RequestPermissionResponse> =>
      call(context, session, id, 'mcp__pubmed__search_articles', { query: `sickle ${id}` })

    // The app's seeded global grant releases directory discovery on every call, without a card.
    const emit = vi.fn()
    const context = connect(emit)
    for (const id of ['dirs-1', 'dirs-2'])
      await expect(
        call(context, 'chat-a', id, 'mcp__open-science-notebook__list_authorized_directories', {})
      ).resolves.toEqual(allowed)
    expect(emit).not.toHaveBeenCalled()

    // An ungranted tool offers the app's reusable scopes; a conversation grant covers later calls.
    const first = search(context, 'chat-a', 'search-1')
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    const pending = context.getPendingRequests()[0]
    expect(pending.options.map(({ scope }) => scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    await context.respondToPermission(
      {
        requestId: pending.requestId,
        optionId: pending.options.find(({ scope }) => scope === 'session')!.optionId
      },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await expect(first).resolves.toEqual(allowed)
    await expect(search(context, 'chat-a', 'search-2')).resolves.toEqual(allowed)
    expect(emit).toHaveBeenCalledOnce()
    const grant = (await registry.list()).find(
      ({ capability }) => capability.key === 'mcp:pubmed/search_articles'
    )!
    expect(grant.scope).toEqual({ kind: 'session', projectId: 'project-pi', sessionId: 'chat-a' })

    // Reconnecting with a recreated registry keeps the grant; another conversation does not get it.
    const restored = await createPermissionGrantRegistry({ getClient: async () => client })
    const reconnectEmit = vi.fn()
    const reconnected = connect(reconnectEmit, restored)
    await expect(search(reconnected, 'chat-a', 'search-3')).resolves.toEqual(allowed)
    expect(reconnectEmit).not.toHaveBeenCalled()
    const isolated = search(reconnected, 'chat-b', 'search-4')
    await vi.waitFor(() => expect(reconnectEmit).toHaveBeenCalledOnce())
    await reconnected.respondToPermission(
      { requestId: reconnected.getPendingRequests()[0].requestId, optionId: 'deny' },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await expect(isolated).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })

    // Revocation takes effect on the next call.
    await restored.revoke({ grants: [{ id: grant.id, revision: grant.revision }] })
    const afterRevoke = search(reconnected, 'chat-a', 'search-5')
    await vi.waitFor(() => expect(reconnectEmit).toHaveBeenCalledTimes(2))
    await reconnected.respondToPermission(
      { requestId: reconnected.getPendingRequests()[0].requestId, optionId: 'once' },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await expect(afterRevoke).resolves.toEqual(allowed)

    // Notebook code keeps its per-code host admission: no reusable scope is offered or stored.
    const grantsBefore = (await restored.list()).length
    await expect(
      call(reconnected, 'chat-a', 'repl-1', 'mcp__open-science-notebook__repl_execute', {
        code: 'return 1 + 1;'
      })
    ).resolves.toEqual(allowed)
    expect(reconnectEmit).toHaveBeenCalledTimes(2)
    expect(await restored.list()).toHaveLength(grantsBefore)
  } finally {
    for (const context of contexts) context.dispose()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
