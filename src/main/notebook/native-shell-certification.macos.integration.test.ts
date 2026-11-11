import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { LookupAddress, LookupAllOptions } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { NotebookShellProcessAdapter } from './shell-process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { certifyNativeShell } from './native-shell-certification'

vi.mock('node:dns/promises', { spy: true })

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip

describeMacOS('native shell certification through the production sandbox', () => {
  it('uses the client Node for legacy or missing PATH Node while preserving network policy', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'shell-node-proxy-')))
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const bin = join(root, 'bin')
    await mkdir(bin)
    const preload = join(root, 'legacy.cjs')
    // Model pre-22.21 Node: it ignores proxy opt-in and does not advertise the native flag.
    await writeFile(
      preload,
      "Object.defineProperty(process, 'allowedNodeEnvironmentFlags', { value: new Set() })"
    )
    await writeFile(
      join(bin, 'node'),
      `#!/bin/sh
unset NODE_USE_ENV_PROXY
exec ${quote(process.execPath)} --require ${quote(preload)} "$@"
`,
      { mode: 0o755 }
    )
    const cli = join(bin, 'sample-cli')
    await writeFile(
      cli,
      `#!/usr/bin/env node
fetch(process.argv[2], { signal: AbortSignal.timeout(3000) }).then(async r => {
  if (!r.ok) throw new Error(String(r.status))
  console.log(await r.text())
}).catch(e => { console.error('NETWORK_ERROR', e.cause?.code ?? e.message); process.exitCode = 1 })
`,
      { mode: 0o755 }
    )
    let requests = 0
    const upstream = createServer((_request, response) => {
      requests++
      response.end('proxy-ok')
    })
    upstream.on('connect', (_request, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', () => {
        requests++
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nproxy-ok')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Missing upstream address')
    const settings = {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      // HTTP requires an exact exception; the legacy domain list only governs link previews.
      trustedPrivateDestinations: [
        { hostname: 'example.test', port: 80, protocol: 'http' as const, approvedAddresses: [] }
      ]
    }
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'resources'),
      temporaryRoot: join(root, 'command-temp'),
      getSettings: async () => settings,
      persistAlwaysAllow: async () => settings,
      requestDecision: async () => 'deny',
      getParentProxy: async () => ({ http: `http://127.0.0.1:${address.port}` })
    })
    const dns = vi
      .mocked<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(lookup)
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const adapter = new NotebookShellProcessAdapter(process.platform, owner)
    const request = {
      cwd: root,
      handoffDir: root,
      runtimeRoot: join(root, 'runtime'),
      notebookSessionRoot: root,
      projectId: 'proxy-project',
      sessionId: 'proxy-session',
      environment: { PATH: bin },
      runtimeBinding: { kind: 'native-posix' as const, shell: '/bin/bash' }
    }
    try {
      const allowed = await adapter.execute({
        ...request,
        command: `${quote(cli)} http://example.test/`
      })
      expect(allowed, allowed.stderr).toMatchObject({ exitCode: 0, stdout: 'proxy-ok\n' })
      const denied = await adapter.execute({
        ...request,
        command: `${quote(cli)} http://blocked.test/`
      })
      expect(denied.exitCode).not.toBe(0)
      expect(requests).toBe(1)
      await adapter.shutdown({})
      await rm(join(bin, 'node'))
      const missing = await adapter.execute({
        ...request,
        command: `${quote(cli)} http://example.test/`
      })
      expect(missing, missing.stderr).toMatchObject({ exitCode: 0, stdout: 'proxy-ok\n' })
      await adapter.shutdown({})
      await writeFile(
        join(bin, 'node'),
        `#!/bin/sh
export SELECTED_COMPATIBLE_NODE=1
exec ${quote(process.execPath)} "$@"
`,
        { mode: 0o755 }
      )
      const compatible = await adapter.execute({
        ...request,
        command: `node -p 'process.env.SELECTED_COMPATIBLE_NODE'`
      })
      expect(compatible, compatible.stderr).toMatchObject({ exitCode: 0, stdout: '1\n' })
    } finally {
      await adapter.shutdown({})
      await owner.dispose()
      dns.mockRestore()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('reaps a background child, times out and then executes again', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'native-shell-certification-test-')))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'resources'),
      temporaryRoot: join(root, 'command-temp'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    try {
      await expect(
        certifyNativeShell({
          appPackaged: true,
          headless: true,
          storageRoot: root,
          environment: {
            OPEN_SCIENCE_E2E_STORAGE_ROOT: root,
            OPEN_SCIENCE_E2E_NATIVE_SHELL_CERTIFICATION: '1'
          },
          processSandbox: owner
        })
      ).resolves.toBeUndefined()
    } finally {
      await owner.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

configureTestRuntimeMetadata()
