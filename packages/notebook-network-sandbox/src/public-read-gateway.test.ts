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
  } = {}
): Promise<{
  open: (servername?: string | false) => Promise<TLSSocket>
  seen: Array<{ method: string; url: string; headers: unknown }>
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
  const seen: Array<{ method: string; url: string; headers: unknown }> = []
  const http = createHttpServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers })
    if (options.upgrade) {
      res.writeHead(101, { connection: 'upgrade', upgrade: 'websocket' })
      res.end()
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
    decide: async (_host, _port, purpose) => {
      if (purpose === 'block') blocked()
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
        headers: { host: 'data.example', 'user-agent': 'OpenScience/1.0', connection: 'close' }
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
