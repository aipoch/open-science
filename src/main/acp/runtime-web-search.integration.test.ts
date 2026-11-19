import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import type { AcpRuntimeEvent } from '../../shared/acp'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import type { AcpRuntimeOptions } from './runtime-contract'
import { configureRuntimeNetwork } from '../runtime-network'
import { WebInvocationStore } from '../web/invocation-store'
import { parseWebResult } from '../../shared/web-tools'
import { WebSessionSlots } from '../web/limits'
import {
  HARNESS_INVOCATION,
  HARNESS_RECEIPT_METHOD,
  receiptResponseSchema
} from '../harness-acp/tool-receipts'

const fixture = vi.hoisted(() => ({
  options: undefined as AcpRuntimeOptions | undefined,
  instantiate: undefined as (() => void) | undefined
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
// Only unrelated Agent process construction is replaced. The production composition, real MCP
// HTTP host, invocation persistence, anonymous Exa client and receipt settlement all execute.
vi.mock('./runtime-base-composition', () => ({ composeAcpRuntimeBaseOwners: () => ({}) }))
vi.mock('./runtime-session-composition', () => ({ composeAcpRuntimeSessionOwners: () => ({}) }))
vi.mock('./runtime', () => ({
  AcpRuntime: class {
    constructor(options: AcpRuntimeOptions) {
      fixture.options = options
    }
  }
}))
vi.mock('./runtime-coordinator', () => ({
  AcpRuntimeCoordinator: class {
    constructor(factory: (callbacks: object, grants: undefined) => unknown) {
      fixture.instantiate = () => {
        factory({}, undefined)
      }
    }
    liveSessionProjectId(): string {
      return 'actual-project'
    }
  }
}))

let root = ''
configureTestRuntimeMetadata(() => ({ homePath: root }))
afterEach(async () => {
  await fixture.options?.mcpHttpHost?.close()
  if (root) await rm(root, { recursive: true, force: true })
  fixture.options = undefined
})

it('commits a real host search in the correct Session without a progress write on the authority queue', async () => {
  root = await mkdtemp(join(tmpdir(), 'composed-exa-web-'))
  const { initDataRoot } = await import('../storage-root')
  initDataRoot(join(root, 'data'))
  const { createAcpRuntime } = await import('./runtime-composition')
  const graph = createLinearConversationGraph({
    sessionId: 'actual-session',
    frameworkId: 'open-science-agent',
    messages: [
      {
        id: 'user-prompt',
        role: 'user',
        content: 'Search science',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  })
  graph.messages[0].runtimeSegmentId = graph.runtimeSegments[0].id
  const session = {
    id: 'actual-session',
    projectId: 'actual-project',
    title: 'Web search',
    cwd: root,
    status: 'idle',
    messages: graph.messages,
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 1
  } as PersistedChatSession
  const blockedProgressWrite = Promise.withResolvers<void>()
  let sessionQueue = Promise.resolve()
  const mutateRuntimeSession = vi.fn(() => {
    sessionQueue = blockedProgressWrite.promise
    return sessionQueue.then(() => session)
  })
  const onEvent = vi.fn<(event: AcpRuntimeEvent) => Promise<void>>(
    () => blockedProgressWrite.promise
  )
  const acceptRuntimeEvent = vi.spyOn(RuntimeSessionOwner.prototype, 'accept')
  const acquireSlot = vi.spyOn(WebSessionSlots.prototype, 'acquire')
  const exaSearch = vi.fn()
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init)
    expect(request.url).toBe('https://mcp.exa.ai/mcp')
    expect(request.headers.has('authorization')).toBe(false)
    if (request.method === 'GET') return new Response(null, { status: 405 })
    const message = await request.json()
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const respond = (result: unknown): Response =>
      Response.json({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'initialize')
      return respond({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'test-exa', version: '1' }
      })
    expect(message.method).toBe('tools/call')
    exaSearch(message.params)
    return respond({
      content: [
        {
          type: 'text',
          text: 'Title: Science\nURL: https://example.org/science\nPublished: N/A\nAuthor: N/A\nHighlights:\nPublic evidence'
        }
      ]
    })
  }
  configureRuntimeNetwork({
    fetch,
    fetchWithManualRedirect: vi.fn(),
    resolveProxy: vi.fn(),
    setProxy: vi.fn()
  })
  createAcpRuntime({
    appVersion: 'test',
    mcpEntryPath: '/unused',
    repository: {},
    runRegistry: {},
    uploadRepository: {},
    notebookRpcServer: {},
    authorizeSkillImportReferencedUploads: vi.fn(),
    managedFileVersions: {},
    finalizeRuntimeArtifacts: vi.fn(),
    runtimeCallbacks: { onEvent },
    settingsService: { captureActiveAgentBackendSelection: vi.fn() },
    sessionPersistenceCoordinator: {
      loadSessionForContinuation: async () => {
        await sessionQueue
        return session
      },
      mutateRuntimeSession
    }
  } as never)
  fixture.instantiate!()
  const host = fixture.options!.mcpHttpHost!
  host.registerWeb(
    'host-route',
    fixture.options!.web!.handlerFor('actual-session', 'actual-project')
  )
  host.registerReceiptScope('host-route', 'receipt-scope', 'web')
  const { token } = await host.ensureStarted()
  const client = new Client({ name: 'composed-web-regression', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(host.urlFor('web', 'host-route')), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
  )
  try {
    const invocation = {
      invocationId: 'search-invocation',
      name: 'web_search' as const,
      arguments: { query: 'science', max_results: 1 }
    }
    const result = await client.callTool(
      {
        name: invocation.name,
        arguments: invocation.arguments,
        _meta: { [HARNESS_INVOCATION]: invocation.invocationId }
      },
      undefined,
      { timeout: 2_500 }
    )
    expect(parseWebResult(result.structuredContent)).toMatchObject({
      status: 'ok',
      provider: { id: 'exa', auth_mode: 'anonymous' },
      sources: [{ url: 'https://example.org/science' }],
      attempts: [{ execution: 'direct_search', provider: { id: 'exa' }, status: 'ok' }]
    })
    await expect(
      client.request({ method: HARNESS_RECEIPT_METHOD, params: invocation }, receiptResponseSchema)
    ).resolves.toMatchObject({ status: 'completed', result })
    await expect(
      new WebInvocationStore(join(root, 'data', 'web-invocations')).read(
        { projectId: 'actual-project', sessionId: 'actual-session' },
        invocation.invocationId
      )
    ).resolves.toMatchObject({
      status: 'completed',
      searchDispatches: [{ index: 1, provider: { id: 'exa' } }],
      searchAttempts: [{ index: 1, status: 'ok' }]
    })
    expect(mutateRuntimeSession).not.toHaveBeenCalled()
    expect(acceptRuntimeEvent).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'in_progress',
        webInvocation: expect.objectContaining({ searchAttempts: [expect.any(Object)] })
      })
    )
    expect(onEvent.mock.lastCall?.[0]).not.toHaveProperty('publicationOwner')
    expect(acquireSlot).toHaveBeenCalledWith(
      JSON.stringify(['actual-project', 'actual-session']),
      expect.any(AbortSignal)
    )
    expect(exaSearch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'web_search_exa',
        arguments: expect.objectContaining({ query: 'science' })
      })
    )
  } finally {
    blockedProgressWrite.resolve()
    await client.close()
    acceptRuntimeEvent.mockRestore()
    acquireSlot.mockRestore()
  }
})
