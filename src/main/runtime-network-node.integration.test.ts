import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import 'reflect-metadata'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import { webcrypto } from 'node:crypto'
import { X509CertificateGenerator, SubjectAlternativeNameExtension } from '@peculiar/x509'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeRuntimeNetwork } from './runtime-network-node'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )
  return (server.address() as { port: number }).port
}
const network = (environment = {}): ReturnType<typeof createNodeRuntimeNetwork> => {
  const transport = createNodeRuntimeNetwork(environment)
  cleanup.push(() => transport.close())
  return transport
}

describe('ordinary Node HTTP transport', () => {
  it('preserves manual redirects and cancellation', async () => {
    const port = await listen(
      createServer((request, response) => {
        if (request.url === '/redirect') {
          response.writeHead(302, { location: '/target' })
          response.end()
          return
        }
        if (request.url === '/wait') return
        response.end('target')
      })
    )
    const transport = network()
    const url = `http://127.0.0.1:${port}`
    const manual = await transport.fetchWithManualRedirect(`${url}/redirect`, {
      redirect: 'manual'
    })
    expect(manual.status).toBe(302)
    expect(manual.headers.get('location')).toBe('/target')
    expect(await (await transport.fetch(`${url}/redirect`)).text()).toBe('target')
    await expect(
      transport.fetch(`${url}/wait`, { signal: AbortSignal.timeout(20) })
    ).rejects.toThrow()
  })
  it('strips origin authentication on a redirect to another origin', async () => {
    let authorization: string | undefined
    const target = await listen(
      createServer((request, response) => {
        authorization = request.headers.authorization
        response.end('redirected')
      })
    )
    const source = await listen(
      createServer((_request, response) => {
        response.writeHead(302, { location: `http://127.0.0.1:${target}/` }).end()
      })
    )
    expect(
      await (
        await network().fetch(`http://127.0.0.1:${source}/`, {
          headers: { authorization: 'Bearer fixture' }
        })
      ).text()
    ).toBe('redirected')
    expect(authorization).toBeUndefined()
  })
  it('authenticates CONNECT only to the proxy, switches modes, and bypasses selected hosts', async () => {
    const received: Array<string | undefined> = []
    const origin = await listen(
      createServer((request, response) => {
        received.push(request.headers['proxy-authorization'])
        response.end('ok')
      })
    )
    let tunnels = 0
    const proxy = createServer()
    const sockets = new Set<import('node:stream').Duplex>()
    proxy.on('connect', (request, client, head) => {
      tunnels++
      expect(request.headers['proxy-authorization']).toBe(
        `Basic ${Buffer.from('user:password').toString('base64')}`
      )
      const upstream = connect(origin, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
      sockets.add(upstream)
      sockets.add(client)
      client.on('close', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
    })
    const port = await listen(proxy)
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy()
    })
    const transport = network({ HTTP_PROXY: `http://user:password@127.0.0.1:${port}` })
    const url = `http://127.0.0.1:${origin}`
    expect(await (await transport.fetch(url)).text()).toBe('ok')
    expect(tunnels).toBe(1)
    expect(received).toEqual([undefined])
    await transport.setProxy({ mode: 'direct' })
    expect(await (await transport.fetch(url)).text()).toBe('ok')
    expect(tunnels).toBe(1)
    await transport.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http://user:password@127.0.0.1:${port}`,
      proxyBypassRules: '127.0.0.1'
    })
    expect(await (await transport.fetch(url)).text()).toBe('ok')
    expect(tunnels).toBe(1)
  })
  it('does not silently bypass a rejected proxy or unsupported PAC configuration', async () => {
    const proxy = createServer()
    proxy.on('connect', (_request, socket) =>
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
    )
    const port = await listen(proxy)
    const transport = network({ HTTPS_PROXY: `http://127.0.0.1:${port}` })
    await expect(transport.fetch('https://example.invalid')).rejects.toThrow()
    await expect(
      transport.setProxy({ mode: 'pac_script', pacScript: 'https://example.invalid/proxy.pac' })
    ).rejects.toThrow('PAC')
  })
  it('rejects an untrusted TLS certificate instead of disabling certificate verification', async () => {
    const algorithm = {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      publicExponent: new Uint8Array([1, 0, 1]),
      modulusLength: 2048
    }
    const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
    const certificate = await X509CertificateGenerator.createSelfSigned(
      {
        name: 'CN=localhost',
        keys,
        signingAlgorithm: algorithm,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 3600_000),
        extensions: [new SubjectAlternativeNameExtension([{ type: 'ip', value: '127.0.0.1' }])]
      },
      webcrypto as unknown as Crypto
    )
    const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
    const key = `-----BEGIN PRIVATE KEY-----\n${der
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END PRIVATE KEY-----`
    const server = createHttpsServer(
      { key, cert: certificate.toString('pem') },
      (_request, response) => response.end('trusted only with explicit CA')
    )
    const port = await listen(server)
    await expect(network().fetch(`https://127.0.0.1:${port}`)).rejects.toThrow()
    // Node reads extra CA roots at process startup. Exercise the actual transport in a new process.
    const directory = await mkdtemp(join(tmpdir(), 'open-science-ca-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const ca = join(directory, 'ca.pem')
    const entry = join(directory, 'transport.cjs')
    await writeFile(ca, certificate.toString('pem'))
    await build({
      stdin: {
        contents: `import { createNodeRuntimeNetwork } from './src/main/runtime-network-node'; const network = createNodeRuntimeNetwork({}); (async () => { try { const response = await network.fetch('https://127.0.0.1:${port}'); if (await response.text() !== 'trusted only with explicit CA') throw new Error('Wrong response'); } finally { await network.close() } })().catch(error => { console.error(error); process.exitCode = 1 })`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: entry,
      packages: 'external',
      alias: {
        '@aipoch/notebook-network-sandbox': resolve(
          'packages/notebook-network-sandbox/src/index.ts'
        )
      }
    })
    await new Promise<void>((resolveChild, reject) => {
      const child = spawn(process.execPath, [entry], {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_PATH: resolve('node_modules'),
          NODE_EXTRA_CA_CERTS: ca
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolveChild() : reject(new Error(stderr))))
    })
  })
})
