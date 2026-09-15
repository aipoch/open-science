import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { opencodeFramework } from '../agent-framework'
import { seedDefaultPermissionGrants } from '../permission-grants/defaults'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AcpPermissionContext, HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import { AcpPermissionBroker } from './permission-broker'

// Regression for report 7: native web reading was Once-only even under Auto.
it('offers conversation approval for the reported OpenCode web fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'permission-web-frequency-'))
  const client = createProjectDbClient(root)
  let broker: AcpPermissionBroker | undefined
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-web', name: 'Web permission' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    const emit = vi.fn()
    broker = new AcpPermissionBroker(emit, undefined, registry)
    const request = {
      sessionId: 'child-rct5-10-round2',
      toolCall: {
        toolCallId: 'webfetch-1',
        title: 'https://www.resurchify.com/impact/details/20982',
        kind: 'fetch' as const,
        rawInput: { url: 'https://www.resurchify.com/impact/details/20982' }
      },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' as const },
        { optionId: 'always', name: 'Always', kind: 'allow_always' as const },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const }
      ]
    }
    const policy = {
      profile: 'auto' as const,
      autoReviewStrategy: 'conservative' as const,
      frameworkId: 'opencode' as const,
      projectId: 'project-web',
      permissionGrantSessionId: 'parent-session',
      cwd: root
    }
    const first = broker.requestPermission(request, policy)
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    expect(
      broker
        .getPendingRequests()[0]
        .options.map((option) => option.scope)
        .filter(Boolean)
    ).toEqual(['once', 'session'])
    const pending = broker.getPendingRequests()[0]
    expect(pending.providerToolName).toBe('WebFetch')
    await broker.respond({
      requestId: pending.requestId,
      optionId: pending.options.find(({ scope }) => scope === 'session')!.optionId
    })
    await expect(first).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    const [grant] = await registry.list()
    expect(grant).toMatchObject({
      capability: { kind: 'builtin_tool', key: 'builtin:web_fetch' },
      scope: { kind: 'session', projectId: 'project-web', sessionId: 'parent-session' }
    })
    expect(JSON.stringify(grant)).not.toContain('resurchify')

    // Another delegated runtime must resolve the same app-conversation grant, even after registry
    // recreation. Later pages on other websites are included; this is not a hostname grant.
    const restoredRegistry = await createPermissionGrantRegistry({ getClient: async () => client })
    const siblingEmit = vi.fn()
    const sibling = new AcpPermissionBroker(siblingEmit, undefined, restoredRegistry)
    const next = {
      ...request,
      sessionId: 'another-child',
      toolCall: {
        ...request.toolCall,
        toolCallId: 'webfetch-2',
        title: 'https://example.org/',
        rawInput: { url: 'https://example.org/' }
      }
    }
    try {
      await expect(sibling.requestPermission(next, policy)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'once' }
      })
      expect(siblingEmit).not.toHaveBeenCalled()
      const isolated = sibling.requestPermission(next, {
        ...policy,
        permissionGrantSessionId: 'other-conversation'
      })
      await vi.waitFor(() => expect(siblingEmit).toHaveBeenCalledOnce())
      await sibling.respond({
        requestId: sibling.getPendingRequests()[0].requestId,
        cancelled: true
      })
      await expect(isolated).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      await restoredRegistry.revoke({ grants: [{ id: grant.id, revision: grant.revision }] })
      const afterRevoke = sibling.requestPermission(next, policy)
      await vi.waitFor(() => expect(siblingEmit).toHaveBeenCalledTimes(2))
      await sibling.respond({
        requestId: sibling.getPendingRequests()[0].requestId,
        optionId: 'once'
      })
      await expect(afterRevoke).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'once' }
      })
      const afterOnce = sibling.requestPermission(next, policy)
      await vi.waitFor(() => expect(siblingEmit).toHaveBeenCalledTimes(3))
      await sibling.respond({
        requestId: sibling.getPendingRequests()[0].requestId,
        optionId: 'deny'
      })
      await expect(afterOnce).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' }
      })
    } finally {
      sibling.abandonAllPending()
    }
  } finally {
    broker?.abandonAllPending()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

// Reconstruct the reported provider boundary, not an exact ACP capture: the attachment contains
// Notebook code and normalized audit identities but does not contain the original ACP envelopes.
it('offers and reuses a conversation grant for OpenCode REPL calls under Auto', async () => {
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
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    const pending = context.getPendingRequests()[0]
    expect(pending.options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session',
      'project',
      'global'
    ])
    await context.respondToPermission(
      {
        requestId: pending.requestId,
        optionId: pending.options.find((option) => option.scope === 'session')!.optionId
      },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await expect(first).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    await expect(
      request('repl_execute', 'repl-2', { code: "const h = await host.help('delegate'); h;" })
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
    await expect(request('notebook_state', 'state-1', {})).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
    expect(emit).toHaveBeenCalledOnce()
  } finally {
    context?.dispose()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
