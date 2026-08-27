import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ComputeJobRepository } from './job-repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeConnectionError, type ComputeConnectionBrokerAcquirer } from './connection-broker'
import { dispatchJob } from './job-dispatcher'
import { ComputeHostRepository } from './repository'
import { OptionalSecureStorageStringProtection, type SecureStorageCipher } from './credential-vault'

// Exercises ComputeJobRepository against the current application schema in a real SQLite database.
// Schema migration behavior is owned by src/main/database/migration-service.test.ts.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

const testCipher = (overrides: Partial<SecureStorageCipher> = {}): SecureStorageCipher => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) =>
    Buffer.from(Array.from(Buffer.from(value, 'utf8'), (byte) => byte ^ 0x5a)),
  decryptString: (value) => Buffer.from(Array.from(value, (byte) => byte ^ 0x5a)).toString('utf8'),
  ...overrides
})

const protectedFields = (
  cipher: SecureStorageCipher = testCipher()
): OptionalSecureStorageStringProtection =>
  new OptionalSecureStorageStringProtection(cipher, 'linux')

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('ComputeJob repository (SQLite integration)', () => {
  it('persists credential conflicts reported while dispatching a migrated job', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-credential-conflict-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const hostRepository = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    const host = await hostRepository.create({ sshAlias: 'credential-conflict-host' })
    await jobRepository.create({
      id: 'credential-conflict-job',
      providerId: host.providerId,
      shape: 'direct_ssh',
      sessionId: 'credential-conflict-session',
      projectId: 'credential-conflict-project',
      intent: 'verify credentials',
      command: 'true',
      commandHash: 'credential-conflict-hash',
      initialStatus: 'submitted'
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: async () => {
        throw new ComputeConnectionError('credential_conflict')
      }
    }

    await dispatchJob('credential-conflict-job', {
      connectionBroker,
      hostRepository,
      jobRepository
    })

    expect(await jobRepository.get('credential-conflict-job')).toMatchObject({
      status: 'error',
      error_code: 'credential_conflict'
    })
  })

  it('round-trips CRUD', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Fresh DB: no jobs.
    expect(await repo.findNonTerminal()).toEqual([])

    // Create a job with all required fields.
    const created = await repo.create({
      id: 'test-job-1',
      providerId: 'ssh:biowulf',
      shape: 'direct_ssh',
      sessionId: 'sess-1',
      projectId: 'proj-1',
      intent: 'smoke test',
      command: 'echo hello',
      commandHash: 'abc123',
      timeoutSeconds: 3600,
      remoteWorkdir: '~/.openscience/jobs/test-job-1'
    })

    expect(created.job_id).toBe('test-job-1')
    expect(created.provider_id).toBe('ssh:biowulf')
    expect(created.status).toBe('submitted')
    expect(created.command).toBe('echo hello')
    expect(created.timeout_seconds).toBe(3600)
    expect(created.remote_workdir).toBe('~/.openscience/jobs/test-job-1')
    expect(created.created_at).toBeGreaterThan(0)
    expect(created.submitted_at).toBeGreaterThan(0)

    // get() round-trips.
    const fetched = await repo.get('test-job-1')
    expect(fetched?.status).toBe('submitted')
    expect(fetched?.session_id).toBe('sess-1')

    // findNonTerminal includes submitted jobs.
    const nonTerminal = await repo.findNonTerminal()
    expect(nonTerminal).toHaveLength(1)
    expect(nonTerminal[0]!.job_id).toBe('test-job-1')

    // update status to running.
    const updated = await repo.update('test-job-1', {
      status: 'running',
      remoteHandle: JSON.stringify({ pid: 1234, workdir: '~/.openscience/jobs/test-job-1' }),
      startedAt: new Date()
    })
    expect(updated.status).toBe('running')
    expect(updated.started_at).toBeGreaterThan(0)

    // update to terminal.
    await repo.update('test-job-1', {
      status: 'success',
      exitCode: 0,
      stdoutTail: 'hello\n',
      stderrTail: '',
      finishedAt: new Date()
    })

    // Terminal jobs not returned by findNonTerminal.
    expect(await repo.findNonTerminal()).toHaveLength(0)

    // hasActiveJobsForProvider.
    expect(await repo.hasActiveJobsForProvider('ssh:biowulf')).toBe(false)
  })

  it('does not persist Compute Job execution secrets as plaintext', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-secret-persistence-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client), protectedFields())
    const intentSecret = 'intent-token-regression-value'
    const commandSecret = 'command-token-regression-value'
    const environmentSecret = 'environment-token-regression-value'
    const outputSecret = 'output-token-regression-value'

    await repo.create({
      id: 'secret-job',
      providerId: 'ssh:secret-host',
      shape: 'direct_ssh',
      sessionId: 'secret-session',
      projectId: 'secret-project',
      intent: `verify persisted job confidentiality ${intentSecret}`,
      command: `curl -H "Authorization: Bearer ${commandSecret}" https://example.invalid`,
      commandHash: 'secret-command-hash',
      environment: JSON.stringify({ API_TOKEN: environmentSecret }),
      resourceRequest: JSON.stringify({ account: environmentSecret }),
      inputManifest: JSON.stringify([
        {
          kind: 'upload',
          localPath: `/private/research/${environmentSecret}/input.csv`,
          dstFilename: 'input.csv',
          label: 'input.csv'
        }
      ]),
      outputManifest: JSON.stringify([{ pattern: `*.${environmentSecret}` }]),
      harvestConfig: JSON.stringify({ label: environmentSecret }),
      remoteWorkdir: `/scratch/${environmentSecret}/secret-job`
    })
    await repo.update('secret-job', {
      status: 'success',
      remoteHandle: JSON.stringify({ id: environmentSecret }),
      stdoutTail: `request completed with ${outputSecret}`,
      stderrTail: `request failed with ${outputSecret}`,
      lastPollError: `poll failed with ${outputSecret}`,
      harvestedAt: new Date(),
      harvestError: `harvest failed with ${outputSecret}`,
      leftOnRemote: JSON.stringify([{ reason: outputSecret }])
    })

    const [stored] = await client.$queryRaw<
      Array<Record<string, string | null>>
    >`SELECT "intent", "command", "environment", "resourceRequest", "inputManifest",
      "outputManifest", "harvestConfig", "remoteWorkdir", "remoteHandle", "stdoutTail",
      "stderrTail", "lastPollError", "harvestError", "leftOnRemote"
      FROM "ComputeJob" WHERE "id" = 'secret-job'`
    const persistedExecutionData = JSON.stringify(stored)

    expect(persistedExecutionData).not.toContain(intentSecret)
    expect(persistedExecutionData).not.toContain(commandSecret)
    expect(persistedExecutionData).not.toContain(environmentSecret)
    expect(persistedExecutionData).not.toContain(outputSecret)

    await expect(repo.get('secret-job')).resolves.toMatchObject({
      intent: `verify persisted job confidentiality ${intentSecret}`,
      command: `curl -H "Authorization: Bearer ${commandSecret}" https://example.invalid`,
      environment: JSON.stringify({ API_TOKEN: environmentSecret }),
      stdout_tail: `request completed with ${outputSecret}`,
      stderr_tail: `request failed with ${outputSecret}`
    })
  })

  it('continues to read legacy plaintext Compute Job rows without rewriting them', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-legacy-plaintext-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    await client.computeJob.create({
      data: {
        id: 'legacy-job',
        providerId: 'ssh:legacy-host',
        shape: 'direct_ssh',
        sessionId: 'legacy-session',
        projectId: 'legacy-project',
        status: 'queued',
        intent: 'legacy intent',
        command: 'echo legacy plaintext',
        commandHash: 'legacy-command-hash'
      }
    })
    const repo = new ComputeJobRepository(() => Promise.resolve(client), protectedFields())

    await expect(repo.get('legacy-job')).resolves.toMatchObject({
      intent: 'legacy intent',
      command: 'echo legacy plaintext'
    })
    const stored = await client.computeJob.findUniqueOrThrow({ where: { id: 'legacy-job' } })
    expect(stored.command).toBe('echo legacy plaintext')
  })

  it('allows plaintext persistence when secure storage is unavailable', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-unprotected-fallback-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(
      () => Promise.resolve(client),
      protectedFields(testCipher({ getSelectedStorageBackend: () => 'basic_text' }))
    )
    expect(repo.isFieldProtectionAvailable()).toBe(false)

    await expect(
      repo.create({
        id: 'fallback-job',
        providerId: 'ssh:fallback-host',
        shape: 'direct_ssh',
        sessionId: 'fallback-session',
        projectId: 'fallback-project',
        intent: 'fallback intent',
        command: 'echo fallback plaintext',
        commandHash: 'fallback-command-hash'
      })
    ).resolves.toMatchObject({ command: 'echo fallback plaintext' })

    const stored = await client.computeJob.findUniqueOrThrow({ where: { id: 'fallback-job' } })
    expect(stored.command).toBe('echo fallback plaintext')
  })

  it('fails safely when protected job data cannot be decrypted', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-unreadable-protection-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const writer = new ComputeJobRepository(() => Promise.resolve(client), protectedFields())
    await writer.create({
      id: 'unreadable-job',
      providerId: 'ssh:unreadable-host',
      shape: 'direct_ssh',
      sessionId: 'unreadable-session',
      projectId: 'unreadable-project',
      intent: 'unreadable intent',
      command: 'echo secret-that-must-not-become-ciphertext-command',
      commandHash: 'unreadable-command-hash'
    })

    const reader = new ComputeJobRepository(
      () => Promise.resolve(client),
      protectedFields(
        testCipher({
          decryptString: () => {
            throw new Error('machine-bound key is unavailable')
          }
        })
      )
    )

    await expect(reader.get('unreadable-job')).rejects.toThrow(
      'Protected application data cannot be decrypted on this system.'
    )
  })

  it('findNonTerminalByProvider returns only jobs for the given provider', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-provider-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    await repo.create({
      id: 'job-a',
      providerId: 'ssh:host-a',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'a',
      command: 'echo a',
      commandHash: 'hash-a'
    })
    await repo.create({
      id: 'job-b',
      providerId: 'ssh:host-b',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'b',
      command: 'echo b',
      commandHash: 'hash-b'
    })

    const forHostA = await repo.findNonTerminalByProvider('ssh:host-a')
    expect(forHostA).toHaveLength(1)
    expect(forHostA[0]!.job_id).toBe('job-a')

    const forHostB = await repo.findNonTerminalByProvider('ssh:host-b')
    expect(forHostB).toHaveLength(1)
    expect(forHostB[0]!.job_id).toBe('job-b')
  })

  it('round-trips the 4 new Phase 3b columns (harvestError, leftOnRemote, notifiedAt, notificationConsumedAt)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-3b-columns-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    const created = await repo.create({
      id: 'job-3b',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'harvest test',
      command: 'echo done',
      commandHash: 'abc'
    })

    // New columns start as undefined.
    expect(created.harvest_error).toBeUndefined()
    expect(created.left_on_remote).toBeUndefined()
    expect(created.notified_at).toBeUndefined()
    expect(created.notification_consumed_at).toBeUndefined()

    // Write all 4 new columns.
    const leftOnRemoteJson = JSON.stringify([
      { uri: 'ssh://host/path/big.bin', size_mb: 250, reason: 'exceeds_max_file_mb' }
    ])
    const notifiedAt = new Date('2026-07-21T10:00:00Z')
    const consumedAt = new Date('2026-07-21T10:01:00Z')

    const updated = await repo.update('job-3b', {
      status: 'success',
      harvestedAt: new Date('2026-07-21T09:59:00Z'),
      harvestError: 'partial harvest: scp failed for 1 file',
      leftOnRemote: leftOnRemoteJson,
      notifiedAt,
      notificationConsumedAt: consumedAt
    })

    expect(updated.harvested_at).toBeGreaterThan(0)
    expect(updated.harvest_error).toBe('partial harvest: scp failed for 1 file')
    expect(updated.left_on_remote).toBe(leftOnRemoteJson)
    expect(updated.notified_at).toBe(notifiedAt.getTime())
    expect(updated.notification_consumed_at).toBe(consumedAt.getTime())

    // Read back via get() to verify persistence.
    const fetched = await repo.get('job-3b')
    expect(fetched!.harvest_error).toBe('partial harvest: scp failed for 1 file')
    expect(fetched!.left_on_remote).toBe(leftOnRemoteJson)
    expect(fetched!.notified_at).toBe(notifiedAt.getTime())
    expect(fetched!.notification_consumed_at).toBe(consumedAt.getTime())

    // Clear the nullable fields.
    const cleared = await repo.update('job-3b', {
      harvestError: null,
      leftOnRemote: null,
      notifiedAt: null,
      notificationConsumedAt: null
    })
    expect(cleared.harvest_error).toBeUndefined()
    expect(cleared.left_on_remote).toBeUndefined()
    expect(cleared.notified_at).toBeUndefined()
    expect(cleared.notification_consumed_at).toBeUndefined()
  })

  it('findTerminalUnharvested returns terminal jobs with null harvestedAt, excludes already-harvested and non-terminal', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-unharvested-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Terminal + unharvested — should be returned.
    await repo.create({
      id: 'job-success-unharvested',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'a',
      command: 'echo ok',
      commandHash: 'h1'
    })
    await repo.update('job-success-unharvested', { status: 'success', finishedAt: new Date() })

    // Terminal + already harvested — must NOT be returned.
    await repo.create({
      id: 'job-success-harvested',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'b',
      command: 'echo ok',
      commandHash: 'h2'
    })
    await repo.update('job-success-harvested', {
      status: 'success',
      finishedAt: new Date(),
      harvestedAt: new Date()
    })

    // Non-terminal (running) — must NOT be returned.
    await repo.create({
      id: 'job-running',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'c',
      command: 'sleep 9999',
      commandHash: 'h3'
    })
    await repo.update('job-running', { status: 'running' })

    // error status — must NOT be returned (error jobs don't get harvested).
    await repo.create({
      id: 'job-error',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'd',
      command: 'bad',
      commandHash: 'h4'
    })
    await repo.update('job-error', {
      status: 'error',
      errorCode: 'dispatch_failed',
      finishedAt: new Date()
    })

    const unharvested = await repo.findTerminalUnharvested()
    expect(unharvested).toHaveLength(1)
    expect(unharvested[0]!.job_id).toBe('job-success-unharvested')
    await expect(repo.hasIdentityChangeBlockingJobsForProvider('ssh:test')).resolves.toBe(true)
    await expect(repo.hasIdentityChangeBlockingJobsForProvider('ssh:other')).resolves.toBe(false)
  })

  it('findPendingNotifications returns jobs with notifiedAt set and notificationConsumedAt null', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-pending-notif-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    const mkJob = async (id: string, sessionId: string): Promise<void> => {
      await repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId,
        projectId: 'p1',
        intent: id,
        command: 'echo ok',
        commandHash: id
      })
    }

    await mkJob('job-notified-unconsumed', 'sess-1')
    await repo.update('job-notified-unconsumed', { notifiedAt: new Date('2026-01-01') })

    await mkJob('job-notified-consumed', 'sess-1')
    await repo.update('job-notified-consumed', {
      notifiedAt: new Date('2026-01-01'),
      notificationConsumedAt: new Date('2026-01-02')
    })

    await mkJob('job-not-notified', 'sess-1')

    await mkJob('job-other-session', 'sess-2')
    await repo.update('job-other-session', { notifiedAt: new Date('2026-01-01') })

    const pending = await repo.findPendingNotifications('sess-1')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.job_id).toBe('job-notified-unconsumed')

    const allPending = await repo.findPendingNotifications()
    expect(allPending.map((job) => job.job_id)).toEqual([
      'job-notified-unconsumed',
      'job-other-session'
    ])
  })

  it('markNotificationsConsumed sets notificationConsumedAt and is idempotent', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-mark-consumed-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    await repo.create({
      id: 'job-to-consume',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo',
      commandHash: 'h'
    })
    await repo.update('job-to-consume', { notifiedAt: new Date() })

    // First call sets the timestamp.
    await repo.markNotificationsConsumed('s1', ['job-to-consume'])
    const after = await repo.get('job-to-consume')
    expect(after!.notification_consumed_at).toBeGreaterThan(0)

    // Second call is idempotent (no error, no change to timestamp).
    const ts1 = after!.notification_consumed_at!
    await repo.markNotificationsConsumed('s1', ['job-to-consume'])
    const after2 = await repo.get('job-to-consume')
    expect(after2!.notification_consumed_at).toBe(ts1)

    // Empty array is a no-op.
    await expect(repo.markNotificationsConsumed('s1', [])).resolves.toBeUndefined()
  })

  it('rejects a mixed-session, missing, or unnotified consumption batch atomically', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-consume-owner-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))
    const createJob = async (id: string, sessionId: string): Promise<void> => {
      await repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId,
        projectId: 'p1',
        intent: 'test',
        command: 'echo',
        commandHash: id
      })
    }

    await createJob('job-owned', 'session-1')
    await createJob('job-foreign', 'session-2')
    await createJob('job-unnotified', 'session-1')
    await repo.update('job-owned', { notifiedAt: new Date('2026-01-01') })
    await repo.update('job-foreign', { notifiedAt: new Date('2026-01-01') })

    await expect(
      repo.markNotificationsConsumed('session-1', ['job-owned', 'job-foreign'])
    ).rejects.toThrow(/outside the requested Session/)
    expect((await repo.get('job-owned'))?.notification_consumed_at).toBeUndefined()
    expect((await repo.get('job-foreign'))?.notification_consumed_at).toBeUndefined()

    await expect(
      repo.markNotificationsConsumed('session-1', ['job-owned', 'missing-job'])
    ).rejects.toThrow(/outside the requested Session/)
    await expect(repo.markNotificationsConsumed('session-1', ['job-unnotified'])).rejects.toThrow(
      /outside the requested Session/
    )

    await repo.markNotificationsConsumed('session-1', ['job-owned', 'job-owned'])
    expect((await repo.get('job-owned'))?.notification_consumed_at).toBeGreaterThan(0)
  })

  it('countNonTerminalByProvider counts active jobs across all sessions', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-count-provider-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Create jobs for provider-a in different sessions
    await repo.create({
      id: 'job-1',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo a',
      commandHash: 'h1'
    })
    await repo.update('job-1', { status: 'running' })

    await repo.create({
      id: 'job-2',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-2',
      projectId: 'p1',
      intent: 'test',
      command: 'echo b',
      commandHash: 'h2'
    })
    // job-2 stays in submitted state

    // Create a terminal job for provider-a (should NOT be counted)
    await repo.create({
      id: 'job-3',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo c',
      commandHash: 'h3'
    })
    await repo.update('job-3', { status: 'success', finishedAt: new Date() })

    // Create a job for provider-b (should NOT be counted)
    await repo.create({
      id: 'job-4',
      providerId: 'ssh:provider-b',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo d',
      commandHash: 'h4'
    })

    // Count for provider-a should be 2 (job-1 running + job-2 submitted)
    const count = await repo.countNonTerminalByProvider('ssh:provider-a')
    expect(count).toBe(2)

    // Count for provider-b should be 1
    const countB = await repo.countNonTerminalByProvider('ssh:provider-b')
    expect(countB).toBe(1)

    // Count for non-existent provider should be 0
    const countC = await repo.countNonTerminalByProvider('ssh:provider-c')
    expect(countC).toBe(0)
  })

  it('countNonTerminalBySession counts active jobs across all providers', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-count-session-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Create jobs for session-1 on different providers
    await repo.create({
      id: 'job-1',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo a',
      commandHash: 'h1'
    })
    await repo.update('job-1', { status: 'running' })

    await repo.create({
      id: 'job-2',
      providerId: 'ssh:provider-b',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo b',
      commandHash: 'h2'
    })
    // job-2 stays in submitted state

    // Create a terminal job for session-1 (should NOT be counted)
    await repo.create({
      id: 'job-3',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo c',
      commandHash: 'h3'
    })
    await repo.update('job-3', { status: 'failed', finishedAt: new Date() })

    // Create a job for session-2 (should NOT be counted)
    await repo.create({
      id: 'job-4',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-2',
      projectId: 'p1',
      intent: 'test',
      command: 'echo d',
      commandHash: 'h4'
    })

    // Count for session-1 should be 2 (job-1 running + job-2 submitted)
    const count = await repo.countNonTerminalBySession('session-1')
    expect(count).toBe(2)

    // Count for session-2 should be 1
    const countB = await repo.countNonTerminalBySession('session-2')
    expect(countB).toBe(1)

    // Count for non-existent session should be 0
    const countC = await repo.countNonTerminalBySession('session-3')
    expect(countC).toBe(0)
  })

  it('countQueuedJobs returns accurate global queued job count', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-count-queued-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Initially no queued jobs
    expect(await repo.countQueuedJobs()).toBe(0)

    // Create queued jobs across different sessions and providers
    await repo.create({
      id: 'job-1',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo a',
      commandHash: 'h1'
    })
    await repo.update('job-1', { status: 'queued' })

    await repo.create({
      id: 'job-2',
      providerId: 'ssh:provider-b',
      shape: 'direct_ssh',
      sessionId: 'session-2',
      projectId: 'p1',
      intent: 'test',
      command: 'echo b',
      commandHash: 'h2'
    })
    await repo.update('job-2', { status: 'queued' })

    // Create non-queued jobs (should NOT be counted)
    await repo.create({
      id: 'job-3',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo c',
      commandHash: 'h3'
    })
    // job-3 stays in submitted state

    await repo.create({
      id: 'job-4',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo d',
      commandHash: 'h4'
    })
    await repo.update('job-4', { status: 'success', finishedAt: new Date() })

    // Count should be 2 (only queued jobs)
    const count = await repo.countQueuedJobs()
    expect(count).toBe(2)

    // Transition one job out of queued state
    await repo.update('job-1', { status: 'submitted' })
    expect(await repo.countQueuedJobs()).toBe(1)
  })

  it('findQueuedJobs returns jobs in createdAt ascending order', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-find-queued-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Create jobs with deliberate timing
    await repo.create({
      id: 'job-oldest',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'oldest',
      command: 'echo a',
      commandHash: 'h1'
    })
    await repo.update('job-oldest', { status: 'queued' })

    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 10))

    await repo.create({
      id: 'job-middle',
      providerId: 'ssh:provider-b',
      shape: 'direct_ssh',
      sessionId: 'session-2',
      projectId: 'p1',
      intent: 'middle',
      command: 'echo b',
      commandHash: 'h2'
    })
    await repo.update('job-middle', { status: 'queued' })

    await new Promise((resolve) => setTimeout(resolve, 10))

    await repo.create({
      id: 'job-newest',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'newest',
      command: 'echo c',
      commandHash: 'h3'
    })
    await repo.update('job-newest', { status: 'queued' })

    // Create a non-queued job (should NOT be returned)
    await repo.create({
      id: 'job-running',
      providerId: 'ssh:provider-a',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'p1',
      intent: 'running',
      command: 'echo d',
      commandHash: 'h4'
    })
    await repo.update('job-running', { status: 'running' })

    // Find queued jobs
    const queuedJobs = await repo.findQueuedJobs()

    // Should return 3 queued jobs in createdAt ascending order
    expect(queuedJobs).toHaveLength(3)
    expect(queuedJobs[0]!.job_id).toBe('job-oldest')
    expect(queuedJobs[1]!.job_id).toBe('job-middle')
    expect(queuedJobs[2]!.job_id).toBe('job-newest')

    // Verify timestamps are in ascending order
    expect(queuedJobs[0]!.created_at).toBeLessThan(queuedJobs[1]!.created_at)
    expect(queuedJobs[1]!.created_at).toBeLessThan(queuedJobs[2]!.created_at)
  })

  it('blocks admission and deletes rows and notifications by owner scope', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-owner-delete-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))
    const create = (
      id: string,
      projectId: string,
      sessionId: string
    ): ReturnType<ComputeJobRepository['create']> =>
      repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId,
        projectId,
        intent: id,
        command: 'echo ok',
        commandHash: id
      })

    await create('owned-job', 'project-1', 'session-1')
    await repo.update('owned-job', { notifiedAt: new Date() })
    await create('survivor', 'project-1', 'session-2')
    await create('owned-terminal', 'project-1', 'session-1')
    await repo.update('owned-terminal', { status: 'success', finishedAt: new Date() })
    await create('owned-error', 'project-1', 'session-1')
    await repo.update('owned-error', {
      status: 'error',
      errorCode: 'dispatch_failed',
      finishedAt: new Date()
    })
    const owner = { projectId: 'project-1', sessionId: 'session-1' }

    expect(await repo.listOwners()).toEqual([
      { projectId: 'project-1', sessionId: 'session-1' },
      { projectId: 'project-1', sessionId: 'session-2' }
    ])

    await repo.beginOwnerDeletion(owner)
    await expect(create('late-job', 'project-1', 'session-1')).rejects.toThrow(/being deleted/i)
    expect((await repo.findNonTerminal()).map((item) => item.job_id)).toEqual(['survivor'])
    expect(await repo.findTerminalUnharvested()).toEqual([])
    expect(await repo.findErrorUnnotified()).toEqual([])
    expect((await repo.findByOwner(owner)).map((item) => item.job_id).sort()).toEqual([
      'owned-error',
      'owned-job',
      'owned-terminal'
    ])
    await repo.deleteByOwner(owner)

    await expect(create('post-commit-job', 'project-1', 'session-1')).rejects.toThrow(
      /being deleted/i
    )
    expect(await repo.get('owned-job')).toBeNull()
    expect(await repo.findPendingNotifications('session-1')).toEqual([])
    expect(await repo.get('survivor')).not.toBeNull()

    await repo.abortOwnerDeletion(owner)
    await expect(create('retry-job', 'project-1', 'session-1')).resolves.toMatchObject({
      job_id: 'retry-job'
    })
  })
})
