import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import {
  claudeCodeFramework,
  codeBuddyFramework,
  codexFramework,
  opencodeFramework
} from '../agent-framework'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLiteratureLibraryMcpServer } from '../literature/library-mcp-server'
import { createLiteratureMcpServer } from '../literature/mcp-server'
import { AcpPermissionContext, HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import {
  LIBRARY_AUTO_TOOL_IDENTITIES,
  resolveAutomaticPermission,
  trustedMcpToolIdentity,
  withTrustedMcpToolIdentity
} from './permission-policy'
import { appMcpToolIdentities } from '../agent-framework/app-mcp-names'

const servers = ['open-science-library', 'open-science-literature']
const request = (title: string): RequestPermissionRequest => ({
  sessionId: 'session',
  toolCall: { toolCallId: 'call', title, kind: 'other', rawInput: { query: 'evidence' } },
  options: [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always' },
    { optionId: 'no', kind: 'reject_once', name: 'Reject' }
  ]
})

describe('Library Auto policy', () => {
  it.each([...LIBRARY_AUTO_TOOL_IDENTITIES])(
    'only allows a verified mounted identity in Auto: %s',
    (identity) => {
      const raw = request(`mcp__${identity.replace('/', '__')}`)
      const trusted = withTrustedMcpToolIdentity(raw, identity)
      const policy = { profile: 'auto' as const, mcpServerNames: servers }
      expect(resolveAutomaticPermission(trusted, policy)).toBe('once')
      expect(resolveAutomaticPermission(raw, policy)).toBeUndefined()
      expect(
        resolveAutomaticPermission(
          withTrustedMcpToolIdentity(raw, `external/${identity.split('/')[1]}`),
          policy
        )
      ).toBeUndefined()
      expect(resolveAutomaticPermission(trusted, { ...policy, mcpServerNames: [] })).toBeUndefined()
      expect(resolveAutomaticPermission(trusted, { ...policy, profile: 'ask' })).toBeUndefined()
      expect(resolveAutomaticPermission(trusted, { ...policy, profile: 'full' })).toBe('once')
      expect(
        resolveAutomaticPermission({ ...trusted, options: raw.options.slice(1) }, policy)
      ).toBeUndefined()
    }
  )

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'checks workflow identity support through the real %s correlation path',
    async (framework) => {
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: {
          resolveAppSessionId: (id) => id,
          sessionSnapshot: () => ({
            frameworkId: framework,
            permissionProfile: { selectedProfile: 'auto' }
          }),
          hasActivePrimarySession: () => true,
          capturePrompt: () => undefined,
          currentInteractionSequence: () => undefined,
          mcpServerNamesFor: () => servers,
          reviewerContextFor: () => undefined,
          resolveReviewerPermission: () => undefined,
          currentFramework: () =>
            ({
              'claude-code': claudeCodeFramework,
              opencode: opencodeFramework,
              codex: codexFramework,
              codebuddy: codeBuddyFramework
            })[framework],
          resolveProjectId: () => 'project'
        }
      })
      try {
        for (const identity of LIBRARY_AUTO_TOOL_IDENTITIES) {
          const [server, tool] = identity.split('/')
          const title =
            framework === 'codex'
              ? `mcp.${server}.${tool}`
              : framework === 'opencode'
                ? `${server.replaceAll('-', '_')}_${tool}`
                : `mcp__${server}__${tool}`
          context.observeToolCall(
            {
              sessionId: 'session',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call',
                title,
                kind: 'other',
                status: 'pending',
                rawInput:
                  framework === 'codex'
                    ? { server, tool, arguments: { query: 'evidence' } }
                    : { query: 'evidence' },
                _meta: framework === 'codex' ? { is_mcp_tool_call: true } : { toolName: title }
              }
            },
            { sessionId: 'session', framework, mcpServerNames: servers }
          )
          const raw = request(title)
          if (framework === 'codex') Object.assign(raw, { _meta: { is_mcp_tool_approval: true } })
          const restored = await context.restoreToolCall(raw, {
            sessionId: 'session',
            framework,
            mcpServerNames: servers,
            isCancelled: () => false
          })
          expect(trustedMcpToolIdentity(restored!)).toBe(
            framework === 'codebuddy' ? undefined : identity
          )
          expect(
            resolveAutomaticPermission(restored!, {
              profile: 'auto',
              frameworkId: framework,
              mcpServerNames: servers
            })
          ).toBe(framework === 'codebuddy' ? undefined : 'once')
          expect(
            resolveAutomaticPermission(restored!, {
              profile: 'ask',
              frameworkId: framework,
              mcpServerNames: servers
            })
          ).toBeUndefined()
        }
      } finally {
        context.dispose()
      }
    }
  )

  it.each([claudeCodeFramework, opencodeFramework, codexFramework])(
    'runs a grant-free Auto workflow through the $id broker and switches back to Ask',
    async (framework) => {
      const directory = await mkdtemp(join(tmpdir(), 'library-auto-'))
      const client = createProjectDbClient(directory)
      await migrateApplicationDatabase(client)
      const registry = await createPermissionGrantRegistry({ getClient: async () => client })
      // An unrelated existing grant must survive every automatic decision unchanged.
      await registry.remember({
        capability: { kind: 'mcp_tool', key: 'mcp:external/existing' },
        scope: { kind: 'global' }
      })
      const before = await registry.list()
      const remember = vi.spyOn(registry, 'remember')
      const emit = vi.fn()
      let profile: 'auto' | 'ask' = 'auto'
      const context = new AcpPermissionContext({
        emitPermissionRequest: emit,
        permissionGrantRegistry: registry,
        routing: {
          resolveAppSessionId: (id) => id,
          sessionSnapshot: () => ({
            cwd: directory,
            frameworkId: framework.id,
            permissionProfile: { selectedProfile: profile }
          }),
          hasActivePrimarySession: () => true,
          capturePrompt: () => ({
            sequence: 1,
            promptMessageId: 'message',
            isCancellationAccepted: () => false
          }),
          currentInteractionSequence: () => 1,
          mcpServerNamesFor: () => [...servers, 'external'],
          reviewerContextFor: () => undefined,
          resolveReviewerPermission: () => undefined,
          currentFramework: () => framework,
          resolveProjectId: () => 'project'
        }
      })
      const invoke = (identity: string): Promise<RequestPermissionResponse> => {
        const [server, tool] = identity.split('/')
        const title =
          framework.id === 'codex'
            ? `mcp.${server}.${tool}`
            : framework.id === 'opencode'
              ? `${server.replaceAll('-', '_')}_${tool}`
              : `mcp__${server}__${tool}`
        const raw = request(title)
        if (framework.id === 'codex') Object.assign(raw, { _meta: { is_mcp_tool_approval: true } })
        context.observeProviderUpdate({
          sessionId: 'session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call',
            title,
            kind: 'other',
            status: 'pending',
            rawInput:
              framework.id === 'codex'
                ? { server, tool, arguments: { query: 'evidence' } }
                : { query: 'evidence' },
            _meta: framework.id === 'codex' ? { is_mcp_tool_call: true } : { toolName: title }
          }
        })
        return context.handleProviderRequest(raw)
      }
      try {
        for (const identity of LIBRARY_AUTO_TOOL_IDENTITIES) {
          await expect(invoke(identity)).resolves.toEqual({
            outcome: { outcome: 'selected', optionId: 'once' }
          })
        }
        expect(emit).not.toHaveBeenCalled()
        expect(remember).not.toHaveBeenCalled()
        expect(await registry.list()).toEqual(before)
        // Same-name external calls still ask; explicit rejection reaches the provider unchanged.
        const external = invoke('external/search_library')
        await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1))
        await context.respondToPermission(
          { requestId: emit.mock.calls[0][0].requestId, optionId: 'no' },
          HUMAN_PERMISSION_ACTION_ORIGIN
        )
        await expect(external).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: 'no' }
        })
        profile = 'ask'
        const asked = invoke('open-science-library/search_library')
        await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2))
        await context.respondToPermission(
          { requestId: emit.mock.calls[1][0].requestId, optionId: 'no' },
          HUMAN_PERMISSION_ACTION_ORIGIN
        )
        await expect(asked).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
        expect(await registry.list()).toEqual(before)
      } finally {
        context.dispose()
        await client.$disconnect()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  // Query real registration, including each optional mount independently. New entries must receive
  // an explicit identity/policy decision; this is not a comparison of two hand-maintained catalogs.
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])(
    'checks actual Library registration for optional-handler mask %s',
    async (mask) => {
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(),
        readPdf: vi.fn(),
        saveToInbox: vi.fn(),
        ...(mask & 1 ? { formatReferences: vi.fn() } : {}),
        ...(mask & 2 ? { formatCitationDocument: vi.fn() } : {}),
        ...(mask & 4 ? { prepareLatexBundle: vi.fn() } : {}),
        ...(mask & 8 ? { acquirePdf: vi.fn() } : {})
      })
      const client = new Client({ name: 'inventory', version: '1' })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(a), server.connect(b)])
      try {
        const names = (await client.listTools()).tools
          .map((tool) => `open-science-library/${tool.name}`)
          .sort()
        const expected = [...LIBRARY_AUTO_TOOL_IDENTITIES]
          .filter((identity) => identity.startsWith('open-science-library/'))
          .filter((identity) => {
            const optional = [
              'format_references',
              'format_citation_document',
              'prepare_latex_bundle',
              'acquire_pdf'
            ].indexOf(identity.split('/')[1])
            return optional < 0 || Boolean(mask & (1 << optional))
          })
          .sort()
        expect(names).toEqual(expected)
        for (const name of names) expect(appMcpToolIdentities()).toContain(name)
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it.each([false, true])(
    'checks actual linked-PDF registration with elements=%s',
    async (elements) => {
      const server = createLiteratureMcpServer({
        readDocument: vi.fn(),
        ...(elements ? { elements: { list: vi.fn(), read: vi.fn() } } : {})
      })
      const client = new Client({ name: 'inventory', version: '1' })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(a), server.connect(b)])
      try {
        const names = (await client.listTools()).tools
          .map((tool) => `open-science-literature/${tool.name}`)
          .sort()
        expect(names).toEqual(
          [...LIBRARY_AUTO_TOOL_IDENTITIES]
            .filter(
              (name) =>
                name.startsWith('open-science-literature/') &&
                (elements || name.endsWith('/read_document'))
            )
            .sort()
        )
        for (const name of names) expect(appMcpToolIdentities()).toContain(name)
      } finally {
        await client.close()
        await server.close()
      }
    }
  )
})
