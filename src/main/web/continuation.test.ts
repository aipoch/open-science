import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryAgentStore,
  openAgentSession,
  type AgentModel,
  type AgentMessage
} from '@aipoch/agent-harness'
import type { WebResult } from '../../shared/web-tools'
import { webResultSchema } from '../../shared/web-tools'
import { WebService } from './service'
import { WebSnapshotStore, WEB_CACHE_TTL_MS, webTextHash } from './snapshot-store'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async (
  body: string
): Promise<{
  root: string
  store: WebSnapshotStore
  service: WebService
  calls: string[]
}> => {
  const root = await mkdtemp(join(tmpdir(), 'web-continuation-'))
  roots.push(root)
  const store = new WebSnapshotStore(root)
  const calls: string[] = []
  const service = new WebService({
    store,
    transport: async (url) => {
      calls.push(url)
      return { body: Buffer.from(body), contentType: 'text/plain', finalUrl: url }
    }
  })
  return { root, store, service, calls }
}
const request = { url: 'https://example.org/long' }

const fetchCommitted = async (
  service: WebService,
  input: { url: string; max_chars?: number } = request
): Promise<WebResult> => {
  const result = await service.fetch('session', input)
  await service.commitSnapshot('session', result.document!.snapshot_id)
  return result
}
const nextPage = ({ document }: WebResult): { snapshot_id: string; cursor: string } => ({
  snapshot_id: document!.snapshot_id,
  cursor: document!.next_cursor!
})

describe('immutable snapshot continuation', () => {
  it('keeps retained tool-result paging separate from unfetched snapshot text under a small model budget', async () => {
    const firstText = 'a'.repeat(3000) + 'RETAINED_FACT=42' + 'b'.repeat(2984)
    const unseen = 'UNRETURNED_FACT=99' + 'c'.repeat(100)
    const { service, calls } = await fixture(firstText + unseen)
    const store = createMemoryAgentStore()
    let modelCalls = 0,
      executions = 0,
      originalJson = '',
      originalInvocation = ''
    let originalResult: WebResult | undefined, originalView: AgentMessage['content'] | undefined
    const model: AgentModel = {
      id: 'small-web-context',
      capabilities: { tools: true, images: false, files: false },
      async *stream(request) {
        modelCalls++
        if (modelCalls === 1) {
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              {
                id: 'fetch',
                name: 'web_fetch',
                arguments: { url: 'https://example.org/long', max_chars: 6000 }
              }
            ]
          }
        } else if (modelCalls === 2) {
          const result = request.messages.find((message) => message.role === 'tool')!
          originalInvocation = result.invocationId!
          originalView = structuredClone(result.content)
          expect(JSON.stringify(result.content)).toContain('read_tool_result')
          expect(JSON.stringify(result.content)).not.toContain('RETAINED_FACT=42')
          expect(JSON.stringify(result.content)).not.toContain('UNRETURNED_FACT=99')
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              {
                id: 'read-retained',
                name: 'read_tool_result',
                arguments: {
                  invocationId: originalInvocation,
                  offset: originalJson.indexOf('RETAINED_FACT=42'),
                  limit: 64
                }
              }
            ]
          }
        } else if (modelCalls === 3) {
          expect(JSON.stringify(request.messages.at(-1)?.content)).toContain('RETAINED_FACT=42')
          expect(calls).toHaveLength(1)
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              {
                id: 'read-cursor',
                name: 'read_tool_result',
                arguments: {
                  invocationId: originalInvocation,
                  offset: originalJson.indexOf('"next_cursor"'),
                  limit: 512
                }
              }
            ]
          }
        } else if (modelCalls === 4) {
          const page = JSON.parse(
            (request.messages.at(-1)!.content[0] as { type: 'text'; text: string }).text
          ) as { text: string }
          const cursor = /"next_cursor":"([^"]+)"/.exec(page.text)?.[1]
          expect(cursor).toEqual(originalResult!.document!.next_cursor)
          yield {
            type: 'finish',
            reason: 'tools',
            content: [],
            calls: [
              {
                id: 'continue-snapshot',
                name: 'web_fetch',
                arguments: {
                  snapshot_id: originalResult!.document!.snapshot_id,
                  cursor: cursor!,
                  max_chars: 6000
                }
              }
            ]
          }
        } else {
          expect(modelCalls).toBe(5)
          expect(JSON.stringify(request.messages.at(-1)?.content)).toContain('UNRETURNED_FACT=99')
          expect(
            request.messages.find((message) => message.invocationId === originalInvocation)?.content
          ).toEqual(originalView)
          yield {
            type: 'finish',
            reason: 'complete',
            content: [{ type: 'text', text: 'Both facts come from https://example.org/long.' }]
          }
        }
      }
    }
    const session = await openAgentSession({
      sessionId: 'small-context',
      store,
      model,
      maxSteps: 8,
      maxOutputTokens: 100,
      compaction: {
        inputBudget: 20000,
        keepRecentItems: 1,
        maxOutputTokens: 100,
        measure: (request) => JSON.stringify(request).length
      },
      toolResults: { authorize: async () => true },
      tools: [
        {
          name: 'web_fetch',
          version: '1',
          description: 'Read immutable webpage evidence.',
          parameters: { type: 'object' },
          validate: (input) => input,
          authorize: async () => true,
          execute: async (input, context) => {
            executions++
            const result = await service.fetch('session', input, context)
            if (result.document)
              await service.commitSnapshot('session', result.document.snapshot_id)
            const json = JSON.stringify(result)
            if (!originalResult) {
              originalResult = result
              originalJson = json
            }
            return { content: [{ type: 'text', text: json }], isError: result.status === 'error' }
          }
        }
      ]
    })
    try {
      expect(
        await session.prompt([
          { type: 'text', text: 'Find the retained and not-yet-returned facts without refetching.' }
        ])
      ).toBe('complete')
      expect(modelCalls).toBe(5)
      expect(executions).toBe(2)
      expect(calls).toHaveLength(1)
      const checkpoint = await session.snapshot()
      const original = checkpoint.messages.find(
        (message) => message.invocationId === originalInvocation
      )!
      expect(original.content).toEqual([{ type: 'text', text: originalJson }])
      expect(original.modelContent).toEqual(originalView)
      expect(
        (
          await session.readToolResult(
            originalInvocation,
            originalJson.indexOf('RETAINED_FACT=42'),
            64
          )
        ).text
      ).toContain('RETAINED_FACT=42')
    } finally {
      await session.dispose()
    }
  })
  it.each([
    ['long single line', 'A'.repeat(24_001)],
    ['Unicode and escapes', '甲😀"\\\n乙🧪\t'.repeat(2000)]
  ])('reads %s without gaps, duplicates or broken code points', async (_name, body) => {
    const { store, service, calls } = await fixture(body)
    const expected = body.trim()
    let result = await service.fetch('session', { ...request, max_chars: 997 })
    expect(result.status).toBe('ok')
    const snapshotId = result.document!.snapshot_id
    await service.commitSnapshot('session', snapshotId)
    let combined = '',
      offset = 0,
      pages = 0
    while (true) {
      expect(webResultSchema.safeParse(result).success).toBe(true)
      const document = result.document!
      expect(document.sha256).toBe(webTextHash(expected))
      expect(document.text.isWellFormed()).toBe(true)
      expect([...document.text].length).toBeLessThanOrEqual(997)
      expect(document.start_line).toBe(1 + (combined.match(/\n/g)?.length ?? 0))
      combined += document.text
      pages++
      if (!document.next_cursor) {
        expect(document.truncated).toBe(false)
        break
      }
      const cursor = await store.parseCursor(snapshotId, document.next_cursor)
      expect(cursor.o).toBe(offset + [...document.text].length)
      expect(cursor.o).toBeGreaterThan(offset)
      offset = cursor.o
      result = await service.fetch('session', {
        snapshot_id: snapshotId,
        cursor: document.next_cursor,
        max_chars: 997
      })
      expect(pages).toBeLessThan(100)
    }
    expect(combined).toBe(expected)
    expect(calls).toHaveLength(1)
    expect(pages).toBeGreaterThan(10)
  })

  it('binds signed cursors to snapshot, version and offset and verifies current session ownership', async () => {
    const { store, service, calls } = await fixture('abcdefghij')
    const first = await service.fetch('session', { ...request, max_chars: 2 })
    const document = first.document!
    const continuation = { snapshot_id: document.snapshot_id, cursor: document.next_cursor! }
    expect((await service.fetch('session', continuation)).error?.code).toBe('INVALID_CURSOR')
    await service.commitSnapshot('session', document.snapshot_id)
    expect((await service.fetch('foreign-session', continuation)).error?.code).toBe(
      'INVALID_CURSOR'
    )
    const tampered =
      document.next_cursor!.slice(0, -1) + (document.next_cursor!.endsWith('A') ? 'B' : 'A')
    expect(
      (await service.fetch('session', { ...continuation, cursor: tampered })).error?.code
    ).toBe('INVALID_CURSOR')
    expect(
      (
        await service.fetch('session', {
          ...continuation,
          snapshot_id: '00000000-0000-4000-8000-000000000001'
        })
      ).error?.code
    ).toBe('INVALID_CURSOR')
    const snapshot = await store.read('session', document.snapshot_id)
    const beyond = await store.createCursor(snapshot, 11)
    expect((await service.fetch('session', { ...continuation, cursor: beyond })).error?.code).toBe(
      'INVALID_CURSOR'
    )
    const wrongVersion = await store.createCursor(
      { ...snapshot, extractorVersion: 'other-version' },
      2
    )
    expect(
      (await service.fetch('session', { ...continuation, cursor: wrongVersion })).error?.code
    ).toBe('INVALID_CURSOR')
    const wrongHash = await store.createCursor({ ...snapshot, sha256: '0'.repeat(64) }, 2)
    expect(
      (await service.fetch('session', { ...continuation, cursor: wrongHash })).error?.code
    ).toBe('INVALID_CURSOR')
    expect(calls).toHaveLength(1)
  })

  it('returns a valid empty EOF page with no next cursor', async () => {
    const { store, service } = await fixture('甲😀\n乙')
    const first = await fetchCommitted(service)
    const snapshot = await store.read('session', first.document!.snapshot_id)
    const cursor = await store.createCursor(snapshot, [...snapshot.text].length)
    const result = await service.fetch('session', { snapshot_id: snapshot.snapshotId, cursor })
    expect(result).toMatchObject({
      status: 'ok',
      document: { text: '', truncated: false, start_line: 2, end_line: 1, total_lines: 2 }
    })
    expect(result.document?.next_cursor).toBeUndefined()
  })
  it('advances across escaped JSON budget boundaries and permits one complete emoji per page', async () => {
    const body = '"\\'.repeat(16000)
    const { service, calls } = await fixture(body)
    let result = await service.fetch('session', { ...request, max_chars: 8000 })
    await service.commitSnapshot('session', result.document!.snapshot_id)
    let combined = '',
      pages = 0
    while (true) {
      const document = result.document!
      const json = JSON.stringify(result)
      expect(json.length).toBeLessThanOrEqual(14000)
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(32768)
      combined += document.text
      pages++
      if (!document.next_cursor) break
      result = await service.fetch('session', {
        snapshot_id: document.snapshot_id,
        cursor: document.next_cursor,
        max_chars: 8000
      })
      expect(pages).toBeLessThan(20)
    }
    expect(combined).toBe(body)
    expect(pages).toBeGreaterThan(4)
    expect(calls).toHaveLength(1)
    const emoji = await fixture('😀🧪甲')
    const first = await emoji.service.fetch('session', { ...request, max_chars: 1 })
    expect(first.document?.text).toBe('😀')
    await emoji.service.commitSnapshot('session', first.document!.snapshot_id)
    const second = await emoji.service.fetch('session', {
      snapshot_id: first.document!.snapshot_id,
      cursor: first.document!.next_cursor!,
      max_chars: 1
    })
    expect(second.document?.text).toBe('🧪')
  })

  it('returns an explicit error when metadata leaves no budget for one complete code point', async () => {
    const { store, service } = await fixture('😀text')
    const first = await service.fetch('session', request)
    const snapshot = await store.read('session', first.document!.snapshot_id)
    // Exercise escaping in bounded metadata independently of the production URL normalizer.
    const oversized = await store.write(
      'session',
      { ...snapshot, finalUrl: 'https://example.org/' + '\u0001'.repeat(2000) },
      new AbortController().signal
    )
    await service.commitSnapshot('session', oversized.snapshotId)
    const result = await service.fetch('session', { ...request, max_chars: 1 })
    expect(result).toMatchObject({ status: 'error', error: { code: 'CONTENT_TOO_LARGE' } })
    expect(webResultSchema.safeParse(result).success).toBe(true)
  })

  it('recovers continuation and short-lived URL cache after restart without a network request', async () => {
    const { root, service } = await fixture('first\nsecond\nthird')
    const first = await fetchCommitted(service, { ...request, max_chars: 5 })
    const transport = vi.fn(async () => {
      throw new Error('offline')
    })
    const restarted = new WebService({ store: new WebSnapshotStore(root), transport })
    const next = await restarted.fetch('session', nextPage(first))
    expect(next).toMatchObject({
      status: 'ok',
      document: { text: '\nsecond\nthird', fetched_at: first.document!.fetched_at }
    })
    const cached = await restarted.fetch('session', request)
    expect(cached).toMatchObject({
      status: 'ok',
      cache: { hit: true },
      document: { snapshot_id: first.document!.snapshot_id }
    })
    expect(transport).not.toHaveBeenCalled()
  })

  it('retains old cursor evidence across refresh and does not let an old continuation replace the newer cache', async () => {
    const { store, service, calls } = await fixture('immutable original body')
    const first = await fetchCommitted(service, { ...request, max_chars: 5 })
    // Make refresh unambiguously newer even on coarse-resolution clocks.
    const old = await store.read('session', first.document!.snapshot_id)
    const newer = await store.write(
      'session',
      {
        ...old,
        invocationId: 'refresh',
        fetchedAt: new Date(Date.parse(old.fetchedAt) + 1).toISOString(),
        text: 'new body'
      },
      new AbortController().signal
    )
    await service.commitSnapshot('session', newer.snapshotId)
    const continuation = await service.fetch('session', nextPage(first))
    expect(continuation.document?.text).toBe('able original body')
    await service.commitSnapshot('session', first.document!.snapshot_id)
    const cached = await service.fetch('session', request)
    expect(cached.document?.snapshot_id).toBe(newer.snapshotId)
    const refresh = await service.fetch('session', { ...request, refresh: true })
    expect(refresh.cache?.hit).toBe(false)
    expect(refresh.document?.snapshot_id).not.toBe(first.document!.snapshot_id)
    expect(calls).toHaveLength(2)
  })
  it('does not let an already committed continuation replace an equal-timestamp refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-16T08:00:00.000Z'))
    const { root, service, calls } = await fixture('equal timestamp immutable evidence')
    const first = await fetchCommitted(service, { ...request, max_chars: 5 })
    const refresh = await service.fetch('session', { ...request, refresh: true })
    expect(refresh.document!.fetched_at).toBe(first.document!.fetched_at)
    expect(refresh.document!.snapshot_id).not.toBe(first.document!.snapshot_id)
    await service.commitSnapshot('session', refresh.document!.snapshot_id)
    const continuation = await service.fetch('session', nextPage(first))
    expect(continuation.document?.text).toBe(' timestamp immutable evidence')
    await service.commitSnapshot('session', first.document!.snapshot_id)
    const restartedStore = new WebSnapshotStore(root)
    expect(
      (await restartedStore.findCached('session', request.url, refresh.document!.extractor_version))
        ?.snapshotId
    ).toBe(refresh.document!.snapshot_id)
    expect(calls).toHaveLength(2)
  })

  it('repairs cache publication interrupted before ownership confirmation using only the completed receipt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-16T08:00:00.000Z'))
    const { root, service, calls } = await fixture('equal-time refresh recovery')
    const first = await fetchCommitted(service)
    const refresh = await service.fetch('session', { ...request, refresh: true })
    const marker = join(
      root,
      webTextHash('session'),
      'committed',
      `${refresh.document!.snapshot_id}.json`
    )
    // The authorization callback runs after the commit-marker read and before publication.
    // Block only the marker write and verify that the earlier cache write fails closed.
    await expect(
      service.commitSnapshot('session', refresh.document!.snapshot_id, async () => {
        await mkdir(marker)
        return true
      })
    ).rejects.toThrow()
    await rm(marker, { recursive: true })
    const restartedStore = new WebSnapshotStore(root)
    await expect(
      restartedStore.findCached('session', request.url, refresh.document!.extractor_version)
    ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' })
    // Equivalent to the host's completed-receipt recovery hook; no service.fetch is repeated.
    await restartedStore.commit('session', refresh.document!.snapshot_id)
    expect(
      (await restartedStore.findCached('session', request.url, refresh.document!.extractor_version))
        ?.snapshotId
    ).toBe(refresh.document!.snapshot_id)
    await restartedStore.commit('session', first.document!.snapshot_id)
    expect(
      (await restartedStore.findCached('session', request.url, refresh.document!.extractor_version))
        ?.snapshotId
    ).toBe(refresh.document!.snapshot_id)
    expect(calls).toHaveLength(2)
  })

  it('expires URL cache after five minutes while continuation remains available', async () => {
    const { service, calls } = await fixture('long-lived immutable evidence')
    const first = await fetchCommitted(service, { ...request, max_chars: 3 })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.document!.fetched_at) + WEB_CACHE_TTL_MS)
    const second = await service.fetch('session', request)
    expect(second.cache?.hit).toBe(false)
    expect(second.document?.snapshot_id).not.toBe(first.document!.snapshot_id)
    const continuation = await service.fetch('session', nextPage(first))
    expect(continuation.status).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('returns unavailable for missing committed body/cache evidence without silently refetching', async () => {
    const { root, service, calls } = await fixture('missing body')
    const first = await fetchCommitted(service, { ...request, max_chars: 1 })
    await rm(join(root, webTextHash('session'), `${first.document!.snapshot_id}.json`))
    expect((await service.fetch('session', nextPage(first))).error?.code).toBe(
      'EVIDENCE_UNAVAILABLE'
    )
    expect((await service.fetch('session', request)).error?.code).toBe('EVIDENCE_UNAVAILABLE')
    expect(calls).toHaveLength(1)
  })

  it('checks capability state for cached reads and continuation', async () => {
    const { store, service } = await fixture('retained text')
    const first = await fetchCommitted(service, { ...request, max_chars: 1 })
    const disabled = new WebService({ store, isEnabled: async () => false })
    expect((await disabled.fetch('session', request)).error?.code).toBe('CAPABILITY_DISABLED')
    expect((await disabled.fetch('session', nextPage(first))).error?.code).toBe(
      'CAPABILITY_DISABLED'
    )
  })

  it('rejects cancellation during evidence loading and never returns a late success', async () => {
    const { store, service } = await fixture('retained text')
    const first = await fetchCommitted(service, { ...request, max_chars: 1 })
    const original = store.readCommitted.bind(store)
    const controller = new AbortController()
    vi.spyOn(store, 'readCommitted').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args)
      controller.abort(new Error('cancel evidence'))
      return snapshot
    })
    await expect(
      service.fetch('session', nextPage(first), { signal: controller.signal })
    ).rejects.toThrow('cancel evidence')
  })

  it('fails closed if the persistent signing key is corrupt', async () => {
    const { root, service } = await fixture('key-bound evidence')
    const first = await fetchCommitted(service, { ...request, max_chars: 1 })
    await writeFile(join(root, 'cursor-key'), 'corrupted')
    const restarted = new WebService({ store: new WebSnapshotStore(root) })
    expect((await restarted.fetch('session', nextPage(first))).error?.code).toBe(
      'EVIDENCE_UNAVAILABLE'
    )
    expect(await readFile(join(root, 'cursor-key'), 'utf8')).toBe('corrupted')
  })
})
