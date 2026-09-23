import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalBroker } from './compute-approval-broker'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeJobWorkflowOwner } from './compute-job-workflow-owner'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { dispatchJob } from './job-dispatcher'
import { ComputeJobRepository } from './job-repository'
import { ComputeHostRepository } from './repository'

// Keep the submission owner, SQLite persistence and evidence worker real. The remote dispatch
// boundary is observed without starting a remote process.
vi.mock('./job-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./job-dispatcher')>()),
  dispatchJob: vi.fn(async () => undefined)
}))

const readerScript = `
param([string]$Receipt, [string]$Release)
$ErrorActionPreference = 'Stop'
$reader = [IO.File]::Open($Receipt, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('locked')
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath $Release)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Submission fixture did not release reader' }
    Start-Sleep -Milliseconds 10
  }
} finally { $reader.Dispose() }
`

describe.skipIf(process.platform !== 'win32')('Compute submission evidence recovery', () => {
  let database: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>> | undefined

  beforeAll(async () => {
    // Schema migration is fixture setup; keep its disk I/O outside the receipt-recovery deadline.
    database = await createMigratedComputeTestDatabase('compute-submission-evidence-')
  })

  afterAll(async () => {
    await database?.dispose()
  })

  it('creates no Job on persistent publication denial and submits once after the reader closes', async () => {
    const { storageRoot: root, client } = database!
    let reader: ReturnType<typeof spawn> | undefined
    let readerClosed: Promise<{ code: number | null; stderr: string }> | undefined
    const releasePath = join(root, 'release-reader')
    try {
      const hosts = new ComputeHostRepository(async () => client)
      const jobs = new ComputeJobRepository(async () => client)
      const host = await hosts.create({ sshAlias: 'fixture-host', displayName: 'Fixture host' })
      const create = vi.spyOn(jobs, 'create')
      const publish = vi.fn()
      const owner = new ComputeJobWorkflowOwner(
        { acquire: vi.fn() } as unknown as ComputeConnectionBrokerAcquirer,
        hosts,
        {
          requestWithContext: vi.fn(async () => 'once')
        } as unknown as ComputeApprovalBroker,
        jobs,
        publish,
        undefined,
        root,
        undefined
      )
      const context = { projectId: 'project-1', sessionId: 'session-1' }
      const evidenceRoot = join(root, 'execution-file-evidence')
      await mkdir(evidenceRoot)
      const receiptPath = join(evidenceRoot, '.project-ownership-project-1.json')
      // A valid crash-recovery state, before the Project ownership publication. No Job exists.
      const prepared = {
        schemaVersion: 1,
        phase: 'prepared',
        projectName: context.projectId,
        ownershipToken: 'submission-fixture-owner'
      }
      await writeFile(receiptPath, JSON.stringify(prepared))
      const scriptPath = join(root, 'reader.ps1')
      await writeFile(scriptPath, readerScript)
      reader = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', scriptPath, receiptPath, releasePath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stderr = ''
      reader.stderr!.on('data', (chunk) => (stderr += chunk))
      readerClosed = new Promise((resolve, reject) => {
        reader!.on('error', reject)
        reader!.on('close', (code) => resolve({ code, stderr }))
      })
      await new Promise<void>((resolve, reject) => {
        let stdout = ''
        reader!.stdout!.on('data', (chunk) => {
          stdout += chunk
          if (stdout.includes('locked')) resolve()
        })
        void readerClosed!.then(
          () => reject(new Error(`Receipt reader exited before acquiring its handle: ${stderr}`)),
          reject
        )
      })

      await expect(
        owner.submitJob(host.providerId, 'recover publication', 'echo ready', {}, context)
      ).rejects.toThrow(/EPERM/)
      expect(create).not.toHaveBeenCalled()
      expect(dispatchJob).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      await expect(jobs.findByOwner(context)).resolves.toEqual([])
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual(prepared)

      await writeFile(releasePath, '')
      expect(await readerClosed).toEqual({ code: 0, stderr: '' })
      const submitted = await owner.submitJob(
        host.providerId,
        'recover publication',
        'echo ready',
        {},
        context
      )
      expect(submitted.status).toBe('submitted')
      expect(create).toHaveBeenCalledOnce()
      expect(dispatchJob).toHaveBeenCalledOnce()
      expect(dispatchJob).toHaveBeenCalledWith(submitted.job_id, expect.any(Object))
      const persisted = await jobs.findByOwner(context)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({ job_id: submitted.job_id, status: 'submitted' })
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ phase: 'owned' })
    } finally {
      await writeFile(releasePath, '')
      await readerClosed
      vi.restoreAllMocks()
      vi.clearAllMocks()
    }
  })
})
