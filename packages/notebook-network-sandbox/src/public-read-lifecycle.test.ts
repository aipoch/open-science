import { connect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CommandGateway,
  type CommandGatewayOptions
} from '../runtime/src/gateway/command-gateway.js'
import {
  createLocalCertificateAuthority,
  type LocalCertificateAuthority
} from '../runtime/src/gateway/local-ca.js'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})
const auth = Buffer.from('test:secret').toString('base64')
const fixture = async (
  override: Partial<CommandGatewayOptions> = {}
): Promise<{
  ca: LocalCertificateAuthority
  gateway: CommandGateway
  blocked: ReturnType<typeof vi.fn>
  connectClient: () => Promise<Socket>
  connectHead: (socket: Socket, target?: string) => boolean
}> => {
  const ca = await createLocalCertificateAuthority()
  cleanup.push(() => ca.dispose())
  const blocked = vi.fn()
  const gateway = await CommandGateway.open({
    credentials: { username: 'test', password: 'secret' },
    decide: async (_h, _p, purpose) => {
      if (purpose === 'block') blocked()
      return { allowed: false, source: 'unknown', address: '93.184.216.34' }
    },
    inspection: { certificate: (host) => ca.getSecureContext(host), isExecutionActive: () => true },
    ...override
  })
  cleanup.push(() => gateway.close())
  const connectClient = async (): Promise<Socket> => {
    const socket = connect(gateway.port, '127.0.0.1')
    socket.on('error', () => undefined)
    cleanup.push(() => {
      socket.destroy()
    })
    await once(socket, 'connect')
    return socket
  }
  const connectHead = (socket: Socket, target = 'data.example:443'): boolean =>
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: data.example:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`
    )
  return { ca, gateway, blocked, connectClient, connectHead }
}
it('records real curl SPKI pin rejection after successful local TLS, without sending HTTP', async () => {
  const { ca, gateway, blocked } = await fixture()
  const directory = await mkdtemp(join(tmpdir(), 'read-pin-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'ca.pem')
  await writeFile(path, ca.certificatePem)
  let failure: unknown
  try {
    await promisify(execFile)(
      'curl',
      [
        '--silent',
        '--show-error',
        '--max-time',
        '5',
        '--noproxy',
        '',
        '--proxy',
        `http://test:secret@127.0.0.1:${gateway.port}`,
        '--cacert',
        path,
        '--pinnedpubkey',
        'sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'https://data.example/file'
      ],
      { env: { ...process.env, ALL_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '' } }
    )
  } catch (error) {
    failure = error
  }
  expect((failure as { code: number }).code).toBe(90)
  await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
})
it('cannot revive a certificate signing result after reset', async () => {
  const ca = await createLocalCertificateAuthority()
  cleanup.push(() => ca.dispose())
  let release!: () => void
  const pending = new Promise<void>((resolve) => (release = resolve))
  const requested = vi.fn()
  const { gateway, connectClient, connectHead, blocked } = await fixture({
    inspection: {
      certificate: async (host) => {
        requested()
        await pending
        return ca.getSecureContext(host)
      },
      isExecutionActive: () => true
    }
  })
  const socket = await connectClient()
  connectHead(socket)
  await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce())
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  gateway.resetConnections()
  release()
  await closed
  expect(blocked).not.toHaveBeenCalled()
})
it('cannot use a DNS probe completed after reset', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => (release = resolve))
  let probes = 0
  const ca = await createLocalCertificateAuthority()
  cleanup.push(() => ca.dispose())
  const { gateway, connectClient, connectHead } = await fixture({
    decide: async () => {
      probes++
      if (probes === 2) await pending
      return { allowed: false, source: 'unknown', address: '93.184.216.34' }
    },
    inspection: { certificate: (host) => ca.getSecureContext(host), isExecutionActive: () => true }
  })
  const raw = await connectClient()
  connectHead(raw)
  await once(raw, 'data')
  const tls = tlsConnect({ socket: raw, servername: 'data.example', ca: ca.certificatePem })
  tls.on('error', () => undefined)
  cleanup.push(() => {
    tls.destroy()
  })
  await once(tls, 'secureConnect')
  tls.write('GET / HTTP/1.1\r\nHost: data.example\r\n\r\n')
  await vi.waitFor(() => expect(probes).toBe(2))
  const closed = new Promise<void>((resolve) => tls.once('close', () => resolve()))
  gateway.resetConnections()
  release()
  await closed
  expect(probes).toBe(2)
})
it.each([
  'user@data.example:443',
  'data.example:443/path',
  'data.example:443?x',
  'data.example:443#fragment'
])('rejects malformed CONNECT authority %s before policy', async (target) => {
  const decide = vi.fn(async () => ({
    allowed: false as const,
    source: 'unknown' as const,
    address: '93.184.216.34'
  }))
  const { connectClient, connectHead } = await fixture({ decide })
  const socket = await connectClient()
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.resume()
  connectHead(socket, target)
  await closed
  expect(decide).not.toHaveBeenCalled()
})

it.each(['handshake', 'headers'] as const)(
  'expires the exact 10-second %s budget without approval',
  async (phase) => {
    const { ca, blocked, connectClient, connectHead } = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const socket = await connectClient()
      connectHead(socket)
      await once(socket, 'data')
      let observed: Socket = socket
      if (phase === 'headers') {
        const tls = tlsConnect({ socket, servername: 'data.example', ca: ca.certificatePem })
        tls.on('error', () => undefined)
        cleanup.push(() => {
          tls.destroy()
        })
        await once(tls, 'secureConnect')
        tls.write('GET ')
        observed = tls
        // Let the real TLS server receive Finished and start its header deadline.
        await new Promise<void>((resolve) => setImmediate(resolve))
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const closed = new Promise<void>((resolve) => observed.once('close', () => resolve()))
      await vi.advanceTimersByTimeAsync(9999)
      expect(observed.destroyed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await closed
      expect(blocked).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  }
)

it('keeps h2-only TLS incompatibility on the approval recovery path', async () => {
  const { ca, blocked, connectClient, connectHead } = await fixture()
  const socket = await connectClient()
  connectHead(socket)
  await once(socket, 'data')
  const tls = tlsConnect({
    socket,
    servername: 'data.example',
    ca: ca.certificatePem,
    ALPNProtocols: ['h2']
  })
  tls.on('error', () => undefined)
  cleanup.push(() => {
    tls.destroy()
  })
  await new Promise<void>((resolve) => {
    tls.once('secureConnect', () => {
      expect(tls.alpnProtocol).not.toBe('h2')
      tls.destroy()
      resolve()
    })
    tls.once('error', () => resolve())
  })
  await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
})

it.each([80, 8443])('preserves explicit CONNECT port %s and never inspects it', async (port) => {
  const decide = vi.fn(async () => ({
    allowed: false as const,
    source: 'unknown' as const,
    address: '93.184.216.34'
  }))
  const { connectClient, connectHead } = await fixture({ decide })
  const socket = await connectClient()
  const done = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.resume()
  connectHead(socket, `data.example:${port}`)
  await done
  expect(decide).toHaveBeenCalledWith('data.example', port, 'probe')
  expect(decide).toHaveBeenCalledWith('data.example', port, 'block')
})
