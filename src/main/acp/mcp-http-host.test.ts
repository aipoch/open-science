import type { WebMcpHandler } from '../web/mcp-server'
import type { ReceiptQuery } from '../harness-acp/tool-receipts'
import { SearchService } from '../web/search-service'
import { WebService, type WebFetchContext } from '../web/service'
import { WebSnapshotStore } from '../web/snapshot-store'
import { WebInvocationOwner } from '../web/invocation-owner'
import { WebInvocationStore } from '../web/invocation-store'
import { parseWebResult, type FetchInput } from '../../shared/web-tools'
import { rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillRuntimeAcpServerConfig } from '../skills/runtime-mcp-server'
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createArtifactSaveFixture } from '../artifacts/save-test-fixtures'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'

import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { ArtifactRepository } from '../artifacts/repository'
import { AgentMcpHttpHost } from './mcp-http-host'
import {
  HARNESS_INVOCATION,
  HARNESS_RECEIPT_METHOD,
  HARNESS_RECEIPTS,
  receiptResponseSchema,
  HarnessToolReceipts
} from '../harness-acp/tool-receipts'

describe('AgentMcpHttpHost', () => {
  let saveFixture: Awaited<ReturnType<typeof createArtifactSaveFixture>> | undefined
  let host: AgentMcpHttpHost | undefined
  let rpcServer: Server | undefined
  let root: string | undefined
  const webClients: Client[] = []

  async function connectWeb(
    host: AgentMcpHttpHost,
    options: { route?: string; fetchImpl?: typeof fetch } = {}
  ): Promise<Client> {
    const { route = 'route', fetchImpl } = options
    const { token } = await host.ensureStarted()
    const client = new Client({ name: 'test-web-mcp', version: '1' })
    webClients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor('web', route)), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        ...(fetchImpl ? { fetch: fetchImpl } : {})
      })
    )
    return client
  }

  function callWeb(
    client: Client,
    query: ReceiptQuery,
    signal?: AbortSignal
  ): ReturnType<Client['callTool']> {
    return client.callTool(
      {
        name: query.name,
        arguments: query.arguments,
        _meta: { [HARNESS_INVOCATION]: query.invocationId }
      },
      undefined,
      { signal }
    )
  }

  function readWebReceipt(
    client: Client,
    query: ReceiptQuery
  ): Promise<z.infer<typeof receiptResponseSchema>> {
    return client.request({ method: HARNESS_RECEIPT_METHOD, params: query }, receiptResponseSchema)
  }

  it('rejects MCP receipt recovery when its route is revoked during ownership repair', async () => {
    root = await mkdtemp(join(tmpdir(), 'web-local-recovery-revoke-'))
    const directory = join(root, 'receipts')
    const receipts = new HarnessToolReceipts(directory)
    host = new AgentMcpHttpHost({ receiptDirectory: directory })
    const query = {
      invocationId: 'revoked-recovery',
      name: 'web_fetch' as const,
      arguments: { url: 'https://example.org/' }
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const receiptCommitted = vi.fn(() => gate)
    const revoke = host.registerWeb('route', { fetchPage: vi.fn(), receiptCommitted })
    host.registerReceiptScope('route', 'scope', 'web')
    await receipts.begin('scope', query)
    await receipts.complete('scope', query, { content: [] })
    const client = await connectWeb(host)
    const reading = readWebReceipt(client, query).catch((error: unknown) => error)
    await vi.waitFor(() => expect(receiptCommitted).toHaveBeenCalledOnce())
    revoke()
    release()
    expect(await reading).toBeInstanceOf(Error)
  })

  it.each(['abort', 'unregister', 'revoke'] as const)(
    'does not commit a late Web Tool result after %s',
    async (operation) => {
      root = await mkdtemp(join(tmpdir(), 'web-host-cancel-'))
      host = new AgentMcpHttpHost({ receiptDirectory: join(root, 'receipts') })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let invocationSignal: AbortSignal | undefined
      const fetchPage = vi.fn(async (_input: FetchInput, context: WebFetchContext) => {
        invocationSignal = context.signal
        await gate
        return {
          schema: 'open-science.web.v1' as const,
          invocation_id: context.invocationId!,
          operation: 'fetch' as const,
          request: { url: 'https://example.org/' },
          status: 'error' as const,
          retrieved_at: '2026-11-16T00:00:00.000Z',
          duration_ms: 0,
          warnings: [],
          sources: [],
          error: { code: 'NETWORK_ERROR' as const, retryable: true }
        }
      })
      const receiptCommitted = vi.fn(async () => undefined)
      const revoke = host.registerWeb('route', { fetchPage, receiptCommitted })
      host.registerReceiptScope('route', 'scope', 'web')
      const abort = new AbortController()
      const query = {
        invocationId: 'cancelled',
        name: 'web_fetch' as const,
        arguments: { url: 'https://example.org/' }
      }
      const client = await connectWeb(host)
      const outcome = callWeb(client, query, abort.signal).catch((error: unknown) => error)
      await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledOnce())
      if (operation === 'abort') abort.abort()
      else if (operation === 'unregister') host.unregister('route')
      else revoke()
      await vi.waitFor(() => expect(invocationSignal?.aborted).toBe(true))
      release()
      expect(await outcome).toBeInstanceOf(Error)
      expect(receiptCommitted).not.toHaveBeenCalled()
      expect(await new HarnessToolReceipts(join(root, 'receipts')).read('scope', query)).toEqual({
        status: 'unknown'
      })
    }
  )

  it('reconciles a known local cancellation once without dispatching the tool again', async () => {
    root = await mkdtemp(join(tmpdir(), 'web-cancel-reconcile-'))
    const directory = join(root, 'receipts')
    host = new AgentMcpHttpHost({ receiptDirectory: directory })
    const query = {
      invocationId: 'cancelled',
      name: 'web_fetch',
      arguments: { url: 'https://example.org/' }
    }
    const result = {
      isError: true,
      content: [{ type: 'text' as const, text: 'Known cancellation' }]
    }
    const fetchPage = vi.fn()
    const reconcileResult = vi.fn(async () => result)
    host.registerWeb('route', { fetchPage, reconcileResult })
    host.registerReceiptScope('route', 'scope', 'web')
    await new HarnessToolReceipts(directory).begin('scope', query)
    const client = await connectWeb(host)
    for (let index = 0; index < 2; index++) {
      expect(await readWebReceipt(client, query)).toEqual({ status: 'completed', result })
    }
    expect(reconcileResult).toHaveBeenCalledExactlyOnceWith(query)
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it.each(['permission-revocation', 'session-authority', 'branch'] as const)(
    'commits a known cancellation over MCP after %s changes without accepting a late result',
    async (change) => {
      root = await mkdtemp(join(tmpdir(), 'web-owner-cancel-'))
      const directory = join(root, 'receipts')
      host = new AgentMcpHttpHost({ receiptDirectory: directory })
      const binding = { projectId: 'project', sessionId: 'session' }
      const store = new WebInvocationStore(join(root, 'ledger'))
      let release!: (result: ReturnType<typeof parseWebResult>) => void
      const gate = new Promise<ReturnType<typeof parseWebResult>>((resolve) => {
        release = resolve
      })
      const execute = vi.fn(async () => (await gate)!)
      const owner = new WebInvocationOwner({
        store,
        scope: async () => ({
          ...binding,
          branchId: 'branch',
          promptMessageId: 'prompt',
          agentFrameId: 'frame',
          runtimeSegmentId: 'segment'
        }),
        execute
      })
      host.registerWeb('route', {
        fetchPage: (input, context) => owner.execute(binding, 'fetch', input, context),
        receiptCommitted: (result) => owner.receiptCommitted(binding, result),
        reconcileResult: (query) => owner.reconcileResult(binding, query)
      })
      host.registerReceiptScope('route', 'scope', 'web')
      const query = {
        invocationId: 'cancelled',
        name: 'web_fetch' as const,
        arguments: { url: 'https://example.org/' }
      }
      const running = callWeb(await connectWeb(host), query)
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
      if (change === 'permission-revocation') owner.cancelSession(binding.sessionId)
      else if (change === 'branch') owner.branchChanged(binding, 'other')
      else owner.cancelSession(binding.sessionId)
      const result = await running
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'CANCELLED', retryable: false } }
      })
      expect(await new HarnessToolReceipts(directory).read('scope', query)).toEqual({
        status: 'completed',
        result
      })
      expect(await store.read(binding, query.invocationId)).toMatchObject({ status: 'cancelled' })
      release({
        schema: 'open-science.web.v1',
        invocation_id: query.invocationId,
        operation: 'fetch',
        status: 'error',
        request: query.arguments,
        retrieved_at: new Date().toISOString(),
        duration_ms: 1,
        sources: [],
        error: { code: 'NETWORK_ERROR', retryable: true }
      })
      await Promise.resolve()
      expect(await new HarnessToolReceipts(directory).read('scope', query)).toEqual({
        status: 'completed',
        result
      })
    }
  )

  it.each(['before', 'after'] as const)(
    'delivers cancellation to the open caller and subsequent receipt recovery when revoked %s receipt publication',
    async (timing) => {
      root = await mkdtemp(join(tmpdir(), 'web-receipt-race-'))
      const directory = join(root, 'receipts')
      const ledger = join(root, 'ledger')
      const receipts = new HarnessToolReceipts(directory)
      const binding = { projectId: 'project', sessionId: 'session' }
      const query = {
        invocationId: 'receipt-race',
        name: 'web_fetch' as const,
        arguments: { url: 'https://example.org/' }
      }
      const snapshots = new WebSnapshotStore(join(root, 'snapshots'))
      const transport = vi.fn(async () => ({
        finalUrl: query.arguments.url,
        contentType: 'text/plain',
        body: Buffer.from('Independent source evidence.')
      }))
      const service = new WebService({ store: snapshots, transport })
      const makeOwner = (): WebInvocationOwner =>
        new WebInvocationOwner({
          store: new WebInvocationStore(ledger),
          scope: async () => ({
            ...binding,
            branchId: 'branch',
            agentFrameId: 'frame',
            promptMessageId: 'prompt',
            runtimeSegmentId: 'segment'
          }),
          execute: (_scope, _op, input, context) => service.fetch('branch', input, context),
          publishSnapshot: (scope, id, authorize) => snapshots.commit(scope.branchId, id, authorize)
        })
      const owner = makeOwner()
      const handler = (authority: WebInvocationOwner): WebMcpHandler => ({
        fetchPage: (input: FetchInput, context: WebFetchContext) =>
          authority.execute(binding, 'fetch', input, context),
        receiptSignal: (id: string) => authority.receiptSignal(binding, id),
        receiptCommitted: (result: unknown) => authority.receiptCommitted(binding, result),
        reconcileResult: (q) => authority.reconcileResult(binding, q)
      })
      host = new AgentMcpHttpHost({ receiptDirectory: directory })
      host.registerWeb('route', handler(owner))
      host.registerReceiptScope('route', 'scope', 'web')
      const entering = Promise.withResolvers<void>(),
        resume = Promise.withResolvers<void>()
      const complete = HarnessToolReceipts.prototype.complete
      const spy = vi
        .spyOn(HarnessToolReceipts.prototype, 'complete')
        .mockImplementationOnce(async function (this: HarnessToolReceipts, ...args) {
          if (timing === 'after') await complete.apply(this, args)
          entering.resolve()
          await resume.promise
          if (timing === 'before') await complete.apply(this, args)
        })
      const client = await connectWeb(host)
      try {
        const calling = callWeb(client, query)
        await entering.promise
        const original = await receipts.read('scope', query)
        const prepared = await new WebInvocationStore(ledger).read(binding, query.invocationId)
        expect(prepared.status).toBe('prepared')
        owner.cancelSession(binding.sessionId)
        resume.resolve()
        const live = await calling
        expect(live).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'CANCELLED' } }
        })
        const final = { status: 'completed', result: live }
        expect(await receipts.read('scope', query)).toEqual(timing === 'after' ? original : final)
        if (timing === 'after') expect(original.result?.structuredContent?.status).toBe('ok')
        else expect(original.status).toBe('unknown')
        // A fresh owner has only its durable journal and the immutable host receipt.
        host.rebindWeb('route', handler(makeOwner()))
        expect(await readWebReceipt(client, query)).toEqual(final)
        expect(await receipts.read('scope', query)).toEqual(timing === 'after' ? original : final)
        await expect(
          snapshots.readCommitted('branch', prepared.result!.document!.snapshot_id)
        ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
        expect(transport).toHaveBeenCalledOnce()
      } finally {
        resume.resolve()
        spy.mockRestore()
      }
    }
  )

  it.each(['MCP cancellation', 'route rebind', 'route revocation'] as const)(
    'settles the receipt after %s while claiming the Web invocation',
    async (change) => {
      root = await mkdtemp(join(tmpdir(), 'web-cancel-before-dispatch-'))
      const directory = join(root, 'receipts')
      host = new AgentMcpHttpHost({ receiptDirectory: directory })
      const binding = { projectId: 'project', sessionId: 'session' }
      const store = new WebInvocationStore(join(root, 'ledger'))
      const scope = vi.fn()
      const execute = vi.fn()
      const owner = new WebInvocationOwner({ store, scope, execute })
      const fetchPage = vi.fn((input, context) => owner.execute(binding, 'fetch', input, context))
      const cancelUndispatched = vi.fn((query) => owner.cancelUndispatched(binding, query))
      const handler: WebMcpHandler = {
        fetchPage,
        cancelUndispatched,
        reconcileResult: (query) => owner.reconcileResult(binding, query),
        receiptCommitted: (result) => owner.receiptCommitted(binding, result)
      }
      const revoke = host.registerWeb('route', handler)
      const replacement = { ...handler, cancelUndispatched: vi.fn(), fetchPage: vi.fn() }
      host.registerReceiptScope('route', 'scope', 'web')
      const started = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const cancellation = Promise.withResolvers<void>()
      const begin = HarnessToolReceipts.prototype.begin
      const spy = vi
        .spyOn(HarnessToolReceipts.prototype, 'begin')
        .mockImplementationOnce(async function (this: HarnessToolReceipts, ...args) {
          await begin.apply(this, args)
          started.resolve()
          await resume.promise
        })
      const client = await connectWeb(host, {
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init)
          if (
            typeof init?.body === 'string' &&
            JSON.parse(init.body).method === 'notifications/cancelled'
          )
            cancellation.resolve()
          return response
        }
      })
      const abort = new AbortController()
      const query = {
        invocationId: 'cancel-before-dispatch',
        name: 'web_fetch',
        arguments: { url: 'https://example.org/' }
      }
      const pending = callWeb(client, query, abort.signal).catch((error: unknown) => error)
      try {
        await started.promise
        if (change === 'MCP cancellation') {
          abort.abort()
          await cancellation.promise
        } else if (change === 'route rebind') {
          host.rebindWeb('route', replacement)
        } else {
          revoke()
          host.registerWeb('route', replacement)
        }
        resume.resolve()
        expect(await pending).toBeInstanceOf(Error)
        const recovery = await connectWeb(host)
        await vi.waitFor(async () =>
          expect(await readWebReceipt(recovery, query)).toMatchObject({
            status: 'completed',
            result: { isError: true, structuredContent: { error: { code: 'CANCELLED' } } }
          })
        )
        expect(cancelUndispatched).toHaveBeenCalledExactlyOnceWith(query)
        expect(replacement.cancelUndispatched).not.toHaveBeenCalled()
        expect(replacement.fetchPage).not.toHaveBeenCalled()
        expect(fetchPage).not.toHaveBeenCalled()
        expect(scope).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
      } finally {
        resume.resolve()
        spy.mockRestore()
      }
    }
  )

  it.each(['policy', 'transport'] as const)(
    'recovers cancellation before scope resolution over %s',
    async (cancel) => {
      root = await mkdtemp(join(tmpdir(), 'web-early-cancel-'))
      const directory = join(root, 'receipts')
      const store = new WebInvocationStore(join(root, 'ledger'))
      const binding = { projectId: 'project', sessionId: 'session' }
      const scope = vi.fn(() => new Promise<never>(() => undefined))
      const execute = vi.fn()
      const owner = new WebInvocationOwner({ store, scope, execute })
      host = new AgentMcpHttpHost({ receiptDirectory: directory })
      host.registerWeb('route', {
        fetchPage: (input, context) => owner.execute(binding, 'fetch', input, context),
        receiptCommitted: (result) => owner.receiptCommitted(binding, result),
        reconcileResult: (query) => owner.reconcileResult(binding, query)
      })
      host.registerReceiptScope('route', 'scope', 'web')
      const abort = new AbortController()
      const query = {
        invocationId: 'early-cancel',
        name: 'web_fetch' as const,
        arguments: { url: 'https://example.org/' }
      }
      const client = await connectWeb(host)
      const calling = callWeb(client, query, abort.signal).catch((error: unknown) => error)
      await vi.waitFor(() => expect(scope).toHaveBeenCalledOnce())
      if (cancel === 'transport') abort.abort()
      owner.cancelSession(binding.sessionId)
      const outcome = await calling
      if (cancel === 'transport') expect(outcome).toBeInstanceOf(Error)
      else
        expect(outcome).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'CANCELLED' } }
        })
      await vi.waitFor(async () =>
        expect(await store.readUndispatchedCancellation(binding, query.invocationId)).toMatchObject(
          { invocationId: query.invocationId }
        )
      )
      expect(await readWebReceipt(client, query)).toMatchObject({
        status: 'completed',
        result: { isError: true, structuredContent: { error: { code: 'CANCELLED' } } }
      })
      expect(execute).not.toHaveBeenCalled()
      expect(owner.dispositionFor(binding, query.invocationId)).toBe('cancelled')
    }
  )

  it('repairs snapshot ownership from a durable receipt without fetching again', async () => {
    root = await mkdtemp(join(tmpdir(), 'web-receipt-repair-'))
    host = new AgentMcpHttpHost({ receiptDirectory: join(root, 'receipts') })
    const store = new WebSnapshotStore(join(root, 'evidence'))
    const transport = vi.fn(async () => ({
      body: Buffer.from('Durable evidence'),
      contentType: 'text/plain',
      finalUrl: 'https://example.org/'
    }))
    const service = new WebService({ store, transport })
    let simulateCrashWindow = true
    host.registerWeb('repair-route', {
      fetchPage: (input, context) => service.fetch('session', input, context),
      receiptCommitted: async (result) => {
        // Simulate interruption after the receipt write but before its ownership index write.
        if (simulateCrashWindow) return
        const envelope = parseWebResult(
          (result as { structuredContent?: unknown }).structuredContent
        )!
        await service.commitSnapshot('session', envelope.document!.snapshot_id)
      }
    })
    host.registerReceiptScope('repair-route', 'scope', 'web')
    const client = await connectWeb(host, { route: 'repair-route' })
    const query = {
      invocationId: 'repair-invocation',
      name: 'web_fetch',
      arguments: { url: 'https://example.org/' }
    }
    const result = await callWeb(client, query)
    const snapshotId = parseWebResult(result.structuredContent)!.document!.snapshot_id
    await expect(store.readCommitted('session', snapshotId)).rejects.toThrow()
    simulateCrashWindow = false
    expect(await readWebReceipt(client, query)).toEqual({ status: 'completed', result })
    expect((await store.readCommitted('session', snapshotId)).text).toBe('Durable evidence')
    expect(transport).toHaveBeenCalledOnce()
  })

  it('persists a single bounded search envelope and reads its receipt without another provider request', async () => {
    root = await mkdtemp(join(tmpdir(), 'web-search-receipt-'))
    host = new AgentMcpHttpHost({ receiptDirectory: join(root, 'receipts') })
    const search = vi.fn(async () => ({
      sources: [
        {
          source_id: 'source',
          url: 'https://example.org/paper',
          title: 'Scientific source',
          snippet: 'Evidence excerpt',
          evidence_kind: 'provider_excerpt' as const
        }
      ]
    }))
    const service = new SearchService({ provider: { search } })
    host.registerWeb('search-route', {
      fetchPage: vi.fn(),
      search: (input, context) => service.search('session', input, context)
    })
    host.registerReceiptScope('search-route', 'search-session', 'web')
    const client = await connectWeb(host, { route: 'search-route' })
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'web_fetch',
      'web_search'
    ])
    const query = {
      invocationId: 'search-invocation',
      name: 'web_search',
      arguments: { query: 'quantum materials' }
    }
    const result = await callWeb(client, query)
    expect(result.content).toEqual([])
    expect(result.structuredContent).toMatchObject({
      operation: 'search',
      status: 'ok',
      returned_count: 1,
      provider: { id: 'exa', auth_mode: 'anonymous' }
    })
    const recovered = await readWebReceipt(client, query)
    expect(recovered).toEqual({ status: 'completed', result })
    expect(search).toHaveBeenCalledOnce()
  })

  it('never lends a replacement Notebook environment to an old HTTP route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const environment = {
      endpoint: 'http://127.0.0.1:1/notebook',
      token: 'old-notebook-token',
      projectId: 'project',
      sessionId: 'session',
      workspaceCwd: '/workspace'
    }
    host.registerNotebook('session', environment)
    const oldUrl = host.urlFor('notebook', 'session')
    host.registerNotebook('session', { ...environment, token: 'new-notebook-token' })
    const newUrl = host.urlFor('notebook', 'session')
    const stale = await fetch(oldUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(stale.status).toBe(404)
    const client = new Client({ name: 'fresh-notebook-intent', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(newUrl), {
          requestInit: { headers: { authorization: `Bearer ${token}` } }
        })
      )
      expect((await client.listTools()).tools.some(({ name }) => name === 'repl_execute')).toBe(
        true
      )
    } finally {
      await client.close()
    }
  })

  it.each(['replacement', 'unregister', 'clear'] as const)(
    'does not restore a Notebook route after %s supersedes its registration',
    async (action) => {
      host = new AgentMcpHttpHost()
      await host.ensureStarted()
      const environment = {
        endpoint: 'http://127.0.0.1:1/notebook',
        token: 'notebook-token',
        projectId: 'project',
        sessionId: 'session',
        workspaceCwd: '/workspace'
      }
      host.registerNotebook('session', environment)
      const rollback = host.registerNotebook('session', environment)
      if (action === 'replacement') {
        host.registerNotebook('session', { ...environment, token: 'successor' })
        const successorUrl = host.urlFor('notebook', 'session')
        rollback()
        expect(host.urlFor('notebook', 'session')).toBe(successorUrl)
      } else {
        if (action === 'clear') host.clear()
        else host.unregister('session')
        rollback()
        expect(() => host!.urlFor('notebook', 'session')).toThrow('No registered notebook')
      }
    }
  )

  it('serves only the owned Skill allowlist and revokes each HTTP projection independently', async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-skill-http-'))
    for (const name of ['allowed', 'hidden']) {
      await mkdir(join(root, '.claude', 'skills', name), { recursive: true })
      await writeFile(
        join(root, '.claude', 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Fixture\n---\n${name} body`
      )
    }
    host = new AgentMcpHttpHost()
    await host.ensureStarted()
    const owned = createSkillRuntimeAcpServerConfig({
      command: process.execPath,
      entryPath: join(root, 'entry.js'),
      root,
      allowedNames: ['allowed']
    })
    expect(() => host!.registerSkillRuntime({ ...owned })).toThrow('host-owned')
    const first = host.registerSkillRuntime(owned)
    const second = host.registerSkillRuntime(owned)
    if (!('url' in first.server) || !('url' in second.server))
      throw new Error('Expected HTTP servers')
    const client = new Client({ name: 'skill-http-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(second.server.url), {
        requestInit: {
          headers: Object.fromEntries(second.server.headers.map(({ name, value }) => [name, value]))
        }
      })
    )
    try {
      const tools = JSON.stringify(await client.listTools())
      expect(tools).toContain('allowed')
      expect(tools).not.toContain('hidden')
      expect(
        JSON.stringify(
          await client.callTool({ name: 'load_skill', arguments: { skill: 'allowed' } })
        )
      ).toContain('allowed body')
      expect(
        await client.callTool({ name: 'load_skill', arguments: { skill: 'hidden' } })
      ).toMatchObject({ isError: true })
      first.release()
      expect(
        (
          await fetch(first.server.url, {
            headers: Object.fromEntries(
              first.server.headers.map(({ name, value }) => [name, value])
            )
          })
        ).status
      ).toBe(404)
      expect((await client.listTools()).tools).toHaveLength(1)
      second.release()
      await expect(client.listTools()).rejects.toThrow()
    } finally {
      await client.close()
    }
  })

  afterEach(async () => {
    await Promise.all(webClients.splice(0).map((client) => client.close()))
    await host?.close()
    await saveFixture?.dispose()
    saveFixture = undefined
    host = undefined
    if (rpcServer) {
      rpcServer.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        rpcServer?.close((error) => (error ? reject(error) : resolve()))
      )
      rpcServer = undefined
    }

    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it.each([
    'artifact',
    'plan',
    'skills',
    'skill-import',
    'host-message',
    'library',
    'literature',
    'web'
  ] as const)(
    'persists %s receipts without exposing recovery as a model tool or replaying effects',
    async (kind) => {
      saveFixture = await createArtifactSaveFixture()
      root = saveFixture.storageRoot
      host = new AgentMcpHttpHost({ receiptDirectory: join(root, 'receipts') })
      const { token } = await host.ensureStarted()
      let route = 'receipt-route'
      const scope = JSON.stringify(['project', 'stable-session', kind])
      if (kind !== 'skills') host.registerReceiptScope(route, scope, kind)
      let name: string
      let args: Record<string, unknown>
      if (kind === 'artifact') {
        host.registerArtifact(
          route,
          await saveFixture.environment(
            { allowedImportRoots: [root], workspaceCwd: root },
            { projectId: 'default-project' }
          )
        )
        name = 'write_artifact_file'
        args = {
          filename: 'receipt.txt',
          source: { kind: 'inline', content: 'persisted', encoding: 'utf8' }
        }
      } else if (kind === 'plan' || kind === 'skill-import') {
        rpcServer = createServer((request, response) => {
          request.resume()
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              result:
                kind === 'plan'
                  ? {
                      changed: true,
                      projection: {
                        artifactVersionId: 'version-1',
                        lifecycle: 'approved',
                        approval: 'approved',
                        revision: 1
                      }
                    }
                  : { status: 'cancelled', skills: [] }
            })
          )
        })
        await new Promise<void>((resolve) => rpcServer!.listen(0, '127.0.0.1', resolve))
        const address = rpcServer.address()
        if (!address || typeof address === 'string') throw new Error('No RPC listener')
        const environment = {
          endpoint: `http://127.0.0.1:${address.port}/rpc`,
          token: 'fixture',
          sessionId: route,
          projectId: 'default-project'
        }
        if (kind === 'plan') host.registerPlan(route, environment)
        else host.registerSkillImport(route, environment)
        name = kind === 'plan' ? 'generate_plan' : 'request_skill_import'
        args =
          kind === 'plan'
            ? { approve: true }
            : { github_url: 'https://github.com/acme/skills/tree/main/fixture' }
      } else if (kind === 'skills') {
        await mkdir(join(root, '.claude', 'skills', 'fixture'), { recursive: true })
        await writeFile(
          join(root, '.claude', 'skills', 'fixture', 'SKILL.md'),
          '---\nname: fixture\ndescription: Test\n---\nSkill evidence'
        )
        route = host.registerSkillRuntime(
          createSkillRuntimeAcpServerConfig({
            command: process.execPath,
            entryPath: join(root, 'entry.js'),
            root,
            allowedNames: ['fixture']
          })
        ).routingId
        name = 'load_skill'
        args = { skill: 'fixture' }
      } else if (kind === 'host-message') {
        host.registerHostMessage(route, {
          sendMessage: async () => ({
            status: 'queued',
            messageId: 'message',
            targetState: 'idle',
            delivery: 'next-user-turn',
            persisted: true,
            systemHint: 'queued'
          })
        })
        name = 'send_message'
        args = { target: 'main', text: 'Advisory fixture' }
      } else if (kind === 'web') {
        const store = new WebSnapshotStore(join(root, 'web-evidence'))
        const service = new WebService({
          store,
          transport: async () => ({
            body: Buffer.from('Offline fixture evidence'),
            contentType: 'text/plain',
            finalUrl: 'https://example.org/'
          })
        })
        host.registerWeb(route, {
          fetchPage: (input, context) => service.fetch('stable-session', input, context),
          receiptCommitted: async (result) => {
            const envelope = parseWebResult(
              (result as { structuredContent?: unknown }).structuredContent
            )!
            expect(envelope.document).toBeDefined()
            expect((await store.read('stable-session', envelope.document!.snapshot_id)).text).toBe(
              'Offline fixture evidence'
            )
            await service.commitSnapshot('stable-session', envelope.document!.snapshot_id)
          }
        })
        name = 'web_fetch'
        args = { url: 'https://example.org/' }
      } else if (kind === 'library') {
        host.registerLiteratureLibrary(route, {
          searchLibrary: async () => ({ items: [], totalCount: 0, hasMore: false }),
          readAbstract: async () => undefined,
          readPdf: async () => undefined,
          saveToInbox: async () => ({ results: [] })
        })
        name = 'search_library'
        args = { query: 'fixture' }
      } else {
        host.registerLiterature(route, {
          readDocument: async () => ({ content: 'fixture page', nextCursor: null })
        })
        name = 'read_document'
        args = {}
      }
      if (kind === 'skills') host.registerReceiptScope(route, scope, kind)
      const client = new Client({ name: 'receipt-client', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(host.urlFor(kind, route)), {
          requestInit: { headers: { authorization: `Bearer ${token}` } }
        })
      )
      try {
        expect(client.getServerCapabilities()?.experimental?.[HARNESS_RECEIPTS]).toBeDefined()
        expect((await client.listTools()).tools.some((tool) => tool.name.includes('receipt'))).toBe(
          false
        )
        const query = { invocationId: 'stable-invocation', name, arguments: args }
        const request = {
          name,
          arguments: args,
          _meta: { [HARNESS_INVOCATION]: query.invocationId }
        }
        const result = await client.callTool(request)
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        await expect(client.callTool(request)).rejects.toThrow()
        const recovered = await client.request(
          { method: HARNESS_RECEIPT_METHOD, params: query },
          receiptResponseSchema
        )
        expect(recovered).toEqual({ status: 'completed', result })
        expect(await new HarnessToolReceipts(join(root, 'receipts')).read(scope, query)).toEqual(
          recovered
        )
        host.registerReceiptScope(route, 'other-session', kind)
        expect(
          await client.request(
            { method: HARNESS_RECEIPT_METHOD, params: query },
            receiptResponseSchema
          )
        ).toEqual({ status: 'unknown' })
        host.unregister(route)
        await expect(
          client.request({ method: HARNESS_RECEIPT_METHOD, params: query }, receiptResponseSchema)
        ).rejects.toThrow()
      } finally {
        await client.close()
      }
    }
  )

  it.each(['revoke', 'replace'] as const)(
    'rejects a receipt read when its service authority changes during %s',
    async (operation) => {
      root = await mkdtemp(join(tmpdir(), 'receipt-revoke-'))
      host = new AgentMcpHttpHost({ receiptDirectory: join(root, 'receipts') })
      const { token } = await host.ensureStarted()
      const handler = { readDocument: async () => ({ content: 'old evidence', nextCursor: null }) }
      const revoke = host.registerLiterature('shared-route', handler)
      host.registerReceiptScope('shared-route', 'literature-scope', 'literature')
      host.registerHostMessage('shared-route', {
        sendMessage: async () => {
          throw new Error('Unused sibling route')
        }
      })
      const client = new Client({ name: 'revocation-test', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(host.urlFor('literature', 'shared-route')), {
          requestInit: { headers: { authorization: `Bearer ${token}` } }
        })
      )
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const original = HarnessToolReceipts.prototype.read
      let blockReceiptRead = false
      const spy = vi
        .spyOn(HarnessToolReceipts.prototype, 'read')
        .mockImplementation(async function (this: HarnessToolReceipts, scope, query) {
          if (blockReceiptRead) await gate
          return original.call(this, scope, query)
        })
      try {
        const query = { invocationId: 'invocation', name: 'read_document', arguments: {} }
        await client.callTool({
          name: query.name,
          arguments: query.arguments,
          _meta: { [HARNESS_INVOCATION]: query.invocationId }
        })
        spy.mockClear()
        blockReceiptRead = true
        const reading = client
          .request({ method: HARNESS_RECEIPT_METHOD, params: query }, receiptResponseSchema)
          .catch((error) => error)
        await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
        if (operation === 'revoke') revoke()
        else host.registerLiterature('shared-route', handler)
        release()
        expect(await reading).toBeInstanceOf(Error)
      } finally {
        release()
        spy.mockRestore()
        await client.close()
      }
    }
  )

  it('serves the artifact MCP tools over http and writes a file for the active run', async () => {
    saveFixture = await createArtifactSaveFixture()
    root = saveFixture.storageRoot
    const projectId = 'default-project'
    const artifactSessionId = 'artifact-session-1'
    const runId = 'artifact-run-1'
    // The artifact tool reads the active run id from this main-process-owned handoff file.
    const environment = await saveFixture.environment(
      { allowedImportRoots: [root], workspaceCwd: root },
      { projectId }
    )

    host = new AgentMcpHttpHost()
    const { endpoint, token } = await host.ensureStarted()
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    host.registerArtifact(artifactSessionId, environment)

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(host.urlFor('artifact', artifactSessionId)),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }
    )
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('write_artifact_file')

    const result = await client.callTool({
      name: 'write_artifact_file',
      arguments: {
        filename: 'note.txt',
        source: { kind: 'inline', content: 'hello http mcp', encoding: 'utf8' }
      }
    })
    expect(JSON.stringify(result.content)).toContain('note.txt')

    await client.close()

    // The file landed in the pending run through the same repository the stdio path uses.
    const files = await new ArtifactRepository(root).listPendingRunFiles({
      projectId,
      sessionId: artifactSessionId,
      runId
    })
    expect(files.map((file) => file.name)).toContain('note.txt')
  })

  it('accepts a JSON-stringified artifact source from an MCP model call', async () => {
    saveFixture = await createArtifactSaveFixture()
    root = saveFixture.storageRoot
    const projectId = 'default-project'
    const artifactSessionId = 'artifact-session-1'
    const runId = 'artifact-run-1'
    const environment = await saveFixture.environment(
      { allowedImportRoots: [root], workspaceCwd: root },
      { projectId }
    )

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerArtifact(artifactSessionId, environment)

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(host.urlFor('artifact', artifactSessionId)),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }
    )
    await client.connect(transport)

    const result = await client.callTool({
      name: 'write_artifact_file',
      arguments: {
        filename: 'report.md',
        mimeType: 'text/markdown',
        source: JSON.stringify({ kind: 'inline', content: '# Report' })
      }
    })
    expect(JSON.stringify(result.content)).toContain('report.md')

    await client.close()

    const files = await new ArtifactRepository(root).listPendingRunFiles({
      projectId,
      sessionId: artifactSessionId,
      runId
    })
    expect(files.map((file) => file.name)).toContain('report.md')
  })

  it('delivers PDF image blocks once and isolates cancellation by server kind as well as route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const signals = new Map<string, AbortSignal>()
    host.registerLiterature('same-route', {
      readDocument: vi.fn(),
      elements: {
        list: async () => ({ data: { elements: [], nextCursor: null } }),
        read: async (_input, signal) => {
          signals.set('literature', signal)
          await blocked
          signal.throwIfAborted()
          return {
            data: { caption: 'Figure 3. Survival.', imageIncluded: true },
            image: { data: 'aW1hZ2U=', mimeType: 'image/png' }
          }
        }
      }
    })
    host.registerLiteratureLibrary('same-route', {
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox: vi.fn(async () => ({ results: [] })),
      resolveSaveReferences: async (_refs, signal) => {
        signals.set('library', signal!)
        await blocked
        return []
      }
    })
    const clients: Client[] = []
    const connect = async (kind: 'library' | 'literature'): Promise<Client> => {
      const client = new Client({ name: 'pdf-http', version: '1' })
      clients.push(client)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(host!.urlFor(kind, 'same-route')), {
          requestInit: { headers: { authorization: `Bearer ${token}` } }
        })
      )
      return client
    }
    try {
      const pdf = await connect('literature'),
        library = await connect('library')
      const reading = pdf
        .callTool({ name: 'read_pdf_element', arguments: { elementRef: 'ref' } })
        .catch((error: unknown) => error)
      const saving = library
        .callTool({ name: 'save_to_inbox', arguments: { refs: ['doi:10.1234/paper'] } })
        .catch((error: unknown) => error)
      await vi.waitFor(() => expect(signals.size).toBe(2))
      const duplicate = await connect('literature')
      await expect(
        duplicate.callTool({ name: 'read_pdf_element', arguments: { elementRef: 'ref' } })
      ).rejects.toMatchObject({ code: 409 })
      await library.notification({ method: 'notifications/cancelled', params: { requestId: 1 } })
      expect(signals.get('library')!.aborted).toBe(true)
      expect(signals.get('literature')!.aborted).toBe(false)
      await pdf.notification({ method: 'notifications/cancelled', params: { requestId: 1 } })
      expect(signals.get('literature')!.aborted).toBe(true)
      release()
      await pdf.close()
      await library.close()
      await Promise.all([reading, saving])
      const reopened = await connect('literature')
      const result = await reopened.callTool({
        name: 'read_pdf_element',
        arguments: { elementRef: 'ref' }
      })
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([
        { type: 'text', text: '{"caption":"Figure 3. Survival.","imageIncluded":true}' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
      ])
      expect(signals.get('literature')!.aborted).toBe(false)
    } finally {
      release()
      await Promise.all(clients.map((client) => client.close()))
    }
  })

  it('serves the conversation Skill import tool over http', async () => {
    const routingId = 'skill-import-session-1'
    const rpcRequest: { authorization?: string; body?: unknown } = {}
    rpcServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        }
        rpcRequest.authorization = request.headers.authorization
        rpcRequest.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ result: { status: 'cancelled', skills: [] } }))
      })()
    })
    await new Promise<void>((resolve, reject) => {
      rpcServer?.once('error', reject)
      rpcServer?.listen(0, '127.0.0.1', resolve)
    })
    const rpcAddress = rpcServer.address()
    if (typeof rpcAddress !== 'object' || rpcAddress === null) {
      throw new Error('Test Skill RPC server did not return a TCP address.')
    }

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerSkillImport(routingId, {
      endpoint: `http://127.0.0.1:${rpcAddress.port}/skill-import`,
      token: 'rpc-token',
      sessionId: routingId
    })

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const skillImportUrl = host.urlFor('skill-import', routingId)
    const transport = new StreamableHTTPClientTransport(new URL(skillImportUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('request_skill_import')

    const result = await client.callTool({
      name: 'request_skill_import',
      arguments: {
        github_url: 'https://github.com/acme/skills/tree/main/slide-master'
      }
    })
    expect(JSON.stringify(result.content)).toContain('cancelled')
    expect(rpcRequest).toEqual({
      authorization: 'Bearer rpc-token',
      body: {
        method: 'skillImport',
        params: {
          sessionId: routingId,
          githubUrl: 'https://github.com/acme/skills/tree/main/slide-master'
        }
      }
    })

    await client.close()

    host.unregister(routingId)
    const removed = await fetch(skillImportUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{}'
    })
    expect(removed.status).toBe(404)
  })

  it('keeps Plan execution identity stable across stateless HTTP requests and revokes the route', async () => {
    const routingId = 'plan-session-1'
    const rpcBodies: unknown[] = []
    rpcServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          params?: { operation?: string }
        }
        rpcBodies.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            result:
              body.params?.operation === 'approve'
                ? {
                    changed: true,
                    projection: {
                      artifactVersionId: 'version-1',
                      lifecycle: 'approved',
                      approval: 'approved',
                      revision: 1
                    }
                  }
                : { projection: { artifactVersionId: 'version-1', lifecycle: 'completed' } }
          })
        )
      })()
    })
    await new Promise<void>((resolve, reject) => {
      rpcServer?.once('error', reject)
      rpcServer?.listen(0, '127.0.0.1', resolve)
    })
    const rpcAddress = rpcServer.address()
    if (typeof rpcAddress !== 'object' || rpcAddress === null) {
      throw new Error('Test Plan RPC server did not return a TCP address.')
    }

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerPlan(routingId, {
      endpoint: `http://127.0.0.1:${rpcAddress.port}/plan`,
      token: 'plan-rpc-token',
      projectId: 'project-1',
      sessionId: routingId
    })
    const planUrl = host.urlFor('plan', routingId)
    const missingRouteTokenUrl = new URL(planUrl)
    missingRouteTokenUrl.search = ''
    const missingRouteToken = await fetch(missingRouteTokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{}'
    })
    expect(missingRouteToken.status).toBe(404)
    const responseTypes: string[] = []
    const client = new Client({ name: 'plan-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(planUrl), {
        fetch: async (url, init) => {
          const response = await fetch(url, init)
          if (init?.method === 'POST' && response.status === 200)
            responseTypes.push(response.headers.get('content-type') ?? '')
          return response
        },
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'generate_plan',
      'update_step_status'
    ])
    await client.callTool({ name: 'generate_plan', arguments: { approve: true } })
    await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'completed' }
    })
    expect(responseTypes.length).toBeGreaterThanOrEqual(3)
    expect(responseTypes.every((type) => type.includes('text/event-stream'))).toBe(true)
    expect(rpcBodies).toEqual([
      {
        method: 'planCall',
        params: {
          projectId: 'project-1',
          sessionId: routingId,
          operation: 'approve'
        }
      },
      {
        method: 'planCall',
        params: {
          projectId: 'project-1',
          sessionId: routingId,
          operation: 'updateStepStatus',
          input: {
            title: 'Analyze the data',
            status: 'completed',
            expectedArtifactVersionId: 'version-1'
          }
        }
      }
    ])

    await client.close()
    host.unregister(routingId)
    const removed = await fetch(planUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(removed.status).toBe(404)
  })

  it('does not route an old Plan capability URL to a replacement environment', async () => {
    const routingId = 'stable-plan-session'
    const seenTokens: string[] = []
    rpcServer = createServer((request, response) => {
      seenTokens.push(request.headers.authorization ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          result: {
            changed: true,
            projection: {
              artifactVersionId: 'version-1',
              lifecycle: 'approved',
              approval: 'approved',
              revision: 1
            }
          }
        })
      )
    })
    await new Promise<void>((resolve, reject) => {
      rpcServer?.once('error', reject)
      rpcServer?.listen(0, '127.0.0.1', resolve)
    })
    const rpcAddress = rpcServer.address()
    if (typeof rpcAddress !== 'object' || rpcAddress === null) {
      throw new Error('Test Plan RPC server did not return a TCP address.')
    }

    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerPlan(routingId, {
      endpoint: `http://127.0.0.1:${rpcAddress.port}/plan`,
      token: 'old-plan-token',
      projectId: 'project-1',
      sessionId: routingId
    })
    const oldUrl = host.urlFor('plan', routingId)
    const oldRouteToken = new URL(oldUrl).searchParams.get('token')
    if (!oldRouteToken) throw new Error('Expected a Plan route token.')
    const oldClient = new Client({ name: 'old-plan-http-test', version: '1.0.0' })
    await oldClient.connect(
      new StreamableHTTPClientTransport(new URL(oldUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    const prepareRollback = host.registerPlan(routingId, {
      endpoint: `http://127.0.0.1:${rpcAddress.port}/plan`,
      token: 'new-plan-token',
      projectId: 'project-1',
      sessionId: routingId
    })
    const replacementUrl = host.urlFor('plan', routingId)
    const replacementClient = new Client({ name: 'replacement-plan-http-test', version: '1.0.0' })
    await replacementClient.connect(
      new StreamableHTTPClientTransport(new URL(replacementUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    const staleResponse = await fetch(oldUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{}'
    })
    expect(staleResponse.status).toBe(404)
    expect(await staleResponse.text()).not.toContain(oldRouteToken)

    await expect(
      oldClient.callTool({ name: 'generate_plan', arguments: { approve: true } })
    ).rejects.toThrow()
    await replacementClient.callTool({ name: 'generate_plan', arguments: { approve: true } })
    expect(seenTokens).toEqual(['Bearer new-plan-token'])

    const restorePreviousRoute = prepareRollback()
    host.unregister(routingId)
    restorePreviousRoute?.()
    await oldClient.callTool({ name: 'generate_plan', arguments: { approve: true } })
    await expect(
      replacementClient.callTool({ name: 'generate_plan', arguments: { approve: true } })
    ).rejects.toThrow()
    expect(seenTokens).toEqual(['Bearer new-plan-token', 'Bearer old-plan-token'])
    await replacementClient.close()
    await oldClient.close()
  })

  it('serves the linked Literature reader over its bound route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const readDocument = vi.fn(async () => ({ content: 'page text', nextCursor: null }))
    host.registerLiterature('literature-session-1', { readDocument })
    const client = new Client({ name: 'literature-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(host.urlFor('literature', 'literature-session-1')),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }
      )
    )

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_document'])
    await client.callTool({ name: 'read_document', arguments: {} })
    expect(readDocument).toHaveBeenCalledWith({})
    await client.close()
  })

  it('uninstalls only its own Literature route and permits reinstall with the same handler', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const handler = { readDocument: vi.fn(async () => ({ content: 'page', nextCursor: null })) }
    const stale = host.registerLiterature('feature', handler)
    const current = host.registerLiterature('feature', handler)
    const removeLibrary = host.registerLiteratureLibrary('feature', {
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox: vi.fn()
    })
    const status = async (kind: 'library' | 'literature'): Promise<number> =>
      (
        await fetch(host!.urlFor(kind, 'feature'), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        })
      ).status
    stale()
    expect(await status('literature')).toBe(200)
    current()
    current()
    expect(await status('literature')).toBe(404)
    expect(await status('library')).toBe(200)
    const reinstalled = host.registerLiterature('feature', handler)
    current()
    expect(await status('literature')).toBe(200)
    reinstalled()
    removeLibrary()
    expect(await status('library')).toBe(404)
  })

  it('aborts a removed Library route before pending lookup can commit', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    let release!: () => void
    let started!: () => void
    let signal: AbortSignal | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const uninstall = host.registerLiteratureLibrary('feature', {
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox,
      resolveSaveReferences: async (_refs, currentSignal) => {
        signal = currentSignal
        started()
        await waiting
        return [
          {
            item: literatureItemInputSchema.parse({ title: 'Paper', itemType: 'journalArticle' }),
            source: { provider: 'test', rawMetadata: {} }
          }
        ]
      }
    })
    const client = new Client({ name: 'uninstall-library-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor('library', 'feature')), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )
    const pending = client
      .callTool({ name: 'save_to_inbox', arguments: { refs: ['doi:10.1234/paper'] } })
      .catch((error: unknown) => error)
    try {
      await entered
      uninstall()
      await pending
      await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    } finally {
      release()
      await client.close()
    }
    expect(saveToInbox).not.toHaveBeenCalled()
  })

  it('serves the user Literature Library over its bound route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false }))
    const readAbstract = vi.fn(async () => undefined)
    const readPdf = vi.fn(async () => undefined)
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    host.registerLiteratureLibrary('library-session-1', {
      searchLibrary,
      readAbstract,
      readPdf,
      saveToInbox
    })
    const client = new Client({ name: 'library-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor('library', 'library-session-1')), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_library',
      'read_library_abstract',
      'read_library_pdf',
      'save_to_inbox'
    ])
    await client.callTool({ name: 'search_library', arguments: { query: 'retrieval' } })
    expect(searchLibrary).toHaveBeenCalledWith({ query: 'retrieval', scope: 'project', limit: 20 })
    await client.close()
  })

  it.each(['cancel', 'replace', 'unregister'] as const)(
    'streams image progress and aborts only the owning RPC on %s',
    async (action) => {
      root = await mkdtemp(join(tmpdir(), 'image-mcp-http-'))
      const currentRunFile = join(root, 'current-run.json')
      await writeFile(
        currentRunFile,
        JSON.stringify({ artifactRunId: 'run-a', rpcCapabilityToken: 'image-token' })
      )
      const requests = new Map<string, ServerResponse>()
      const closed = new Set<string>()
      rpcServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const { params } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          requests.set(params.filename, response)
          response.once('close', () => closed.add(params.filename))
        })()
      })
      await new Promise<void>((resolve) => rpcServer!.listen(0, '127.0.0.1', resolve))
      const address = rpcServer.address()
      if (!address || typeof address === 'string') throw new Error('Missing RPC address')
      host = new AgentMcpHttpHost()
      const { token } = await host.ensureStarted()
      const environment = {
        projectId: 'project-a',
        sessionId: 'session-a',
        currentRunFile,
        rpcEndpoint: `http://127.0.0.1:${address.port}`
      }
      const clients: Client[] = []
      const contentTypes: string[] = []
      const connect = async (route: string): Promise<Client> => {
        const client = new Client({ name: 'image-http-test', version: '1' })
        clients.push(client)
        await client.connect(
          new StreamableHTTPClientTransport(new URL(host!.urlFor('image', route)), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
            fetch: async (input, init) => {
              const response = await fetch(input, init)
              if (
                typeof init?.body === 'string' &&
                JSON.parse(init.body).method === 'tools/call' &&
                response.ok
              )
                contentTypes.push(response.headers.get('content-type') ?? '')
              return response
            }
          })
        )
        return client
      }
      const controller = new AbortController()
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        host.registerImage('first', environment)
        host.registerImage('second', environment)
        const first = await connect('first')
        const second = await connect('second')
        const onprogress = vi.fn()
        const firstResult = first
          .callTool(
            { name: 'generate_image', arguments: { prompt: 'a circle', filename: 'first' } },
            undefined,
            { onprogress, signal: controller.signal }
          )
          .catch((error: unknown) => error)
        const secondResult = second.callTool({
          name: 'edit_image',
          arguments: {
            prompt: 'recolor',
            filename: 'second',
            source: {
              projectId: 'project-a',
              sourceKind: 'artifact-version',
              sourceFileId: 'file-a',
              inputFileVersionId: 'version-a'
            }
          }
        })
        await vi.waitFor(() => expect(requests.size).toBe(2))
        await vi.advanceTimersByTimeAsync(30_000)
        await vi.waitFor(() =>
          expect(onprogress).toHaveBeenCalledWith({ progress: 1, message: 'Generating image.' })
        )
        const duplicate = await connect('first')
        await expect(
          duplicate.callTool({ name: 'generate_image', arguments: { prompt: 'duplicate' } })
        ).rejects.toMatchObject({ code: 409 })
        if (action === 'cancel') controller.abort()
        else if (action === 'replace') host.registerImage('first', { ...environment })
        else host.unregister('first')
        await vi.waitFor(() => expect(closed.has('first')).toBe(true))
        expect(closed.has('second')).toBe(false)
        requests.get('second')!.writeHead(200, { 'content-type': 'application/json' })
        requests
          .get('second')!
          .end(JSON.stringify({ result: { artifactId: 'artifact-a', versionId: 'version-b' } }))
        expect((await secondResult).isError).not.toBe(true)
        expect(contentTypes).toHaveLength(2)
        expect(contentTypes.every((type) => type.includes('text/event-stream'))).toBe(true)
        controller.abort()
        await first.close()
        await firstResult
        expect(requests.size).toBe(2)
      } finally {
        controller.abort()
        await Promise.all(clients.map((client) => client.close()))
        vi.useRealTimers()
      }
    }
  )

  it('delivers HTTP cancellation to the active literature lookup before it can save', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    let release!: () => void
    let lookupStarted!: () => void
    let lookupSignal: AbortSignal | undefined
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let delivered!: () => void
    const cancellationDelivered = new Promise<void>((resolve) => {
      delivered = resolve
    })
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    host.registerLiteratureLibrary('cancel-library', {
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox,
      resolveSaveReferences: async (_refs, signal) => {
        lookupSignal = signal
        lookupStarted()
        await blocked
        return [
          {
            item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' }),
            source: { provider: 'test', rawMetadata: {} }
          }
        ]
      }
    })
    const client = new Client({ name: 'cancel-http-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor('library', 'cancel-library')), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init)
          if (
            typeof init?.body === 'string' &&
            JSON.parse(init.body).method === 'notifications/cancelled'
          )
            delivered()
          return response
        }
      })
    )
    const controller = new AbortController()
    const pending = client
      .callTool({ name: 'save_to_inbox', arguments: { refs: ['doi:10.1234/paper'] } }, undefined, {
        signal: controller.signal
      })
      .catch((error: unknown) => error)
    try {
      await started
      controller.abort()
      await pending
      await cancellationDelivered
      expect(lookupSignal?.aborted).toBe(true)
    } finally {
      release()
      await client.close()
    }
    expect(saveToInbox).not.toHaveBeenCalled()
  })

  it('honors cancellation while the original Library request body is still arriving', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    host.registerLiteratureLibrary('slow-body', {
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox
    })
    const url = host.urlFor('library', 'slow-body')
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    }
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: {
        name: 'save_to_inbox',
        arguments: {
          candidates: [
            {
              item: { itemType: 'journalArticle', title: 'Cancelled before body completion' },
              source: { provider: 'test', rawMetadata: {} }
            }
          ]
        }
      }
    })
    let finish!: () => void
    let accepted!: () => void
    const bodyAccepted = new Promise<void>((resolve) => {
      accepted = resolve
    })
    const pending = new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        url,
        { method: 'POST', headers: { ...headers, expect: '100-continue' } },
        (response) => {
          response.resume()
          response.on('end', resolve)
        }
      )
      request.on('error', reject)
      request.on('continue', accepted)
      request.write(body.slice(0, -1))
      finish = () => request.end(body.slice(-1))
    })
    await bodyAccepted
    // This notification can complete while the earlier POST is waiting for its final byte.
    const cancelled = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 71 }
      })
    })
    expect(cancelled.status).toBe(202)
    finish()
    await pending
    expect(saveToInbox).not.toHaveBeenCalled()
    // The same ID is reusable after this POST closes; cancellation must not poison a future call.
    const repeated = await fetch(url, { method: 'POST', headers, body })
    expect(repeated.status).toBe(200)
    await repeated.json()
    expect(saveToInbox).toHaveBeenCalledOnce()
  })

  it('isolates concurrent Library request IDs by route and releases completed or cancelled entries', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const signals = new Map<string, AbortSignal | undefined>()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const saves = new Map<string, ReturnType<typeof vi.fn>>()
    for (const route of ['first', 'second']) {
      const save = vi.fn(async () => ({ results: [] }))
      saves.set(route, save)
      host.registerLiteratureLibrary(route, {
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(),
        readPdf: vi.fn(),
        saveToInbox: save,
        resolveSaveReferences: async (_refs, signal) => {
          signals.set(route, signal)
          await blocked
          return [
            {
              item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' }),
              source: { provider: 'test', rawMetadata: {} }
            }
          ]
        }
      })
    }
    const clients: Client[] = []
    const connect = async (route: string): Promise<Client> => {
      const client = new Client({ name: 'route-test', version: '1' })
      clients.push(client)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(host!.urlFor('library', route)), {
          requestInit: { headers: { authorization: `Bearer ${token}` } }
        })
      )
      return client
    }
    const request = { name: 'save_to_inbox', arguments: { refs: ['doi:10.1234/paper'] } }
    try {
      const first = await connect('first')
      const second = await connect('second')
      const firstResult = first.callTool(request).catch((error: unknown) => error)
      const secondResult = second.callTool(request)
      await vi.waitFor(() => expect(signals.size).toBe(2))
      const duplicate = await connect('first')
      await expect(duplicate.callTool(request)).rejects.toMatchObject({ code: 409 })
      await first.notification({ method: 'notifications/cancelled', params: { requestId: 1 } })
      await vi.waitFor(() => expect(signals.get('first')?.aborted).toBe(true))
      expect(signals.get('second')?.aborted).toBe(false)
      release()
      expect((await secondResult).isError).not.toBe(true)
      await first.close()
      await firstResult
      expect(saves.get('first')).not.toHaveBeenCalled()
      expect(saves.get('second')).toHaveBeenCalledOnce()
      // Fresh clients reuse request id 1. Neither completed nor cancelled POSTs may retain it.
      for (const route of ['first', 'second']) {
        const reopened = await connect(route)
        expect((await reopened.callTool(request)).isError).not.toBe(true)
      }
      expect(saves.get('first')).toHaveBeenCalledOnce()
      expect(saves.get('second')).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await Promise.all(clients.map((client) => client.close()))
    }
  })

  it('rejects requests without the bearer token', async () => {
    host = new AgentMcpHttpHost()
    const { endpoint } = await host.ensureStarted()

    const response = await fetch(`${endpoint}/mcp/artifact/whatever`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })

    expect(response.status).toBe(401)
  })

  it('rejects an authenticated request body above the host budget', async () => {
    host = new AgentMcpHttpHost({ requestBytes: 2 })
    const { endpoint, token } = await host.ensureStarted()
    host.registerHostMessage('bounded', { sendMessage: vi.fn() })

    const response = await fetch(`${endpoint}/mcp/host-message/bounded`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: '{} '
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
  })

  it('retains the host body budget above the SDK default for parsed requests', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    host.registerHostMessage('large', { sendMessage: vi.fn() })
    const response = await fetch(host.urlFor('host-message', 'large'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { padding: 'x'.repeat(4 * 1024 * 1024) }
      })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 1, result: {} })
  })

  it.each([100, 101])('enforces the SDK batch boundary for %i messages', async (count) => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const sendMessage = vi.fn()
    host.registerHostMessage('batch', { sendMessage })
    const response = await fetch(host.urlFor('host-message', 'batch'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(
        Array.from({ length: count }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' }))
      )
    })
    expect(response.status).toBe(count === 100 ? 200 : 400)
    const body = await response.json()
    if (count === 100) {
      expect(body).toHaveLength(100)
      expect(body).toEqual(
        expect.arrayContaining(
          Array.from({ length: count }, (_, id) => ({ jsonrpc: '2.0', id, result: {} }))
        )
      )
    } else {
      expect(body).toMatchObject({ error: { code: -32600 } })
    }
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('serves one trusted side-chat host-message handler over its bound route', async () => {
    host = new AgentMcpHttpHost()
    const { token } = await host.ensureStarted()
    const sendMessage = vi.fn().mockResolvedValue({
      status: 'queued',
      messageId: 'side-chat-message-1',
      targetState: 'idle',
      delivery: 'next-user-turn',
      persisted: true,
      systemHint: 'Wait for the next user turn.'
    })
    host.registerHostMessage('side-routing-1', { sendMessage })
    const client = new Client({ name: 'host-message-http-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.urlFor('host-message', 'side-routing-1')), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )

    const result = await client.callTool({
      name: 'send_message',
      arguments: { target: 'main', text: 'Use black.' }
    })

    expect(sendMessage).toHaveBeenCalledWith({ target: 'main', text: 'Use black.' })
    expect(result.structuredContent).toMatchObject({ messageId: 'side-chat-message-1' })
    await client.close()
  })
})

configureTestRuntimeMetadata()
