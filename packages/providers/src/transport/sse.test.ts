import { expect, it, vi } from 'vitest'
import { readSseRecords } from './sse'
import { DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES } from './body'

it('frames fragmented UTF-8, CRLF, comments and a final unterminated record without parsing payloads', async () => {
  const bytes = new TextEncoder().encode(': comment\r\ndata: 🙂\r\n\r\ndata: [DONE]')
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      }
    })
  )
  const actual = []
  for await (const record of readSseRecords(upstream, 1000)) actual.push(record)
  expect(actual).toEqual([': comment\r\ndata: 🙂', 'data: [DONE]'])
  expect(upstream.body?.locked).toBe(false)
})
it('bounds bytes observed in chunks and releases a reader after overflow', async () => {
  const cancel = vi.fn()
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: overflow\n\n'))
      },
      cancel
    })
  )
  await expect(async () => {
    for await (const _ of readSseRecords(upstream, 4)) {
      void _
    }
  }).rejects.toThrow('exceeded 4 bytes')
  expect(cancel).toHaveBeenCalledOnce()
  expect(upstream.body?.locked).toBe(false)
})
it('rejects oversized individual events even within the total byte budget', async () => {
  const size = DEFAULT_MAX_PROVIDER_SSE_EVENT_BYTES
  const upstream = new Response('data: ' + 'x'.repeat(size) + '\n\n')
  await expect(async () => {
    for await (const _ of readSseRecords(upstream, size * 2)) {
      void _
    }
  }).rejects.toThrow('Provider SSE event')
  expect(upstream.body?.locked).toBe(false)
})
it('releases the upstream when a consumer stops between framed records', async () => {
  const cancel = vi.fn()
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'))
      },
      cancel
    })
  )
  for await (const record of readSseRecords(upstream, 100)) {
    expect(record).toBe('data: one')
    break
  }
  expect(cancel).toHaveBeenCalledOnce()
  expect(upstream.body?.locked).toBe(false)
})
