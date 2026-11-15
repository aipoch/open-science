import { spawn } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import type { LookupAddress, LookupAllOptions } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createSecureContext, TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'

import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', { spy: true })

import { NotebookNetworkSandbox } from './index.js'
import * as localCa from '../runtime/src/gateway/local-ca.js'
import { CommandGateway } from '../runtime/src/gateway/command-gateway.js'
import { DestinationPolicy } from '../runtime/src/gateway/address-policy.js'
import type { NotebookSandboxedProcess } from './types.js'

const run = (
  wrapped: NotebookSandboxedProcess,
  cwd: string
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      cwd,
      env: wrapped.env,
      shell: false
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, stderr, stdout }))
  })

const transientGatewayFailure = (result: Awaited<ReturnType<typeof run>>): boolean =>
  result.code === 7 && /Failed to connect to localhost port \d+/u.test(result.stderr)

const retryDelays = [50, 100, 200, 400] as const

// Release the command before any assertion runs. `run` settles only after the child closed, so
// termination evidence exists here; a command left behind makes `dispose` fail without termination
// evidence, which keeps the process-wide owner held and fails every later test in this file.
const runAndCleanup = async (
  wrapped: NotebookSandboxedProcess,
  cwd: string,
  options: Readonly<{ retryTransientGatewayFailure?: boolean }> = {}
): Promise<Awaited<ReturnType<typeof run>> & { annotatedStderr: string }> => {
  let result = await run(wrapped, cwd)
  // macOS seatbelt can race the freshly opened localhost gateway while the sandboxed process is
  // starting. Retry only this transport-level failure with bounded backoff; the final policy
  // assertions still require the expected curl status and diagnostic marker.
  if (options.retryTransientGatewayFailure) {
    for (const delay of retryDelays) {
      if (!transientGatewayFailure(result)) break
      await new Promise((resolveRetry) => setTimeout(resolveRetry, delay))
      result = await run(wrapped, cwd)
    }
  }
  const annotatedStderr = wrapped.annotateStderr(result.stderr)
  expect(await wrapped.cleanup('exit', { processesTerminated: true })).toMatchObject({
    processesTerminated: true,
    networkClosed: true,
    temporaryResourcesRemoved: true
  })
  return { ...result, annotatedStderr }
}

const platformSupported = process.platform === 'darwin' || process.platform === 'linux'

describe.runIf(platformSupported)('Notebook network sandbox enforcement', () => {
  it.each(['fetch', 'http'] as const)(
    'routes Node %s HTTP and HTTPS through the gateway and preserves policy denial',
    async (client) => {
      await import('reflect-metadata')
      const x509 = await import('@peculiar/x509')
      const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
      const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
      // Use a distinct issuer from the gateway's inspection CA, including on older OpenSSL.
      const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        name: 'CN=example.test',
        keys,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 86400_000),
        signingAlgorithm: algorithm,
        extensions: [
          new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'example.test' }])
        ]
      })
      const certificatePem = certificate.toString('pem')
      const context = createSecureContext({
        cert: certificatePem,
        key: createPrivateKey({
          key: Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
          format: 'der',
          type: 'pkcs8'
        }).export({ format: 'pem', type: 'pkcs8' })
      })
      const destinations: string[] = []
      const sockets = new Set<Socket>()
      // A local parent proxy is the upstream fixture. Only host-side DNS is pinned; the child
      // must use the real authenticated gateway because example.test cannot resolve in it.
      const server = createServer((request, response) => {
        destinations.push(request.url!)
        response.end('node-proxy-ok')
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      server.on('connect', (request, socket) => {
        destinations.push(request.url!)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        // Node 22's fetch tunnels HTTP as well as HTTPS; newer versions can forward HTTP.
        if (request.url!.endsWith(':80')) {
          socket.once('data', () => {
            socket.end(
              'HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nnode-proxy-ok'
            )
          })
          return
        }
        const tls = new TLSSocket(socket, { isServer: true, secureContext: context })
        tls.on('error', () => tls.destroy())
        tls.once('data', () => {
          tls.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nnode-proxy-ok')
        })
      })
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected an IPv4 server address.')
      const sandbox = new NotebookNetworkSandbox({
        policy: {
          allowedDomains: ['example.test'],
          deniedDomains: [],
          trustedPrivateDestinations: [
            { hostname: 'example.test', port: 80, protocol: 'http', approvedAddresses: [] }
          ]
        },
        resources: { root: resolve(import.meta.dirname, '../vendor') },
        parentProxy: { http: `http://127.0.0.1:${address.port}` },
        trustBundle: { path: '', certificates: [certificatePem] }
      })
      const dnsFixture = vi
        .mocked<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(lookup)
        .mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      try {
        await sandbox.initialize()
        for (const protocol of ['http', 'https']) {
          const url = `${protocol}://example.test/`
          const script =
            client === 'fetch'
              ? `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) }).then(async r => { if (!r.ok) throw new Error(String(r.status)); process.stdout.write(await r.text()) }).catch(e => { console.error(e.cause?.code ?? e.message); process.exitCode = 1 })`
              : `require('node:${protocol}').get(${JSON.stringify(url)}, { timeout: 3000 }, r => { if (r.statusCode !== 200) { r.resume(); process.exitCode = 1 } else r.pipe(process.stdout) }).on('error', e => { console.error(e.code); process.exitCode = 1 }).on('timeout', function () { this.destroy(new Error('timeout')) })`
          const runClient = async (): Promise<Awaited<ReturnType<typeof runAndCleanup>>> => {
            const wrapped = await sandbox.wrap({
              command: `${quote(process.execPath)} -e ${quote(script)}`,
              cwd: process.cwd(),
              onNetworkAccessRequest: async () => false
            })
            return runAndCleanup(wrapped, process.cwd())
          }
          sandbox.updatePolicy({
            allowedDomains: ['example.test'],
            deniedDomains: [],
            trustedPrivateDestinations: [
              { hostname: 'example.test', port: 80, protocol: 'http', approvedAddresses: [] }
            ]
          })
          const allowed = await runClient()
          expect(allowed, allowed.annotatedStderr).toMatchObject({
            code: 0,
            stdout: 'node-proxy-ok'
          })
          expect(destinations).toHaveLength(1)

          sandbox.updatePolicy({
            allowedDomains: ['example.test'],
            deniedDomains: ['example.test']
          })
          const denied = await runClient()
          expect(denied.code).not.toBe(0)
          expect(denied.annotatedStderr).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
          expect(destinations).toHaveLength(1)
          destinations.length = 0
        }
      } finally {
        dnsFixture.mockRestore()
        await sandbox.dispose()
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      }
    }
  )

  it('keeps ordinary target approval available when local CA initialization fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-ca-failure-'))
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })
    const caFailure = vi
      .spyOn(localCa, 'createLocalCertificateAuthority')
      .mockRejectedValue(new Error('fixture failure'))
    const policy = vi.spyOn(DestinationPolicy.prototype, 'inspect').mockResolvedValue({
      kind: 'ask',
      host: 'example.test',
      address: '93.184.216.34',
      source: 'unknown'
    })
    const approval = vi.fn(async () => false)
    const gatewayOpened = vi.spyOn(CommandGateway, 'open')
    let wrapped: NotebookSandboxedProcess | undefined
    try {
      await sandbox.initialize()
      wrapped = await sandbox.wrap({
        command: '/usr/bin/true',
        cwd: directory,
        onNetworkAccessRequest: approval
      })
      expect(wrapped.env.SSL_CERT_FILE).toBeUndefined()
      wrapped.setExecutionActive(true)
      const proxy = new URL(wrapped.env.HTTPS_PROXY!)
      // This request runs on the host; Linux's advertised proxy port belongs to its namespace.
      proxy.port = String((await gatewayOpened.mock.results[0]!.value).port)
      await new Promise<void>((resolveResponse, reject) => {
        const request = httpRequest({
          hostname: proxy.hostname,
          port: proxy.port,
          method: 'CONNECT',
          path: 'example.test:443',
          headers: {
            'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
          }
        })
        request.on('error', reject)
        request.on('connect', (response, socket) => {
          expect(response.statusCode).toBe(200)
          socket.once('close', resolveResponse)
          socket.write(Buffer.from([0x16, 0x03, 0x03]))
          socket.resume()
        })
        request.end()
      })
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'block', host: 'example.test' })
      )
      expect(wrapped.annotateStderr('')).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
    } finally {
      gatewayOpened.mockRestore()
      caFailure.mockRestore()
      policy.mockRestore()
      try {
        if (wrapped) {
          expect(
            await wrapped.cleanup('spawn-failed', { processesTerminated: true })
          ).toMatchObject({
            processesTerminated: true,
            networkClosed: true,
            temporaryResourcesRemoved: true
          })
        }
      } finally {
        try {
          await sandbox.dispose()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  })

  it('discards DNS results from an ended execution before recording approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-dns-window-'))
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })
    const approval = vi.fn(async () => false)
    let release!: (value: Awaited<ReturnType<DestinationPolicy['inspect']>>) => void
    let inspected!: () => void
    const started = new Promise<void>((resolveStarted) => {
      inspected = resolveStarted
    })
    const policy = vi.spyOn(DestinationPolicy.prototype, 'inspect').mockImplementation(() => {
      inspected()
      return new Promise((resolveDecision) => {
        release = resolveDecision
      })
    })
    const gatewayOpened = vi.spyOn(CommandGateway, 'open')
    let wrapped: NotebookSandboxedProcess | undefined
    try {
      await sandbox.initialize()
      wrapped = await sandbox.wrap({
        command: '/usr/bin/true',
        cwd: directory,
        onNetworkAccessRequest: approval
      })
      wrapped.setExecutionActive(true)
      const proxy = new URL(wrapped.env.HTTPS_PROXY!)
      // This request runs on the host; Linux's advertised proxy port belongs to its namespace.
      proxy.port = String((await gatewayOpened.mock.results[0]!.value).port)
      const request = httpRequest({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: 'example.test:443',
        headers: {
          'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
        }
      })
      request.on('error', () => {})
      request.on('connect', (_response, socket) => {
        socket.on('error', () => {})
        socket.write(Buffer.from([0x16, 0x03, 0x03]))
      })
      request.end()
      await started
      wrapped.setExecutionActive(false)
      wrapped.setExecutionActive(true)
      release({ kind: 'ask', host: 'example.test', address: '93.184.216.34', source: 'unknown' })
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 20))
      expect(approval).not.toHaveBeenCalled()
      expect(wrapped.annotateStderr('')).not.toContain('not approved')
      request.destroy()
    } finally {
      gatewayOpened.mockRestore()
      policy.mockRestore()
      try {
        if (wrapped) {
          expect(
            await wrapped.cleanup('spawn-failed', { processesTerminated: true })
          ).toMatchObject({
            processesTerminated: true,
            networkClosed: true,
            temporaryResourcesRemoved: true
          })
        }
      } finally {
        try {
          await sandbox.dispose()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  })

  it('injects a read-only certificate-only bundle into a real process and removes it on cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-ca-launch-'))
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })
    let bundlePath: string | undefined
    try {
      await sandbox.initialize()
      const wrapped = await sandbox.wrap({
        command:
          '/bin/cat "$SSL_CERT_FILE"; if /bin/chmod u+w "$SSL_CERT_FILE" 2>/dev/null; then echo MUTATED; fi; if /bin/rm "$SSL_CERT_FILE" 2>/dev/null; then echo REMOVED; fi',
        cwd: directory,
        env: { PATH: '/usr/bin:/bin' },
        filesystem: {
          readOnlyRoots: ['/usr/bin', '/bin'],
          readWriteRoots: [directory],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        onNetworkAccessRequest: async () => false
      })
      bundlePath = wrapped.env.SSL_CERT_FILE
      wrapped.setExecutionActive(true)
      const result = await run(wrapped, directory)
      wrapped.setExecutionActive(false)
      // Capture the bundle before cleanup removes it; assertions run only after the release.
      const bundle = bundlePath
        ? await Promise.all([readFile(bundlePath, 'utf8'), stat(bundlePath)]).catch(() => undefined)
        : undefined
      await wrapped.cleanup('exit', { processesTerminated: true })
      expect(result.stdout).toContain('BEGIN CERTIFICATE')
      expect(result.stdout).not.toContain('PRIVATE KEY')
      expect(result.stdout).not.toContain('MUTATED')
      expect(result.stdout).not.toContain('REMOVED')
      expect(bundle).toBeDefined()
      expect(bundle![0]).toBe(result.stdout)
      expect(bundle![1].mode & 0o222).toBe(0)
    } finally {
      await sandbox.dispose()
      await rm(directory, { recursive: true, force: true })
    }
    await expect(stat(bundlePath!)).rejects.toThrow()
  })

  it('launches the Electron-as-Node process used by POSIX REPL kernels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-repl-launch-'))
    const electronPath = createRequire(import.meta.url)('electron') as string
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })

    try {
      await sandbox.initialize()
      const wrapped = await sandbox.wrap({
        command: `${JSON.stringify(electronPath)} -e ${JSON.stringify("process.stdout.write('repl-ok')")}`,
        cwd: directory,
        env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH },
        filesystem: {
          readOnlyRoots: [resolve(dirname(electronPath), '../..')],
          readWriteRoots: [directory],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        onNetworkAccessRequest: async () => false
      })
      const result = await runAndCleanup(wrapped, directory)
      expect(result).toMatchObject({ code: 0, stdout: 'repl-ok' })
    } finally {
      await sandbox.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'linux')(
    'preserves the REPL credential descriptor through bubblewrap and the gateway bridge',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-repl-fd-'))
      const sandbox = new NotebookNetworkSandbox({
        policy: { allowedDomains: [], deniedDomains: [] },
        resources: { root: resolve(import.meta.dirname, '../vendor') }
      })

      try {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command: '/usr/bin/cat <&3',
          cwd: directory,
          env: { PATH: process.env.PATH },
          inheritedFileDescriptorCount: 1,
          filesystem: {
            readOnlyRoots: ['/usr/bin'],
            readWriteRoots: [directory],
            deniedReadRoots: [],
            deniedWriteRoots: []
          },
          onNetworkAccessRequest: async () => false
        })
        const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
          (resolveRun, reject) => {
            const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
              cwd: directory,
              env: wrapped.env,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe', 'pipe']
            })
            let stdout = ''
            let stderr = ''
            child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
            child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
            child.on('error', reject)
            child.on('close', (code) => resolveRun({ code, stderr, stdout }))
            const descriptor = child.stdio[3]
            if (!descriptor || !('end' in descriptor)) {
              child.kill()
              reject(new Error('Failed to create inherited descriptor 3.'))
              return
            }
            descriptor.on('error', reject)
            descriptor.end('fd-ok')
          }
        )
        await wrapped.cleanup('exit', { processesTerminated: true })
        expect(result).toMatchObject({ code: 0, stderr: '', stdout: 'fd-ok' })
      } finally {
        await sandbox.dispose()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('exposes only the declared local RPC socket inside the process sandbox', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpc-'))
    const socketPath = join(directory, 'rpc')
    const otherSocketPath = join(directory, 'other.sock')
    const server = createServer((_request, response) => response.end('rpc-ok'))
    const otherServer = createServer((_request, response) => response.end('must-not-connect'))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolveListen)
    })
    await new Promise<void>((resolveListen, reject) => {
      otherServer.once('error', reject)
      otherServer.listen(otherSocketPath, resolveListen)
    })
    const cwd = process.cwd()
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })

    try {
      await sandbox.initialize()
      const wrapped = await sandbox.wrap({
        command:
          '/usr/bin/curl --silent --show-error --fail-with-body --unix-socket "$OPEN_SCIENCE_MCP_RPC_SOCKET_PATH" http://localhost/',
        cwd,
        env: { OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: socketPath },
        localRpcSocketPath: socketPath,
        onNetworkAccessRequest: async () => false
      })
      const result = await runAndCleanup(wrapped, cwd)
      expect(result).toMatchObject({ code: 0, stdout: 'rpc-ok' })

      const blocked = await sandbox.wrap({
        command: `/usr/bin/curl --silent --show-error --fail-with-body --unix-socket ${JSON.stringify(otherSocketPath)} http://localhost/`,
        cwd,
        env: { OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: socketPath },
        localRpcSocketPath: socketPath,
        onNetworkAccessRequest: async () => true
      })
      const blockedResult = await runAndCleanup(blocked, cwd)
      expect(blockedResult.code).not.toBe(0)
    } finally {
      await sandbox.dispose()
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
      await new Promise<void>((resolveClose, reject) =>
        otherServer.close((error) => (error ? reject(error) : resolveClose()))
      )
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allows a listed destination and blocks it after a live policy update', async () => {
    // Pin public DNS as well as the parent proxy: this tests live policy changes, not DNS availability.
    const server = createServer((_request, response) => response.end('sandbox-ok'))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an IPv4 server address.')

    const cwd = process.cwd()
    const sandbox = new NotebookNetworkSandbox({
      policy: {
        allowedDomains: [],
        deniedDomains: [],
        trustedPrivateDestinations: [
          { hostname: 'example.com', port: 80, protocol: 'http', approvedAddresses: [] }
        ]
      },
      resources: { root: resolve(import.meta.dirname, '../vendor') },
      parentProxy: { http: `http://127.0.0.1:${address.port}` }
    })
    const dnsFixture = vi
      .mocked<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(lookup)
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }])

    try {
      await sandbox.initialize()
      const allowedProcess = await sandbox.wrap({
        command: '/usr/bin/curl --silent --show-error --fail-with-body http://example.com/',
        cwd,
        onNetworkAccessRequest: async () => false
      })
      const allowed = await runAndCleanup(allowedProcess, cwd)
      expect(allowed, allowed.stderr).toMatchObject({ code: 0, stdout: 'sandbox-ok' })

      sandbox.updatePolicy({ allowedDomains: [], deniedDomains: [] })
      const deniedProcess = await sandbox.wrap({
        command: '/usr/bin/curl --silent --show-error --fail http://example.com/',
        cwd,
        onNetworkAccessRequest: async () => false
      })
      const denied = await runAndCleanup(deniedProcess, cwd, {
        retryTransientGatewayFailure: true
      })
      expect(denied.code, denied.annotatedStderr).toBe(22)
      expect(denied.stdout).not.toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
      expect(denied.annotatedStderr).toContain('Destination approval is required')
      expect(denied.annotatedStderr).toContain('deny network-outbound example.com:80')

      sandbox.updatePolicy({
        allowedDomains: [],
        deniedDomains: ['example.com'],
        deniedDomainReasons: { 'example.com': 'destination is explicitly blocked' }
      })
      const hardDeniedDecision = vi.fn(async () => true)
      const hardDeniedProcess = await sandbox.wrap({
        command: '/usr/bin/curl --silent --show-error --fail-with-body http://example.com/',
        cwd,
        onNetworkAccessRequest: hardDeniedDecision
      })
      const hardDenied = await runAndCleanup(hardDeniedProcess, cwd)
      expect(hardDenied.code, hardDenied.annotatedStderr).toBe(22)
      expect(hardDenied.stdout).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(hardDenied.annotatedStderr).toContain('destination is explicitly blocked')
      expect(hardDeniedDecision).not.toHaveBeenCalled()

      const privateDecision = vi.fn(async () => false)
      const privateProcess = await sandbox.wrap({
        command: `/usr/bin/curl --silent --show-error --fail-with-body http://127.0.0.1:${address.port}/`,
        cwd,
        onNetworkAccessRequest: privateDecision
      })
      const privateResult = await runAndCleanup(privateProcess, cwd)
      expect(privateResult.code, privateResult.annotatedStderr).toBe(22)
      expect(privateResult.stdout).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
      expect(privateResult.annotatedStderr).toContain('Destination approval is required')
      expect(privateDecision).toHaveBeenCalledOnce()
    } finally {
      dnsFixture.mockRestore()
      try {
        await sandbox.dispose()
      } finally {
        await new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose()))
        )
      }
    }
  })

  it('blocks raw sockets even when a command removes every proxy variable', async () => {
    const server = createServer((_request, response) => response.end('must-not-connect'))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an IPv4 server address.')

    const cwd = process.cwd()
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })
    try {
      await sandbox.initialize()
      const script = [
        "const net = require('node:net')",
        `const socket = net.connect(${address.port}, '127.0.0.1')`,
        "socket.once('connect', () => process.exit(0))",
        "socket.once('error', () => process.exit(7))",
        'setTimeout(() => process.exit(8), 2000)'
      ].join(';')
      const wrapped = await sandbox.wrap({
        command: `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        cwd,
        onNetworkAccessRequest: async () => true
      })
      const result = await runAndCleanup(wrapped, cwd)
      expect(result.code).not.toBe(0)
    } finally {
      await sandbox.dispose()
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
    }
  })
})

describe.runIf(platformSupported)('strict whitelist with a real Python client', () => {
  it('blocks without asking, allows a manually added localhost rule, checks redirects, and restores relaxed trust', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strict-python-'))
    let requests = 0
    const server = createServer((request, response) => {
      requests++
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/` })
        response.end()
      } else response.end('strict-python-ok')
    })
    // Both loopback families must reach the fixture when relaxed policy pins the first DNS result.
    await new Promise<void>((resolve) =>
      server.listen({ port: 0, host: '::', ipv6Only: false }, resolve)
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const port = address.port
    const trusted = [
      { hostname: 'localhost', protocol: 'http' as const, port, approvedAddresses: [] }
    ]
    const sandbox = new NotebookNetworkSandbox({
      policy: {
        mode: 'strict',
        strictWhitelist: [],
        trustedPrivateDestinations: trusted,
        allowedDomains: [],
        deniedDomains: []
      },
      resources: { root: resolve(import.meta.dirname, '../vendor') }
    })
    const approval = vi.fn(async () => true)
    // Exercise hosts where localhost resolves to IPv6 first, as on the Linux CI runner.
    const dnsFixture = vi
      .mocked<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(lookup)
      .mockResolvedValue([
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 }
      ])
    const python = process.env.OPEN_SCIENCE_TEST_PYTHON ?? '/usr/bin/python3'
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const request = async (path = '/'): Promise<Awaited<ReturnType<typeof runAndCleanup>>> => {
      const script = `import urllib.request; print(urllib.request.urlopen(${JSON.stringify(`http://localhost:${port}${path}`)}, timeout=5).read().decode())`
      const wrapped = await sandbox.wrap({
        command: `${quote(python)} -c ${quote(script)}`,
        cwd: directory,
        env: { ...process.env, NO_PROXY: '', no_proxy: '' },
        filesystem: {
          readOnlyRoots: ['/usr/bin', '/bin', dirname(dirname(python))],
          readWriteRoots: [directory],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        onNetworkAccessRequest: approval
      })
      wrapped.setExecutionActive(true)
      return runAndCleanup(wrapped, directory)
    }
    try {
      await sandbox.initialize()
      const blocked = await request()
      expect(blocked.annotatedStderr).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(blocked.code).not.toBe(0)
      expect(requests).toBe(0)
      expect(approval).not.toHaveBeenCalled()
      sandbox.updatePolicy({
        mode: 'strict',
        strictWhitelist: [{ hostnamePattern: 'localhost', protocol: 'http', port }],
        allowedDomains: [],
        deniedDomains: []
      })
      const allowed = await request()
      expect(allowed, allowed.annotatedStderr).toMatchObject({
        code: 0,
        stdout: 'strict-python-ok\n'
      })
      expect(requests).toBe(1)
      const redirected = await request('/redirect')
      expect(redirected.annotatedStderr).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(requests).toBe(2)
      sandbox.updatePolicy({
        mode: 'relaxed',
        trustedPrivateDestinations: trusted,
        allowedDomains: [],
        deniedDomains: []
      })
      const restored = await request()
      expect(restored, restored.annotatedStderr).toMatchObject({
        code: 0,
        stdout: 'strict-python-ok\n'
      })
      expect(requests).toBe(3)
      sandbox.updatePolicy({
        mode: 'strict',
        strictWhitelist: [],
        trustedPrivateDestinations: trusted,
        allowedDomains: [],
        deniedDomains: []
      })
      expect((await request()).annotatedStderr).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(requests).toBe(3)
      expect(approval).not.toHaveBeenCalled()
    } finally {
      dnsFixture.mockRestore()
      await sandbox.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
