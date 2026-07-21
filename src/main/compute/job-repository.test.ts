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
})
