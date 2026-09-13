import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createLiteratureMcpServer, type LiteratureMcpHandler } from './mcp-server'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const setup = async (): Promise<{
  client: Client
  elements: NonNullable<LiteratureMcpHandler['elements']>
}> => {
  const elements: NonNullable<LiteratureMcpHandler['elements']> = {
    list: vi.fn(async () => ({
      data: { document: { name: 'Trial.pdf' }, elements: [], nextCursor: null }
    })),
    read: vi.fn(async () => ({
      data: { caption: 'Figure 3. Treatment effects.', imageIncluded: true },
      image: { data: 'aW1hZ2U=', mimeType: 'image/png' }
    }))
  }
  const server = createLiteratureMcpServer({ readDocument: vi.fn(), elements })
  const client = new Client({ name: 'pdf-evidence-contract', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(right), client.connect(left)])
  cleanup.push(
    () => server.close(),
    () => client.close()
  )
  return { client, elements }
}

it('registers two minimal tools and injects business JSON once with a typed image block', async () => {
  const { client } = await setup()
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    'read_document',
    'list_pdf_elements',
    'read_pdf_element'
  ])
  const listing = await client.callTool({ name: 'list_pdf_elements', arguments: {} })
  expect(listing.structuredContent).toBeUndefined()
  expect(listing.content).toHaveLength(1)
  const result = await client.callTool({
    name: 'read_pdf_element',
    arguments: { elementRef: 'reference' }
  })
  expect(result).toMatchObject({
    content: [
      { type: 'text', text: '{"caption":"Figure 3. Treatment effects.","imageIncluded":true}' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
    ]
  })
  expect(result.structuredContent).toBeUndefined()
  expect(JSON.stringify(result.content).match(/Figure 3/g)).toHaveLength(1)
})

it.each([
  ['list_pdf_elements', { documentId: 'paper', cursor: 'cursor' }],
  ['list_pdf_elements', { query: 'figure' }],
  ['list_pdf_elements', { documentId: '' }],
  ['list_pdf_elements', { cursor: null }],
  ['read_pdf_element', {}],
  ['read_pdf_element', { elementRef: 'ref', includeImage: false }],
  ['read_pdf_element', { elementRef: 'ref', cursor: '' }]
])('rejects invalid %s arguments before dispatch', async (name, args) => {
  const { client, elements } = await setup()
  expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true })
  expect(elements.list).not.toHaveBeenCalled()
  expect(elements.read).not.toHaveBeenCalled()
})

it('returns actionable reference errors without leaking image bytes or duplicate content', async () => {
  const { client, elements } = await setup()
  vi.mocked(elements.read).mockRejectedValueOnce(
    new Error('PDF_STRUCTURE_REFERENCE_STALE: List again.')
  )
  expect(
    await client.callTool({ name: 'read_pdf_element', arguments: { elementRef: 'stale' } })
  ).toEqual({
    isError: true,
    content: [
      {
        type: 'text',
        text: '{"error":{"code":"PDF_STRUCTURE_REFERENCE_STALE","message":"List again."}}'
      }
    ]
  })
})

it('propagates MCP cancellation to the pending read', async () => {
  const { client, elements } = await setup()
  let started!: () => void
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  let captured: AbortSignal | undefined
  vi.mocked(elements.read).mockImplementationOnce(
    (_input, signal) =>
      new Promise((_resolve, reject) => {
        captured = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        started()
      })
  )
  const controller = new AbortController()
  const request = client.callTool(
    { name: 'read_pdf_element', arguments: { elementRef: 'ref' } },
    undefined,
    { signal: controller.signal }
  )
  const rejected = expect(request).rejects.toThrow()
  await pending
  controller.abort()
  await rejected
  await vi.waitFor(() => expect(captured?.aborted).toBe(true))
})
