import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { runShellCommand } from './shell-process'

const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER
const enabled = process.platform === 'win32' && Boolean(distro && user)
const previewAvailable = (): boolean => true

describe.runIf(enabled)('Notebook WSL2 Bash execution', () => {
  let root = ''
  let workspace = ''
  let runtimeRoot = ''
  let handoff = ''
  let sandbox: NotebookNetworkSandboxOwner
  let fixture: Server
  let fixturePort = 0
  const info = vi.fn()
  const requestDecision = vi.fn().mockResolvedValue('deny')

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-wsl-shell-'))
    workspace = join(root, 'Workspace 路径')
    runtimeRoot = join(root, 'runtime')
    handoff = join(root, 'handoff')
    await Promise.all(
      [workspace, runtimeRoot, handoff].map((path) => mkdir(path, { recursive: true }))
    )
    fixture = createServer((_request, response) => response.end('wsl-gateway-ok'))
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject)
      fixture.listen(0, '127.0.0.1', () => resolve())
    })
    const address = fixture.address()
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP.')
    fixturePort = address.port
    sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      getSettings: async () => ({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        allowedDomains: ['example.com']
      }),
      getParentProxy: async () => ({ http: `http://127.0.0.1:${fixturePort}` }),
      persistAlwaysAllow: vi.fn(),
      requestDecision,
      platform: 'win32',
      logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() }
    })
  })

  afterAll(async () => {
    await sandbox?.dispose()
    await new Promise<void>((resolve) => fixture?.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  it('returns bounded output and the real exit code through the existing process sandbox', async () => {
    const result = await runShellCommand({
      command:
        `printf '你好 stdout\\n'; printf 'guest stderr\\n' >&2; ` +
        `head -c 2200000 /dev/zero | tr '\\0' x; exit 19`,
      cwd: workspace,
      handoffDir: handoff,
      runtimeRoot,
      notebookSessionRoot: root,
      executionReference: 'real-wsl-execution',
      sessionId: 'session-1',
      projectId: 'project-1',
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      processSandbox: sandbox,
      previewAvailable,
      terminateTree: async () => ({ reaped: true })
    })

    expect(result.exitCode).toBe(19)
    expect(result.stdout.startsWith('你好 stdout\n')).toBe(true)
    expect(result.stderr).toBe('guest stderr\n')
    expect(result.truncated).toBe(true)
    expect(
      info.mock.calls.filter(([message]) => message === 'sandbox cleanup completed')
    ).toHaveLength(1)
    const diagnosticText = JSON.stringify(info.mock.calls)
    expect(diagnosticText).not.toContain(workspace)
    expect(diagnosticText).not.toContain(distro)
    expect(diagnosticText).not.toContain(user)
    expect(diagnosticText).not.toContain('你好 stdout')
    expect(diagnosticText).toContain('real-wsl-execution')
  })

  it.each([
    { reason: 'timeout' as const, timeoutMs: 200 },
    { reason: 'cancel' as const, timeoutMs: 5_000 }
  ])(
    'propagates $reason to exact guest cleanup within a bounded time',
    async ({ reason, timeoutMs }) => {
      const controller = new AbortController()
      if (reason === 'cancel') setTimeout(() => controller.abort(), 200)
      const startedAt = Date.now()

      const result = await runShellCommand({
        command: `trap '' TERM; while :; do sleep 1; done`,
        cwd: workspace,
        handoffDir: handoff,
        runtimeRoot,
        notebookSessionRoot: root,
        executionReference: `real-wsl-${reason}`,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        timeoutMs,
        signal: controller.signal,
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'real-profile',
          distro: distro!,
          user: user!
        },
        processSandbox: sandbox,
        previewAvailable,
        // The WSL adapter owns exact guest cleanup; host taskkill is not authoritative here.
        terminateTree: async () => ({ reaped: false })
      })

      expect(Date.now() - startedAt).toBeLessThan(8_000)
      expect(result.exitCode).toBeNull()
      expect(result.errorCode).toBeUndefined()
      expect(result.cancelled).toBe(reason === 'cancel' ? true : undefined)
      expect(result.stderr).toContain(reason === 'cancel' ? 'cancelled' : 'timed out')
    },
    15_000
  )

  it('allows only gateway-mediated outbound access and preserves denial semantics', async () => {
    const allowed = await runShellCommand({
      command: '/usr/bin/curl --silent --show-error --fail http://example.com/',
      cwd: workspace,
      handoffDir: handoff,
      runtimeRoot,
      notebookSessionRoot: root,
      sessionId: 'session-network',
      projectId: 'project-1',
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      processSandbox: sandbox,
      previewAvailable,
      terminateTree: async () => ({ reaped: true })
    })
    expect(allowed).toMatchObject({ exitCode: 0, stdout: 'wsl-gateway-ok' })

    const denied = await runShellCommand({
      command: '/usr/bin/curl --silent --show-error --fail http://example.org/',
      cwd: workspace,
      handoffDir: handoff,
      runtimeRoot,
      notebookSessionRoot: root,
      sessionId: 'session-network',
      projectId: 'project-1',
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      processSandbox: sandbox,
      previewAvailable,
      terminateTree: async () => ({ reaped: true })
    })
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stderr).toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')

    const direct = await runShellCommand({
      command:
        'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy ' +
        `/usr/bin/python3 -c 'import socket; socket.create_connection(("127.0.0.1", ${fixturePort}), 1)'`,
      cwd: workspace,
      handoffDir: handoff,
      runtimeRoot,
      notebookSessionRoot: root,
      sessionId: 'session-network',
      projectId: 'project-1',
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      processSandbox: sandbox,
      previewAvailable,
      terminateTree: async () => ({ reaped: true })
    })
    expect(direct.exitCode).not.toBe(0)

    const protectedDestinations = await runShellCommand({
      command:
        '/usr/bin/curl --silent --fail http://169.254.169.254/latest/meta-data/ >/dev/null && exit 31; ' +
        `/usr/bin/curl --silent --fail --proxy http://127.0.0.1:${fixturePort} http://example.com/ >/dev/null && exit 32; ` +
        'exit 0',
      cwd: workspace,
      handoffDir: handoff,
      runtimeRoot,
      notebookSessionRoot: root,
      sessionId: 'session-network',
      projectId: 'project-1',
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      processSandbox: sandbox,
      previewAvailable,
      terminateTree: async () => ({ reaped: true })
    })
    expect(protectedDestinations.exitCode).toBe(0)
    expect(requestDecision).not.toHaveBeenCalled()

    const diagnostics = JSON.stringify(info.mock.calls)
    expect(diagnostics).not.toContain('example.com')
    expect(diagnostics).not.toContain('example.org')
    expect(diagnostics).not.toContain('Download')
  }, 30_000)
})
