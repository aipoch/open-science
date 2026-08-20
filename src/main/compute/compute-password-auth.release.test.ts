import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
  shell: { showItemInFolder: () => undefined },
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => tmpdir()
  }
}))

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { errorLogFields } from '../logger'
import { ComputeHostProfileOwner } from './compute-host-profile-owner'
import { PasswordSshAdapter } from './connection-adapters'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { CredentialVault, type ComputeCredentialCipher } from './credential-vault'
import { createComputeHandlers } from './ipc'
import { dispatchJob } from './job-dispatcher'
import { ComputeJobRepository } from './job-repository'
import { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'

const protectedTestCipher: ComputeCredentialCipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5)),
  decryptString: (value) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString('utf8')
}

const readFilesRecursively = async (directory: string): Promise<Buffer[]> => {
  const values: Buffer[] = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if ((await stat(path)).isDirectory()) values.push(...(await readFilesRecursively(path)))
    else values.push(await readFile(path))
  }
  return values
}

describe('Compute password authentication release gate', () => {
  let storageRoot: string | undefined
  let disconnect: (() => Promise<void>) | undefined

  afterEach(async () => {
    await disconnect?.()
    disconnect = undefined
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  })

  it('round-trips a distinctive long password without crossing public, disk, argv, or env seams', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-password-release-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const secret = `spaces and 'single' "double" quotes\nUnicode 密碼 🧬 ${'長'.repeat(1024)}`
    const repository = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    const vault = new CredentialVault(repository, protectedTestCipher, 'linux')
    const childEnvironments: NodeJS.ProcessEnv[] = []
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
      vault,
      runner,
      vi.fn(async () => ({ sshBinary: 'ssh', host: 'cluster', extraArgs: [] })),
      vi.fn(async () => ({})),
      vi.fn(async (password: string) => {
        expect(password).toBe(secret)
        const env = { SSH_ASKPASS: '/constrained/helper', OPAQUE_CAPABILITY: 'capability' }
        childEnvironments.push(env)
        return {
          env,
          wasAnswered: () => true,
          dispose: async () => undefined
        }
      })
    )
    const handlers = createComputeHandlers(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      jobRepository,
      undefined,
      undefined,
      storageRoot,
      undefined,
      undefined,
      undefined,
      { vault, passwordAdapter }
    )

    const created = await handlers.createPassword({
      sshAlias: 'cluster',
      authenticationMode: 'password',
      username: 'researcher',
      port: 22,
      password: secret,
      operationId: 'release-gate-create'
    })
    const listed = await handlers.list()
    const fetched = await handlers.get('ssh:cluster')
    const publicValues = JSON.stringify({ created, listed, fetched })

    expect(created).toMatchObject({
      ok: true,
      host: {
        providerId: 'ssh:cluster',
        authentication: { mode: 'password', credentialStatus: 'configured', revision: 1 }
      }
    })
    expect(publicValues).not.toContain(secret)
    expect(publicValues).not.toMatch(/ciphertext|credentialRef|passwordMask|passwordLength/)

    const runnerCalls = JSON.stringify(vi.mocked(runner.run).mock.calls)
    expect(runnerCalls).not.toContain(secret)
    expect(JSON.stringify(childEnvironments)).not.toContain(secret)
    expect(childEnvironments).toEqual([
      { SSH_ASKPASS: '/constrained/helper', OPAQUE_CAPABILITY: 'capability' }
    ])

    const rows = await client.$queryRaw<Array<{ ciphertext: Uint8Array }>>`
      SELECT "ciphertext" FROM "ComputeCredential"
    `
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]!.ciphertext).toString('utf8')).not.toContain(secret)

    const databaseBytes = await readFile(join(storageRoot, 'open-science.db'))
    expect(databaseBytes.includes(Buffer.from(secret, 'utf8'))).toBe(false)

    const makeFailingBroker = (): {
      broker: SshConfigComputeConnectionBroker
      runner: SshRunner
    } => {
      const failingRunner: SshRunner = {
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
            stderr: `vendor diagnostic accidentally included ${secret}`,
            truncated: false,
            timedOut: false
          })
      }
      const adapter = new PasswordSshAdapter(
        vault,
        failingRunner,
        vi.fn(async () => ({ sshBinary: 'ssh', host: 'cluster', extraArgs: [] })),
        vi.fn(async () => ({})),
        vi.fn(async (candidate: string) => {
          expect(candidate).toBe(secret)
          return {
            env: { SSH_ASKPASS: '/constrained/helper', OPAQUE_CAPABILITY: 'capability' },
            wasAnswered: () => true,
            dispose: async () => undefined
          }
        })
      )
      return {
        broker: new SshConfigComputeConnectionBroker({
          getHost: (providerId) => repository.get(providerId),
          runner: failingRunner,
          passwordAdapter: adapter
        }),
        runner: failingRunner
      }
    }

    const probeFailure = makeFailingBroker()
    const probe = await new ComputeHostProfileOwner(probeFailure.broker, repository).probe(
      'ssh:cluster'
    )
    expect(JSON.stringify(probe)).not.toContain(secret)
    expect(probe).toMatchObject({ ok: false, authenticationCode: 'unsupported_auth_configuration' })

    await jobRepository.create({
      id: 'release-gate-job',
      providerId: 'ssh:cluster',
      shape: 'direct_ssh',
      sessionId: 'release-session',
      projectId: 'release-project',
      intent: 'release gate',
      command: 'true',
      commandHash: 'release-gate-hash',
      initialStatus: 'submitted'
    })
    const jobFailure = makeFailingBroker()
    await dispatchJob('release-gate-job', {
      connectionBroker: jobFailure.broker,
      hostRepository: repository,
      jobRepository
    })
    const job = await jobRepository.get('release-gate-job')
    expect(JSON.stringify(job)).not.toContain(secret)
    expect(job).toMatchObject({
      status: 'error',
      error_code: 'dispatch_failed',
      stderr_tail: 'The remote Compute Job launcher failed.'
    })

    const diagnosticFailure = makeFailingBroker()
    const diagnosticLease = await diagnosticFailure.broker.acquire('ssh:cluster', {
      intent: 'direct_command'
    })
    const safeFailure = await diagnosticLease
      .run('true', { timeoutMs: 1000, loginShell: false, maxOutputBytes: 4096 })
      .catch((error: unknown) => error)
    const diagnostics = JSON.stringify({
      ipcError: safeFailure,
      logFields: errorLogFields(safeFailure),
      crashMetadata: {
        name: safeFailure instanceof Error ? safeFailure.name : 'Error',
        message: safeFailure instanceof Error ? safeFailure.message : String(safeFailure)
      }
    })
    expect(diagnostics).not.toContain(secret)
    expect(diagnostics).toContain('[redacted]')

    const settingsDocument = await readFile(join(storageRoot, 'settings.json')).catch(() =>
      Buffer.alloc(0)
    )
    expect(settingsDocument.includes(Buffer.from(secret, 'utf8'))).toBe(false)
    for (const persistedFile of await readFilesRecursively(storageRoot)) {
      expect(persistedFile.includes(Buffer.from(secret, 'utf8'))).toBe(false)
    }
    expect(
      JSON.stringify([
        ...vi.mocked(runner.run).mock.calls,
        ...vi.mocked(probeFailure.runner.run).mock.calls,
        ...vi.mocked(jobFailure.runner.run).mock.calls,
        ...vi.mocked(diagnosticFailure.runner.run).mock.calls
      ])
    ).not.toContain(secret)
  })
})
