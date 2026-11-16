import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { normalizeUpstreamError } from './normalize-upstream-error'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function upstream(write: (response: ServerResponse) => void): Promise<Response> {
  const server = createServer((_request, response) => write(response))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
}

it.each([
  ['application/json', '{"error":{"message":"' + 'x'.repeat(20_000) + '"}}', undefined],
  ['application/json', '{"error":{"message":"unfinished', undefined],
  ['text/plain', 'x'.repeat(20_000), 'x'.repeat(299) + '…'],
  ['text/plain', '  <!doctype html><html>gateway error</html>', undefined]
])('bounds and releases a real %s error response', async (contentType, body, safeMessage) => {
  const response = await upstream((reply) => {
    reply.writeHead(400, { 'content-type': contentType, 'x-request-id': 'bounded-request' })
    reply.end(body)
  })
  expect(await normalizeUpstreamError(response, new AbortController().signal)).toEqual({
    requestId: 'bounded-request',
    ...(safeMessage ? { safeMessage } : {})
  })
  expect(response.body?.locked).toBe(false)
})

it('does not wait indefinitely for an error body that never ends', async () => {
  const response = await upstream((reply) => {
    reply.writeHead(503, { 'content-type': 'application/json', 'request-id': 'stalled-request' })
    reply.write('{"error":')
  })
  expect(await normalizeUpstreamError(response, new AbortController().signal)).toEqual({
    requestId: 'stalled-request'
  })
  expect(response.body?.locked).toBe(false)
}, 5000)

it('keeps user cancellation distinct from an HTTP failure while releasing the body', async () => {
  const response = await upstream((reply) => {
    reply.writeHead(400, { 'content-type': 'application/json' })
    reply.write('{"error":')
  })
  const controller = new AbortController()
  const pending = normalizeUpstreamError(response, controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(response.body?.locked).toBe(false)
})
