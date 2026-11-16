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
  ['application/json', '{"error":{"message":"' + 'x'.repeat(20_000) + '"}}'],
  ['application/json', '{"error":{"message":"unfinished'],
  ['text/plain', 'x'.repeat(20_000)],
  ['text/plain', '  <!doctype html><html>gateway error</html>']
])('bounds and releases a real %s error response', async (contentType, body) => {
  const response = await upstream((reply) => {
    reply.writeHead(400, { 'content-type': contentType, 'x-request-id': 'bounded-request' })
    reply.end(body)
  })
  expect(await normalizeUpstreamError(response, new AbortController().signal)).toEqual({
    requestId: 'bounded-request',
    reason: 'provider_error'
  })
  expect(response.body?.locked).toBe(false)
})

it('does not wait indefinitely for an error body that never ends', async () => {
  const response = await upstream((reply) => {
    reply.writeHead(503, { 'content-type': 'application/json', 'request-id': 'stalled-request' })
    reply.write('{"error":')
  })
  expect(await normalizeUpstreamError(response, new AbortController().signal)).toEqual({
    requestId: 'stalled-request',
    reason: 'server_error'
  })
  expect(response.body?.locked).toBe(false)
}, 5000)

it.each([16_384, 16_385])('distinguishes EOF from overflow at %i bytes', async (size) => {
  const body = {
    error: { message: 'Model is unavailable; private account and token must not escape' },
    padding: ''
  }
  body.padding = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(body)))
  const response = await upstream((reply) => {
    reply.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'limit-request' })
    reply.end(JSON.stringify(body))
  })
  expect(await normalizeUpstreamError(response, new AbortController().signal)).toEqual({
    requestId: 'limit-request',
    reason: size === 16_384 ? 'model_not_found' : 'provider_error'
  })
  expect(response.body?.locked).toBe(false)
})

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
