import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { createMarkdownMcpServer } from './mcp-server'
import { markdownEditStore, MarkdownEditStore, MAX_MARKDOWN_BYTES } from './store'

it('exposes only handle-scoped read and stage operations on the mounted project', async () => {
  const client = new Client({ name: 'test', version: '1' })
  const server = createMarkdownMcpServer('a')
  const [left, right] = InMemoryTransport.createLinkedPair()
  const handle = markdownEditStore.open(1, 'a', '**selected**')
  const foreign = markdownEditStore.open(1, 'b', 'foreign')
  try {
    await server.connect(right)
    await client.connect(left)
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'propose_replacement',
      'read_selection'
    ])
    const read = (handle: string) =>
      client.callTool({ name: 'read_selection', arguments: { handle } })
    const propose = (handle: string, markdown: string) =>
      client.callTool({ name: 'propose_replacement', arguments: { handle, markdown } })
    expect((await read(handle)).content).toEqual([
      { type: 'text', text: JSON.stringify({ markdown: '**selected**' }) }
    ])
    expect((await read(foreign)).isError).toBe(true)
    expect((await propose(foreign, 'no')).isError).toBe(true)
    expect(markdownEditStore.take(1, foreign)).toBeNull()
    expect((await propose(handle, '')).isError).not.toBe(true)
    expect(markdownEditStore.take(1, handle)).toBe('')
    expect(markdownEditStore.read('a', handle)).toBe('**selected**')
    markdownEditStore.close(1, handle)
    expect((await read(handle)).isError).toBe(true)
    expect((await propose(handle, 'late')).isError).toBe(true)
  } finally {
    markdownEditStore.close(1, handle)
    markdownEditStore.close(1, foreign)
    await client.close()
    await server.close()
  }
})

it('notifies only the owner and consumes the latest pending proposal exactly once', () => {
  const store = new MarkdownEditStore()
  const handle = store.open(1, 'project', 'original')
  const ready = vi.fn(),
    foreign = vi.fn(),
    late = vi.fn()
  store.onReady(2, handle, foreign)
  const unsubscribe = store.onReady(1, handle, ready)
  store.close(2, handle)
  store.propose('project', handle, 'first')
  unsubscribe()
  store.onReady(1, handle, late)
  store.propose('project', handle, 'second')
  expect(foreign).not.toHaveBeenCalled()
  expect(ready).toHaveBeenCalledTimes(1)
  expect(late).toHaveBeenCalledTimes(2)
  expect(store.take(2, handle)).toBeNull()
  expect(store.take(1, handle)).toBe('second')
  expect(store.take(1, handle)).toBeNull()
  store.close(1, handle)
})

it('bounds UTF-8 input size and expires pending replacements and read access', () => {
  vi.useFakeTimers()
  try {
    const store = new MarkdownEditStore()
    const oversized = 'é'.repeat(MAX_MARKDOWN_BYTES / 2 + 1)
    expect(() => store.open(1, 'a', oversized)).toThrow()
    const handle = store.open(1, 'a', 'text')
    store.propose('a', handle, 'valid')
    expect(() => store.propose('a', handle, oversized)).toThrow()
    vi.advanceTimersByTime(15 * 60_000)
    expect(store.take(1, handle)).toBeNull()
    expect(() => store.read('a', handle)).toThrow()
  } finally {
    vi.useRealTimers()
  }
})
