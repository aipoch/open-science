import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

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

const platformSupported = process.platform === 'darwin' || process.platform === 'linux'

describe.runIf(platformSupported)('Notebook network sandbox enforcement', () => {
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
          expect(response.statusCode).toBe(403)
          socket.destroy()
          resolveResponse()
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
          expect(await wrapped.cleanup('spawn-failed', { processesTerminated: true })).toEqual({
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
      request.on('connect', (_response, socket) => socket.destroy())
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
          expect(await wrapped.cleanup('spawn-failed', { processesTerminated: true })).toEqual({
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
      expect(bundlePath).toBeTruthy()
      wrapped.setExecutionActive(true)
      const result = await run(wrapped, directory)
      wrapped.setExecutionActive(false)
      expect(result.stdout).toContain('BEGIN CERTIFICATE')
      expect(result.stdout).not.toContain('PRIVATE KEY')
      expect(result.stdout).not.toContain('MUTATED')
      expect(result.stdout).not.toContain('REMOVED')
      expect(await readFile(bundlePath!, 'utf8')).toBe(result.stdout)
      expect((await stat(bundlePath!)).mode & 0o222).toBe(0)
      await wrapped.cleanup('exit', { processesTerminated: true })
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
      const result = await run(wrapped, directory)
      await wrapped.cleanup('exit', { processesTerminated: true })
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
    const directory = await mkdtemp(join(tmpdir(), 'open-science-rpc-test-'))
    const socketPath = join(directory, 'notebook-rpc.sock')
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
      const result = await run(wrapped, cwd)
      await wrapped.cleanup('exit', { processesTerminated: true })
      expect(result).toMatchObject({ code: 0, stdout: 'rpc-ok' })

      const blocked = await sandbox.wrap({
        command: `/usr/bin/curl --silent --show-error --fail-with-body --unix-socket ${JSON.stringify(otherSocketPath)} http://localhost/`,
        cwd,
        env: { OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: socketPath },
        localRpcSocketPath: socketPath,
        onNetworkAccessRequest: async () => true
      })
      const blockedResult = await run(blocked, cwd)
      await blocked.cleanup('exit', { processesTerminated: true })
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
    // A trusted local parent-proxy fixture keeps this test hermetic while the requested destination
    // remains a real public hostname. The sandbox must never allowlist loopback/private destinations,
    // even for tests.
    const server = createServer((_request, response) => response.end('sandbox-ok'))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an IPv4 server address.')

    const cwd = process.cwd()
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: ['example.com:80'], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') },
      parentProxy: { http: `http://127.0.0.1:${address.port}` }
    })

    try {
      await sandbox.initialize()
      const allowedProcess = await sandbox.wrap({
        command: '/usr/bin/curl --silent --show-error --fail-with-body http://example.com/',
        cwd,
        onNetworkAccessRequest: async () => false
      })
      const allowed = await run(allowedProcess, cwd)
      await allowedProcess.cleanup('exit', { processesTerminated: true })
      expect(allowed, allowed.stderr).toMatchObject({ code: 0, stdout: 'sandbox-ok' })

      sandbox.updatePolicy({ allowedDomains: [], deniedDomains: [] })
      const deniedProcess = await sandbox.wrap({
        command: '/usr/bin/curl --silent --show-error --fail http://example.com/',
        cwd,
        onNetworkAccessRequest: async () => false
      })
      const denied = await run(deniedProcess, cwd)
      expect(denied.code).not.toBe(0)
      expect(denied.stdout).not.toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
      const annotatedDeniedStderr = deniedProcess.annotateStderr(denied.stderr)
      expect(annotatedDeniedStderr).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
      expect(annotatedDeniedStderr).toContain('deny network-outbound example.com:80')
      await deniedProcess.cleanup('exit', { processesTerminated: true })

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
      const hardDenied = await run(hardDeniedProcess, cwd)
      expect(hardDenied.code).not.toBe(0)
      expect(hardDenied.stdout).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(hardDeniedProcess.annotateStderr(hardDenied.stderr)).toContain(
        'destination is explicitly blocked'
      )
      expect(hardDeniedDecision).not.toHaveBeenCalled()
      await hardDeniedProcess.cleanup('exit', { processesTerminated: true })

      const privateDecision = vi.fn(async () => true)
      const privateProcess = await sandbox.wrap({
        command: `/usr/bin/curl --silent --show-error --fail-with-body http://127.0.0.1:${address.port}/`,
        cwd,
        onNetworkAccessRequest: privateDecision
      })
      const privateResult = await run(privateProcess, cwd)
      expect(privateResult.code).not.toBe(0)
      expect(privateResult.stdout).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(privateProcess.annotateStderr(privateResult.stderr)).toContain(
        'destination resolves to a non-public network address'
      )
      expect(privateDecision).not.toHaveBeenCalled()
      await privateProcess.cleanup('exit', { processesTerminated: true })
    } finally {
      await sandbox.dispose()
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
    }
  })

  it('binds concurrent approval requests to their owning command', async () => {
    const server = createServer((_request, response) => response.end('approved'))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an IPv4 server address.')

    const cwd = process.cwd()
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve(import.meta.dirname, '../vendor') },
      parentProxy: { http: `http://127.0.0.1:${address.port}` }
    })
    const firstRequests: string[] = []
    const secondRequests: string[] = []

    try {
      await sandbox.initialize()
      const [first, second] = await Promise.all([
        sandbox.wrap({
          command: '/usr/bin/curl --silent http://example.com/',
          cwd,
          onNetworkAccessRequest: async ({ host }) => {
            firstRequests.push(host)
            return true
          }
        }),
        sandbox.wrap({
          command: '/usr/bin/curl --silent http://example.org/',
          cwd,
          onNetworkAccessRequest: async ({ host }) => {
            secondRequests.push(host)
            return true
          }
        })
      ])

      const [firstResult, secondResult] = await Promise.all([run(first, cwd), run(second, cwd)])
      await first.cleanup('exit', { processesTerminated: true })
      await second.cleanup('exit', { processesTerminated: true })

      expect(firstResult).toMatchObject({ code: 0, stdout: 'approved' })
      expect(secondResult).toMatchObject({ code: 0, stdout: 'approved' })
      expect(firstRequests).toEqual(['example.com'])
      expect(secondRequests).toEqual(['example.org'])
    } finally {
      await sandbox.dispose()
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
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
      const result = await run(wrapped, cwd)
      await wrapped.cleanup('exit', { processesTerminated: true })
      expect(result.code).not.toBe(0)
    } finally {
      await sandbox.dispose()
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
    }
  })
})
