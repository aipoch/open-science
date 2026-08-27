import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { platform } from 'node:os'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))

import type { ComputeHost } from '../../shared/compute'
import {
  ComputeConnectionError,
  SshConfigComputeConnectionBroker,
  type ComputeConnectionLease
} from './connection-broker'
import { PasswordSshAdapter, createAskpassEnvironment } from './connection-adapters'
import { CredentialVault } from './credential-vault'
import type { ScpRunner } from './scp-runner'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'

const host = {
  id: 'host-1',
  providerId: 'ssh:cluster',
  displayName: 'Cluster',
  sshAlias: 'cluster',
  sshOverrides: { user: 'researcher', port: 2222 }
} as ComputeHost

const target: ResolvedSshTarget = {
  sshBinary: 'ssh',
  host: 'cluster',
  extraArgs: ['-o', 'BatchMode=yes']
}

const socketAskpass = it

const answeredAskpass = (): {
  env: NodeJS.ProcessEnv
  wasAnswered: () => boolean
  wasUnsupportedPromptRejected: () => boolean
  dispose: () => Promise<void>
} => ({
  env: { SSH_ASKPASS: '/constrained/helper' },
  wasAnswered: () => true,
  wasUnsupportedPromptRejected: () => false,
  dispose: async () => undefined
})

const askAskpass = (env: NodeJS.ProcessEnv, prompt: string): Promise<Record<string, string>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(env['OPEN_SCIENCE_ASKPASS_SOCKET'] as string)
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.end(
        JSON.stringify({
          capability: env['OPEN_SCIENCE_ASKPASS_CAPABILITY'],
          prompt
        })
      )
    })
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.on('end', () => resolve(JSON.parse(response) as Record<string, string>))
    socket.on('error', reject)
  })

describe('ComputeConnectionBroker SSH configuration compatibility', () => {
  it.runIf(platform() === 'win32')(
    'returns one matching password through the constrained Windows askpass helper',
    async () => {
      const secret = 'Windows askpass secret "quoted" Unicode 密码'
      vi.stubEnv('OPEN_SCIENCE_RELEASE_GATE_SECRET', secret)
      const askpass = await createAskpassEnvironment(secret, ['researcher@cluster'])
      const invoke = (
        prompt: string
      ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(askpass.env['SSH_ASKPASS'] as string, [prompt], {
            env: askpass.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          })
          let stdout = ''
          let stderr = ''
          child.stdout.setEncoding('utf8')
          child.stderr.setEncoding('utf8')
          child.stdout.on('data', (chunk) => {
            stdout += chunk
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.once('error', reject)
          child.once('close', (code) => resolve({ code, stdout, stderr }))
        })

      try {
        expect(askpass.env['OPEN_SCIENCE_RELEASE_GATE_SECRET']).toBeUndefined()
        expect(JSON.stringify(askpass.env)).not.toContain(secret)
        expect(askpass.env['OPEN_SCIENCE_ASKPASS_SOCKET']).toMatch(/^\\\\\.\\pipe\\/)
        expect(askpass.env['SSH_ASKPASS']).toBe(process.execPath)
        expect(askpass.env['NODE_OPTIONS']).toContain('compute-askpass-win.cjs')

        await expect(invoke("researcher@cluster's password:")).resolves.toEqual({
          code: 0,
          stdout: secret,
          stderr: ''
        })
        expect(askpass.wasAnswered()).toBe(true)

        await expect(invoke("researcher@cluster's password:")).resolves.toMatchObject({ code: 1 })
        expect(askpass.wasUnsupportedPromptRejected?.()).toBe(true)
      } finally {
        await askpass.dispose()
      }
    }
  )

  socketAskpass(
    'does not inherit unrelated process environment values into the askpass child',
    async () => {
      const distinctiveSecret = 'release gate secret "quoted"\nUnicode 密码'
      vi.stubEnv('OPEN_SCIENCE_RELEASE_GATE_SECRET', distinctiveSecret)

      const askpass = await createAskpassEnvironment(distinctiveSecret, ['researcher@cluster'])
      try {
        expect(askpass.env['OPEN_SCIENCE_RELEASE_GATE_SECRET']).toBeUndefined()
        expect(JSON.stringify(askpass.env)).not.toContain(distinctiveSecret)
      } finally {
        await askpass.dispose()
      }
    }
  )

  it('suppresses background authentication retries per Host after a confirmed failure', async () => {
    const otherHost = { ...host, id: 'host-2', providerId: 'ssh:other', sshAlias: 'other' }
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ComputeConnectionError('authentication_failed'))
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    const adapter = {
      acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
    }
    const persistAuthenticationFailure = vi.fn(async () => undefined)
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async (providerId) =>
        providerId === otherHost.providerId
          ? ({
              ...otherHost,
              authentication: {
                mode: 'password',
                credentialStatus: 'configured',
                revision: 1
              }
            } as ComputeHost)
          : ({
              ...host,
              authentication: {
                mode: 'password',
                credentialStatus: 'configured',
                revision: 1
              }
            } as ComputeHost)
      ),
      runner: { run: vi.fn() },
      passwordAdapter: adapter,
      persistAuthenticationFailure
    })

    const direct = await broker.acquire(host.providerId, { intent: 'direct_command' })
    await expect(direct.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'authentication_failed'
    })

    await expect(broker.acquire(host.providerId, { intent: 'job_poll' })).rejects.toMatchObject({
      code: 'authentication_failed'
    })
    await expect(broker.acquire(host.providerId, { intent: 'job_harvest' })).rejects.toMatchObject({
      code: 'authentication_failed'
    })
    await expect(
      broker.acquire(otherHost.providerId, { intent: 'job_poll' })
    ).resolves.toBeDefined()
    expect(adapter.acquire).toHaveBeenCalledTimes(2)
    expect(persistAuthenticationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: host.id })
    )
  })

  it('does not overlap background password submissions while authentication is unconfirmed', async () => {
    let rejectFirst!: () => void
    const firstMayReject = new Promise<void>((resolve) => {
      rejectFirst = resolve
    })
    const run = vi.fn(async (command: string) => {
      if (command === 'poll') {
        await firstMayReject
        throw new ComputeConnectionError('authentication_failed')
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
    })
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => ({
        ...host,
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision: 1,
          lastVerifiedAt: undefined
        }
      })),
      runner: { run: vi.fn() },
      passwordAdapter: {
        acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
      }
    })
    const pollLease = await broker.acquire(host.providerId, { intent: 'job_poll' })
    const harvestLease = await broker.acquire(host.providerId, { intent: 'job_harvest' })

    const poll = pollLease.run('poll', { timeoutMs: 1000 })
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    const harvest = harvestLease.run('harvest', { timeoutMs: 1000 })
    await Promise.resolve()

    expect(run).toHaveBeenCalledOnce()
    rejectFirst()
    await expect(poll).rejects.toMatchObject({ code: 'authentication_failed' })
    await expect(harvest).rejects.toMatchObject({ code: 'authentication_failed' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('restores the authentication breaker from the persisted Host revision after restart', async () => {
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 4,
        lastVerifiedAt: undefined
      },
      probeResult: {
        ok: false,
        probedAt: new Date().toISOString(),
        exitCode: null,
        errorTail: 'Authentication failed. Verify the username and password.',
        authenticationCode: 'authentication_failed' as const,
        authenticationRevision: 4
      }
    }
    const passwordAdapter = { acquire: vi.fn() }
    const restartedBroker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner: { run: vi.fn() },
      passwordAdapter
    })

    await expect(
      restartedBroker.acquire(host.providerId, { intent: 'job_poll' })
    ).rejects.toMatchObject({ code: 'authentication_failed' })
    expect(passwordAdapter.acquire).not.toHaveBeenCalled()

    passwordAdapter.acquire.mockResolvedValue({
      run: vi.fn(),
      upload: vi.fn(),
      download: vi.fn()
    })
    await expect(
      restartedBroker.acquire(host.providerId, { intent: 'test_connection', interactive: true })
    ).resolves.toBeDefined()
  })

  it('keeps network retries independent and closes the breaker after trusted recovery', async () => {
    const successfulResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ComputeConnectionError('host_unreachable'))
      .mockRejectedValueOnce(new ComputeConnectionError('authentication_failed'))
      .mockResolvedValue(successfulResult)
      .mockResolvedValue(successfulResult)
    const adapter = {
      acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
    }
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner: { run: vi.fn() },
      passwordAdapter: adapter
    })

    const networkAttempt = await broker.acquire(host.providerId, { intent: 'job_poll' })
    await expect(networkAttempt.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'host_unreachable'
    })
    await expect(broker.acquire(host.providerId, { intent: 'job_poll' })).resolves.toBeDefined()

    const failingAttempt = await broker.acquire(host.providerId, { intent: 'direct_command' })
    await expect(failingAttempt.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'authentication_failed'
    })
    const testLease = await broker.acquire(host.providerId, {
      intent: 'test_connection',
      interactive: true
    })
    await expect(testLease.run('true', { timeoutMs: 1000 })).resolves.toBe(successfulResult)
    await expect(broker.acquire(host.providerId, { intent: 'job_harvest' })).resolves.toBeDefined()

    const finalFailure = await broker.acquire(host.providerId, { intent: 'direct_command' })
    await expect(finalFailure.run('true', { timeoutMs: 1000 })).resolves.toBe(successfulResult)
    await broker.clearAuthenticationFailure(host.providerId)
    await expect(broker.acquire(host.providerId, { intent: 'job_poll' })).resolves.toBeDefined()
  })

  it('does not let an older failure persistence restore the breaker after a successful test', async () => {
    let releaseFailurePersistence: (() => void) | undefined
    let persistedFailure = false
    const failurePersistenceStarted = new Promise<void>((resolve) => {
      releaseFailurePersistence = resolve
    })
    const persistAuthenticationFailure = vi.fn(async () => {
      await failurePersistenceStarted
      persistedFailure = true
    })
    const clearPersistedAuthenticationFailure = vi.fn(async () => {
      persistedFailure = false
    })
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ComputeConnectionError('authentication_failed'))
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      })
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner: { run: vi.fn() },
      passwordAdapter: {
        acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
      },
      persistAuthenticationFailure,
      clearPersistedAuthenticationFailure
    })

    const failingLease = await broker.acquire(host.providerId, { intent: 'direct_command' })
    const failure = failingLease.run('true', { timeoutMs: 1000 })
    await vi.waitFor(() => expect(persistAuthenticationFailure).toHaveBeenCalledOnce())

    const testLease = await broker.acquire(host.providerId, {
      intent: 'test_connection',
      interactive: true
    })
    const recovery = testLease.run('true', { timeoutMs: 1000 })
    await Promise.resolve()
    expect(clearPersistedAuthenticationFailure).not.toHaveBeenCalled()

    releaseFailurePersistence?.()
    await expect(failure).rejects.toMatchObject({ code: 'authentication_failed' })
    await expect(recovery).resolves.toMatchObject({ exitCode: 0 })
    expect(clearPersistedAuthenticationFailure).toHaveBeenCalledOnce()
    expect(persistedFailure).toBe(false)
  })

  it('does not let an old-revision in-flight failure reopen the current breaker', async () => {
    let revision = 1
    let persistedRevision: number | undefined
    const oldRun = vi.fn().mockRejectedValue(new ComputeConnectionError('authentication_failed'))
    const currentRun = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }))
    const passwordAdapter = {
      acquire: vi
        .fn()
        .mockResolvedValueOnce({ run: oldRun, upload: vi.fn(), download: vi.fn() })
        .mockResolvedValue({ run: currentRun, upload: vi.fn(), download: vi.fn() })
    }
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => ({
        ...host,
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision,
          lastVerifiedAt: undefined
        }
      })),
      runner: { run: vi.fn() },
      passwordAdapter,
      persistAuthenticationFailure: vi.fn(async (failedHost) => {
        if (failedHost.authentication?.revision === revision) {
          persistedRevision = revision
        }
      })
    })
    const oldLease = await broker.acquire(host.providerId, { intent: 'direct_command' })

    revision = 2
    await expect(oldLease.run('old work', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'authentication_failed'
    })

    expect(persistedRevision).toBeUndefined()
    await expect(broker.acquire(host.providerId, { intent: 'job_poll' })).resolves.toBeDefined()
    expect(passwordAdapter.acquire).toHaveBeenCalledTimes(2)
  })

  it('preserves the authentication error when breaker persistence fails', async () => {
    const run = vi.fn().mockRejectedValue(new ComputeConnectionError('authentication_failed'))
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const passwordAdapter = {
      acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
    }
    const reportAuthenticationFailurePersistenceError = vi.fn()
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner: { run: vi.fn() },
      passwordAdapter,
      persistAuthenticationFailure: vi.fn(async () => {
        throw new Error('database unavailable')
      }),
      reportAuthenticationFailurePersistenceError
    })

    const lease = await broker.acquire(host.providerId, { intent: 'direct_command' })
    await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'authentication_failed'
    })
    await expect(broker.acquire(host.providerId, { intent: 'job_poll' })).rejects.toMatchObject({
      code: 'authentication_failed'
    })
    expect(passwordAdapter.acquire).toHaveBeenCalledOnce()
    expect(reportAuthenticationFailurePersistenceError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'database unavailable' })
    )
  })

  it('rejects new leases while Host deletion is armed and becomes retryable when deletion aborts', async () => {
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => host),
      runner: { run: vi.fn() },
      resolveTarget: vi.fn(async () => target)
    })

    await broker.beginHostDeletion('ssh:cluster')

    await expect(broker.acquire('ssh:cluster', { intent: 'probe' })).rejects.toMatchObject({
      code: 'credential_unavailable'
    })

    broker.abortHostDeletion('ssh:cluster')
    await expect(broker.acquire('ssh:cluster', { intent: 'probe' })).resolves.toBeDefined()
  })

  it('invalidates a lease acquired before Host deletion before it can start an operation', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }))
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => host),
      runner: { run },
      resolveTarget: vi.fn(async () => target)
    })
    const lease = await broker.acquire('ssh:cluster', { intent: 'probe' })

    await broker.beginHostDeletion('ssh:cluster')

    await expect(lease.run('true', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'credential_unavailable'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('invalidates an old lease after a successful authentication identity change', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }))
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => host),
      runner: { run },
      resolveTarget: vi.fn(async () => target)
    })
    const oldLease = await broker.acquire(host.providerId, { intent: 'direct_command' })

    broker.invalidateAuthenticationIdentity(host.providerId)

    await expect(oldLease.run('true', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'credential_conflict'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an acquire that crossed the asynchronous Host lookup deletion boundary', async () => {
    let releaseHost!: () => void
    const hostReady = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => {
        await hostReady
        return host
      }),
      runner: { run: vi.fn() },
      resolveTarget: vi.fn(async () => target)
    })

    const acquiring = broker.acquire('ssh:cluster', { intent: 'probe' })
    await broker.beginHostDeletion('ssh:cluster')
    broker.completeHostDeletion('ssh:cluster')
    releaseHost()

    await expect(acquiring).rejects.toMatchObject({ code: 'credential_unavailable' })
  })

  it('drains an operation that already started before Host deletion can continue', async () => {
    let finishRun!: () => void
    const running = new Promise<void>((resolve) => {
      finishRun = resolve
    })
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => host),
      runner: {
        run: vi.fn(async () => {
          await running
          return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
        })
      },
      resolveTarget: vi.fn(async () => target)
    })
    const lease = await broker.acquire('ssh:cluster', { intent: 'probe' })
    const operation = lease.run('true', { timeoutMs: 1_000 })
    let drained = false
    const deletion = broker.beginHostDeletion('ssh:cluster').then(() => {
      drained = true
    })

    await Promise.resolve()
    expect(drained).toBe(false)
    finishRun()
    await operation
    await deletion
    expect(drained).toBe(true)
  })

  it('resolves the registered Host and preserves target, run options, result, and cancellation', async () => {
    const result = {
      exitCode: 0,
      stdout: 'probe complete',
      stderr: '',
      truncated: false,
      timedOut: false
    }
    const runner: SshRunner = { run: vi.fn(async () => result) }
    const resolveTarget = vi.fn(async () => target)
    const getHost = vi.fn(async () => host)
    const broker = new SshConfigComputeConnectionBroker({ getHost, runner, resolveTarget })
    const controller = new AbortController()

    const lease: ComputeConnectionLease = await broker.acquire('ssh:cluster', {
      intent: 'probe',
      signal: controller.signal
    })
    const observed = await lease.run('probe-script', {
      timeoutMs: 30_000,
      loginShell: true,
      maxOutputBytes: 4 * 1024
    })

    expect(getHost).toHaveBeenCalledWith('ssh:cluster')
    expect(resolveTarget).toHaveBeenCalledWith('cluster', host.sshOverrides)
    expect(runner.run).toHaveBeenCalledWith(target, 'probe-script', {
      timeoutMs: 30_000,
      loginShell: true,
      maxOutputBytes: 4 * 1024,
      signal: controller.signal
    })
    expect(observed).toBe(result)
  })

  it('fails before resolution when the registered Host no longer exists', async () => {
    const runner: SshRunner = { run: vi.fn() }
    const resolveTarget = vi.fn(async () => target)
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => null),
      runner,
      resolveTarget
    })

    await expect(broker.acquire('ssh:missing', { intent: 'probe' })).rejects.toThrow(
      'No compute host found'
    )
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('honors cancellation before resolving a Host or opening SSH configuration', async () => {
    const controller = new AbortController()
    controller.abort()
    const getHost = vi.fn(async () => host)
    const resolveTarget = vi.fn(async () => target)
    const broker = new SshConfigComputeConnectionBroker({
      getHost,
      runner: { run: vi.fn() },
      resolveTarget
    })

    await expect(
      broker.acquire('ssh:cluster', { intent: 'probe', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(getHost).not.toHaveBeenCalled()
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it('routes a password Host through the password adapter without opening ssh_config', async () => {
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 3,
        lastVerifiedAt: undefined
      }
    }
    const passwordLease = {
      run: vi.fn(),
      upload: vi.fn(),
      download: vi.fn(),
      redactSensitiveOutputs: vi.fn(async (values: readonly string[]) => [...values])
    } as unknown as ComputeConnectionLease
    const passwordAdapter = { acquire: vi.fn(async () => passwordLease) }
    const resolveTarget = vi.fn(async () => target)
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner: { run: vi.fn() },
      resolveTarget,
      passwordAdapter
    })

    const observedLease = await broker.acquire('ssh:cluster', { intent: 'probe' })
    expect(observedLease).toMatchObject({
      run: expect.any(Function),
      upload: expect.any(Function),
      download: expect.any(Function),
      redactSensitiveOutputs: expect.any(Function)
    })
    await expect(observedLease.redactSensitiveOutputs?.(['tail'])).resolves.toEqual(['tail'])
    expect(passwordAdapter.acquire).toHaveBeenCalledWith(passwordHost, { intent: 'probe' })
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown', 'Host key verification failed.', 'host_key_unknown'],
    ['changed', 'REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host_key_changed']
  ] as const)(
    'checks a %s host key before releasing a stored password',
    async (_state, stderr, code) => {
      const passwordHost = {
        ...host,
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision: 1,
          lastVerifiedAt: undefined
        }
      }
      const withPassword = vi.fn()
      const runner: SshRunner = {
        run: vi.fn(async () => ({
          exitCode: 255,
          stdout: '',
          stderr,
          truncated: false,
          timedOut: false
        }))
      }
      const passwordAdapter = new PasswordSshAdapter(
        { withPassword } as unknown as CredentialVault,
        runner
      )
      const broker = new SshConfigComputeConnectionBroker({
        getHost: vi.fn(async () => passwordHost),
        runner,
        passwordAdapter
      })

      await expect(broker.acquire('ssh:cluster', { intent: 'probe' })).rejects.toMatchObject({
        code
      })
      expect(withPassword).not.toHaveBeenCalled()
    }
  )

  it('rejects proxy-based SSH configuration before releasing a password', async () => {
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const withPassword = vi.fn()
    const runner: SshRunner = { run: vi.fn() }
    const passwordAdapter = new PasswordSshAdapter(
      { withPassword } as unknown as CredentialVault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({ proxyjump: 'bastion' }))
    )
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner,
      passwordAdapter
    })

    await expect(broker.acquire('ssh:cluster', { intent: 'probe' })).rejects.toMatchObject({
      code: 'unsupported_auth_configuration'
    })
    expect(withPassword).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('rejects a successful SSH session unless the one password prompt consumed its capability', async () => {
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const passwordAdapter = new PasswordSshAdapter(
      {} as CredentialVault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => false,
        dispose: async () => undefined
      }))
    )
    const lease = await passwordAdapter.acquireWithPassword(passwordHost, 'unused secret', {
      intent: 'test_connection'
    })

    await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'unsupported_auth_configuration'
    })
  })

  it('builds the password probe target without inherited BatchMode or multiplexing conflicts', async () => {
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const inheritedTarget: ResolvedSshTarget = {
      ...target,
      extraArgs: [
        '-o',
        'User=researcher',
        '-p',
        '2222',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPath=/tmp/shared',
        '-o',
        'ControlPersist=60'
      ]
    }
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('secret')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => inheritedTarget),
      vi.fn(async () => ({})),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      }))
    )
    const lease = await adapter.acquire(host, { intent: 'probe' })

    await lease.run('true', { timeoutMs: 1000 })

    const passwordTarget = vi.mocked(runner.run).mock.calls[1]![0]
    const options = passwordTarget.extraArgs.flatMap((argument, index, args) =>
      argument === '-o' ? [args[index + 1]] : []
    )
    expect(options.filter((option) => option?.startsWith('BatchMode='))).toEqual(['BatchMode=no'])
    expect(options.filter((option) => option?.startsWith('ControlMaster='))).toEqual([
      'ControlMaster=no'
    ])
    expect(options).not.toContain('ControlPath=/tmp/shared')
    expect(options).not.toContain('ControlPersist=60')
  })

  it('does not reread executable SSH configuration after attaching the askpass capability', async () => {
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'connected',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('secret')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => ({
        ...target,
        host: 'cluster-alias',
        extraArgs: ['-o', 'User=researcher', '-p', '2222', '-o', 'ConnectTimeout=10']
      })),
      vi.fn(async () => ({
        hostname: 'login.cluster.example',
        hostkeyalias: 'cluster-host-key',
        userknownhostsfile: '/custom/known_hosts',
        knownhostscommand: '/tmp/credential-consuming-helper'
      })),
      vi.fn(async () => ({
        env: {
          SSH_ASKPASS: '/constrained/helper',
          OPEN_SCIENCE_ASKPASS_CAPABILITY: 'opaque'
        },
        wasAnswered: () => true,
        dispose: async () => undefined
      }))
    )

    const lease = await adapter.acquire(host, { intent: 'direct_command' })
    await lease.run('true', { timeoutMs: 1000 })

    const passwordTarget = vi.mocked(runner.run).mock.calls[1]![0]
    expect(passwordTarget.host).toBe('login.cluster.example')
    expect(passwordTarget.extraArgs).toEqual(
      expect.arrayContaining([
        '-F',
        'none',
        '-o',
        'HostKeyAlias=cluster-host-key',
        '-o',
        'UserKnownHostsFile=/custom/known_hosts'
      ])
    )
    expect(passwordTarget.extraArgs.join(' ')).not.toContain('credential-consuming-helper')
  })

  it('keeps the explicit password username when the SSH alias has the same value', async () => {
    const sameAliasAndUserHost = {
      ...host,
      sshAlias: 'researcher',
      sshOverrides: { user: 'researcher', port: 2222 }
    }
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'connected',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('secret')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => ({
        ...target,
        host: 'researcher',
        extraArgs: ['-p', '2222', '-o', 'ConnectTimeout=10']
      })),
      vi.fn(async () => ({ hostname: 'login.cluster.example' })),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      }))
    )

    const lease = await adapter.acquire(sameAliasAndUserHost, { intent: 'direct_command' })
    await lease.run('true', { timeoutMs: 1000 })

    const passwordTarget = vi.mocked(runner.run).mock.calls[1]![0]
    expect(passwordTarget.host).toBe('login.cluster.example')
    expect(passwordTarget.extraArgs).toEqual(expect.arrayContaining(['-o', 'User=researcher']))
  })

  it('rejects a resolved hostname that SSH could parse as an option before attaching askpass', async () => {
    const runner: SshRunner = {
      run: vi.fn()
    }
    const createAskpass = vi.fn()
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('secret')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => ({
        ...target,
        host: 'cluster-alias',
        extraArgs: ['-o', 'User=researcher', '-p', '2222']
      })),
      vi.fn(async () => ({
        hostname: '-oKnownHostsCommand=/tmp/credential-consuming-helper'
      })),
      createAskpass
    )

    await expect(adapter.acquire(host, { intent: 'direct_command' })).rejects.toMatchObject({
      code: 'unsupported_auth_configuration'
    })
    expect(createAskpass).not.toHaveBeenCalled()
  })

  it('decrypts the persisted credential for the first password Probe after restart', async () => {
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const vault = new CredentialVault(
      {
        getCredential: vi.fn(async () => ({
          ciphertext: Buffer.from('encrypted:restart password')
        }))
      },
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace(/^encrypted:/, '')
      },
      'linux'
    )
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'probe complete',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const createAskpass = vi.fn(async (password: string) => {
      void password
      return {
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      }
    })
    const passwordAdapter = new PasswordSshAdapter(
      vault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      createAskpass
    )
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => passwordHost),
      runner,
      passwordAdapter
    })

    const lease = await broker.acquire('ssh:cluster', { intent: 'probe' })
    await expect(lease.run('probe-script', { timeoutMs: 1000 })).resolves.toMatchObject({
      stdout: 'probe complete'
    })
    expect(createAskpass).toHaveBeenCalledWith(
      'restart password',
      expect.arrayContaining(['researcher@cluster'])
    )
  })

  it('authorizes the effective HostName password prompt when the SSH alias differs', async () => {
    const passwordHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'connected',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const createAskpass = vi.fn(async () => ({
      env: { SSH_ASKPASS: '/constrained/helper' },
      wasAnswered: () => true,
      dispose: async () => undefined
    }))
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('secret')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({ hostname: 'login.cluster.example' })),
      createAskpass
    )

    const lease = await adapter.acquire(passwordHost, { intent: 'probe' })
    await expect(lease.run('true', { timeoutMs: 1000 })).resolves.toMatchObject({
      stdout: 'connected'
    })
    expect(createAskpass).toHaveBeenCalledWith(
      'secret',
      expect.arrayContaining(['researcher@login.cluster.example'])
    )
  })

  it('routes SSH-configuration upload and bounded download through one lease', async () => {
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false })),
      copyFromRemoteBounded: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 12,
        exceeded: false
      }))
    }
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => host),
      runner: { run: vi.fn() },
      scpRunner,
      resolveTarget: vi.fn(async () => target)
    })
    const signal = new AbortController().signal

    const lease = await broker.acquire('ssh:cluster', { intent: 'direct_download', signal })
    await lease.upload('/local/input.csv', '/remote/input.csv')
    await expect(lease.download('/remote/output.csv', '/local/output.csv', 1024)).resolves.toEqual({
      exitCode: 0,
      stderr: '',
      timedOut: false,
      bytesWritten: 12,
      exceeded: false
    })

    expect(scpRunner.copy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['/local/input.csv', 'cluster:/remote/input.csv']),
      expect.any(Number),
      { signal }
    )
    expect(scpRunner.copyFromRemoteBounded).toHaveBeenCalledWith(
      target,
      '/remote/output.csv',
      '/local/output.csv',
      1024,
      expect.any(Number),
      { signal }
    )
  })

  it('uses one constrained password prompt for a transfer and never exposes the secret in args', async () => {
    const secret = 'transfer secret\nUnicode 密码'
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false })),
      copyFromRemoteBounded: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 20,
        exceeded: false
      }))
    }
    const createAskpass = vi.fn(async () => ({
      env: { SSH_ASKPASS: '/constrained/helper', CAPABILITY: 'opaque' },
      wasAnswered: () => true,
      dispose: vi.fn(async () => undefined)
    }))
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation(secret)
        }))
      } as unknown as CredentialVault,
      {
        run: vi.fn(async () => ({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        }))
      },
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      createAskpass,
      scpRunner
    )

    const lease = await adapter.acquire(host, { intent: 'direct_upload' })
    await lease.upload('/local/input.csv', '/remote/input.csv')
    await expect(lease.download('/remote/output.csv', '/local/output.csv', 1024)).resolves.toEqual({
      exitCode: 0,
      stderr: '',
      timedOut: false,
      bytesWritten: 20,
      exceeded: false
    })

    const [binary, args, , options] = vi.mocked(scpRunner.copy).mock.calls[0]!
    expect([binary, ...args].join(' ')).not.toContain(secret)
    expect(options?.env).toEqual({ SSH_ASKPASS: '/constrained/helper', CAPABILITY: 'opaque' })
    expect(scpRunner.copyFromRemoteBounded).toHaveBeenCalledWith(
      expect.anything(),
      '/remote/output.csv',
      '/local/output.csv',
      1024,
      expect.any(Number),
      expect.objectContaining({
        env: { SSH_ASKPASS: '/constrained/helper', CAPABILITY: 'opaque' }
      })
    )
    expect(createAskpass).toHaveBeenCalledWith(
      secret,
      expect.arrayContaining(['researcher@cluster'])
    )
  })

  it('brackets a resolved IPv6 hostname in password-mode SCP upload specs', async () => {
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false }))
    }
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('secret')
        }))
      } as unknown as CredentialVault,
      {
        run: vi.fn(async () => ({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        }))
      },
      vi.fn(async () => target),
      vi.fn(async () => ({ hostname: '2001:db8::1' })),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      })),
      scpRunner
    )

    const lease = await adapter.acquire(host, { intent: 'direct_upload' })
    await lease.upload('/local/input.csv', '/remote/input.csv')

    expect(scpRunner.copy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['/local/input.csv', '[2001:db8::1]:/remote/input.csv']),
      expect.any(Number),
      expect.anything()
    )
  })

  socketAskpass(
    'fails closed after rejecting any interactive variant or repeated target prompt',
    async () => {
      const secret = 'distinctive target-only secret'
      const responses: Array<Record<string, string>> = []
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockImplementationOnce(async (_target, _command, options) => {
            for (const prompt of [
              "Enter passphrase for key '/tmp/id_ed25519':",
              "intruder@other-host's password:",
              "proxy@bastion's password:",
              'Keyboard-interactive authentication:',
              'One-time password (OTP):',
              'MFA verification code:'
            ]) {
              responses.push(await askAskpass(options.env ?? {}, prompt))
            }
            responses.push(await askAskpass(options.env ?? {}, "researcher@cluster's password:"))
            responses.push(await askAskpass(options.env ?? {}, "researcher@cluster's password:"))
            return {
              exitCode: 0,
              stdout: 'ok',
              stderr: '',
              truncated: false,
              timedOut: false
            }
          })
      }
      const adapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) => operation(secret)
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({}))
      )

      const lease = await adapter.acquire(host, { intent: 'direct_command' })
      await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
        code: 'unsupported_auth_configuration'
      })

      expect(responses.slice(0, 6)).toEqual([{}, {}, {}, {}, {}, {}])
      expect(responses[6]).toEqual({ password: secret })
      expect(responses[7]).toEqual({})
    }
  )

  socketAskpass.each([
    ['passphrase', ["Enter passphrase for key '/tmp/id_ed25519':"]],
    ['other-account password', ["proxy@bastion's password:"]],
    ['keyboard-interactive', ['Keyboard-interactive authentication:']],
    ['one-time password', ['One-time password (OTP):']],
    ['MFA', ['MFA verification code:']],
    [
      'repeated target password',
      ["researcher@cluster's password:", "researcher@cluster's password:"]
    ]
  ] as const)(
    'classifies a rejected %s prompt as unsupported when SSH exits with permission denied',
    async (_label, prompts) => {
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockImplementationOnce(async (_target, _command, options) => {
            for (const prompt of prompts) await askAskpass(options.env ?? {}, prompt)
            return {
              exitCode: 255,
              stdout: '',
              stderr: 'Permission denied (password).',
              truncated: false,
              timedOut: false
            }
          })
      }
      const adapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) =>
              operation('prompt-classification-secret')
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({}))
      )

      const lease = await adapter.acquire(host, { intent: 'direct_command' })

      await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
        code: 'unsupported_auth_configuration'
      })
    }
  )

  it.each([
    [
      'network failure',
      {
        exitCode: 255,
        stdout: '',
        stderr: 'ssh: connect to host cluster port 2222: Connection refused',
        truncated: false,
        timedOut: false
      },
      'host_unreachable'
    ],
    [
      'timeout',
      {
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: true
      },
      'timeout'
    ]
  ] as const)(
    'preserves a password-mode %s without a rejected prompt',
    async (_label, result, code) => {
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockResolvedValueOnce(result)
      }
      const adapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) =>
              operation('unused-on-transport-failure')
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({})),
        vi.fn(async () => answeredAskpass())
      )

      const lease = await adapter.acquire(host, { intent: 'direct_command' })

      await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({ code })
    }
  )

  it.each(['direct_command', 'direct_download'] as const)(
    'returns an ordinary password-mode %s remote command failure after authentication succeeds',
    async (intent) => {
      const remoteFailure = {
        exitCode: 1,
        stdout: '',
        stderr: 'remote command failed',
        truncated: false,
        timedOut: false
      }
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockResolvedValueOnce(remoteFailure)
      }
      const adapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) =>
              operation('ordinary-command-failure-secret')
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({})),
        vi.fn(async () => ({
          env: { SSH_ASKPASS: '/constrained/helper' },
          wasAnswered: () => true,
          dispose: async () => undefined
        }))
      )

      const lease = await adapter.acquire(host, { intent })

      await expect(lease.run('false', { timeoutMs: 1000 })).resolves.toEqual(remoteFailure)
    }
  )

  it('preserves password-mode job protocol stdout and redacts parsed payloads on demand', async () => {
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '1\n',
          stderr: 'diagnostic 1',
          truncated: false,
          timedOut: false
        })
    }
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) => operation('1')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      }))
    )

    const lease = await adapter.acquire(host, { intent: 'job_dispatch' })
    const result = await lease.run('launch', { timeoutMs: 1000 })

    expect(result.stdout).toBe('1\n')
    expect(result.stderr).toBe('diagnostic [redacted]')
    await expect(lease.redactSensitiveOutputs?.(['tail 1'])).resolves.toEqual(['tail [redacted]'])
  })

  socketAskpass(
    'keeps an answered target-password failure classified and persisted as authentication_failed',
    async () => {
      const passwordHost = {
        ...host,
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision: 1,
          lastVerifiedAt: undefined
        }
      }
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockImplementationOnce(async (_target, _command, options) => {
            await askAskpass(options.env ?? {}, "researcher@cluster's password:")
            return {
              exitCode: 255,
              stdout: '',
              stderr: 'Permission denied (password).',
              truncated: false,
              timedOut: false
            }
          })
      }
      const passwordAdapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) =>
              operation('incorrect-target-password')
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({}))
      )
      const persistAuthenticationFailure = vi.fn(async () => undefined)
      const broker = new SshConfigComputeConnectionBroker({
        getHost: vi.fn(async () => passwordHost),
        runner,
        passwordAdapter,
        persistAuthenticationFailure
      })

      const lease = await broker.acquire(host.providerId, { intent: 'direct_command' })

      await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
        code: 'authentication_failed'
      })
      expect(persistAuthenticationFailure).toHaveBeenCalledWith(passwordHost)
    }
  )

  socketAskpass(
    'does not persist a rejected proxy prompt as an authentication failure',
    async () => {
      const passwordHost = {
        ...host,
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision: 1,
          lastVerifiedAt: undefined
        }
      }
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockImplementationOnce(async (_target, _command, options) => {
            await askAskpass(options.env ?? {}, "proxy@bastion's password:")
            return {
              exitCode: 255,
              stdout: '',
              stderr: 'Permission denied (password).',
              truncated: false,
              timedOut: false
            }
          })
      }
      const passwordAdapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) =>
              operation('must-not-be-released')
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({}))
      )
      const persistAuthenticationFailure = vi.fn(async () => undefined)
      const broker = new SshConfigComputeConnectionBroker({
        getHost: vi.fn(async () => passwordHost),
        runner,
        passwordAdapter,
        persistAuthenticationFailure
      })

      const lease = await broker.acquire(host.providerId, { intent: 'direct_command' })

      await expect(lease.run('true', { timeoutMs: 1000 })).rejects.toMatchObject({
        code: 'unsupported_auth_configuration'
      })
      expect(persistAuthenticationFailure).not.toHaveBeenCalled()
    }
  )

  it('returns a stable authentication error without raw transfer diagnostics', async () => {
    const rawDiagnostic = 'Permission denied (password). helper=/private/path secret=do-not-leak'
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operation: (password: string) => Promise<unknown>) =>
            operation('do-not-leak')
        }))
      } as unknown as CredentialVault,
      {
        run: vi.fn(async () => ({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        }))
      },
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      })),
      {
        copy: vi.fn(async () => ({ exitCode: 255, stderr: rawDiagnostic, timedOut: false }))
      }
    )

    const lease = await adapter.acquire(host, { intent: 'direct_upload' })
    const failure = await lease.upload('/local/input', '/remote/input').catch((error) => error)

    expect(failure).toMatchObject({ code: 'authentication_failed' })
    expect(failure.message).toBe('Authentication failed. Verify the username and password.')
    expect(failure.message).not.toContain('do-not-leak')
    expect(failure.message).not.toContain('/private/path')
  })

  it('returns an ordinary remote status while redacting the saved password from its output', async () => {
    const rawDiagnostic = 'remote command failed: release-gate-secret at /private/helper'
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 42,
          stdout: '',
          stderr: rawDiagnostic,
          truncated: false,
          timedOut: false
        })
    }
    const adapter = new PasswordSshAdapter(
      {
        acquirePasswordLease: vi.fn(async () => ({
          withPassword: (operationWithPassword: (password: string) => Promise<unknown>) =>
            operationWithPassword('release-gate-secret')
        }))
      } as unknown as CredentialVault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      vi.fn(async () => ({
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      }))
    )
    const lease = await adapter.acquire(host, { intent: 'direct_command' })

    const result = await lease.run('true', { timeoutMs: 1000 })

    expect(result).toMatchObject({
      exitCode: 42,
      stderr: 'remote command failed: [redacted] at /private/helper'
    })
    expect(result.stderr).not.toContain('release-gate-secret')
  })

  it.each(['upload', 'download'] as const)(
    'fails closed with a safe code when password %s returns unclassified diagnostics',
    async (operation) => {
      const rawDiagnostic = 'vendor helper crashed: release-gate-secret at /private/helper'
      const runner: SshRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 255,
            stdout: '',
            stderr: 'Permission denied',
            truncated: false,
            timedOut: false
          })
          .mockResolvedValueOnce({
            exitCode: 42,
            stdout: '',
            stderr: rawDiagnostic,
            truncated: false,
            timedOut: false
          })
      }
      const scpRunner: ScpRunner = {
        copy: vi.fn(async () => ({ exitCode: 42, stderr: rawDiagnostic, timedOut: false })),
        copyFromRemoteBounded: vi.fn(async () => ({
          exitCode: 42,
          stderr: rawDiagnostic,
          timedOut: false,
          bytesWritten: 0,
          exceeded: false
        }))
      }
      const adapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: vi.fn(async () => ({
            withPassword: (operationWithPassword: (password: string) => Promise<unknown>) =>
              operationWithPassword('release-gate-secret')
          }))
        } as unknown as CredentialVault,
        runner,
        vi.fn(async () => target),
        vi.fn(async () => ({})),
        vi.fn(async () => ({
          env: { SSH_ASKPASS: '/constrained/helper' },
          wasAnswered: () => true,
          dispose: async () => undefined
        })),
        scpRunner
      )
      const lease = await adapter.acquire(host, {
        intent: `direct_${operation}`
      })

      const failure = await (
        operation === 'upload'
          ? lease.upload('/local/input', '/remote/input')
          : lease.download('/remote/output', '/local/output', 1024)
      ).catch((error) => error)

      expect(failure).toMatchObject({ code: 'unsupported_auth_configuration' })
      expect(failure.message).not.toContain(rawDiagnostic)
      expect(failure.message).not.toContain('release-gate-secret')
    }
  )

  it('binds a password lease to the credential snapshot for its authentication revision', async () => {
    let ciphertext = Buffer.from('encrypted:revision-one')
    let credentialRevision = 1
    const getCredential = vi.fn(async () => ({ ciphertext, revision: credentialRevision }))
    const vault = new CredentialVault(
      { getCredential },
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace(/^encrypted:/, '')
      },
      'linux'
    )
    const usedPasswords: string[] = []
    const createAskpass = vi.fn(async (password: string) => {
      usedPasswords.push(password)
      return {
        env: { SSH_ASKPASS: '/constrained/helper' },
        wasAnswered: () => true,
        dispose: async () => undefined
      }
    })
    const runner: SshRunner = {
      run: vi.fn(async (_target, command) => ({
        exitCode: command === 'exit 0' ? 255 : 0,
        stdout: '',
        stderr: command === 'exit 0' ? 'Permission denied' : '',
        truncated: false,
        timedOut: false
      }))
    }
    const adapter = new PasswordSshAdapter(
      vault,
      runner,
      vi.fn(async () => target),
      vi.fn(async () => ({})),
      createAskpass
    )
    const revisionOneHost = {
      ...host,
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 1,
        lastVerifiedAt: undefined
      }
    }
    const oldLease = await adapter.acquire(revisionOneHost, { intent: 'direct_command' })

    ciphertext = Buffer.from('encrypted:revision-two')
    credentialRevision = 2
    const newLease = await adapter.acquire(
      {
        ...revisionOneHost,
        authentication: { ...revisionOneHost.authentication, revision: 2 }
      },
      { intent: 'direct_command' }
    )

    await oldLease.run('old operation', { timeoutMs: 1000 })
    await newLease.run('new operation', { timeoutMs: 1000 })
    expect(usedPasswords).toEqual(['revision-one', 'revision-two'])
    await expect(
      adapter.acquire(revisionOneHost, { intent: 'direct_command' })
    ).rejects.toMatchObject({ code: 'credential_conflict' })
    expect(getCredential).toHaveBeenNthCalledWith(1, 'host-1')
    expect(getCredential).toHaveBeenNthCalledWith(2, 'host-1')
  })
})
