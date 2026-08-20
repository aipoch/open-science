// Environment-gated release certification for a real password-capable SSH Host. It is skipped by
// default and requires an alias that also has a working SSH-configuration login for switch coverage.
//
// RUN_COMPUTE_PASSWORD_AUTH=1 \
// COMPUTE_PASSWORD_TEST_ALIAS=cluster \
// COMPUTE_PASSWORD_TEST_USERNAME=researcher \
// COMPUTE_PASSWORD_TEST_PORT=22 \
// COMPUTE_PASSWORD_TEST_HOSTNAME=login.cluster.example \
// COMPUTE_PASSWORD_TEST_PASSWORD='...' \
// npx vitest run src/main/compute/compute-password-auth.real-ssh.integration.test.ts

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { PasswordSshAdapter } from './connection-adapters'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { CredentialVault, type ComputeCredentialCipher } from './credential-vault'
import { harvestJob } from './harvest-engine'
import { createComputeHandlers } from './ipc'
import { ComputeJobRepository } from './job-repository'
import { JobPoller } from './job-poller'
import { ComputeHostRepository } from './repository'
import { SystemScpRunner } from './scp-runner'
import { readEffectiveConfig, resolveSshBinary, SystemSshRunner } from './ssh-runner'

const alias = process.env['COMPUTE_PASSWORD_TEST_ALIAS'] ?? ''
const username = process.env['COMPUTE_PASSWORD_TEST_USERNAME'] ?? ''
const password = process.env['COMPUTE_PASSWORD_TEST_PASSWORD'] ?? ''
const effectiveHostname = process.env['COMPUTE_PASSWORD_TEST_HOSTNAME'] ?? ''
const port = Number(process.env['COMPUTE_PASSWORD_TEST_PORT'] ?? '22')
const enabled =
  process.env['RUN_COMPUTE_PASSWORD_AUTH'] === '1' &&
  alias.length > 0 &&
  username.length > 0 &&
  password.length > 0 &&
  Number.isSafeInteger(port) &&
  port >= 1 &&
  port <= 65535
const describeIf = enabled ? describe : describe.skip

const testCipher: ComputeCredentialCipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a)),
  decryptString: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString('utf8')
}

describeIf('Compute password authentication real SSH certification', () => {
  let storageRoot = ''
  let client: ReturnType<typeof createProjectDbClient>

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-password-real-ssh-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
  })

  afterAll(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('certifies connection, transfer, Job recovery, reset, auth switch, and cleanup', async () => {
    if (effectiveHostname) {
      await expect(readEffectiveConfig(alias, resolveSshBinary())).resolves.toMatchObject({
        hostname: effectiveHostname
      })
      expect(alias).not.toBe(effectiveHostname)
    }
    const repository = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    const runner = new SystemSshRunner()
    const scpRunner = new SystemScpRunner()
    const vault = new CredentialVault(repository, testCipher, 'linux')
    const passwordAdapter = new PasswordSshAdapter(
      vault,
      runner,
      undefined,
      undefined,
      undefined,
      scpRunner
    )
    const broker = new SshConfigComputeConnectionBroker({
      getHost: (providerId) => repository.get(providerId),
      runner,
      scpRunner,
      passwordAdapter
    })
    const approval = new ComputeApprovalBroker({
      broadcast: () => undefined,
      generateId: () => 'real-password-job-approval',
      timeoutMs: 5000
    })
    const originalRequest = approval.requestWithContext.bind(approval)
    approval.requestWithContext = async (info, context) => {
      const pending = originalRequest(info, context)
      setImmediate(() => approval.respond('real-password-job-approval', 'once'))
      return pending
    }
    const handlers = createComputeHandlers(
      repository,
      undefined,
      undefined,
      approval,
      undefined,
      jobRepository,
      undefined,
      undefined,
      storageRoot,
      undefined,
      undefined,
      undefined,
      { vault, passwordAdapter, connectionBroker: broker }
    )
    const creation = await handlers.createPassword({
      operationId: 'real-ssh-create',
      sshAlias: alias,
      authenticationMode: 'password',
      username,
      port,
      password
    })
    if (!creation.ok) throw new Error(`Real password Host creation failed: ${creation.errorCode}`)
    const host = creation.host

    const remoteFixture = `/tmp/open-science-password-${randomUUID()}`
    const localFixture = join(storageRoot, 'distinctive local fixture.txt')
    const downloadedFixture = join(storageRoot, 'downloaded fixture.txt')
    await writeFile(localFixture, 'password transport certification\n')
    const connection = await broker.acquire(host.providerId, {
      intent: 'test_connection',
      interactive: true
    })
    await expect(
      connection.run(`mkdir -p '${remoteFixture}' && printf connected`, {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4096
      })
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'connected' })
    await connection.upload(localFixture, `${remoteFixture}/fixture.txt`)
    await connection.download(`${remoteFixture}/fixture.txt`, downloadedFixture, 1024 * 1024)
    await expect(readFile(downloadedFixture, 'utf8')).resolves.toBe(
      'password transport certification\n'
    )

    // A new Vault and Broker prove that no process-local password cache is required after restart.
    const restartedVault = new CredentialVault(repository, testCipher, 'linux')
    const restartedBroker = new SshConfigComputeConnectionBroker({
      getHost: (providerId) => repository.get(providerId),
      runner,
      scpRunner,
      passwordAdapter: new PasswordSshAdapter(
        restartedVault,
        runner,
        undefined,
        undefined,
        undefined,
        scpRunner
      )
    })
    const restartedConnection = await restartedBroker.acquire(host.providerId, {
      intent: 'direct_command'
    })
    await expect(
      restartedConnection.run('printf restarted', {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4096
      })
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'restarted' })

    const service = handlers.computeService
    const submitted = await service.submitJob(
      host.providerId,
      'password release certification',
      'printf job-complete > result.txt',
      { timeoutSeconds: 60 },
      { sessionId: 'password-e2e-session', projectId: 'password-e2e-project' }
    )
    const poller = new JobPoller({
      connectionBroker: restartedBroker,
      hostRepository: repository,
      jobRepository
    })
    const deadline = Date.now() + 120_000
    let completed = await jobRepository.get(submitted.job_id)
    while (completed && !['success', 'failed', 'timeout', 'error'].includes(completed.status)) {
      if (Date.now() > deadline)
        throw new Error('Real password Compute Job did not finish in time.')
      await poller.tick()
      completed = await jobRepository.get(submitted.job_id)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    expect(completed?.status).toBe('success')
    await harvestJob(completed!, {
      connectionBroker: restartedBroker,
      hostRepository: repository,
      jobRepository,
      storageRoot
    })
    expect((await jobRepository.get(submitted.job_id))?.harvested_at).toBeTruthy()

    // Revalidating the same server password still exercises the atomic revision swap used for a
    // real rotation, without requiring the certification account to support two passwords at once.
    const candidate = await passwordAdapter.acquireWithPassword(host, password, {
      intent: 'test_connection',
      interactive: true
    })
    await candidate.run('true', {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4096
    })
    const resetResult = await handlers.resetPassword({
      providerId: host.providerId,
      operationId: 'real-ssh-reset',
      expectedAuthenticationRevision: 1,
      password
    })
    if (!resetResult.ok) throw new Error(`Real password reset failed: ${resetResult.errorCode}`)
    const reset = resetResult.host
    expect(reset.authentication?.revision).toBe(2)

    // The alias must also support its existing SSH configuration for this candidate switch. Both
    // directions go through the local handler/AuthOwner seam, including revision and Job guards.
    const switchToSsh = await handlers.changeAuthentication({
      providerId: host.providerId,
      operationId: 'real-ssh-switch',
      expectedRevision: 2,
      authenticationMode: 'ssh_config',
      username,
      port
    })
    if (!switchToSsh.ok) throw new Error(`Real SSH switch failed: ${switchToSsh.errorCode}`)
    const switched = switchToSsh.host
    expect(switched.authentication).toMatchObject({ mode: 'ssh_config', revision: 3 })
    await expect(repository.getCredential(host.id)).resolves.toBeNull()

    const switchBack = await handlers.changeAuthentication({
      providerId: host.providerId,
      operationId: 'real-password-switch-back',
      expectedRevision: 3,
      authenticationMode: 'password',
      username,
      port,
      password
    })
    if (!switchBack.ok) throw new Error(`Real password switch failed: ${switchBack.errorCode}`)
    expect(switchBack.host.authentication).toMatchObject({ mode: 'password', revision: 4 })
    const finalConnection = await broker.acquire(host.providerId, { intent: 'job_cleanup' })
    await finalConnection.run(`rm -rf '${remoteFixture}' '${submitted.remote_workdir}'`, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4096
    })
    await handlers.delete(host.providerId, { allowPasswordCredentialDeletion: true })
    await expect(repository.get(host.providerId)).resolves.toBeNull()
  }, 240_000)
})
