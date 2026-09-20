import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { inspectReadRequest } from '../runtime/src/gateway/read-request.js'

const inspect = (
  rawHeaders: string[] = [],
  method = 'GET',
  url = '/',
  bytes = 30
): ReturnType<typeof inspectReadRequest> =>
  inspectReadRequest(
    {
      rawHeaders: ['Host', 'data.example', ...rawHeaders],
      method,
      url,
      httpVersion: '1.1'
    } as IncomingMessage,
    'data.example',
    bytes
  )

describe('automatic public read contract', () => {
  it.each(['GET', 'HEAD'])('accepts %s and rebuilds headers', (method) => {
    expect(inspect(['User-Agent', 'synthetic-marker', 'Content-Length', '0'], method)).toEqual({
      kind: 'read',
      headers: { host: 'data.example', 'user-agent': 'Open-Science/1.0' }
    })
  })
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT'])(
    'requires approval for %s',
    (method) => expect(inspect([], method).kind).toBe('approval')
  )
  it.each([
    'Cookie',
    'Authorization',
    'X-Api-Key',
    'X-Custom',
    'If-None-Match',
    'Transfer-Encoding',
    'Expect',
    'Upgrade',
    'Trailer'
  ])('requires approval for %s without deleting it', (name) =>
    expect(inspect([name, 'synthetic']).kind).toBe('approval')
  )
  it.each([
    ['Accept', 'text/html'],
    ['Content-Length', '1'],
    ['Range', 'bytes=9-1'],
    ['Accept-Encoding', 'gzip;q=1'],
    ['Connection', 'upgrade']
  ])('rejects unsupported %s', (name, value) =>
    expect(inspect([name, value]).kind).toBe('approval')
  )
  it('accepts fixed metadata and numeric range', () =>
    expect(
      inspect(['Accept', 'text/csv', 'Accept-Encoding', 'gzip, br', 'Range', 'bytes=0-99']).kind
    ).toBe('read'))
  it.each(['https://other.example/file', '/file#fragment', '/bad\x7f', '/bad\n'])(
    'rejects invalid target %s',
    (path) => expect(inspect([], 'GET', path).kind).toBe('invalid')
  )
  it('preserves double slash as origin path', () =>
    expect(inspect([], 'GET', '//other.example/file').kind).toBe('read'))
  it('rejects duplicate host and length', () => {
    expect(inspect(['host', 'data.example']).kind).toBe('invalid')
    expect(inspect(['Content-Length', '0', 'content-length', '0']).kind).toBe('invalid')
    expect(inspect(['Content-Length', '0', 'Transfer-Encoding', 'chunked']).kind).toBe('invalid')
  })
  it.each([8191, 8192, 8193])('target wire byte boundary %s', (size) =>
    expect(inspect([], 'GET', '/'.padEnd(size, 'a')).kind).toBe(size > 8192 ? 'limit' : 'read')
  )
  it.each([16383, 16384, 16385])('header wire byte boundary %s', (size) =>
    expect(inspect([], 'GET', '/', size).kind).toBe(size > 16384 ? 'limit' : 'read')
  )
})
