import { createServer as createHttpServer } from 'node:http'
import { connect, type Server, type Socket } from 'node:net'
import {
  createServer as createTlsServer,
  connect as tlsConnect,
  checkServerIdentity,
  type TLSSocket
} from 'node:tls'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandGateway } from '../runtime/src/gateway/command-gateway.js'
import { createLocalCertificateAuthority } from '../runtime/src/gateway/local-ca.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})
const listen = async (server: Server): Promise<number> => {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  )
  return (server.address() as { port: number }).port
}
const setup = async (
  options: {
    origin?: 'wrong-host' | 'local-ca'
    upgrade?: boolean
    source?: 'unknown' | 'explicit'
    active?: boolean
    readBody?: boolean
    approve?: (canResume?: () => boolean) => Promise<boolean>
  } = {}
): Promise<{
  open: (servername?: string | false) => Promise<TLSSocket>
  seen: Array<{ method: string; url: string; headers: unknown; body?: string }>
  blocked: ReturnType<typeof vi.fn>
  gateway: CommandGateway
  authorities: string[]
}> => {
  const localCa = await createLocalCertificateAuthority()
  const originCa = await createLocalCertificateAuthority()
  cleanup.push(() => {
    localCa.dispose()
    originCa.dispose()
  })
  const originContext = await (options.origin === 'local-ca' ? localCa : originCa).getSecureContext(
    options.origin === 'wrong-host' ? 'other.example' : 'data.example'
  )
  const seen: Array<{ method: string; url: string; headers: unknown; body?: string }> = []
  const http = createHttpServer((req, res) => {
    const received: (typeof seen)[number] = {
      method: req.method!,
      url: req.url!,
      headers: req.headers
    }
    seen.push(received)
    if (options.upgrade) {
      res.writeHead(101, { connection: 'upgrade', upgrade: 'websocket' })
      res.end()
      return
    }
    if (options.readBody) {
      received.body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        received.body += chunk
      })
      req.on('end', () => res.end('fixture'))
      return
    }
    res.end('fixture')
  })
  const origin = createTlsServer(
    { SNICallback: (_host, callback) => callback(null, originContext) },
    (socket) => http.emit('connection', socket)
  )
  origin.on('tlsClientError', () => undefined)
  const originPort = await listen(origin)
  const authorities: string[] = []
  const proxy = createHttpServer()
  proxy.on('connect', (req, client, head) => {
    authorities.push(req.url!)
    const upstream = connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 OK\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
  })
  const proxyPort = await listen(proxy)
  const blocked = vi.fn()
  const gateway = await CommandGateway.open({
    credentials: { username: 'test', password: 'secret' },
    parentProxy: { https: `http://127.0.0.1:${proxyPort}` },
    decide: async (_host, _port, purpose, canResume) => {
      if (purpose === 'block') {
        blocked()
        if (options.approve)
          return { allowed: await options.approve(canResume), address: '93.184.216.34' }
      }
      return { allowed: false, source: options.source ?? 'unknown', address: '93.184.216.34' }
    },
    inspection: {
      certificate: (host) => localCa.getSecureContext(host),
      isExecutionActive: () => options.active ?? true,
      trustedCaCertificates: [originCa.certificatePem]
    }
  })
  cleanup.push(() => gateway.close())
  const open = async (servername: string | false = 'data.example'): Promise<TLSSocket> => {
    const socket = connect(gateway.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(
      `CONNECT data.example:443 HTTP/1.1\r\nHost: data.example:443\r\nProxy-Authorization: Basic ${Buffer.from('test:secret').toString('base64')}\r\n\r\n`
    )
    const [reply] = await once(socket, 'data')
    expect(reply.toString()).toContain('200 Connection Established')
    const tls = tlsConnect({
      socket,
      servername: servername || undefined,
      ca: localCa.certificatePem,
      rejectUnauthorized: true,
      ...(servername
        ? {}
        : { checkServerIdentity: (_host, cert) => checkServerIdentity('data.example', cert) })
    })
    tls.on('error', () => undefined)
    cleanup.push(() => {
      tls.destroy()
      socket.destroy()
    })
    await once(tls, 'secureConnect')
    return tls
  }
  return { open, seen, blocked, gateway, authorities }
}
const response = (socket: Socket): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let data = ''
    const onData = (chunk: Buffer): void => {
      data += chunk.toString()
      if (
        data.includes('fixture') ||
        data.includes('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED') ||
        data.includes('OPEN_SCIENCE_NETWORK_UPSTREAM_FAILED')
      ) {
        socket.off('data', onData)
        resolve(data)
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
describe('inspected CONNECT over real sockets (injected public address via local parent)', () => {
  it('reports client expiry while the command remains alive and never sends the approved stale body', async () => {
    const approval = Promise.withResolvers<boolean>()
    let canResume: (() => boolean) | undefined
    const { open, seen, blocked } = await setup({
      approve: (live) => {
        canResume = live
        return approval.promise
      }
    })
    const socket = await open()
    socket.write(
      'POST /synthetic HTTP/1.1\r\nHost: data.example\r\nContent-Length: 6\r\n\r\nmarker'
    )
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
    expect(canResume?.()).toBe(true)
    socket.destroy()
    await vi.waitFor(() => expect(canResume?.()).toBe(false))
    approval.resolve(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual([])
  })

  it('holds an authenticated POST until approval and forwards it on the same connection', async () => {
    const approval = Promise.withResolvers<boolean>()
    const { open, seen, blocked } = await setup({ approve: () => approval.promise })
    const socket = await open()
    const reply = response(socket)
    socket.write(
      'POST /synthetic HTTP/1.1\r\nHost: data.example\r\nAuthorization: Bearer fixture-only\r\nContent-Length: 6\r\n\r\nmarker'
    )
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
    expect(seen).toEqual([])
    approval.resolve(true)
    expect(await reply).toContain('fixture')
    expect(seen).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/synthetic',
        headers: expect.objectContaining({ authorization: 'Bearer fixture-only' })
      })
    ])
  })

  it.each([true, false])('holds 100-continue until the user decision (allow=%s)', async (allow) => {
    const approval = Promise.withResolvers<boolean>()
    const { open, seen, blocked, authorities } = await setup({
      approve: () => approval.promise,
      readBody: true
    })
    const socket = await open()
    let interim = ''
    let sentBody = false
    socket.on('data', (chunk: Buffer) => {
      interim += chunk.toString()
      if (!sentBody && interim.includes('100 Continue\r\n\r\n')) {
        sentBody = true
        socket.write('synthetic-upload')
      }
    })
    const reply = response(socket)
    socket.write(
      'POST /synthetic HTTP/1.1\r\nHost: data.example\r\nExpect: 100-continue\r\nContent-Length: 16\r\n\r\n'
    )
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
    expect(interim).toBe('')
    expect(authorities).toEqual([])
    expect(seen).toEqual([])
    approval.resolve(allow)
    const result = await reply
    if (allow) {
      expect(result).toContain('100 Continue')
      expect(result).toContain('fixture')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ method: 'POST', body: 'synthetic-upload' })
      // The gateway acknowledged this expectation; the origin receives an ordinary upload.
      expect(seen[0]!.headers).not.toHaveProperty('expect')
    } else {
      expect(result).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
      expect(result).not.toContain('100 Continue')
      expect(sentBody).toBe(false)
      expect(authorities).toEqual([])
      expect(seen).toEqual([])
    }
  })

  it('never forwards a pending approved request after the gateway has closed', async () => {
    const approval = Promise.withResolvers<boolean>()
    const { open, seen, blocked, gateway } = await setup({ approve: () => approval.promise })
    const socket = await open()
    socket.write('POST /synthetic HTTP/1.1\r\nHost: data.example\r\nContent-Length: 0\r\n\r\n')
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
    await gateway.close()
    approval.resolve(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual([])
  })

  it('GET then POST on the same TLS connection never sends POST upstream', async () => {
    const { open, seen, blocked, authorities } = await setup()
    const socket = await open()
    let reply = response(socket)
    socket.write(
      'GET /echo?synthetic=marker HTTP/1.1\r\nHost: data.example\r\nUser-Agent: test-marker\r\n\r\n'
    )
    expect(await reply).toContain('fixture')
    expect(seen).toEqual([
      {
        method: 'GET',
        url: '/echo?synthetic=marker',
        headers: { host: 'data.example', 'user-agent': 'Open-Science/1.0', connection: 'close' }
      }
    ])
    expect(blocked).not.toHaveBeenCalled()
    expect(authorities).toEqual(['93.184.216.34:443'])
    reply = response(socket)
    socket.write('POST /upload HTTP/1.1\r\nHost: data.example\r\nContent-Length: 6\r\n\r\nmarker')
    expect(await reply).toContain('DOMAIN_BLOCKED')
    expect(seen).toHaveLength(1)
    expect(blocked).toHaveBeenCalledOnce()
  })
  it.each(['Cookie: marker', 'Host: other.example', 'Content-Length: 0\r\nContent-Length: 0'])(
    'does not send forbidden/invalid metadata %s',
    async (field) => {
      const { open, seen } = await setup()
      const socket = await open()
      const done = once(socket, 'close')
      socket.write(`GET / HTTP/1.1\r\nHost: data.example\r\n${field}\r\n\r\n`)
      socket.resume()
      await done
      expect(seen).toHaveLength(0)
    }
  )
  it('resets inspected streams on policy generation change', async () => {
    const { open, seen, gateway } = await setup()
    const socket = await open()
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    gateway.resetConnections()
    await closed
    expect(seen).toHaveLength(0)
  })
  it('binds no-SNI clients to the CONNECT certificate and origin', async () => {
    const { open, seen } = await setup()
    const socket = await open(false)
    const reply = response(socket)
    socket.write('GET //other.example/file HTTP/1.1\r\nHost: data.example\r\n\r\n')
    await reply
    expect(seen[0]?.url).toBe('//other.example/file')
  })
  it('rejects mismatched SNI without approval', async () => {
    const { open, seen, blocked } = await setup()
    await expect(open('other.example')).rejects.toThrow()
    expect(seen).toHaveLength(0)
    expect(blocked).not.toHaveBeenCalled()
  })
  it('rejects pipelined reads before any upstream request', async () => {
    const { open, seen, blocked } = await setup()
    const socket = await open()
    const closed = once(socket, 'close')
    socket.write(
      'GET /one HTTP/1.1\r\nHost: data.example\r\n\r\nGET /two HTTP/1.1\r\nHost: data.example\r\n\r\n'
    )
    await closed
    expect(seen).toHaveLength(0)
    expect(blocked).not.toHaveBeenCalled()
  })
  it.each([16383, 16384, 16385])(
    'measures exact raw header bytes %s excluding request line',
    async (size) => {
      const { open, seen, blocked } = await setup()
      const socket = await open()
      const fixed = 'Host: data.example\r\nUser-Agent: ' + '\r\n\r\n'
      const header =
        'Host: data.example\r\nUser-Agent: ' +
        'x'.repeat(size - Buffer.byteLength(fixed)) +
        '\r\n\r\n'
      expect(Buffer.byteLength(header)).toBe(size)
      const done = size > 16384 ? once(socket, 'close') : response(socket)
      socket.write('GET / HTTP/1.1\r\n' + header)
      socket.resume()
      await done
      expect(seen).toHaveLength(size > 16384 ? 0 : 1)
      expect(blocked).not.toHaveBeenCalled()
    }
  )
  it('uses a new pinned upstream connection for every sequential read', async () => {
    const { open, authorities } = await setup()
    const socket = await open()
    for (const path of ['/one', '/two']) {
      const reply = response(socket)
      socket.write(`GET ${path} HTTP/1.1\r\nHost: data.example\r\n\r\n`)
      await reply
    }
    expect(authorities).toEqual(['93.184.216.34:443', '93.184.216.34:443'])
  })
})

const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve) => socket.once('close', () => resolve()))

describe('public read network contract and resource gates', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'never forwards a structurally valid %s without target approval',
    async (method) => {
      const { open, seen, blocked, authorities } = await setup()
      const socket = await open()
      const reply = response(socket)
      socket.write(
        `${method} /upload HTTP/1.1\r\nHost: data.example\r\nContent-Length: 6\r\n\r\nmarker`
      )
      expect(await reply).toContain('DOMAIN_BLOCKED')
      expect(blocked).toHaveBeenCalledOnce()
      expect(seen).toEqual([])
      expect(authorities).toEqual([])
    }
  )
  it.each([
    'Cookie: OS_EVAL_CREDENTIAL',
    'Authorization: Bearer OS_EVAL_CREDENTIAL',
    'X-Api-Key: OS_EVAL_CREDENTIAL',
    'X-Custom: OS_EVAL_CREDENTIAL',
    'If-None-Match: marker',
    'Accept: application/json, text/csv',
    'Content-Length: 6',
    'Transfer-Encoding: chunked',
    'Expect: 100-continue',
    'Trailer: X-Result',
    'Upgrade: websocket\r\nConnection: upgrade'
  ])('does not send request headers upstream for %s', async (field) => {
    const { open, seen, blocked, authorities } = await setup()
    const socket = await open()
    const done = closed(socket)
    socket.write(`GET / HTTP/1.1\r\nHost: data.example\r\n${field}\r\n\r\n`)
    socket.resume()
    await done
    expect(seen).toEqual([])
    expect(authorities).toEqual([])
    expect(blocked).toHaveBeenCalledOnce()
  })
  it.each(['wrong-host', 'local-ca'] as const)(
    'rejects %s upstream certificates before HTTP',
    async (origin) => {
      const { open, seen, blocked } = await setup({ origin })
      const socket = await open()
      const reply = response(socket)
      socket.write('GET / HTTP/1.1\r\nHost: data.example\r\n\r\n')
      expect(await reply).toContain('UPSTREAM_FAILED')
      expect(seen).toEqual([])
      expect(blocked).not.toHaveBeenCalled()
    }
  )
  it('does not expose an upstream 101 as a raw tunnel', async () => {
    const { open, seen, blocked } = await setup({ upgrade: true })
    const socket = await open()
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
    })
    const done = closed(socket)
    socket.write('GET / HTTP/1.1\r\nHost: data.example\r\n\r\n')
    await done
    expect(seen).toHaveLength(1)
    expect(received).not.toContain('101')
    expect(blocked).not.toHaveBeenCalled()
  })
  it('admits at most four inspection connections including idle handshakes', async () => {
    const { open, seen, blocked } = await setup()
    for (let index = 0; index < 4; index++) await open()
    await expect(open()).rejects.toThrow('200 Connection Established')
    expect(seen).toEqual([])
    expect(blocked).not.toHaveBeenCalled()
  })
  it('never starts inspection outside an execution window', async () => {
    const { open, seen, blocked } = await setup({ active: false })
    await expect(open()).rejects.toThrow('200 Connection Established')
    expect(seen).toEqual([])
    expect(blocked).not.toHaveBeenCalled()
  })
  it('does not use automatic reads for an explicit ask rule', async () => {
    const { open, seen, blocked } = await setup({ source: 'explicit' })
    await expect(open()).rejects.toThrow('200 Connection Established')
    expect(seen).toEqual([])
    expect(blocked).toHaveBeenCalledOnce()
  })
  it.each([8191, 8192, 8193])('counts actual request-target bytes at %s', async (size) => {
    const { open, seen, blocked } = await setup()
    const socket = await open()
    const done = size > 8192 ? closed(socket) : response(socket)
    socket.write(`GET ${'/'.padEnd(size, 'a')} HTTP/1.1\r\nHost: data.example\r\n\r\n`)
    socket.resume()
    await done
    expect(seen).toHaveLength(size > 8192 ? 0 : 1)
    expect(blocked).not.toHaveBeenCalled()
  })
})
