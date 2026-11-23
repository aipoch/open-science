import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { fetchInputSchema, webResultSchema } from '../../shared/web-tools'
import { HARNESS_INVOCATION } from '../harness-acp/tool-receipts'
import { WebService } from './service'
import { SearchService } from './search-service'
import { WebSessionSlots } from './limits'
import { WebSnapshotStore, webTextHash } from './snapshot-store'
import { extractWebResource } from './extraction'
import { createWebMcpServer } from './mcp-server'
import { WebToolError } from './errors'
import type { WebResource } from './transport'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const setup = async (
  body = 'Evidence from a public webpage.',
  contentType = 'text/plain'
): Promise<{
  root: string
  store: WebSnapshotStore
  service: WebService
  transport: Mock<(url: string) => Promise<WebResource>>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'web-fetch-test-'))
  roots.push(root)
  const store = new WebSnapshotStore(root)
  const transport = vi.fn(async (url: string) => ({
    body: Buffer.from(body),
    contentType,
    finalUrl: url
  }))
  return { root, store, transport, service: new WebService({ store, transport }) }
}
const signal = (): AbortSignal => new AbortController().signal

it('shares session admission across search and separate branch evidence owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-branch-admission-'))
  roots.push(root)
  const slots = new WebSessionSlots()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const search = vi.fn(async () => {
    await gate
    return { sources: [] }
  })
  const transport = vi.fn(async (url: string) => {
    await gate
    return { body: Buffer.from('Evidence'), contentType: 'text/plain', finalUrl: url }
  })
  const searches = new SearchService({ sessionSlots: slots, provider: { search } })
  const fetches = new WebService({
    sessionSlots: slots,
    store: new WebSnapshotStore(root),
    transport
  })
  const inFlight = [
    searches.search('session', { query: 'first' }),
    searches.search('session', { query: 'second' }),
    fetches.fetch('branch-one', { url: 'https://example.org/one' }, { sessionSlotKey: 'session' })
  ]
  try {
    await vi.waitFor(() => {
      expect(search).toHaveBeenCalledTimes(2)
      expect(transport).toHaveBeenCalledOnce()
    })
    const abort = new AbortController()
    const queued = fetches.fetch(
      'branch-two',
      { url: 'https://example.org/two' },
      {
        sessionSlotKey: 'session',
        signal: abort.signal
      }
    )
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transport).toHaveBeenCalledOnce()
    abort.abort()
    await rejected
  } finally {
    release()
    await Promise.all(inFlight)
  }
})

describe('web fetch input contract', () => {
  it.each([
    {},
    { url: 'https://example.org', cursor: 'x' },
    { url: 'https://example.org', headers: {} },
    { url: 'https://example.org', max_chars: 0 },
    { url: 'https://example.org', max_chars: 8001 },
    { url: 'x'.repeat(2049) },
    { snapshot_id: 'snapshot', cursor: 'x', refresh: false }
  ])('rejects %j', (value) => {
    expect(fetchInputSchema.safeParse(value).success).toBe(false)
  })
  it('accepts the continuation contract while rejecting malformed cursors', async () => {
    expect(fetchInputSchema.safeParse({ snapshot_id: 'snapshot', cursor: 'x' }).success).toBe(true)
    const { service, transport } = await setup()
    expect(await service.fetch('session', { snapshot_id: 'snapshot', cursor: 'x' })).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_CURSOR' }
    })
    expect(transport).not.toHaveBeenCalled()
  })
  it('refuses credential URLs without persisting the secret in the result', async () => {
    const { service, transport } = await setup()
    const result = await service.fetch('session', {
      url: 'https://example.org/?access_token=never-display-this'
    })
    expect(result.error?.code).toBe('BLOCKED_TARGET')
    expect(JSON.stringify(result)).not.toContain('never-display-this')
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('worker-bound extraction', () => {
  it('preserves headings, lists, tables and code while discarding executable and navigation content', async () => {
    const html =
      '<title>A scientific page</title><nav>Noise</nav><main><h1>Science</h1><p>Water &amp; ice.</p><ul><li>One</li><li>Two</li></ul><table><tr><th>Atom</th><th>Mass</th></tr><tr><td>H</td><td>1</td></tr></table><pre>print(1)\nprint(2)</pre><script>stealCredentials()</script><iframe src="https://tracking.example"></iframe><span hidden>Hidden</span></main>'
    const result = await extractWebResource(
      { body: Buffer.from(html), contentType: 'text/html', finalUrl: 'https://example.org/' },
      signal()
    )
    expect(result).toMatchObject({
      title: 'A scientific page',
      method: 'main_content',
      quality: 'normal'
    })
    expect(result.text).toContain('# Science')
    expect(result.text).toContain('Water & ice.')
    expect(result.text).toContain('- One')
    expect(result.text).toContain('| Atom | Mass |')
    expect(result.text).toContain('```\nprint(1)\nprint(2)\n```')
    expect(result.text).not.toMatch(/Noise|stealCredentials|tracking|Hidden/)
  })
  it('marks semantic fallback as degraded and preserves plain Markdown structure', async () => {
    const html = await extractWebResource(
      {
        body: Buffer.from('<div><p>Body evidence.</p></div>'),
        contentType: 'text/html',
        finalUrl: 'https://example.org/'
      },
      signal()
    )
    expect(html).toMatchObject({
      method: 'semantic_dom',
      quality: 'degraded',
      text: 'Body evidence.'
    })
    const markdown = '# Heading\n\n- First\n- Second\n\n```py\nx = 1\n```'
    expect(
      (
        await extractWebResource(
          {
            body: Buffer.from(markdown),
            contentType: 'text/markdown',
            finalUrl: 'https://example.org/'
          },
          signal()
        )
      ).text
    ).toBe(markdown)
  })
  it.each(['<script>no body</script>', '<div class="g-recaptcha">Check browser</div>'])(
    'rejects empty or challenge markup',
    async (html) => {
      await expect(
        extractWebResource(
          { body: Buffer.from(html), contentType: 'text/html', finalUrl: 'https://example.org/' },
          signal()
        )
      ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' })
    }
  )
  it.each([
    '<h1>Sign in</h1><form><input type="password"></form>',
    '<h1>Sign in</h1><p>Please sign in to continue reading.</p><form><input type="password"></form>'
  ])(
    'reports an identifiable short login wall without accepting it as page evidence',
    async (html) => {
      await expect(
        extractWebResource(
          {
            body: Buffer.from(html),
            contentType: 'text/html',
            finalUrl: 'https://example.org/'
          },
          signal()
        )
      ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    }
  )
  it.each([
    '<footer><form><div class="g-recaptcha">Check browser</div></form></footer>',
    '<div hidden><form><input type="password"></form><div class="cf-turnstile">Verify you are human</div></div>',
    '<div style="display:none"><form><input type="password"></form></div>',
    '<footer><form><input type="password"></form></footer>'
  ])(
    'keeps readable main evidence with unrelated or hidden login/challenge controls',
    async (widget) => {
      const result = await extractWebResource(
        {
          body: Buffer.from('<main><h1>Science</h1><p>Readable article.</p></main>' + widget),
          contentType: 'text/html',
          finalUrl: 'https://example.org/'
        },
        signal()
      )
      expect(result.text).toBe('# Science\n\nReadable article.')
    }
  )
})

describe('durable fetch evidence and bounded results', () => {
  it('durably writes immutable canonical text before returning a replayable result', async () => {
    const { root, service } = await setup('first line\nsecond line')
    const result = await service.fetch(
      'session',
      { url: 'https://example.org/' },
      { invocationId: 'invocation-1' }
    )
    expect(result).toMatchObject({
      status: 'ok',
      invocation_id: 'invocation-1',
      document: {
        text: 'first line\nsecond line',
        start_line: 1,
        end_line: 2,
        total_lines: 2,
        truncated: false
      }
    })
    const document = result.document!
    expect(document.sha256).toBe(webTextHash('first line\nsecond line'))
    const restartedStore = new WebSnapshotStore(root)
    expect((await restartedStore.read('session', document.snapshot_id)).text).toBe(document.text)
    await expect(
      restartedStore.read('different-session', document.snapshot_id)
    ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' })
    await expect(restartedStore.read('session', '../../escape')).rejects.toMatchObject({
      code: 'EVIDENCE_UNAVAILABLE'
    })
  })
  it('only reuses cache after receipt confirmation; refresh always creates a new snapshot', async () => {
    const { service, transport } = await setup()
    const first = await service.fetch('session', { url: 'https://example.org/' })
    const second = await service.fetch('session', { url: 'https://example.org/' })
    expect(second.cache?.hit).toBe(false)
    expect(second.document?.snapshot_id).not.toBe(first.document?.snapshot_id)
    await service.commitSnapshot('session', first.document!.snapshot_id)
    const cached = await service.fetch('session', { url: 'https://example.org/' })
    expect(cached).toMatchObject({
      cache: { hit: true },
      document: { snapshot_id: first.document!.snapshot_id, fetched_at: first.document!.fetched_at }
    })
    const refresh = await service.fetch('session', { url: 'https://example.org/', refresh: true })
    expect(refresh.cache?.hit).toBe(false)
    expect(refresh.document?.snapshot_id).not.toBe(first.document?.snapshot_id)
    await service.fetch('other-session', { url: 'https://example.org/' })
    expect(transport).toHaveBeenCalledTimes(4)
  })
  it('rejects corrupted persisted evidence without reaching the network', async () => {
    const { root, service, store } = await setup('original')
    const first = await service.fetch('session', { url: 'https://example.org/' })
    const path = join(root, webTextHash('session'), `${first.document!.snapshot_id}.json`)
    const snapshot = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...snapshot, text: 'tampered' }))
    await expect(store.read('session', first.document!.snapshot_id)).rejects.toMatchObject({
      code: 'EVIDENCE_UNAVAILABLE'
    })
  })
  it.each(['😀'.repeat(10000), '"\\\n'.repeat(10000), '汉'.repeat(10000)])(
    'fits escaped Unicode envelope budgets without breaking JSON or code points',
    async (body) => {
      const { service } = await setup(body)
      const result = await service.fetch('session', {
        url: 'https://example.org/',
        max_chars: 8000
      })
      const json = JSON.stringify(result)
      expect(json.length).toBeLessThanOrEqual(14000)
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(32 * 1024)
      expect(webResultSchema.safeParse(JSON.parse(json)).success).toBe(true)
      expect(result.document?.truncated).toBe(true)
      expect(result.document?.next_cursor).toEqual(expect.any(String))
      expect(result.document?.sha256).toBe(webTextHash(body.trimEnd()))
      expect(result.document?.text.isWellFormed()).toBe(true)
    }
  )
  it('returns explicit expected failures and never exposes upstream diagnostics', async () => {
    const { service, transport } = await setup()
    transport.mockRejectedValueOnce(new WebToolError('CONTENT_TOO_LARGE'))
    expect(await service.fetch('session', { url: 'https://example.org/' })).toMatchObject({
      status: 'error',
      error: { code: 'CONTENT_TOO_LARGE', retryable: false }
    })
    transport.mockRejectedValueOnce(new Error('password=secret-token upstream response'))
    const result = await service.fetch('session', { url: 'https://example.org/' })
    expect(result.error?.code).toBe('NETWORK_ERROR')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
  it('checks the current enabled setting before cache or transport', async () => {
    const { store, transport } = await setup()
    const isEnabled = vi.fn(async () => false)
    const service = new WebService({ store, transport, isEnabled })
    expect(await service.fetch('session', { url: 'https://example.org/' })).toMatchObject({
      status: 'error',
      error: { code: 'CAPABILITY_DISABLED', retryable: false }
    })
    expect(isEnabled).toHaveBeenCalledWith('fetch')
    expect(transport).not.toHaveBeenCalled()
  })
  it('does not publish success when snapshot durability fails', async () => {
    const { service, store } = await setup()
    vi.spyOn(store, 'write').mockRejectedValueOnce(new WebToolError('EVIDENCE_UNAVAILABLE'))
    const result = await service.fetch('session', { url: 'https://example.org/' })
    expect(result).toMatchObject({ status: 'error', error: { code: 'EVIDENCE_UNAVAILABLE' } })
    expect(result.document).toBeUndefined()
  })
  it('propagates caller cancellation and rejects late network results', async () => {
    const { service, transport, store } = await setup()
    let complete!: (value: Awaited<ReturnType<typeof transport>>) => void
    transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const write = vi.spyOn(store, 'write')
    const controller = new AbortController()
    const pending = service.fetch(
      'session',
      { url: 'https://example.org/' },
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    controller.abort(new Error('user cancelled'))
    complete({
      body: Buffer.from('late body'),
      contentType: 'text/plain',
      finalUrl: 'https://example.org/'
    })
    await expect(pending).rejects.toThrow('user cancelled')
    expect(write).not.toHaveBeenCalled()
  })
  it('bounds total fetch time and reports timeout separately from caller cancellation', async () => {
    const { store } = await setup()
    const service = new WebService({
      store,
      deadlineMs: 20,
      transport: async (_url, pendingSignal) => {
        await new Promise((_resolve, reject) =>
          pendingSignal.addEventListener('abort', () => reject(pendingSignal.reason), {
            once: true
          })
        )
        throw new Error('unreachable')
      }
    })
    expect(await service.fetch('session', { url: 'https://example.org/' })).toMatchObject({
      status: 'error',
      error: { code: 'TIMEOUT', retryable: true }
    })
  })
})

describe('web MCP projection', () => {
  it('passes cancellation and invocation identity and supplies exactly one structured envelope', async () => {
    const { service } = await setup()
    const fetchPage = vi.fn((input, context) => service.fetch('session', input, context))
    const server = createWebMcpServer({ fetchPage })
    const client = new Client({ name: 'web-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(b), client.connect(a)])
    try {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(['web_fetch'])
      const result = await client.callTool({
        name: 'web_fetch',
        arguments: { url: 'https://example.org/' },
        _meta: { [HARNESS_INVOCATION]: 'authoritative-invocation' }
      })
      expect(result.content).toEqual([])
      expect(result.structuredContent).toMatchObject({
        invocation_id: 'authoritative-invocation',
        status: 'ok'
      })
      expect(fetchPage.mock.calls[0][1]).toMatchObject({
        invocationId: 'authoritative-invocation',
        signal: expect.any(AbortSignal)
      })
      const failure = await client.callTool({
        name: 'web_fetch',
        arguments: { url: 'file:///tmp/private' }
      })
      expect(failure.isError).toBe(true)
      expect(failure.structuredContent).toMatchObject({ error: { code: 'BLOCKED_TARGET' } })
      const unknown = await client.callTool({
        name: 'web_fetch',
        arguments: { url: 'https://example.org/', headers: {} }
      })
      expect(unknown.isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
