import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ParserEngine } from '../engine'
import { ZOTERO_TOOLS } from './zotero'

const library = { library_type: 'group', library_id: '12345' }
const response = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers }
  })
const fixture = (
  body: unknown,
  headers: Record<string, string> = {}
): {
  fetchImpl: Mock<typeof fetch>
  engine: ParserEngine
  call: (method: string, args: Record<string, unknown>) => Promise<unknown>
  url: () => URL
} => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body, headers))
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  const call = (method: string, args: Record<string, unknown>): Promise<unknown> => {
    const tool = ZOTERO_TOOLS.find((tool) => tool.id === method)!
    return engine.call(tool, args, {})
  }
  return { fetchImpl, engine, call, url: () => new URL(String(fetchImpl.mock.calls[0]![0])) }
}
afterEach(() => vi.useRealTimers())
const groupsTool = ZOTERO_TOOLS.find((tool) => tool.id === 'zotero_list_groups')!

describe('Zotero read-only library tools', () => {
  it('lists public groups anonymously using API version 3', async () => {
    const f = fixture([{ id: 1 }], { 'Total-Results': '2' })
    expect(await f.call('zotero_list_groups', { user_id: '123', limit: 1 })).toMatchObject({
      next_start: 1,
      total_results: 2,
      library_version: null
    })
    expect(f.url().pathname).toBe('/users/123/groups')
    const init = f.fetchImpl.mock.calls[0]![1]!
    expect(init.headers).toMatchObject({ 'Zotero-API-Version': '3' })
    expect(init.headers).not.toHaveProperty('Zotero-API-Key')
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(init.redirect).toBe('error')
    expect(init.method).toBeUndefined()
  })
  it.each(['user', 'group'])(
    'supports public %s libraries without credentials',
    async (library_type) => {
      const f = fixture([])
      await f.call('zotero_list_collections', { ...library, library_type })
      expect(f.url().pathname).toBe(
        `/${library_type === 'user' ? 'users' : 'groups'}/12345/collections/top`
      )
      expect(f.fetchImpl.mock.calls[0]![1]!.headers).not.toHaveProperty('Zotero-API-Key')
    }
  )
  it('lists immediate subcollections and preserves pagination metadata', async () => {
    const f = fixture([{ key: 'COLL2345' }], {
      'Total-Results': '26',
      'Last-Modified-Version': '12'
    })
    expect(
      await f.call('zotero_list_collections', { ...library, collection_key: 'PARN2345', start: 25 })
    ).toMatchObject({ next_start: null, start: 25, library_version: '12', records_returned: 1 })
    expect(f.url().pathname).toBe('/groups/12345/collections/PARN2345/collections')
  })
  it('encodes search syntax without changing the request target or adding parameters', async () => {
    const f = fixture([])
    await f.call('zotero_search_items', {
      ...library,
      collection_key: 'COLL2345',
      query: 'single cell &key=bad',
      tag: 'review || methods',
      item_type: 'journalArticle',
      direction: 'asc',
      sort: 'title'
    })
    expect(f.url().pathname).toBe('/groups/12345/collections/COLL2345/items/top')
    expect(f.url().searchParams.get('q')).toBe('single cell &key=bad')
    expect(f.url().searchParams.get('key')).toBeNull()
    expect(f.url().searchParams.get('tag')).toBe('review || methods')
    expect(f.url().searchParams.get('itemType')).toBe('journalArticle')
    expect(f.url().searchParams.get('qmode')).toBe('titleCreatorYear')
  })
  it('can search notes using all items rather than only top-level references', async () => {
    const f = fixture([])
    await f.call('zotero_search_items', { ...library, include_children: true, item_type: 'note' })
    expect(f.url().pathname).toBe('/groups/12345/items')
  })
  it('returns note HTML and attachment metadata as data without downloading links', async () => {
    const records = [
      { key: 'NOTE2345', data: { itemType: 'note', note: '<p>My note</p>' } },
      {
        key: 'FILE2345',
        data: { itemType: 'attachment', linkMode: 'linked_file', filename: 'paper.pdf' },
        links: { enclosure: { href: 'https://untrusted.test/file' } }
      }
    ]
    const f = fixture(records, { 'Total-Results': '2' })
    expect(
      await f.call('zotero_get_item_children', { ...library, item_key: 'ITEM2345' })
    ).toMatchObject({ records, next_start: null })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('reads an item with its full bibliographic data', async () => {
    const item = {
      key: 'ITEM2345',
      version: 5,
      data: { title: 'Paper', DOI: '10.1/example', abstractNote: 'Abstract', creators: [] }
    }
    const f = fixture(item)
    expect(await f.call('zotero_get_item', { ...library, item_key: 'ITEM2345' })).toEqual(item)
    expect(f.url().pathname).toBe('/groups/12345/items/ITEM2345')
  })
  it.each([null, {}, ['bad']])('rejects malformed item data %j', async (body) => {
    await expect(
      fixture(body).call('zotero_get_item', { ...library, item_key: 'ITEM2345' })
    ).rejects.toThrow('Invalid Zotero')
  })
  it('does not claim completeness when totals are absent on a full page', async () => {
    const f = fixture([{ key: 'ITEM2345' }])
    expect(await f.call('zotero_search_items', { ...library, limit: 1 })).toMatchObject({
      total_results: null,
      next_start: 1
    })
  })
  it('rejects an empty page that contradicts Total-Results', async () => {
    await expect(
      fixture([], { 'Total-Results': '1' }).call('zotero_search_items', library)
    ).rejects.toThrow('empty page')
  })
  it.each([401, 403, 404, 429, 503])(
    'surfaces HTTP %s with public-only guidance for denied access',
    async (status) => {
      const f = fixture([])
      f.fetchImpl.mockResolvedValue(new Response('upstream message', { status }))
      await expect(f.call('zotero_list_groups', { user_id: '123' })).rejects.toThrow(
        `HTTP ${status}`
      )
      const error = await f.call('zotero_list_groups', { user_id: '123' }).catch((e: Error) => e)
      expect(String(error)).not.toContain('Settings > Credentials')
      if (status === 401 || status === 403)
        expect(String(error)).toContain('public Zotero libraries only')
    }
  )
  it('does not follow redirects from the Zotero API', async () => {
    const f = fixture([])
    f.fetchImpl.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://evil.test' } })
    )
    await expect(f.call('zotero_list_groups', { user_id: '123' })).rejects.toThrow('HTTP 302')
    expect(f.fetchImpl.mock.calls[0]![1]!.redirect).toBe('error')
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('honors Backoff on successful responses across calls', async () => {
    vi.useFakeTimers()
    const f = fixture([], { Backoff: '2' })
    await f.call('zotero_list_groups', { user_id: '123' })
    f.fetchImpl.mockResolvedValue(response([]))
    const pending = f.call('zotero_list_groups', { user_id: '123' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([429, 503])(
    'retains Retry-After after HTTP %s exhausts the call budget',
    async (status) => {
      vi.useFakeTimers()
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('', { status, headers: { 'Retry-After': '180' } }))
      const engine = new ParserEngine({ fetchImpl })
      const args = { user_id: '123' }
      await expect(engine.call(groupsTool, args, {})).rejects.toThrow(`HTTP ${status}`)
      fetchImpl.mockResolvedValue(response([]))
      // A new call must not evade the upstream cooldown.
      await expect(engine.call(groupsTool, args, {})).rejects.toThrow('Retry after 180s')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(180_000)
      await expect(engine.call(groupsTool, args, {})).resolves.toMatchObject({ records: [] })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  it.each([1, 3])(
    'waits for the longer deadline with Backoff=%s and HTTP-date Retry-After',
    async (backoff) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const f = fixture([])
      f.fetchImpl.mockResolvedValue(
        new Response('', {
          status: 429,
          headers: { Backoff: String(backoff), 'Retry-After': 'Thu, 01 Jan 2026 00:00:02 GMT' }
        })
      )
      await expect(f.call('zotero_list_groups', { user_id: '123' })).rejects.toThrow('HTTP 429')
      f.fetchImpl.mockResolvedValue(response([]))
      const pending = f.call('zotero_list_groups', { user_id: '123' })
      await vi.advanceTimersByTimeAsync(Math.max(backoff, 2) * 1000 - 1)
      expect(f.fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['1e308', 'Infinity', '-1', '1.5', '9007199254740991'])(
    'does not retain malformed or overflowing throttle headers: %s',
    async (value) => {
      const f = fixture([])
      f.fetchImpl.mockResolvedValue(
        new Response('', {
          status: 503,
          headers: { Backoff: value, 'Retry-After': value }
        })
      )
      await expect(f.call('zotero_list_groups', { user_id: '123' })).rejects.toThrow('HTTP 503')
      f.fetchImpl.mockResolvedValue(response([]))
      await expect(f.call('zotero_list_groups', { user_id: '123' })).resolves.toMatchObject({
        records: []
      })
      expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  it('cancels a cooldown wait without clearing the deadline or issuing another request', async () => {
    vi.useFakeTimers()
    const f = fixture([], { Backoff: '2' })
    await f.call('zotero_list_groups', { user_id: '123' })
    f.fetchImpl.mockResolvedValue(response([]))
    const controller = new AbortController()
    const pending = f.engine.call(groupsTool, { user_id: '123' }, {}, controller.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled'))
    await rejected
    const next = f.call('zotero_list_groups', { user_id: '123' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await next
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not apply Zotero request policy to another descriptor or origin', async () => {
    const f = fixture([], { Backoff: '180' })
    await f.call('zotero_list_groups', { user_id: '123' })
    f.fetchImpl.mockImplementation(async () => response([]))
    for (const [connector, url] of [
      ['other', 'https://api.zotero.org/users/123/items'],
      ['zotero', 'https://api.zotero.org.evil.test/items'],
      ['zotero', 'http://api.zotero.org/users/123/items']
    ]) {
      await f.engine.call(
        {
          ...groupsTool,
          connector,
          required: [],
          run: (ctx) => ctx.fetchJson(url)
        },
        {},
        {}
      )
      const init = f.fetchImpl.mock.calls.at(-1)![1]!
      expect(init.headers).not.toHaveProperty('Zotero-API-Key')
      expect(init.headers).not.toHaveProperty('Zotero-API-Version')
      expect(init.redirect).toBeUndefined()
    }
    expect(f.fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('retains Retry-After when cancellation happens immediately after receiving headers', async () => {
    const controller = new AbortController()
    const f = fixture([])
    f.fetchImpl.mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled'))
      return new Response('', { status: 429, headers: { 'Retry-After': '180' } })
    })
    await expect(
      f.engine.call(groupsTool, { user_id: '123' }, {}, controller.signal)
    ).rejects.toThrow('cancelled')
    await expect(f.call('zotero_list_groups', { user_id: '123' })).rejects.toThrow('backoff')
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
})
