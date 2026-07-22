import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ComputeJobRepository } from './job-repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'

// Verifies ComputeJob schema migration is purely additive (CLAUDE.md requirement):
// - The table + indexes can be created on a fresh DB.
// - Re-running ensure is idempotent.
// - The table can be added to a pre-existing DB (Project only) without disturbing existing rows.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('ComputeJob schema migration (integration)', () => {
  it('creates the ComputeJob table and round-trips CRUD', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    const repo = new ComputeJobRepository(() => Promise.resolve(client))

    // Fresh DB: no jobs.
    expect(await repo.findNonTerminal()).toEqual([])

    // Idempotent second run.
    await ensureProjectSchema(client)
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

  it('findNonTerminalByProvider returns only jobs for the given provider', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-provider-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

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

  it('adds ComputeJob to a pre-existing DB with Project table only (additive migration)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-migrate-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Simulate a pre-3a DB: only Project and ComputeHost tables exist.
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('p1','Existing',CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ComputeHost" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "providerId" TEXT NOT NULL,
      "displayName" TEXT NOT NULL,
      "shape" TEXT NOT NULL DEFAULT 'direct_ssh',
      "sshAlias" TEXT NOT NULL,
      "sshOverrides" TEXT,
      "scratchRoot" TEXT,
      "scratchPinned" BOOLEAN NOT NULL DEFAULT false,
      "concurrencyLimit" INTEGER,
      "probeResult" TEXT,
      "detailsDoc" TEXT NOT NULL DEFAULT '',
      "detailsUpdatedAt" DATETIME,
      "detailsUpdatedBy" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)

    // ensureProjectSchema must add ComputeJob without disturbing existing rows.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
    // Idempotent second run.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    // Existing Project row is intact.
    const projects = await client.project.findMany()
    expect(projects).toHaveLength(1)
    expect(projects[0]!.name).toBe('Existing')

    // ComputeJob table is usable.
    const repo = new ComputeJobRepository(() => Promise.resolve(client))
    expect(await repo.findNonTerminal()).toHaveLength(0)

    const created = await repo.create({
      id: 'job-migrated',
      providerId: 'ssh:test',
      shape: 'direct_ssh',
      sessionId: 's1',
      projectId: 'p1',
      intent: 'test',
      command: 'echo ok',
      commandHash: 'hash'
    })
    expect(created.job_id).toBe('job-migrated')
  })

  it('applies Phase 3b columns to a Phase 3a DB: old rows readable, new columns null', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-3a-to-3b-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Simulate a Phase 3a DB: ComputeJob table WITHOUT the 4 new 3b columns.
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ComputeJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "providerId" TEXT NOT NULL,
      "shape" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'submitted',
      "intent" TEXT NOT NULL,
      "command" TEXT NOT NULL,
      "commandHash" TEXT NOT NULL,
      "environment" TEXT,
      "resourceRequest" TEXT,
      "inputManifest" TEXT,
      "outputManifest" TEXT,
      "harvestConfig" TEXT,
      "timeoutSeconds" INTEGER,
      "remoteWorkdir" TEXT,
      "remoteHandle" TEXT,
      "exitCode" INTEGER,
      "stdoutTail" TEXT,
      "stderrTail" TEXT,
      "errorCode" TEXT,
      "lastPollError" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "submittedAt" DATETIME,
      "startedAt" DATETIME,
      "finishedAt" DATETIME,
      "harvestedAt" DATETIME
    )`)
    // Insert a row with only 3a columns populated.
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJob" ("id","providerId","shape","sessionId","projectId","intent","command","commandHash","status","createdAt")
       VALUES ('old-job-1','ssh:test','direct_ssh','s1','p1','legacy intent','echo ok','hash123','submitted',CURRENT_TIMESTAMP)`
    )

    // Apply ensureProjectSchema — must add the 4 new columns without error.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
    // Idempotent second run.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    // Old row is readable via the repository; new columns default to null/undefined.
    const repo = new ComputeJobRepository(() => Promise.resolve(client))
    const jobs = await repo.findNonTerminal()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.job_id).toBe('old-job-1')
    expect(jobs[0]!.intent).toBe('legacy intent')
    // New 3b columns must be undefined (null → undefined at repository boundary).
    expect(jobs[0]!.harvest_error).toBeUndefined()
    expect(jobs[0]!.left_on_remote).toBeUndefined()
    expect(jobs[0]!.notified_at).toBeUndefined()
    expect(jobs[0]!.notification_consumed_at).toBeUndefined()
  })

  it('round-trips the 4 new Phase 3b columns (harvestError, leftOnRemote, notifiedAt, notificationConsumedAt)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-3b-columns-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

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

    await ensureProjectSchema(client)

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
  })

  it('findPendingNotifications returns jobs with notifiedAt set and notificationConsumedAt null', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-pending-notif-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)
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
  })

  it('markNotificationsConsumed sets notificationConsumedAt and is idempotent', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-mark-consumed-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)
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
    await repo.markNotificationsConsumed(['job-to-consume'])
    const after = await repo.get('job-to-consume')
    expect(after!.notification_consumed_at).toBeGreaterThan(0)

    // Second call is idempotent (no error, no change to timestamp).
    const ts1 = after!.notification_consumed_at!
    await repo.markNotificationsConsumed(['job-to-consume'])
    const after2 = await repo.get('job-to-consume')
    expect(after2!.notification_consumed_at).toBe(ts1)

    // Empty array is a no-op.
    await expect(repo.markNotificationsConsumed([])).resolves.toBeUndefined()
  })

  it('countNonTerminalByProvider counts active jobs across all sessions', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-count-provider-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)
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

    await ensureProjectSchema(client)
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

    await ensureProjectSchema(client)
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

    await ensureProjectSchema(client)
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
})
