import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ComputeJobRepository } from './job-repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeConnectionError, type ComputeConnectionBrokerAcquirer } from './connection-broker'
import { dispatchJob } from './job-dispatcher'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
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

const makeJobRepository = (
  client: ReturnType<typeof createProjectDbClient>
): ComputeJobRepository =>
  new ComputeJobRepository(() => Promise.resolve(client), protectedFields())

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
    const jobRepository = makeJobRepository(client)
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

    const repo = makeJobRepository(client)
    const fileEvidence = {
      schemaVersion: 1 as const,
      activityId: 'test-job-1',
      activityKind: 'compute-job' as const,
      parentActivityId: 'run-1',
      state: 'unavailable' as const,
      scientificOutputCount: 0,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'unavailable' as const,
      scientificOutputAnalysis: 'unavailable' as const,
      fileReads: 'unavailable' as const,
      externalPaths: 'unavailable' as const,
      writerAttribution: 'complete' as const,
      reasonCodes: ['remote-output-not-harvested' as const]
    }

    // Fresh DB: no jobs.
    expect(await repo.findNonTerminal()).toEqual([])

    // Create a job with all required fields.
    const created = await repo.create({
      id: 'test-job-1',
      providerId: 'ssh:biowulf',
      shape: 'direct_ssh',
      sessionId: 'sess-1',
      projectId: 'proj-1',
      producerRunId: 'run-1',
      fileEvidence,
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
    expect(created.producer_run_id).toBe('run-1')
    expect(created.file_evidence).toEqual(fileEvidence)
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
      remoteWorkdir: '/scratch/.openscience/jobs/test-job-1',
      startedAt: new Date()
    })
    expect(updated.status).toBe('running')
    expect(updated.started_at).toBeGreaterThan(0)
    expect(updated.remote_workdir).toBe('/scratch/.openscience/jobs/test-job-1')

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

    await client.computeJob.update({
      where: { id: 'test-job-1' },
      data: {
        fileEvidence: JSON.stringify({
          ...fileEvidence,
          activityId: 'another-job',
          state: 'partial'
        })
      }
    })
    await expect(repo.get('test-job-1')).resolves.toMatchObject({ file_evidence: undefined })

    await client.computeJob.update({
      where: { id: 'test-job-1' },
      data: { fileEvidence: JSON.stringify({ ...fileEvidence, state: 'partial' }) }
    })
    await expect(repo.get('test-job-1')).resolves.toMatchObject({ file_evidence: undefined })

    await client.computeJob.update({
      where: { id: 'test-job-1' },
      data: {
        fileEvidence: JSON.stringify({ ...fileEvidence, reasonCodes: ['unrecognized-reason'] })
      }
    })
    await expect(repo.get('test-job-1')).resolves.toMatchObject({ file_evidence: undefined })
  })

  it('does not downgrade an immutable file-evidence reference from a stale update', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-immutable-evidence-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const repo = makeJobRepository(client)
    const immutableEvidence = {
      schemaVersion: 1 as const,
      activityId: 'immutable-evidence-job',
      activityKind: 'compute-job' as const,
      parentActivityId: 'producer-run',
      state: 'available' as const,
      evidenceId: 'execution-file-evidence-immutable-evidence-job',
      checksum: 'a'.repeat(64),
      storageKey:
        'execution-file-evidence/project/session/activity-immutable-evidence-job/evidence.json',
      relationCount: 1,
      generationCount: 1,
      scientificOutputCount: 1,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'complete' as const,
      scientificOutputAnalysis: 'complete' as const,
      fileReads: 'unavailable' as const,
      externalPaths: 'unavailable' as const,
      writerAttribution: 'complete' as const,
      reasonCodes: ['file-reads-not-observed' as const]
    }
    await repo.create({
      id: 'immutable-evidence-job',
      providerId: 'ssh:biowulf',
      shape: 'direct_ssh',
      sessionId: 'session',
      projectId: 'project',
      producerRunId: 'producer-run',
      fileEvidence: immutableEvidence,
      intent: 'preserve evidence',
      command: 'true',
      commandHash: 'immutable-evidence-hash'
    })
    await repo.update('immutable-evidence-job', {
      status: 'success',
      finishedAt: new Date()
    })
    await expect(repo.get('immutable-evidence-job')).resolves.toMatchObject({
      file_evidence: immutableEvidence
    })

    await repo.update('immutable-evidence-job', {
      harvestedAt: new Date(),
      harvestError: 'stale re-harvest failed',
      fileEvidence: {
        ...immutableEvidence,
        state: 'unavailable',
        evidenceId: undefined,
        checksum: undefined,
        storageKey: undefined,
        relationCount: undefined,
        generationCount: undefined,
        scientificOutputCount: 0,
        managedRootsFinalState: 'unavailable',
        scientificOutputAnalysis: 'unavailable',
        reasonCodes: ['evidence-persistence-failed']
      }
    })

    await expect(repo.get('immutable-evidence-job')).resolves.toMatchObject({
      file_evidence: immutableEvidence,
      harvest_error: 'stale re-harvest failed'
    })
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
      Array<Record<string, string | boolean | null>>
    >`SELECT "intent", "command", "environment", "resourceRequest", "inputManifest",
      "outputManifest", "harvestConfig", "remoteWorkdir", "remoteHandle", "stdoutTail",
      "stderrTail", "lastPollError", "harvestError", "leftOnRemote", "sensitiveDataEncrypted"
      FROM "ComputeJob" WHERE "id" = 'secret-job'`
    const persistedExecutionData = JSON.stringify(stored)

    expect(persistedExecutionData).not.toContain(intentSecret)
    expect(persistedExecutionData).not.toContain(commandSecret)
    expect(persistedExecutionData).not.toContain(environmentSecret)
    expect(persistedExecutionData).not.toContain(outputSecret)
    expect(stored?.sensitiveDataEncrypted).toBe(true)

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
    expect(stored.sensitiveDataEncrypted).toBeNull()
  })

  it('does not mistake a legacy plaintext protection prefix for ciphertext', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-legacy-prefix-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const legacyCommand = 'open-science:protected:v1:not-ciphertext'
    await client.computeJob.create({
      data: {
        id: 'legacy-prefix-job',
        providerId: 'ssh:legacy-host',
        shape: 'direct_ssh',
        sessionId: 'legacy-session',
        projectId: 'legacy-project',
        status: 'queued',
        intent: 'legacy intent',
        command: legacyCommand,
        commandHash: 'legacy-prefix-command-hash'
      }
    })
    const repo = new ComputeJobRepository(() => Promise.resolve(client), protectedFields())

    await expect(repo.get('legacy-prefix-job')).resolves.toMatchObject({
      command: legacyCommand
    })
  })

  it('does not silently persist plaintext after runtime encryption fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-encryption-failure-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(
      () => Promise.resolve(client),
      protectedFields(
        testCipher({
          encryptString: () => {
            throw new Error('keychain became unavailable')
          }
        })
      )
    )

    await expect(
      repo.create({
        id: 'encryption-failure-job',
        providerId: 'ssh:failure-host',
        shape: 'direct_ssh',
        sessionId: 'failure-session',
        projectId: 'failure-project',
        intent: 'failure intent',
        command: 'echo secret-that-must-not-be-persisted',
        commandHash: 'encryption-failure-command-hash'
      })
    ).rejects.toThrow('Compute Job plaintext persistence requires explicit approval')

    await expect(
      client.computeJob.findUnique({ where: { id: 'encryption-failure-job' } })
    ).resolves.toBeNull()
    expect(repo.isFieldProtectionAvailable()).toBe(false)

    await expect(
      repo.create({
        id: 'encryption-fallback-retry-job',
        providerId: 'ssh:failure-host',
        shape: 'direct_ssh',
        sessionId: 'failure-session',
        projectId: 'failure-project',
        intent: 'retry intent',
        command: 'echo disclosed-plaintext-fallback',
        commandHash: 'encryption-fallback-retry-command-hash',
        allowUnencryptedPersistence: true
      })
    ).resolves.toMatchObject({ command: 'echo disclosed-plaintext-fallback' })
    await expect(
      client.computeJob.findUniqueOrThrow({ where: { id: 'encryption-fallback-retry-job' } })
    ).resolves.toMatchObject({ sensitiveDataEncrypted: false })
  })

  it('rejects invalid JSON container shapes before protecting them', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-invalid-protected-json-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client), protectedFields())

    await expect(
      repo.create({
        id: 'invalid-protected-json-job',
        providerId: 'ssh:invalid-json-host',
        shape: 'direct_ssh',
        sessionId: 'invalid-json-session',
        projectId: 'invalid-json-project',
        intent: 'invalid JSON intent',
        command: 'true',
        commandHash: 'invalid-json-command-hash',
        outputManifest: '{}'
      })
    ).rejects.toThrow()
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
        id: 'fallback-without-approval-job',
        providerId: 'ssh:fallback-host',
        shape: 'direct_ssh',
        sessionId: 'fallback-session',
        projectId: 'fallback-project',
        intent: 'fallback intent',
        command: 'echo unapproved plaintext',
        commandHash: 'unapproved-fallback-command-hash'
      })
    ).rejects.toThrow('Compute Job plaintext persistence requires explicit approval')

    await expect(
      repo.create({
        id: 'fallback-job',
        providerId: 'ssh:fallback-host',
        shape: 'direct_ssh',
        sessionId: 'fallback-session',
        projectId: 'fallback-project',
        intent: 'fallback intent',
        command: 'echo fallback plaintext',
        commandHash: 'fallback-command-hash',
        allowUnencryptedPersistence: true
      })
    ).resolves.toMatchObject({ command: 'echo fallback plaintext' })

    const stored = await client.computeJob.findUniqueOrThrow({ where: { id: 'fallback-job' } })
    expect(stored.command).toBe('echo fallback plaintext')
    expect(stored.sensitiveDataEncrypted).toBe(false)
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

    await expect(reader.get('unreadable-job')).resolves.toMatchObject({
      intent: '',
      command: '',
      needs_attention: true,
      integrity_issues: [
        expect.objectContaining({
          code: 'sensitive-fields-unavailable',
          disposition: 'needs-attention'
        })
      ]
    })
  })

  it('findNonTerminalByProvider returns only jobs for the given provider', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-provider-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repo = makeJobRepository(client)

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

    const repo = makeJobRepository(client)

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

  it('allows only one concurrent notification claim', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notification-claim-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))
    await repo.create({
      id: 'job-claim',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'notification claim',
      command: 'true',
      commandHash: 'claim-hash',
      allowUnencryptedPersistence: true
    })
    await repo.update('job-claim', {
      status: 'error',
      errorCode: 'dispatch_failed',
      finishedAt: new Date()
    })

    const claims = await Promise.all([
      repo.claimNotification('job-claim', new Date('2026-08-24T01:00:00Z')),
      repo.claimNotification('job-claim', new Date('2026-08-24T01:00:01Z'))
    ])

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
    expect(claims.filter((claim) => claim === null)).toHaveLength(1)
  })

  it('findTerminalUnharvested returns terminal jobs with null harvestedAt, excludes already-harvested and non-terminal', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-unharvested-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repo = makeJobRepository(client)

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

    // A Job cancelled before submission has no remote execution and must not enter harvest recovery.
    await repo.create({
      id: 'job-cancelled-while-queued',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'cancel before dispatch',
      command: 'sleep 9999',
      commandHash: 'h5',
      initialStatus: 'queued'
    })
    const operations = new ComputeJobOperationRepository(() => Promise.resolve(client))
    await operations.request(
      'job-cancelled-while-queued',
      'cancel',
      { projectId: 'p1', sessionId: 's1', providerId: 'ssh:test' },
      new Date()
    )

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

  it('does not recover harvest for jobs whose remote directory was cleaned', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-cleaned-unharvested-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)

    for (const disposition of ['cleaned', 'abandoned'] as const) {
      const id = `job-${disposition}`
      await repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId: 's1',
        projectId: 'p1',
        intent: disposition,
        command: 'sleep 9999',
        commandHash: `hash-${disposition}`
      })
      await repo.update(id, { status: 'failed', finishedAt: new Date() })
      await repo.settleRemoteCleanup({
        jobId: id,
        providerId: 'ssh:test',
        projectId: 'p1',
        sessionId: 's1',
        disposition
      })
    }

    expect((await repo.findTerminalUnharvested()).map((job) => job.job_id)).toEqual([
      'job-abandoned'
    ])
  })

  it('blocks Host identity changes while a harvested Job still needs remote cleanup', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-pending-cleanup-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)
    await repo.create({
      id: 'job-harvested-pending-cleanup',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'preserve cleanup credentials',
      command: 'true',
      commandHash: 'pending-cleanup-hash'
    })
    await repo.update('job-harvested-pending-cleanup', {
      status: 'success',
      finishedAt: new Date(),
      harvestedAt: new Date()
    })

    await expect(repo.hasIdentityChangeBlockingJobsForProvider('ssh:test')).resolves.toBe(true)
  })

  it('findPendingNotifications returns jobs with notifiedAt set and notificationConsumedAt null', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-pending-notif-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)

    const mkJob = async (id: string, sessionId: string): Promise<void> => {
      await repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId,
        projectId: 'p1',
        intent: id,
        command: 'echo ok',
        commandHash: id,
        initialStatus: 'success'
      })
    }

    await mkJob('job-notified-unconsumed', 'sess-1')
    await repo.update('job-notified-unconsumed', {
      status: 'error',
      errorCode: 'dispatch_failed',
      notifiedAt: new Date('2026-01-01')
    })

    await mkJob('job-notified-consumed', 'sess-1')
    await repo.update('job-notified-consumed', {
      status: 'error',
      errorCode: 'dispatch_failed',
      notifiedAt: new Date('2026-01-01'),
      notificationConsumedAt: new Date('2026-01-02')
    })

    await mkJob('job-not-notified', 'sess-1')

    await mkJob('job-other-session', 'sess-2')
    await repo.update('job-other-session', {
      status: 'error',
      errorCode: 'dispatch_failed',
      notifiedAt: new Date('2026-01-01')
    })

    const pending = await repo.findPendingNotifications('sess-1')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.job_id).toBe('job-notified-unconsumed')
    expect((await repo.findPendingNotifications()).map((job) => job.job_id)).toEqual([
      'job-notified-unconsumed',
      'job-other-session'
    ])
  })

  it('keeps notified non-terminal rows out of the pending analysis seam', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-pending-terminal-guard-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    await repo.create({
      id: 'job-running-notified',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 'sess-1',
      projectId: 'p1',
      intent: 'still running',
      command: 'sleep 60',
      commandHash: 'running-notified',
      allowUnencryptedPersistence: true
    })
    await repo.update('job-running-notified', {
      status: 'running',
      notifiedAt: new Date('2026-01-01')
    })

    expect(await repo.findPendingNotifications('sess-1')).toEqual([])
    expect(await repo.findNonTerminal()).toEqual([])
    expect(await repo.get('job-running-notified')).toMatchObject({
      status: 'running',
      notified_at: new Date('2026-01-01').getTime(),
      needs_attention: true,
      integrity_issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'notified-before-terminal',
          disposition: 'quarantined'
        })
      ])
    })
  })

  it('classifies valid encrypted active handles after decryption', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-encrypted-integrity-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)
    const workdir = '/remote/jobs/encrypted-active'

    await repo.create({
      id: 'encrypted-active',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 'sess-encrypted',
      projectId: 'p1',
      intent: 'encrypted integrity',
      command: 'sleep 30',
      commandHash: 'encrypted-active',
      remoteWorkdir: workdir
    })
    await repo.update('encrypted-active', {
      status: 'running',
      remoteHandle: JSON.stringify({
        pid: 321,
        workdir,
        exit_code_path: `${workdir}/exit_code`,
        stdout_path: `${workdir}/stdout`,
        stderr_path: `${workdir}/stderr`
      })
    })

    expect(await repo.scanIntegrity()).toEqual([])
    const encryptedJob = await repo.get('encrypted-active')
    expect(encryptedJob).toMatchObject({
      job_id: 'encrypted-active',
      remote_workdir: workdir
    })
    expect(encryptedJob).not.toHaveProperty('needs_attention')
    expect(await repo.findNonTerminal()).toHaveLength(1)
  })

  it('reports encrypted projection failures without exposing ciphertext', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-decrypt-failure-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const healthyRepo = makeJobRepository(client)
    const workdir = '/remote/jobs/decrypt-failure'
    await healthyRepo.create({
      id: 'decrypt-failure',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 'sess-encrypted',
      projectId: 'p1',
      intent: 'never leak this intent',
      command: 'never leak this command',
      commandHash: 'decrypt-failure',
      remoteWorkdir: workdir
    })
    await healthyRepo.update('decrypt-failure', {
      status: 'running',
      remoteHandle: JSON.stringify({
        pid: 321,
        workdir,
        exit_code_path: `${workdir}/exit_code`,
        stdout_path: `${workdir}/stdout`,
        stderr_path: `${workdir}/stderr`
      })
    })
    await client.computeJobOperation.create({
      data: {
        id: 'cancel:decrypt-failure',
        jobId: 'decrypt-failure',
        kind: 'cancel',
        phase: 'active',
        updatedAt: new Date('2026-01-01')
      }
    })
    const failingRepo = new ComputeJobRepository(
      () => Promise.resolve(client),
      protectedFields(
        testCipher({
          decryptString: () => {
            throw new Error('secure storage unavailable')
          }
        })
      )
    )

    const report = await failingRepo.scanIntegrity()
    expect(report).toEqual([
      expect.objectContaining({
        jobId: 'decrypt-failure',
        code: 'sensitive-fields-unavailable',
        disposition: 'needs-attention'
      })
    ])
    expect(JSON.stringify(report)).not.toContain('never leak')
    expect(await failingRepo.get('decrypt-failure')).toMatchObject({
      intent: '',
      command: '',
      remote_handle: undefined,
      cancellation_status: 'cancelling',
      needs_attention: true
    })
    expect(await failingRepo.findNonTerminal()).toEqual([])
    const visibleJobs = await failingRepo.findBySession('sess-encrypted')
    expect(visibleJobs).toEqual([
      expect.objectContaining({
        job_id: 'decrypt-failure',
        intent: '',
        command: '',
        remote_workdir: undefined,
        remote_handle: undefined,
        cancellation_status: 'cancelling',
        needs_attention: true,
        integrity_issues: [expect.objectContaining({ code: 'sensitive-fields-unavailable' })]
      })
    ])
    expect(JSON.stringify(visibleJobs)).not.toContain('never leak')
  })

  it('reports raw persistence incompatibilities without hiding unknown statuses', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-integrity-scan-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = new ComputeJobRepository(() => Promise.resolve(client))
    const create = async (id: string): Promise<void> => {
      await repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId: 'sess-integrity',
        projectId: 'p1',
        intent: id,
        command: 'true',
        commandHash: id,
        remoteWorkdir: `/remote/jobs/${id}`,
        allowUnencryptedPersistence: true
      })
    }

    await create('unknown-status')
    await create('unknown-error')
    await create('partial-handle')
    await create('missing-handle')
    await create('consumed-without-notified')
    await client.$executeRawUnsafe('PRAGMA ignore_check_constraints = ON')
    await client.$executeRawUnsafe(
      `UPDATE ComputeJob SET status = 'future_state', notifiedAt = ? WHERE id = 'unknown-status'`,
      new Date('2026-01-01').toISOString()
    )
    await client.$executeRawUnsafe(
      `UPDATE ComputeJob SET status = 'failed', errorCode = 'future_error', finishedAt = ? WHERE id = 'unknown-error'`,
      new Date('2026-01-01').toISOString()
    )
    await client.$executeRawUnsafe(
      `UPDATE ComputeJob SET status = 'running', remoteHandle = ? WHERE id = 'partial-handle'`,
      JSON.stringify({ pid: 321, workdir: '/remote/jobs/partial-handle' })
    )
    await client.$executeRawUnsafe(
      `UPDATE ComputeJob SET status = 'running' WHERE id = 'missing-handle'`
    )
    await client.$executeRawUnsafe(
      `UPDATE ComputeJob SET notificationConsumedAt = ? WHERE id = 'consumed-without-notified'`,
      new Date('2026-01-02').toISOString()
    )

    const report = await repo.scanIntegrity()

    expect(report).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: 'unknown-status',
          code: 'unknown-status',
          rawStatus: 'future_state',
          disposition: 'quarantined'
        }),
        expect.objectContaining({
          jobId: 'unknown-error',
          code: 'unknown-error-code',
          rawErrorCode: 'future_error',
          disposition: 'needs-attention'
        }),
        expect.objectContaining({
          jobId: 'partial-handle',
          code: 'malformed-remote-handle',
          disposition: 'recovery-required'
        }),
        expect.objectContaining({
          jobId: 'missing-handle',
          code: 'malformed-remote-handle',
          disposition: 'recovery-required'
        }),
        expect.objectContaining({
          jobId: 'consumed-without-notified',
          code: 'consumed-without-notification',
          disposition: 'quarantined'
        })
      ])
    )
    expect((await repo.get('unknown-status'))?.raw_status).toBe('future_state')
    expect(await repo.findPendingNotifications('sess-integrity')).toEqual([])
  })

  it('markNotificationsConsumed sets notificationConsumedAt and is idempotent', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-mark-consumed-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)

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

  it('persists and validates automatic-analysis transitions for a notified Job batch', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-analysis-state-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)

    for (const id of ['job-success', 'job-failed']) {
      await repo.create({
        id,
        providerId: 'ssh:test',
        shape: 'direct_ssh',
        sessionId: 'session-1',
        projectId: 'project-1',
        intent: id,
        command: 'echo ok',
        commandHash: id,
        initialStatus: 'success'
      })
      await repo.update(id, { notifiedAt: new Date('2026-01-01') })
    }

    expect(await repo.get('job-success')).toMatchObject({
      analysis_state: undefined,
      analysis_message_id: undefined
    })
    await repo.transitionAnalysis({
      sessionId: 'session-1',
      jobIds: ['job-success'],
      messageId: 'analysis-success',
      state: 'dispatched'
    })
    await repo.transitionAnalysis({
      sessionId: 'session-1',
      jobIds: ['job-success'],
      messageId: 'analysis-success',
      state: 'succeeded'
    })
    expect(await repo.get('job-success')).toMatchObject({
      analysis_state: 'succeeded',
      analysis_message_id: 'analysis-success',
      analysis_updated_at: expect.any(Number),
      notification_consumed_at: expect.any(Number)
    })

    await repo.transitionAnalysis({
      sessionId: 'session-1',
      jobIds: ['job-failed'],
      messageId: 'analysis-failed',
      state: 'dispatched'
    })
    expect((await repo.findPendingNotifications()).map(({ job_id }) => job_id)).toEqual([
      'job-failed'
    ])
    await repo.transitionAnalysis({
      sessionId: 'session-1',
      jobIds: ['job-failed'],
      messageId: 'analysis-failed',
      state: 'failed'
    })
    expect(await repo.get('job-failed')).toMatchObject({
      analysis_state: 'failed',
      analysis_message_id: 'analysis-failed',
      notification_consumed_at: undefined
    })
    await expect(repo.findPendingNotifications()).resolves.toEqual([])
    await expect(
      repo.transitionAnalysis({
        sessionId: 'session-1',
        jobIds: ['job-failed'],
        messageId: 'different-message',
        state: 'succeeded'
      })
    ).rejects.toThrow(/does not match its durable dispatch/)
  })

  it('rejects a mixed-session, missing, or unnotified consumption batch atomically', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-consume-owner-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)
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
    const repo = makeJobRepository(client)

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
    const repo = makeJobRepository(client)

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
    const repo = makeJobRepository(client)

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
    const repo = makeJobRepository(client)

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
    const repo = makeJobRepository(client)
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
    expect(await repo.findNotificationReadyUnnotified()).toEqual([])
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

  it('keeps a historical Job as a Host blocker until remote cleanup is settled', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-host-delete-blocker-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repo = makeJobRepository(client)

    await repo.create({
      id: 'historical-job',
      providerId: 'ssh:retired-host',
      shape: 'direct_ssh',
      sessionId: 'session-1',
      projectId: 'project-1',
      intent: 'completed research',
      command: 'echo done',
      commandHash: 'historical-job'
    })
    await repo.update('historical-job', {
      status: 'success',
      finishedAt: new Date(),
      harvestedAt: new Date(),
      harvestError: null,
      leftOnRemote: null
    })

    await expect(repo.hasDeletionBlockingJobsForProvider('ssh:retired-host')).resolves.toBe(true)
    await expect(repo.findDeletionBlockingJobsForProvider('ssh:retired-host')).resolves.toEqual([
      expect.objectContaining({
        job_id: 'historical-job',
        remote_cleanup_disposition: 'pending'
      })
    ])

    await repo.settleRemoteCleanup({
      jobId: 'historical-job',
      providerId: 'ssh:retired-host',
      projectId: 'project-1',
      sessionId: 'session-1',
      disposition: 'abandoned'
    })

    await expect(repo.hasDeletionBlockingJobsForProvider('ssh:retired-host')).resolves.toBe(false)
    await expect(repo.findDeletionBlockingJobsForProvider('ssh:retired-host')).resolves.toEqual([])
    await expect(repo.get('historical-job')).resolves.toMatchObject({
      remote_cleanup_disposition: 'abandoned'
    })
  })
})
