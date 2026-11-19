import 'reflect-metadata'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { X509CertificateGenerator, SubjectAlternativeNameExtension } from '@peculiar/x509'
import { afterEach, expect, it } from 'vitest'
import { createWebTransport } from './transport'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const listen = async (server: Server): Promise<number> => {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      })
  )
  return (server.address() as { port: number }).port
}
const lookup = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: '8.8.8.8', family: 4 }
]
// Fixture proxy maps the validated numeric public address to a test-owned local server. Production
// receives no local-target exemption; this exercises the actual CONNECT/socket/HTTP/TLS path.
const proxy = async (targetPort: number, observed: string[], status = 200): Promise<string> => {
  const server = createServer()
  server.on('connect', (request, client, head) => {
    observed.push(request.url!, JSON.stringify(request.headers))
    if (status !== 200) {
      client.end(`HTTP/1.1 ${status} Proxy failure\r\n\r\n`)
      return
    }
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  return `PROXY 127.0.0.1:${await listen(server)}`
}

it('CONNECTs only to the pinned IP, preserves HTTP Host, and revalidates a private redirect', async () => {
  const requests: Array<{ host?: string; authorization?: string; cookie?: string }> = []
  const origin = await listen(
    createServer((request, response) => {
      requests.push(request.headers)
      if (request.url === '/redirect')
        response.writeHead(302, { location: 'http://127.0.0.1/private' }).end()
      else response.writeHead(200, { 'content-type': 'text/plain' }).end('proxy public evidence')
    })
  )
  const tunnels: string[] = []
  const directive = await proxy(origin, tunnels)
  let resolutions = 0
  const transport = createWebTransport({
    lookup,
    resolveProxy: async () => {
      resolutions++
      return directive
    }
  })
  expect(
    (await transport('http://public.example/', AbortSignal.timeout(5000))).body.toString()
  ).toBe('proxy public evidence')
  expect(tunnels[0]).toBe('8.8.8.8:80')
  expect(tunnels[1]).not.toMatch(/proxy-authorization/i)
  expect(requests[0]).toMatchObject({ host: 'public.example' })
  expect(requests[0].authorization).toBeUndefined()
  expect(requests[0].cookie).toBeUndefined()
  await expect(
    transport('http://public.example/redirect', AbortSignal.timeout(5000))
  ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' })
  expect(tunnels.filter((_, index) => index % 2 === 0)).toEqual(['8.8.8.8:80', '8.8.8.8:80'])
  expect(resolutions).toBe(3)
})

it('rejects mixed private DNS before opening a proxy tunnel', async () => {
  const tunnels: string[] = []
  const directive = await proxy(1, tunnels)
  const transport = createWebTransport({
    resolveProxy: async () => directive,
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '198.18.0.1', family: 4 }
    ]
  })
  await expect(
    transport('https://public.example/', AbortSignal.timeout(5000))
  ).rejects.toMatchObject({ code: 'BLOCKED_TARGET' })
  expect(tunnels).toHaveLength(0)
})

it('reports proxy authentication without forwarding credentials or falling back to direct', async () => {
  const tunnels: string[] = []
  const directive = await proxy(1, tunnels, 407)
  const transport = createWebTransport({ lookup, resolveProxy: async () => directive })
  await expect(
    transport('http://public.example/', AbortSignal.timeout(5000))
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', retryable: false })
  expect(tunnels).toHaveLength(2)
  expect(tunnels[1]).not.toMatch(/authorization|cookie/i)
})

it.each([false, true])(
  'cancels a stalled proxy handshake (CONNECT established=%s)',
  async (established) => {
    let accepted!: () => void
    let closed!: () => void
    const connected = new Promise<void>((done) => {
      accepted = done
    })
    const disconnected = new Promise<void>((done) => {
      closed = done
    })
    const server = createServer()
    server.on('connect', (_request, socket) => {
      socket.once('end', () => {
        socket.end()
        closed()
      })
      socket.resume()
      if (established) {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        // Wait for ClientHello so cancellation actually exercises the TLS-handshake path.
        socket.once('data', accepted)
      } else accepted()
    })
    const port = await listen(server)
    const transport = createWebTransport({
      lookup,
      resolveProxy: async () => `PROXY 127.0.0.1:${port}`
    })
    const controller = new AbortController()
    const reading = transport('https://public.example/', controller.signal)
    const rejected = expect(reading).rejects.toThrow('cancelled')
    await connected
    controller.abort(new Error('cancelled'))
    await rejected
    await disconnected
  }
)

it('uses original HTTPS SNI and rejects untrusted or mismatched hostname and IP certificates through CONNECT', async () => {
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048
  }
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: 'CN=public.example',
      keys,
      signingAlgorithm: algorithm,
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 3600000),
      extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: 'public.example' }])]
    },
    webcrypto as unknown as Crypto
  )
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const key = `-----BEGIN PRIVATE KEY-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PRIVATE KEY-----`
  const names: Array<string | false | null> = []
  const hosts: string[] = []
  const origin = createHttpsServer(
    { key, cert: certificate.toString('pem') },
    (request, response) => {
      hosts.push(request.headers.host!)
      response.writeHead(200, { 'content-type': 'text/plain' }).end('TLS public evidence')
    }
  )
  origin.on('secureConnection', (socket) => names.push(socket.servername))
  const tunnels: string[] = []
  const directive = await proxy(await listen(origin), tunnels)
  const transport = createWebTransport({ lookup, resolveProxy: async () => directive })
  await expect(transport('https://public.example/', AbortSignal.timeout(5000))).rejects.toThrow()
  expect(hosts).toHaveLength(0)
  const directory = await mkdtemp(join(tmpdir(), 'web-proxy-tls-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ca = join(directory, 'ca.pem')
  const entry = join(directory, 'verify.cjs')
  await writeFile(ca, certificate.toString('pem'))
  await build({
    stdin: {
      contents: `import { createWebTransport } from './src/main/web/transport';
        const transport = createWebTransport({ lookup: async () => [{address:'8.8.8.8',family:4}], resolveProxy: async () => ${JSON.stringify(directive)} });
        (async () => {
          const result = await transport('https://public.example/', AbortSignal.timeout(5000));
          if (result.body.toString() !== 'TLS public evidence') throw Error('Wrong body');
          for (const url of ['https://wrong.example/', 'https://8.8.8.8/']) {
            try { await transport(url, AbortSignal.timeout(5000)); } catch(error) { if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') continue; throw error; }
            throw Error('Invalid hostname certificate accepted');
          }
        })().catch(error => { console.error(error); process.exitCode=1 })`,
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    packages: 'external',
    alias: {
      '@aipoch/notebook-network-sandbox': resolve('packages/notebook-network-sandbox/src/index.ts')
    }
  })
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, NODE_PATH: resolve('node_modules') }
    })
    let output = ''
    child.stderr.on('data', (data) => {
      output += String(data)
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(output || `Child exited ${code}`))
    )
  })
  expect(names).toContain('public.example')
  expect(hosts).toEqual(['public.example'])
  expect(tunnels.filter((_, index) => index % 2 === 0)).toEqual(Array(4).fill('8.8.8.8:443'))
}, 15000)
