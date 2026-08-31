import { randomUUID } from 'node:crypto'
import { createServer, connect, type Socket } from 'node:net'
import { createServer as createHttpServer, request } from 'node:http'
import { createServer as createTlsServer } from 'node:tls'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandGateway } from '../runtime/src/gateway/command-gateway.js'

const closeTasks: Array<() => Promise<void>> = []
const credentials = { username: 'command-a', password: 'secret-a' }
const authorization = `Basic ${Buffer.from('command-a:secret-a').toString('base64')}`
const execFileAsync = promisify(execFile)
const openssl = ['/usr/bin/openssl', '/opt/homebrew/bin/openssl'].find(existsSync)

afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((close) => close()))
})

const listen = async (
  onConnection: (socket: Socket) => void
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer(onConnection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')
  const close = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()))
  closeTasks.push(close)
  return { port: address.port, close }
}

const readBytes = (socket: Socket, count: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const receive = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < count) return
      socket.removeListener('data', receive)
      const result = buffered.subarray(0, count)
      const remainder = buffered.subarray(count)
      if (remainder.length) socket.unshift(remainder)
      resolve(result)
    }
    socket.on('data', receive)
    socket.once('error', reject)
  })

const readHttpHeader = (socket: Socket): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const receive = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.removeListener('data', receive)
      const remainder = buffered.subarray(end + 4)
      if (remainder.length) socket.unshift(remainder)
      resolve(buffered.subarray(0, end + 4).toString('latin1'))
    }
    socket.on('data', receive)
    socket.once('error', reject)
  })

describe('Notebook command gateway', () => {
  it('routes concurrent commands by credentials through one shared port', async () => {
    const reservation = await listen(() => undefined)
    await reservation.close()
    const secondCredentials = { username: 'command-b', password: 'secret-b' }
    const first = await CommandGateway.open({
      decide: async () => ({ allowed: false, message: 'first policy' }),
      credentials,
      sharedPort: reservation.port
    })
    const second = await CommandGateway.open({
      decide: async () => ({ allowed: false, message: 'second policy' }),
      credentials: secondCredentials,
      sharedPort: reservation.port
    })
    closeTasks.push(
      () => first.close(),
      () => second.close()
    )

    const call = (username: string, password: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const requestCall = request(
          {
            host: '127.0.0.1',
            port: first.port,
            path: 'http://example.com/data',
            headers: {
              'proxy-authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
            }
          },
          (response) => {
            let body = ''
            response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
            response.on('end', () => resolve(body))
          }
        )
        requestCall.once('error', reject)
        requestCall.end()
      })

    expect(second.port).toBe(first.port)
    await expect(call(credentials.username, credentials.password)).resolves.toBe('first policy')
    await expect(call(secondCredentials.username, secondCredentials.password)).resolves.toBe(
      'second policy'
    )

    await first.close()
    await expect(call(credentials.username, credentials.password)).resolves.toBe(
      'Proxy authentication required.'
    )
    await expect(call(secondCredentials.username, secondCredentials.password)).resolves.toBe(
      'second policy'
    )
  })

  it('fails closed when the shared gateway port is already occupied', async () => {
    const occupied = await listen(() => undefined)

    await expect(
      CommandGateway.open({
        decide: async () => ({ allowed: false, message: 'unused' }),
        credentials,
        sharedPort: occupied.port
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('returns the policy denial body to HTTP clients', async () => {
    const gateway = await CommandGateway.open({
      decide: async () => ({ allowed: false, message: 'blocked by test policy' }),
      credentials
    })
    closeTasks.push(() => gateway.close())

    const result = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const call = request(
          {
            host: '127.0.0.1',
            port: gateway.port,
            path: 'http://example.com/data',
            headers: { 'proxy-authorization': authorization }
          },
          (response) => {
            let body = ''
            response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
            response.on('end', () => resolve({ status: response.statusCode, body }))
          }
        )
        call.once('error', reject)
        call.end()
      }
    )

    expect(result).toEqual({ status: 403, body: 'blocked by test policy' })
  })

  it('rejects missing or cross-command credentials before consulting policy', async () => {
    const decide = vi.fn(async () => ({ allowed: true as const, address: '127.0.0.1' }))
    const gateway = await CommandGateway.open({ decide, credentials })
    closeTasks.push(() => gateway.close())

    const statuses = await Promise.all(
      [undefined, `Basic ${Buffer.from('command-b:secret-b').toString('base64')}`].map(
        (header) =>
          new Promise<number | undefined>((resolve, reject) => {
            const call = request(
              {
                host: '127.0.0.1',
                port: gateway.port,
                path: 'http://example.com/data',
                ...(header ? { headers: { 'proxy-authorization': header } } : {})
              },
              (response) => {
                response.resume()
                response.on('end', () => resolve(response.statusCode))
              }
            )
            call.once('error', reject)
            call.end()
          })
      )
    )

    expect(statuses).toEqual([407, 407])
    expect(decide).not.toHaveBeenCalled()
  })

  it('brokers authenticated local RPC without consulting the external domain policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notebook-rpc-broker-'))
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\open-science-notebook-rpc-${process.pid}-${randomUUID()}`
        : join(directory, 'rpc.sock')
    const received: Array<{ url?: string; authorization?: string }> = []
    const rpc = createHttpServer((incoming, response) => {
      received.push({
        ...(incoming.url ? { url: incoming.url } : {}),
        ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {})
      })
      response.end('rpc-ok')
    })
    await new Promise<void>((resolve, reject) => {
      rpc.once('error', reject)
      rpc.listen(socketPath, resolve)
    })
    closeTasks.push(
      () => new Promise((resolve) => rpc.close(() => resolve())),
      () => rm(directory, { recursive: true, force: true })
    )
    const decide = vi.fn(async () => ({ allowed: false as const }))
    const gateway = await CommandGateway.open({
      decide,
      credentials,
      localRpcSocketPath: socketPath
    })
    closeTasks.push(() => gateway.close())

    const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const call = request(
        {
          host: '127.0.0.1',
          port: gateway.port,
          path: 'http://open-science-notebook-rpc.invalid/rpc?command=capabilities',
          headers: {
            authorization: 'Bearer rpc-token',
            'proxy-authorization': authorization
          }
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
          response.on('end', () => resolve({ status: response.statusCode, body }))
        }
      )
      call.once('error', reject)
      call.end()
    })

    expect(result).toEqual({ status: 200, body: 'rpc-ok' })
    expect(received).toEqual([
      { url: '/rpc?command=capabilities', authorization: 'Bearer rpc-token' }
    ])
    expect(decide).not.toHaveBeenCalled()
  })

  it('supports SOCKS5 hostname connections and resets active tunnels', async () => {
    const echo = await listen((socket) => socket.pipe(socket))
    const reservation = await listen(() => undefined)
    await reservation.close()
    const decisions: Array<{ host: string; port: number }> = []
    const gateway = await CommandGateway.open({
      decide: async (host, port) => {
        decisions.push({ host, port })
        return { allowed: true, address: '127.0.0.1' }
      },
      credentials,
      sharedPort: reservation.port
    })
    closeTasks.push(() => gateway.close())
    const socket = connect({ host: '127.0.0.1', port: gateway.port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    socket.write(Buffer.from([5, 1, 2]))
    await expect(readBytes(socket, 2)).resolves.toEqual(Buffer.from([5, 2]))
    const username = Buffer.from(credentials.username)
    const password = Buffer.from(credentials.password)
    socket.write(
      Buffer.concat([
        Buffer.from([1, username.length]),
        username,
        Buffer.from([password.length]),
        password
      ])
    )
    await expect(readBytes(socket, 2)).resolves.toEqual(Buffer.from([1, 0]))
    const host = Buffer.from('localhost')
    const port = Buffer.alloc(2)
    port.writeUInt16BE(echo.port)
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, port]))
    await expect(readBytes(socket, 10)).resolves.toEqual(
      Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    )
    socket.write('gateway-ok')
    await expect(readBytes(socket, 10)).resolves.toEqual(Buffer.from('gateway-ok'))

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    gateway.resetConnections()
    await closed

    expect(decisions).toEqual([{ host: 'localhost', port: echo.port }])
  })

  it('connects to the address approved by policy instead of resolving the hostname again', async () => {
    const origin = await listen((socket) => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\npinned')
      })
    })
    const gateway = await CommandGateway.open({
      decide: async () => ({ allowed: true, address: '127.0.0.1' }),
      credentials
    })
    closeTasks.push(() => gateway.close())

    const result = await new Promise<string>((resolve, reject) => {
      const call = request(
        {
          host: '127.0.0.1',
          port: gateway.port,
          path: `http://not-resolvable.invalid:${origin.port}/data`,
          headers: { 'proxy-authorization': authorization }
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
          response.on('end', () => resolve(body))
        }
      )
      call.once('error', reject)
      call.end()
    })

    expect(result).toBe('pinned')
  })

  it.each([
    ['socks5', 'socks5:', Buffer.from([5, 0])],
    ['socks4', 'socks4:', Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0])]
  ] as const)(
    'tunnels through a %s parent proxy using the policy-pinned address',
    async (kind, protocol, successResponse) => {
      let destination: { address: string; port: number } | undefined
      const parent = await listen((socket) => {
        void (async () => {
          if (kind === 'socks5') {
            await readBytes(socket, 3)
            socket.write(Buffer.from([5, 0]))
            const request = await readBytes(socket, 10)
            expect(request.subarray(0, 4)).toEqual(Buffer.from([5, 1, 0, 1]))
            const address = [...request.subarray(4, 8)].join('.')
            const port = request.readUInt16BE(8)
            destination = { address, port }
            socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          } else {
            const request = await readBytes(socket, 9)
            expect(request.subarray(0, 2)).toEqual(Buffer.from([4, 1]))
            destination = {
              address: [...request.subarray(4, 8)].join('.'),
              port: request.readUInt16BE(2)
            }
            socket.write(successResponse)
          }
          socket.pipe(socket)
        })()
      })
      const gateway = await CommandGateway.open({
        decide: async () => ({ allowed: true, address: '203.0.113.9' }),
        credentials,
        parentProxy: { https: `${protocol}//127.0.0.1:${parent.port}` }
      })
      closeTasks.push(() => gateway.close())
      const socket = connect({ host: '127.0.0.1', port: gateway.port })
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.write(
        `CONNECT packages.example.org:443 HTTP/1.1\r\nHost: packages.example.org:443\r\nProxy-Authorization: ${authorization}\r\n\r\n`
      )
      await expect(readHttpHeader(socket)).resolves.toContain('200 Connection Established')
      socket.write('tunneled')
      await expect(readBytes(socket, 8)).resolves.toEqual(Buffer.from('tunneled'))
      socket.destroy()

      expect(destination).toEqual({ address: '203.0.113.9', port: 443 })
    }
  )

  it.runIf(openssl)(
    'uses the configured CA bundle to authenticate a TLS-inspecting parent proxy',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'notebook-parent-proxy-ca-'))
      closeTasks.push(() => rm(directory, { recursive: true, force: true }))
      const keyPath = join(directory, 'proxy-key.pem')
      const certificatePath = join(directory, 'proxy-ca.pem')
      await execFileAsync(openssl!, [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certificatePath
      ])
      const [key, certificate] = await Promise.all([
        readFile(keyPath, 'utf8'),
        readFile(certificatePath, 'utf8')
      ])
      let parentRequest = ''
      const parent = createTlsServer({ key, cert: certificate }, (socket) => {
        socket.once('data', (chunk) => {
          parentRequest = chunk.toString('latin1')
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        })
      })
      await new Promise<void>((resolve, reject) => {
        parent.once('error', reject)
        parent.listen(0, '127.0.0.1', resolve)
      })
      const parentAddress = parent.address()
      if (!parentAddress || typeof parentAddress === 'string') {
        throw new Error('Expected a TLS parent proxy address.')
      }
      closeTasks.push(() => new Promise((resolve) => parent.close(() => resolve())))

      const gateway = await CommandGateway.open({
        decide: async () => ({ allowed: true, address: '203.0.113.1' }),
        credentials,
        parentProxy: {
          https: `https://127.0.0.1:${parentAddress.port}`,
          trustedCaCertificates: [certificate]
        }
      })
      closeTasks.push(() => gateway.close())
      const socket = connect({ host: '127.0.0.1', port: gateway.port })
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.write(
        `CONNECT packages.example.org:443 HTTP/1.1\r\nHost: packages.example.org:443\r\nProxy-Authorization: ${authorization}\r\n\r\n`
      )
      const response = await readBytes(socket, 'HTTP/1.1 200 Connection Established\r\n\r\n'.length)
      socket.destroy()

      expect(response.toString('latin1')).toBe('HTTP/1.1 200 Connection Established\r\n\r\n')
      expect(parentRequest).toContain('CONNECT 203.0.113.1:443 HTTP/1.1')
    }
  )
})
