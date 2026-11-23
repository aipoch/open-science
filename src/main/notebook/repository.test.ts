import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableFiles from '@aipoch/durable-files'

import { parseOwnedExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import type { NotebookEnvironmentManifest, NotebookRunRecord } from '../../shared/notebook'
import {
  NotebookRunRepository,
  NotebookRunSubmissionConflictError,
  getNotebookSessionRoot,
  getNotebookRunJsonPath
} from './repository'
import { createFrameNotebookLane, createRootNotebookLane } from './lane-identity'
import { getNotebookInputRoot } from './input-staging'
import { NotebookExportReader } from './export-reader'
import { digestNotebookHelperSource } from './helper-evidence'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-runs-'))
  return storageRoot
}

const admittedRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  submissionIdentity: 'submission-1',
  submissionFingerprint: 'a'.repeat(64),
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'queued',
  startedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const completedEnvironmentManifest = (): {
  manifest: NotebookEnvironmentManifest
  checksum: string
} => {
  const manifest: NotebookEnvironmentManifest = {
    schemaVersion: 1,
    captureKind: 'completed-run',
    capturedAt: '2026-11-20T00:00:00.000Z',
    installedInventory: {
      capturedAt: '2026-11-20T00:00:00.000Z',
      source: 'full-scan',
      validation: 'full-scan'
    },
    kernelKind: 'python',
    environmentName: 'default-python',
    runtimeSource: 'managed',
    inventorySources: ['kernel-native'],
    packages: [
      {
        name: 'numpy',
        version: '2.0.0',
        versionStatus: 'known',
        ecosystem: 'python',
        evidenceSources: ['python-importlib-metadata']
      }
    ],
    complete: true,
    captureStatus: 'complete'
  }
  const checksum = createHash('sha256')
    .update(`${JSON.stringify(manifest, null, 2)}\n`)
    .digest('hex')
  return { manifest, checksum }
}

const createTerminalRecoveryFixture = async (
  kind: 'root' | 'frame' = 'root'
): Promise<{
  root: string
  repository: NotebookRunRepository
  projectId: string
  sessionId: string
  lane: ReturnType<typeof createRootNotebookLane>
  running: NotebookRunRecord
  terminal: NotebookRunRecord
  fact: {
    version: number
    projectId: string
    sessionId: string
    expectedStatus: string
    run: NotebookRunRecord
  }
  outboxRoot: string
  factPath: string
  temporaryPath: string
}> => {
  const root = await createStorageRoot()
  const projectId = 'default-project'
  const sessionId = 'session-1'
  const agentFrameId = kind === 'root' ? 'root-frame-session-1' : 'frame-1'
  const lane =
    kind === 'root'
      ? createRootNotebookLane(projectId, sessionId, agentFrameId)
      : createFrameNotebookLane(projectId, sessionId, agentFrameId)
  const repository = new NotebookRunRepository(root)
  const document = await repository.loadOrCreate({
    projectId,
    sessionId,
    lane,
    workspaceCwd: '/workspace'
  })
  const running = admittedRun({ status: 'running', executionMode: 'background', agentFrameId })
  await repository.appendRun({ projectId, sessionId, lane, run: running })
  const terminal: NotebookRunRecord = {
    ...running,
    status: 'completed',
    endedAt: 2,
    text: { stdout: '42\n', stderr: '', traceback: '', plain: ['42\n'] },
    outputs: [{ type: 'stream', name: 'stdout', text: '42\n' }]
  }
  const fact = { version: 1, projectId, sessionId, expectedStatus: 'running', run: terminal }
  const outboxRoot = join(document.notebookSessionRoot, '.run-terminal-outbox')
  await mkdir(outboxRoot)
  const factPath = join(outboxRoot, `${terminal.runId}.json`)
  const exitedPid = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    {
      encoding: 'utf8'
    }
  )
  const temporaryPath = `${factPath}.${exitedPid}-12345678-1234-1234-1234-123456789abc.tmp`
  return {
    root,
    repository,
    projectId,
    sessionId,
    lane,
    running,
    terminal,
    fact,
    outboxRoot,
    factPath,
    temporaryPath
  }
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('notebook run repository', () => {
  it('recovers a pending Run once after its complete checkpoint survives a failed cleanup', async () => {
    const root = await createStorageRoot()
    const projectId = 'project',
      sessionId = 'session'
    const lane = createFrameNotebookLane(projectId, sessionId, 'child')
    const request = { projectId, sessionId, lane }
    const writer = new NotebookRunRepository(root),
      reader = new NotebookRunRepository(root)
    const doc = await writer.loadOrCreate({ ...request, workspaceCwd: root })
    const manifest = join(doc.notebookSessionRoot, 'run.json')
    const old = Array.from({ length: 32 }, (_, i) =>
      admittedRun({
        runId: 'old-' + i,
        submissionIdentity: 'old-' + i,
        status: 'completed',
        // A sub-MiB history must also survive an interrupted batch checkpoint.
        script: 'x'.repeat(12 * 1024)
      })
    )
    const base = { ...JSON.parse(await readFile(manifest, 'utf8')), runs: old }
    await writeFile(manifest, JSON.stringify(base))
    const run = admittedRun()
    const receipts = await Promise.all(
      [writer, reader].map((repo) => repo.appendOrGetRun({ ...request, run }))
    )
    expect(receipts.map((r) => r.admitted).sort()).toEqual([false, true])
    await writer.transitionRun({
      ...request,
      expectedStatus: 'queued',
      run: { ...run, status: 'running' }
    })
    const liveTemp = join(
      doc.notebookSessionRoot,
      '.pending-runs',
      `32.json.${process.pid}-12345678-1234-1234-1234-123456789abc.tmp`
    )
    await writeFile(liveTemp, '{')
    expect((await reader.findExisting(projectId, sessionId, lane))?.runs.at(-1)?.status).toBe(
      'running'
    )
    expect(await readFile(liveTemp, 'utf8')).toBe('{')
    await rm(liveTemp)
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual(base)
    const hot = join(doc.notebookSessionRoot, '.pending-runs'),
      name = '32.json'
    const pending = await readFile(join(hot, name))
    await new NotebookRunRepository(root).recoverAllRunLifecycles()
    await mkdir(hot)
    await writeFile(join(hot, name), pending)
    const fresh = new NotebookRunRepository(root)
    await fresh.recoverAllRunLifecycles()
    const saved = JSON.parse(await readFile(manifest, 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.runs.map((row: NotebookRunRecord) => row.runId)).toEqual([
      ...old.map((r) => r.runId),
      run.runId
    ])
    expect(saved.runs.at(-1).status).toBe('interrupted')
    await expect(stat(hot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fresh.appendOrGetRun({ ...request, run })).admitted).toBe(false)
  })
  it('retains the manifest and hot slot if a referenced terminal result is damaged', async () => {
    const root = await createStorageRoot()
    const repo = new NotebookRunRepository(root)
    const request = {
      projectId: 'p',
      sessionId: 's',
      lane: createRootNotebookLane('p', 's', 'root-frame-s')
    }
    const doc = await repo.loadOrCreate({ ...request, workspaceCwd: root })
    const manifest = join(doc.notebookSessionRoot, 'run.json')
    const base = JSON.parse(await readFile(manifest, 'utf8'))
    const run = admittedRun({ script: '#'.repeat(96 * 1024) })
    base.runs = Array.from({ length: 32 }, (_, i) =>
      admittedRun({
        runId: 'old-' + i,
        submissionIdentity: 'old-' + i,
        status: 'completed',
        script: 'x'.repeat(34000)
      })
    )
    const original = JSON.stringify(base)
    await writeFile(manifest, original)
    await repo.appendOrGetRun({ ...request, run })
    await repo.transitionRun({
      ...request,
      expectedStatus: 'queued',
      run: { ...run, status: 'running' }
    })
    const active = await new NotebookRunRepository(root).findExisting('p', 's', request.lane)
    expect(active?.runs.at(-1)).toMatchObject({ status: 'running', script: run.script })
    expect(await readFile(manifest, 'utf8')).toBe(original)
    const output = 'x'.repeat(125000)
    await repo.commitTerminalRun({
      ...request,
      expectedStatus: 'running',
      run: { ...run, status: 'completed', endedAt: 2, text: { ...run.text, stdout: output } }
    })
    const slot = join(doc.notebookSessionRoot, '.pending-runs', '32.json')
    const entry = JSON.parse(await readFile(slot, 'utf8'))
    expect(entry.run).toMatchObject({ storage: 'file', runId: run.runId })
    const record = join(doc.notebookSessionRoot, '.run-records', entry.run.sha256 + '.json')
    const body = await readFile(record, 'utf8')
    await writeFile(record, body.replace('xxx', 'yyy'))
    await expect(repo.checkpointPendingRuns()).rejects.toThrow(/checkpoint/i)
    expect(await readFile(manifest, 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(slot, 'utf8'))).toEqual(entry)
    await writeFile(record, body)
    const reader = new NotebookRunRepository(root)
    await reader.recoverAllRunLifecycles()
    const recovered = await reader.findExisting('p', 's', request.lane)
    expect(recovered?.runs.at(-1)?.text.stdout).toBe(output)
    expect(JSON.parse(await readFile(manifest, 'utf8')).runs.at(-1)).toEqual(entry.run)
  })

  it('keeps new lifecycle writes off a large mixed manifest and verifies its external body', async () => {
    const root = await createStorageRoot()
    const lane = createFrameNotebookLane('p', 's', 'f')
    const request = { projectId: 'p', sessionId: 's', lane }
    const repo = new NotebookRunRepository(root)
    const doc = await repo.loadOrCreate({ ...request, workspaceCwd: root })
    const manifest = join(doc.notebookSessionRoot, 'run.json')
    const base = JSON.parse(await readFile(manifest, 'utf8'))
    const stdout = 'x'.repeat(60_000)
    base.runs = Array.from({ length: 600 }, (_, i) =>
      admittedRun({
        runId: 'old-' + i,
        submissionIdentity: 'old-' + i,
        text: { stdout, stderr: '', traceback: '', plain: [] },
        status: 'completed'
      })
    )
    await writeFile(manifest, JSON.stringify(base))
    // Pure inline version 1 manifests also serve old results without a conversion.
    const legacy = new NotebookRunRepository(root)
    const legacyIdentity = await stat(manifest, { bigint: true })
    await legacy.findExisting('p', 's', lane)
    const legacyResult = await legacy.readCachedHistoryWindow('p', 's', {
      limit: 0,
      runIds: ['old-1'],
      lane
    })
    expect(legacyResult?.window.runs[0]?.text.stdout).toBe(stdout)
    expect((await stat(manifest, { bigint: true })).mtimeNs).toBe(legacyIdentity.mtimeNs)
    const external = { ...base.runs[0], script: 'x'.repeat(180_000) }
    await repo.updateRun({ ...request, run: external })
    const before = await stat(manifest, { bigint: true })
    const run = admittedRun()
    await repo.appendOrGetRun({ ...request, run })
    await repo.transitionRun({
      ...request,
      expectedStatus: 'queued',
      run: { ...run, status: 'running' }
    })
    await repo.requestRunCancellation({ ...request, run, requestedAt: 2, reason: 'user-requested' })
    await repo.commitTerminalRun({
      ...request,
      expectedStatus: 'running',
      run: { ...run, status: 'cancelled', endedAt: 3 }
    })
    const reads = vi.spyOn(durableFiles, 'readDurableJsonFile')
    try {
      expect(await repo.hasCachedForegroundOnlyHistory('p', 's', lane)).toBe(true)
      const selected = await repo.readCachedHistoryWindow('p', 's', {
        limit: 0,
        runIds: ['old-0', 'old-599', run.runId],
        lane
      })
      expect(selected?.window.runs.map((row) => [row.runId, row.text.stdout])).toEqual(
        expect.arrayContaining([
          ['old-0', stdout],
          ['old-599', stdout],
          [run.runId, '']
        ])
      )
      const older = await repo.readCachedHistoryWindow('p', 's', {
        limit: 0,
        runIds: ['old-1', 'old-2'],
        lane
      })
      expect(older?.window.runs.map((row) => [row.runId, row.text.stdout])).toEqual([
        ['old-1', stdout],
        ['old-2', stdout]
      ])

      const index = await repo.readSessionRunIndex('p', 's')
      expect(index.find((row) => row.runId === 'old-0')).toMatchObject({
        hasOutput: true,
        detailBytes: expect.any(Number)
      })
      expect(index.find((row) => row.runId === 'old-0')!.detailBytes).toBeGreaterThan(400000)
      const initialized = await repo.loadSessionInitialization({ ...request, workspaceCwd: root })
      expect(initialized.runs).toHaveLength(601)
      const evidence = await repo.readCachedHistoryWindow('p', 's', {
        limit: 0,
        runIds: [run.runId],
        lane,
        evidenceOnly: true
      })
      expect(evidence?.window.runs[0]?.cancellationReason).toBe('user-requested')
      await repo.loadSessionKernel({ ...request, workspaceCwd: root })
      expect((await repo.readLaneAnalysisRuns('p', 's', lane)).at(-1)?.status).toBe('cancelled')
      const task = admittedRun({
        runId: 'background',
        submissionIdentity: 'background',
        executionMode: 'background',
        startedAt: 5
      })
      await repo.appendOrGetRun({ ...request, run: task })
      expect((await repo.findRun('p', 's', lane, { runId: task.runId }))?.run.runId).toBe(
        task.runId
      )
      const tasks = await repo.readCachedHistoryWindow('p', 's', {
        limit: 100,
        runIds: [],
        lane,
        backgroundTaskMetadata: true
      })
      expect(tasks?.window.runs.map((row) => row.runId)).toEqual([task.runId])
      expect(reads.mock.calls.some(([path]) => path === manifest)).toBe(false)
    } finally {
      reads.mockRestore()
    }
    const after = await stat(manifest, { bigint: true })
    expect([after.ino, after.mtimeNs, after.size]).toEqual([
      before.ino,
      before.mtimeNs,
      before.size
    ])
    await repo.checkpointPendingRuns()
    const fresh = new NotebookRunRepository(root)
    const saved = await fresh.findExisting('p', 's', lane)
    expect(saved?.runs[0].script).toBe(external.script)
    expect(saved?.runs.find((row) => row.runId === run.runId)).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'user-requested',
      cancellationRequestedAt: 2
    })
    const records = join(doc.notebookSessionRoot, '.run-records')
    const [file] = await readdir(records)
    await writeFile(join(records, file), 'broken')
    await expect(
      fresh.appendOrGetRun({
        ...request,
        run: admittedRun({ runId: 'next', submissionIdentity: 'next' })
      })
    ).rejects.toThrow(/corrupt/i)
  })

  it.each([
    [`0.json.${process.pid}-12345678-1234-1234-1234-123456789abc.tmp`, '{'],
    ['0.json', '{'],
    ['.DS_Store', 'unrelated'],
    ['0.json.invalid.tmp', 'unrecognized'],
    ['0.json.1699999999999-1.tmp', 'x'.repeat(65537)]
  ])('isolates a damaged pending lane containing %s during recovery', async (name, contents) => {
    const root = await createStorageRoot()
    const repo = new NotebookRunRepository(root)
    const [bad, good] = ['a', 'b'].map((id) => ({
      projectId: 'p',
      sessionId: id,
      lane: createRootNotebookLane('p', id, 'root-frame-' + id)
    }))
    const damaged = await repo.loadOrCreate({ ...bad, workspaceCwd: root })
    const hot = join(damaged.notebookSessionRoot, '.pending-runs')
    await mkdir(hot)
    await writeFile(join(hot, name), contents)
    await repo.loadOrCreate({ ...good, workspaceCwd: root })
    await repo.appendRun({
      ...good,
      run: admittedRun({ status: 'running', executionMode: 'background' })
    })
    const fresh = new NotebookRunRepository(root)
    const recovered = await fresh.recoverAllRunLifecycles()
    expect(recovered.map((item) => [item.sessionId, item.run.status])).toEqual([
      ['b', 'interrupted']
    ])
    await expect(fresh.appendOrGetRun({ ...bad, run: admittedRun() })).rejects.toThrow()
    expect(await readFile(join(hot, name), 'utf8')).toBe(contents)
    const secondWriter = new NotebookRunRepository(root)
    await expect(
      secondWriter.commitTerminalRun({
        ...bad,
        run: admittedRun({ status: 'completed', endedAt: 3 }),
        expectedStatus: 'running'
      })
    ).rejects.toThrow()
    await expect(
      stat(join(damaged.notebookSessionRoot, '.run-terminal-outbox'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(secondWriter.checkpointPendingRuns()).rejects.toThrow('checkpoints incomplete')
    await rm(join(hot, name))
    await expect(secondWriter.appendOrGetRun({ ...bad, run: admittedRun() })).rejects.toThrow()
    await fresh.recoverAllRunLifecycles()
    expect((await secondWriter.appendOrGetRun({ ...bad, run: admittedRun() })).admitted).toBe(true)
    await secondWriter.checkpointPendingRuns()
  })

  it('checkpoints a healthy sibling even when the first pending lane cannot be merged', async () => {
    const root = await createStorageRoot()
    const writer = new NotebookRunRepository(root)
    const manifests: string[] = []
    for (const sessionId of ['bad', 'good']) {
      const lane = createRootNotebookLane('p', sessionId, 'root-frame-' + sessionId)
      const request = { projectId: 'p', sessionId, lane }
      const doc = await writer.loadOrCreate({ ...request, workspaceCwd: root })
      const manifest = join(doc.notebookSessionRoot, 'run.json')
      manifests.push(manifest)
      const base = JSON.parse(await readFile(manifest, 'utf8'))
      base.runs = Array.from({ length: 32 }, (_, i) =>
        admittedRun({
          runId: 'old-' + i,
          submissionIdentity: 'old-' + i,
          status: 'completed',
          script: 'x'.repeat(34000)
        })
      )
      await writeFile(manifest, JSON.stringify(base))
      await writer.appendOrGetRun({ ...request, run: admittedRun() })
    }
    const stray = join(dirname(manifests[0]), '.pending-runs', '.DS_Store')
    await writeFile(stray, 'unrelated')
    const other = new NotebookRunRepository(root)
    await expect(other.checkpointPendingRuns()).rejects.toThrow('checkpoints incomplete')
    const counts = await Promise.all(
      manifests.map(async (path) => JSON.parse(await readFile(path, 'utf8')).runs.length)
    )
    expect(counts).toEqual([32, 33])
    await rm(stray)
    await other.recoverAllRunLifecycles()
    await writer.checkpointPendingRuns()
    expect(JSON.parse(await readFile(manifests[0], 'utf8')).runs.at(-1).status).toBe('interrupted')
  })

  it.each([
    { kernelKind: 'bash', exitCode: -1, readable: true },
    { kernelKind: 'bash', exitCode: -2147483648, readable: true },
    { kernelKind: 'bash', exitCode: 4294967295, readable: true },
    { kernelKind: 'bash', exitCode: -1.5, readable: false },
    { kernelKind: 'bash', exitCode: '-1', readable: false },
    { kernelKind: 'bash', exitCode: Number.MAX_SAFE_INTEGER + 1, readable: false },
    { kernelKind: 'python', exitCode: -1, readable: false },
    { kernelKind: 'r', exitCode: -1, readable: false },
    { kernelKind: 'repl', exitCode: -1, readable: false },
    { kernelKind: undefined, exitCode: -1, readable: false }
  ])(
    'validates persisted $kernelKind exit code $exitCode without rewriting history',
    async ({ kernelKind, exitCode, readable }) => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const projectId = 'default-project'
      const sessionId = 'session-1'
      const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
      const document = await repository.loadOrCreate({
        projectId,
        sessionId,
        lane,
        workspaceCwd: '/workspace'
      })
      await repository.appendRun({
        projectId,
        sessionId,
        lane,
        run: admittedRun({
          kernelKind: 'bash',
          status: 'failed',
          endedAt: 2,
          exitCode: 1
        })
      })
      const path = join(document.notebookSessionRoot, 'run.json')
      const persisted = JSON.parse(await readFile(path, 'utf8'))
      persisted.runs[0].kernelKind = kernelKind
      persisted.runs[0].exitCode = exitCode
      const before = JSON.stringify(persisted)
      await writeFile(path, before)

      const reopened = new NotebookRunRepository(root).findExisting(projectId, sessionId)
      if (readable) {
        await expect(reopened).resolves.toMatchObject({
          runs: [expect.objectContaining({ status: 'failed', exitCode })]
        })
      } else {
        await expect(reopened).rejects.toThrow('Notebook document is corrupt.')
      }
      expect(await readFile(path, 'utf8')).toBe(before)
    }
  )

  it('preserves failed runs and optional execution evidence after reopening durable history', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    await repository.loadOrCreate({ projectId, sessionId, lane, workspaceCwd: '/workspace' })
    const runs = [
      admittedRun({ runId: 'parse-failure', status: 'failed', executionStarted: false }),
      admittedRun({ runId: 'runtime-failure', status: 'failed', executionStarted: true }),
      admittedRun({ runId: 'legacy-failure', status: 'failed' })
    ]
    for (const run of runs) {
      await repository.appendRun({ projectId, sessionId, lane, run })
    }

    const reopened = new NotebookRunRepository(root)
    const history = await reopened.readSessionRuns(projectId, sessionId)
    expect(history).toHaveLength(3)
    expect(history).toEqual(expect.arrayContaining(runs.map((run) => expect.objectContaining(run))))
    expect(history.find((run) => run.runId === 'legacy-failure')).not.toHaveProperty(
      'executionStarted'
    )
  })

  it('keeps a published large Run file when only the kernel status changes after environment capture', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const scope = { projectId: 'project', sessionId: 'session' }
    const lane = createRootNotebookLane(scope.projectId, scope.sessionId, 'root-frame-session')
    const document = await repository.loadOrCreate({ ...scope, lane, workspaceCwd: root })
    const { manifest, checksum } = completedEnvironmentManifest()
    await repository.appendRun({
      ...scope,
      lane,
      run: admittedRun({
        status: 'completed',
        environmentManifest: manifest,
        environmentCapture: { state: 'available', manifestChecksum: checksum },
        text: { stdout: 'x'.repeat(1024 * 1024), stderr: '', traceback: '', plain: [] }
      })
    })
    const writes = vi.spyOn(durableFiles, 'writeDurableJsonFile')
    try {
      await repository.updateKernelStatus({ ...scope, lane, status: 'restarting' })
      expect(writes.mock.calls.map(([file]) => file)).toEqual([
        join(document.notebookSessionRoot, 'run.json')
      ])
    } finally {
      writes.mockRestore()
    }
  })

  it('persists environment manifests as checksum-addressed sidecars and hydrates targeted reads', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    const document = await repository.loadOrCreate({
      projectId,
      sessionId,
      lane,
      workspaceCwd: '/workspace'
    })
    const { manifest, checksum } = completedEnvironmentManifest()
    await repository.appendRun({
      projectId,
      sessionId,
      lane,
      run: admittedRun({
        status: 'completed',
        endedAt: 2,
        kernelKind: 'python',
        environment: 'default-python',
        environmentCapture: { state: 'available', manifestChecksum: checksum },
        environmentManifest: manifest
      })
    })

    const raw = JSON.parse(await readFile(join(document.notebookSessionRoot, 'run.json'), 'utf8'))
    expect(raw.runs[0]).toMatchObject({
      environmentCapture: { state: 'available', manifestChecksum: checksum }
    })
    expect(raw.runs[0]).not.toHaveProperty('environmentManifest')

    const sidecarPath = join(
      root,
      'runtime',
      'provenance',
      'environment-manifests',
      `${checksum}.json`
    )
    expect(JSON.parse(await readFile(sidecarPath, 'utf8'))).toEqual(manifest)

    const cachedOrdinary = await repository.readSessionDocuments(projectId, sessionId)
    expect(cachedOrdinary[0]?.runs[0]).not.toHaveProperty('environmentManifest')

    const reopened = new NotebookRunRepository(root)
    const ordinary = await reopened.readSessionDocuments(projectId, sessionId)
    expect(ordinary[0]?.runs[0]).not.toHaveProperty('environmentManifest')
    const targeted = await reopened.readSessionRunWindow(projectId, sessionId, 0, ['run-1'])
    expect(targeted.runs[0]?.environmentManifest).toEqual(manifest)
    const lightRuns = await reopened.readSessionRuns(projectId, sessionId)
    expect(lightRuns[0]).not.toHaveProperty('environmentManifest')
    const fullRuns = await reopened.readSessionRuns(projectId, sessionId, {
      includeEnvironmentManifests: true
    })
    expect(fullRuns[0]?.environmentManifest).toEqual(manifest)
    const found = await reopened.findRun(projectId, sessionId, lane, { runId: 'run-1' })
    expect(found?.run.environmentManifest).toEqual(manifest)

    await repository.appendRun({
      projectId,
      sessionId,
      lane,
      run: admittedRun({
        runId: 'legacy-inline',
        status: 'completed',
        endedAt: 3,
        environmentManifest: manifest
      })
    })
    const legacyWindow = await reopened.readSessionRunWindow(projectId, sessionId, 10)
    expect(
      legacyWindow.runs.find((run) => run.runId === 'legacy-inline')?.environmentManifest
    ).toEqual(manifest)

    await writeFile(sidecarPath, '{}')
    const corrupt = await reopened.readSessionRunWindow(projectId, sessionId, 0, ['run-1'])
    expect(corrupt.runs[0]).not.toHaveProperty('environmentManifest')
  })

  it('publishes and loads shared environment evidence once per operation', async () => {
    const root = await createStorageRoot()
    const scope = { projectId: 'project', sessionId: 'session' }
    const lane = createRootNotebookLane('project', 'session', 'root-frame-session')
    const writer = new NotebookRunRepository(root)
    const doc = await writer.loadOrCreate({ ...scope, lane, workspaceCwd: root })
    const path = join(doc.notebookSessionRoot, 'run.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    const { manifest, checksum } = completedEnvironmentManifest()
    legacy.runs = ['a', 'b'].map((runId) =>
      admittedRun({
        runId,
        status: 'completed',
        environmentManifest: manifest,
        environmentManifestChecksum: checksum
      })
    )
    await writeFile(path, JSON.stringify(legacy))
    const sidecar = join(root, 'runtime', 'provenance', 'environment-manifests', checksum + '.json')
    const writes = vi.spyOn(durableFiles, 'writeDurableJsonFile')
    const reads = vi.spyOn(durableFiles, 'readFileWithinLimit')
    try {
      await writer.updateKernelStatus({ ...scope, lane, status: 'idle' })
      expect(writes.mock.calls.filter(([file]) => file === sidecar)).toHaveLength(1)
      const rows = await writer.readAnalysisRuns('project', 'session', {
        includeEnvironmentManifests: true
      })
      expect(reads.mock.calls.filter(([file]) => file === sidecar)).toHaveLength(1)
      expect(rows.map((run) => run.environmentManifest)).toEqual([manifest, manifest])
      expect(rows[0].environmentManifest?.packages).not.toBe(rows[1].environmentManifest?.packages)
      legacy.runs[1].environmentManifest = { ...manifest, complete: false }
      await writeFile(path, JSON.stringify(legacy))
      await expect(writer.updateKernelStatus({ ...scope, lane, status: 'idle' })).rejects.toThrow(
        'checksum mismatch'
      )
    } finally {
      reads.mockRestore()
      writes.mockRestore()
    }
  })

  it('preserves valid history with more than 32 loaded helper modules', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    const document = await repository.loadOrCreate({
      projectId,
      sessionId,
      lane,
      workspaceCwd: '/workspace'
    })
    const helperModules = Array.from({ length: 33 }, (_, index) => {
      const source = `def reader_${index}():\n    return 1`
      return {
        helperId: `helper-${index}`,
        skillIdentity: 'skill://readers',
        packageOrigin: 'test',
        interfaceRevision: '1',
        registeredGeneration: 'generation-1',
        exports: [`reader_${index}`],
        source,
        sourceDigest: digestNotebookHelperSource(source)
      }
    })
    await repository.appendRun({
      projectId,
      sessionId,
      lane,
      run: admittedRun({
        status: 'completed',
        helperModules,
        helperEvidenceStatus: { state: 'complete' }
      })
    })
    const filePath = join(document.notebookSessionRoot, 'run.json')
    const before = await readFile(filePath, 'utf8')
    const reopened = new NotebookRunRepository(root)
    expect(await reopened.readSessionRuns(projectId, sessionId)).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        helperModules,
        helperEvidenceStatus: { state: 'complete' }
      })
    ])
    expect(await readFile(filePath, 'utf8')).toBe(before)
  })

  it('resolves a provisional root Frame without reading it as a child Frame lane', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const projectId = 'default-project'
    const sessionId = 'canonical-session'
    const provisionalRootFrameId = 'root-frame-pending-session-1'
    const rootLane = createRootNotebookLane(projectId, sessionId, provisionalRootFrameId)
    await repository.loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane: rootLane
    })
    await repository.appendOrGetRun({
      projectId,
      sessionId,
      lane: rootLane,
      run: admittedRun({
        runId: 'run-root',
        executionMode: 'background',
        rootFrameId: provisionalRootFrameId,
        agentFrameId: provisionalRootFrameId
      })
    })

    await expect(
      repository.findOwnedRun(projectId, sessionId, provisionalRootFrameId, {
        runId: 'run-root'
      })
    ).resolves.toMatchObject({ run: { runId: 'run-root' } })
    await expect(
      repository.findOwnedRun(projectId, sessionId, 'child-frame', { runId: 'run-root' })
    ).resolves.toBeUndefined()
  })

  it.each([false, true])(
    'counts and exports root aliases without rewriting provenance (missing root: %s)',
    async (missingRoot) => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const projectId = 'default-project'
      const sessionId = 'canonical-session'
      const provisionalRoot = 'provisional-owner'
      const canonicalRoot = `root-frame-${sessionId}`
      const records = [
        { id: 'manual', frame: canonicalRoot, root: 'explicit-root-owner' },
        { id: 'agent', frame: provisionalRoot, root: missingRoot ? undefined : provisionalRoot },
        {
          id: 'child',
          frame: 'root-frame-unrelated-delegate',
          root: missingRoot ? undefined : provisionalRoot
        }
      ]
      for (const [index, record] of records.entries()) {
        const lane =
          record.id === 'child'
            ? createFrameNotebookLane(projectId, sessionId, record.frame)
            : createRootNotebookLane(projectId, sessionId, record.frame)
        await repository.loadOrCreate({ projectId, sessionId, workspaceCwd: '/workspace', lane })
        await repository.appendRun({
          projectId,
          sessionId,
          lane,
          run: admittedRun({
            runId: record.id,
            cellId: record.id,
            submissionIdentity: undefined,
            submissionFingerprint: undefined,
            startedAt: index,
            status: 'completed',
            script: `print("${record.id}")`,
            rootFrameId: record.root,
            agentFrameId: record.frame,
            messageBranchId: `branch-${index}`,
            environment: index === 1 ? 'analysis' : 'default-python'
          })
        })
      }
      const stored = await repository.readSessionDocuments(projectId, sessionId)
      const runPath = getNotebookRunJsonPath(root, projectId, sessionId)
      const storedBytes = await readFile(runPath, 'utf8')
      const exporter = new NotebookExportReader({ repository, defaultProjectId: projectId })
      for (const frameId of [provisionalRoot, canonicalRoot, 'root-frame-unrelated-delegate']) {
        const expectedIds =
          frameId === 'root-frame-unrelated-delegate' ? ['child'] : ['manual', 'agent']
        const window = await repository.readSessionRunWindow(projectId, sessionId, 1, [], frameId)
        expect(window.agentSummaries).toEqual([
          {
            agentFrameId: canonicalRoot,
            isRoot: true,
            runCount: 2,
            views: [
              { kernelKind: 'python', environment: 'analysis', runCount: 1, latestRunId: 'agent' },
              {
                kernelKind: 'python',
                environment: 'default-python',
                runCount: 1,
                latestRunId: 'manual'
              }
            ]
          },
          {
            agentFrameId: 'root-frame-unrelated-delegate',
            isRoot: false,
            runCount: 1,
            views: [
              {
                kernelKind: 'python',
                environment: 'default-python',
                runCount: 1,
                latestRunId: 'child'
              }
            ]
          }
        ])
        expect(window.historySummary).toMatchObject({
          agentFrameId: frameId,
          runCount: expectedIds.length,
          kernelCounts: { python: expectedIds.length }
        })
        const exported = await exporter.readKernel({
          projectId,
          sessionId,
          workspaceCwd: '/workspace',
          kernel: 'python',
          agentFrameFilter: frameId
        })
        const notebook = JSON.parse(exported.data) as { cells: { source: string[] }[] }
        expect(notebook.cells.map((cell) => cell.source.join(''))).toEqual(
          expectedIds.map((id) => `print("${id}")`)
        )
      }
      expect(
        await new NotebookRunRepository(root).readSessionDocuments(projectId, sessionId)
      ).toEqual(stored)
      expect(await readFile(runPath, 'utf8')).toBe(storedBytes)
      const targeted = await repository.readSessionRunWindow(projectId, sessionId, 0, [
        'agent',
        'child'
      ])
      expect(targeted.runs).toMatchObject([
        { runId: 'agent', agentFrameId: provisionalRoot, rootFrameId: provisionalRoot },
        {
          runId: 'child',
          agentFrameId: 'root-frame-unrelated-delegate',
          rootFrameId: missingRoot ? undefined : provisionalRoot
        }
      ])
      expect((await repository.readSessionRuns(projectId, sessionId))[0].rootFrameId).toBe(
        'explicit-root-owner'
      )
      expect(
        (await repository.readSessionRuns(projectId, sessionId)).map((run) => run.agentFrameId)
      ).toEqual(records.map((record) => record.frame))
    }
  )

  it('atomically returns the canonical Run for a repeated submission', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })

    const first = await repository.appendOrGetRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun()
    })
    const repeated = await repository.appendOrGetRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun({ runId: 'run-that-must-not-be-created' })
    })

    expect(first.admitted).toBe(true)
    expect(repeated).toMatchObject({ admitted: false, run: { runId: 'run-1' } })
    expect(await repository.readSessionRunIndex('default-project', 'session-1')).toHaveLength(1)
  })

  it('rejects reuse of a submission identity with a different fingerprint', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    await repository.appendOrGetRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun()
    })

    await expect(
      repository.appendOrGetRun({
        projectId: 'default-project',
        sessionId: 'session-1',
        lane,
        run: admittedRun({ runId: 'run-2', submissionFingerprint: 'b'.repeat(64) })
      })
    ).rejects.toMatchObject({
      name: 'NotebookRunSubmissionConflictError',
      code: 'NOTEBOOK_RUN_SUBMISSION_CONFLICT'
    } satisfies Partial<NotebookRunSubmissionConflictError>)
  })

  it('uses expected-state transitions and never overwrites a terminal Run', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    await repository.appendOrGetRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun()
    })

    const running = await repository.transitionRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun({ status: 'running' }),
      expectedStatus: 'queued'
    })
    const completed = await repository.transitionRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun({ status: 'completed', endedAt: 2 }),
      expectedStatus: 'running'
    })
    const lateCancellation = await repository.transitionRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun({ status: 'cancelled', endedAt: 3 }),
      expectedStatus: 'running'
    })

    expect(running.transitioned).toBe(true)
    expect(completed.transitioned).toBe(true)
    expect(lateCancellation).toMatchObject({
      transitioned: false,
      run: { status: 'completed', endedAt: 2 }
    })
  })

  it('repairs a durable terminal outcome after the canonical terminal write fails', async () => {
    const root = await createStorageRoot()
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const repository = new NotebookRunRepository(root)
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    await repository.appendOrGetRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun()
    })
    await repository.transitionRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: admittedRun({ status: 'running' }),
      expectedStatus: 'queued'
    })

    const transition = repository.transitionRun.bind(repository)
    let failCanonicalWrite = true
    repository.transitionRun = async (request) => {
      if (failCanonicalWrite) {
        failCanonicalWrite = false
        throw new Error('injected canonical write failure')
      }
      return transition(request)
    }
    await expect(
      repository.commitTerminalRun({
        projectId: 'default-project',
        sessionId: 'session-1',
        lane,
        run: admittedRun({ status: 'completed', endedAt: 2 }),
        expectedStatus: 'running'
      })
    ).rejects.toThrow('injected canonical write failure')

    await new NotebookRunRepository(root).recoverAllRunLifecycles()

    const recovered = await new NotebookRunRepository(root).findExisting(
      'default-project',
      'session-1'
    )
    expect(recovered?.runs[0]).toMatchObject({ status: 'completed', endedAt: 2 })
  })

  it.each(['root', 'frame'] as const)(
    'recovers a temp-only terminal fact before interrupting its %s lane and replays background delivery',
    async (kind) => {
      const fixture = await createTerminalRecoveryFixture(kind)
      await writeFile(fixture.temporaryPath, JSON.stringify(fixture.fact), 'utf8')

      const reopened = new NotebookRunRepository(fixture.root)
      const deliveries = await reopened.recoverAllRunLifecycles()
      const document = await reopened.findExisting(
        fixture.projectId,
        fixture.sessionId,
        fixture.lane
      )
      expect(document?.runs[0]).toMatchObject(fixture.terminal)
      expect(deliveries).toEqual([
        {
          projectId: fixture.projectId,
          sessionId: fixture.sessionId,
          run: expect.objectContaining(fixture.terminal)
        }
      ])
      await expect(readdir(fixture.outboxRoot)).resolves.toEqual([])
      await expect(
        new NotebookRunRepository(fixture.root).recoverAllRunLifecycles()
      ).resolves.toEqual(deliveries)
    }
  )

  it.each(['live writer', 'unrecognized suffix', 'invalid fact'] as const)(
    'preserves a terminal temp from a %s without adopting its outcome',
    async (kind) => {
      const fixture = await createTerminalRecoveryFixture()
      const temporaryPath =
        kind === 'live writer'
          ? `${fixture.factPath}.${process.pid}-12345678-1234-1234-1234-123456789abc.tmp`
          : kind === 'unrecognized suffix'
            ? `${fixture.factPath}.unrecognized.tmp`
            : fixture.temporaryPath
      const contents = JSON.stringify(
        kind === 'invalid fact' ? { ...fixture.fact, expectedStatus: 'queued' } : fixture.fact
      )
      await writeFile(temporaryPath, contents, 'utf8')

      const reopened = new NotebookRunRepository(fixture.root)
      const deliveries = await reopened.recoverAllRunLifecycles()
      const document = await reopened.findExisting(
        fixture.projectId,
        fixture.sessionId,
        fixture.lane
      )
      expect(document?.runs[0]).toMatchObject({
        status: 'interrupted',
        interruptionReason: 'app-terminated',
        text: fixture.running.text,
        outputs: []
      })
      expect(deliveries[0]?.run.status).toBe('interrupted')
      await expect(readFile(temporaryPath, 'utf8')).resolves.toBe(contents)
      await expect(stat(fixture.factPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects a recovered foreign terminal fact before mutating its lane', async () => {
    const fixture = await createTerminalRecoveryFixture()
    const contents = JSON.stringify({ ...fixture.fact, sessionId: 'another-session' })
    await writeFile(fixture.temporaryPath, contents, 'utf8')

    const reopened = new NotebookRunRepository(fixture.root)
    await expect(reopened.recoverAllRunLifecycles()).rejects.toThrow(
      'Notebook terminal outcome recovery fact ownership mismatch.'
    )
    const document = await reopened.findExisting(fixture.projectId, fixture.sessionId, fixture.lane)
    expect(document?.runs[0]).toMatchObject(fixture.running)
    await expect(readFile(fixture.factPath, 'utf8')).resolves.toBe(contents)
  })

  it('keeps an existing terminal Run authoritative over a recovered temporary fact', async () => {
    const fixture = await createTerminalRecoveryFixture()
    await fixture.repository.transitionRun({
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      lane: fixture.lane,
      expectedStatus: 'running',
      run: { ...fixture.running, status: 'cancelled', endedAt: 3 }
    })
    await writeFile(fixture.temporaryPath, JSON.stringify(fixture.fact), 'utf8')

    const reopened = new NotebookRunRepository(fixture.root)
    const deliveries = await reopened.recoverAllRunLifecycles()
    const document = await reopened.findExisting(fixture.projectId, fixture.sessionId, fixture.lane)
    expect(document?.runs[0]).toMatchObject({ status: 'cancelled', endedAt: 3, outputs: [] })
    expect(deliveries[0]?.run).toMatchObject({ status: 'cancelled', endedAt: 3 })
    await expect(readdir(fixture.outboxRoot)).resolves.toEqual([])
  })

  it('globally interrupts stale admitted Runs without opening their Sessions', async () => {
    const root = await createStorageRoot()
    const priorRepository = new NotebookRunRepository(root)
    const rootLane = createRootNotebookLane(
      'default-project',
      'root-session',
      'root-frame-root-session'
    )
    const frameLane = createFrameNotebookLane('default-project', 'frame-session', 'frame-1')
    for (const [sessionId, lane] of [
      ['root-session', rootLane],
      ['frame-session', frameLane]
    ] as const) {
      await priorRepository.loadOrCreate({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: '/workspace',
        lane
      })
      await priorRepository.appendOrGetRun({
        projectId: 'default-project',
        sessionId,
        lane,
        run: admittedRun({
          runId: `run-${sessionId}`,
          submissionIdentity: `submission-${sessionId}`,
          executionMode: 'background'
        })
      })
    }

    const recoveredDeliveries = await new NotebookRunRepository(root).recoverAllRunLifecycles()

    const recoveredRoot = await new NotebookRunRepository(root).findExisting(
      'default-project',
      'root-session'
    )
    const recoveredFrame = await new NotebookRunRepository(root).readSessionDocuments(
      'default-project',
      'frame-session'
    )
    expect(recoveredRoot?.runs[0]).toMatchObject({
      status: 'interrupted',
      interruptionReason: 'app-terminated'
    })
    expect(recoveredFrame[0]?.runs[0]).toMatchObject({
      status: 'interrupted',
      interruptionReason: 'app-terminated'
    })
    expect(recoveredDeliveries).toEqual([
      {
        projectId: 'default-project',
        sessionId: 'frame-session',
        run: expect.objectContaining({
          runId: 'run-frame-session',
          status: 'interrupted',
          interruptionReason: 'app-terminated'
        })
      },
      {
        projectId: 'default-project',
        sessionId: 'root-session',
        run: expect.objectContaining({
          runId: 'run-root-session',
          status: 'interrupted',
          interruptionReason: 'app-terminated'
        })
      }
    ])
  })

  it('does not block startup recovery when an unrelated Notebook document is corrupt', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const validProjectId = 'default-project'
    const validSessionId = 'valid-session'
    const validLane = createRootNotebookLane(
      validProjectId,
      validSessionId,
      'root-frame-valid-session'
    )
    await repository.loadOrCreate({
      projectId: validProjectId,
      sessionId: validSessionId,
      workspaceCwd: '/workspace',
      lane: validLane
    })
    const validRun = admittedRun({
      runId: 'background-run',
      executionMode: 'background',
      status: 'completed',
      endedAt: 2
    })
    await repository.appendRun({
      projectId: validProjectId,
      sessionId: validSessionId,
      lane: validLane,
      run: validRun
    })

    const corruptProjectId = 'corrupt-project'
    const corruptSessionId = 'corrupt-session'
    const corruptDocument = await repository.loadOrCreate({
      projectId: corruptProjectId,
      sessionId: corruptSessionId,
      workspaceCwd: '/workspace',
      lane: createRootNotebookLane(corruptProjectId, corruptSessionId, 'root-frame-corrupt')
    })
    const corruptPath = join(corruptDocument.notebookSessionRoot, 'run.json')
    await writeFile(corruptPath, '{ not-json', 'utf8')

    await expect(repository.recoverAllRunLifecycles()).resolves.toEqual([
      {
        projectId: validProjectId,
        sessionId: validSessionId,
        run: expect.objectContaining({ runId: validRun.runId, status: 'completed' })
      }
    ])
    await expect(readFile(corruptPath, 'utf8')).resolves.toBe('{ not-json')
  })

  it('replays every durable terminal background Run even after its terminal fact is gone', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane(
      'default-project',
      'terminal-background',
      'root-frame-terminal-background'
    )
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'terminal-background',
      workspaceCwd: '/workspace',
      lane
    })
    const queued = admittedRun({ executionMode: 'background' })
    await repository.appendOrGetRun({
      projectId: 'default-project',
      sessionId: 'terminal-background',
      lane,
      run: queued
    })
    await repository.transitionRun({
      projectId: 'default-project',
      sessionId: 'terminal-background',
      lane,
      expectedStatus: 'queued',
      run: { ...queued, status: 'running' }
    })
    await repository.commitTerminalRun({
      projectId: 'default-project',
      sessionId: 'terminal-background',
      lane,
      expectedStatus: 'running',
      run: { ...queued, status: 'completed', endedAt: 2 }
    })

    const firstStartup = await new NotebookRunRepository(root).recoverAllRunLifecycles()
    const secondStartup = await new NotebookRunRepository(root).recoverAllRunLifecycles()

    expect(firstStartup).toEqual([
      {
        projectId: 'default-project',
        sessionId: 'terminal-background',
        run: expect.objectContaining({ runId: 'run-1', status: 'completed' })
      }
    ])
    expect(secondStartup).toEqual(firstStartup)
  })

  it('recovers a valid historical run.json temp when the primary is missing', async () => {
    const root = await createStorageRoot()
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const original = await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/workspace/before-crash'
    })
    const filePath = join(original.notebookSessionRoot, 'run.json')
    await rename(filePath, `${filePath}.1700000000000-1.tmp`)

    const recovered = await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/workspace/after-crash'
    })

    expect(recovered.workspaceCwd).toBe('/workspace/after-crash')
    expect(recovered.updatedAt).toBe(original.updatedAt)
    await expect(readdir(original.notebookSessionRoot)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining('.tmp')])
    )
    await expect(readFile(filePath, 'utf8')).resolves.toContain('before-crash')
  })

  it('bounds the process-lifetime full-document cache', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    for (let index = 0; index < 9; index += 1) {
      const sessionId = `session-${index}`
      await repository.loadOrCreate({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: '/workspace',
        lane: createRootNotebookLane('default-project', sessionId, `root-frame-${index}`)
      })
    }

    const cache = repository as unknown as {
      documentCache: Map<string, unknown>
      documentCacheBytes: number
    }
    expect(cache.documentCache.size).toBe(8)
    expect(cache.documentCacheBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
  })

  it('fails closed when a new run write omits its Frame lane', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    await expect(
      repository.loadOrCreate({
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      } as never)
    ).rejects.toThrow('Notebook writes require an explicit Frame lane.')
  })

  it('persists the explicit lane as the owner of every new Run', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })

    const document = await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: {
        runId: 'new-run',
        cellId: 'cell-new-run',
        source: 'agent',
        kernelKind: 'python',
        script: '1',
        status: 'completed',
        startedAt: 1,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    expect(document.runs[0]?.agentFrameId).toBe('root-frame-session-1')
  })

  it('round-trips optional kernel, runtime, and file-generation evidence', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const document = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: {
        runId: 'external-run',
        cellId: 'cell-external-run',
        source: 'agent',
        kernelKind: 'python',
        kernelEpochId: 'epoch-1',
        kernelDispatched: true,
        runtimeId: '/external/python',
        script: 'x = 1',
        status: 'completed',
        startedAt: 1,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [
          {
            path: join(document.notebookSessionRoot, 'data', 'result.csv'),
            relativePath: 'data/result.csv',
            kind: 'other',
            generationId: 'generation-1',
            checksum: 'b'.repeat(64),
            change: 'created'
          }
        ],
        fileEvidence: {
          schemaVersion: 1,
          activityId: 'external-run',
          activityKind: 'notebook-run',
          evidenceId: 'execution-file-evidence-external-run',
          state: 'partial',
          checksum: 'a'.repeat(64),
          storageKey: 'file-evidence/runs/external-run.json',
          relationCount: 1,
          generationCount: 1,
          scientificOutputCount: 1,
          initialViewState: 'complete',
          managedRootsFinalState: 'partial',
          scientificOutputAnalysis: 'partial',
          fileReads: 'unavailable',
          externalPaths: 'unavailable',
          writerAttribution: 'unavailable',
          reasonCodes: ['file-reads-not-observed']
        }
      }
    })

    await expect(
      new NotebookRunRepository(root).findExisting('default-project', 'session-1')
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          runId: 'external-run',
          kernelEpochId: 'epoch-1',
          kernelDispatched: true,
          runtimeId: '/external/python',
          workingFiles: [
            expect.objectContaining({
              generationId: 'generation-1',
              checksum: 'b'.repeat(64),
              change: 'created'
            })
          ],
          fileEvidence: {
            schemaVersion: 1,
            activityId: 'external-run',
            activityKind: 'notebook-run',
            evidenceId: 'execution-file-evidence-external-run',
            state: 'partial',
            checksum: 'a'.repeat(64),
            storageKey: 'file-evidence/runs/external-run.json',
            relationCount: 1,
            generationCount: 1,
            scientificOutputCount: 1,
            initialViewState: 'complete',
            managedRootsFinalState: 'partial',
            scientificOutputAnalysis: 'partial',
            fileReads: 'unavailable',
            externalPaths: 'unavailable',
            writerAttribution: 'unavailable',
            reasonCodes: ['file-reads-not-observed']
          }
        })
      ]
    })

    const malformed = JSON.parse(
      await readFile(join(document.notebookSessionRoot, 'run.json'), 'utf8')
    ) as { runs: Array<Record<string, unknown>> }
    malformed.runs[0]!.kernelEpochId = ''
    await writeFile(
      join(document.notebookSessionRoot, 'run.json'),
      JSON.stringify(malformed),
      'utf8'
    )
    await expect(
      new NotebookRunRepository(root).findExisting('default-project', 'session-1')
    ).rejects.toThrow('Notebook document is corrupt.')
  })

  it('normalizes legacy Notebook file evidence without changing its immutable reference', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const document = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    const runJsonPath = join(document.notebookSessionRoot, 'run.json')
    const persisted = JSON.parse(await readFile(runJsonPath, 'utf8'))
    const legacyEvidence = {
      schemaVersion: 1,
      state: 'complete',
      evidenceId: 'notebook-file-evidence-legacy-run',
      checksum: 'a'.repeat(64),
      storageKey: 'notebook-file-evidence/default-project/session-1/run-legacy-run/evidence.json',
      relationCount: 1,
      generationCount: 1,
      scientificOutputCount: 1,
      initialViewState: 'complete',
      managedRootsFinalState: 'complete',
      scientificOutputAnalysis: 'complete',
      fileReads: 'unavailable',
      externalPaths: 'unavailable',
      writerAttribution: 'unavailable',
      reasonCodes: ['file-reads-not-observed']
    }
    const legacyOwner = {
      activityId: 'legacy-run',
      activityKind: 'notebook-run' as const
    }
    expect(
      parseOwnedExecutionFileEvidenceSummary(
        {
          ...legacyEvidence,
          evidenceId: 'notebook-file-evidence-another-run'
        },
        legacyOwner
      )
    ).toBeUndefined()
    expect(
      parseOwnedExecutionFileEvidenceSummary(
        {
          ...legacyEvidence,
          storageKey:
            'notebook-file-evidence/default-project/session-1/run-another-run/evidence.json'
        },
        legacyOwner
      )
    ).toBeUndefined()
    expect(
      parseOwnedExecutionFileEvidenceSummary(
        {
          ...legacyEvidence,
          runId: 'legacy-run'
        },
        legacyOwner
      )
    ).toBeUndefined()
    expect(
      parseOwnedExecutionFileEvidenceSummary(
        {
          ...legacyEvidence,
          unexpectedField: true
        },
        legacyOwner
      )
    ).toBeUndefined()
    persisted.runs = [
      {
        runId: 'legacy-run',
        cellId: 'cell-legacy-run',
        source: 'agent',
        script: '1',
        status: 'completed',
        startedAt: 1,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        fileEvidence: legacyEvidence
      },
      {
        runId: 'legacy-unavailable-run',
        cellId: 'cell-legacy-unavailable-run',
        source: 'agent',
        script: '2',
        status: 'failed',
        startedAt: 2,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        fileEvidence: {
          ...legacyEvidence,
          state: 'unavailable',
          evidenceId: undefined,
          checksum: undefined,
          storageKey: undefined,
          relationCount: undefined,
          generationCount: undefined,
          scientificOutputCount: 0,
          reasonCodes: ['run-identity-missing']
        }
      }
    ]
    await writeFile(runJsonPath, JSON.stringify(persisted, null, 2), 'utf8')

    const reloaded = await new NotebookRunRepository(root).findExisting(
      'default-project',
      'session-1'
    )

    expect(reloaded?.runs[0]?.fileEvidence).toEqual({
      ...legacyEvidence,
      activityId: 'legacy-run',
      activityKind: 'notebook-run',
      state: 'available'
    })
    expect(reloaded?.runs[1]?.fileEvidence).toMatchObject({
      activityId: 'legacy-unavailable-run',
      activityKind: 'notebook-run',
      state: 'unavailable',
      reasonCodes: ['activity-identity-missing']
    })

    await new NotebookRunRepository(root).updateKernelStatus({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      status: 'idle'
    })
    const normalizedOnDisk = JSON.parse(await readFile(runJsonPath, 'utf8'))
    expect(normalizedOnDisk.runs[0].fileEvidence).toMatchObject({
      activityId: 'legacy-run',
      activityKind: 'notebook-run',
      state: 'available',
      storageKey: 'notebook-file-evidence/default-project/session-1/run-legacy-run/evidence.json'
    })
  })

  it('isolates Frame workspaces while root keeps the legacy Session work surface', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const rootLane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const childLane = createFrameNotebookLane('default-project', 'session-1', 'child-frame-1')

    const rootDocument = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane: rootLane
    })
    const childDocument = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane: childLane
    })

    expect(rootDocument.notebookSessionRoot).toBe(
      join(root, 'notebooks', 'default-project', 'session-1')
    )
    expect(childDocument.notebookSessionRoot).toBe(
      join(root, 'notebooks', 'default-project', 'session-1', 'frames', 'child-frame-1')
    )
    expect(childDocument.dataRoot).not.toBe(rootDocument.dataRoot)
  })

  it('aggregates attributed Frame runs with legacy Unattributed Session runs', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const childLane = createFrameNotebookLane('default-project', 'session-1', 'child-frame-1')
    const run = (runId: string, agentFrameId?: string): NotebookRunRecord => ({
      runId,
      cellId: `cell-${runId}`,
      source: 'agent' as const,
      kernelKind: 'python' as const,
      script: '1',
      status: 'completed' as const,
      startedAt: runId === 'legacy' ? 1 : 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      ...(agentFrameId ? { agentFrameId, runtimeSegmentId: 'runtime-child' } : {})
    })

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    const legacyPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')
    const legacyDocument = JSON.parse(await readFile(legacyPath, 'utf8'))
    legacyDocument.runs = [{ ...run('legacy'), environment: 'historical-python' }]
    await writeFile(legacyPath, JSON.stringify(legacyDocument, null, 2), 'utf8')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane: childLane
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: childLane,
      run: {
        ...run('child-r', 'child-frame-1'),
        kernelKind: 'r',
        startedAt: 0
      }
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: childLane,
      run: run('child', 'child-frame-1')
    })

    const runs = await repository.readSessionRuns('default-project', 'session-1')
    expect(runs.map(({ runId, agentFrameId }) => ({ runId, agentFrameId }))).toEqual([
      { runId: 'child-r', agentFrameId: 'child-frame-1' },
      { runId: 'legacy', agentFrameId: undefined },
      { runId: 'child', agentFrameId: 'child-frame-1' }
    ])
    await expect(
      repository.readSessionRunWindow('default-project', 'session-1', 1)
    ).resolves.toEqual({
      runs: [expect.objectContaining({ runId: 'child' })],
      total: 3,
      agentSummaries: [expect.objectContaining({ agentFrameId: 'child-frame-1', runCount: 2 })],
      latestRunEnvironments: { python: 'historical-python' },
      historyPage: {
        hasEarlierRuns: true,
        oldestCursor: { startedAt: 2, runId: 'child' }
      }
    })
    await expect(
      repository.readSessionRunWindow('default-project', 'session-1', 1, ['legacy'])
    ).resolves.toEqual({
      runs: [
        expect.objectContaining({ runId: 'legacy' }),
        expect.objectContaining({ runId: 'child' })
      ],
      total: 3,
      agentSummaries: [expect.objectContaining({ agentFrameId: 'child-frame-1', runCount: 2 })],
      latestRunEnvironments: { python: 'historical-python' },
      historyPage: {
        hasEarlierRuns: true,
        oldestCursor: { startedAt: 2, runId: 'child' }
      }
    })
    await expect(
      repository.readSessionRunWindow('default-project', 'session-1', 1, [], 'child-frame-1')
    ).resolves.toEqual({
      runs: [expect.objectContaining({ runId: 'child' })],
      total: 3,
      agentSummaries: [expect.objectContaining({ agentFrameId: 'child-frame-1', runCount: 2 })],
      latestRunEnvironments: { python: 'historical-python' },
      historyPage: {
        hasEarlierRuns: true,
        oldestCursor: { startedAt: 2, runId: 'child' }
      },
      historySummary: {
        agentFrameId: 'child-frame-1',
        runCount: 2,
        kernelCounts: { python: 1, r: 1, repl: 0, bash: 0 },
        latestDataKernel: 'python'
      }
    })
    await expect(
      repository.readSessionRunWindow('default-project', 'session-1', 1, [], undefined, {
        startedAt: 2,
        runId: 'child'
      })
    ).resolves.toEqual({
      runs: [expect.objectContaining({ runId: 'legacy' })],
      total: 3,
      agentSummaries: [expect.objectContaining({ agentFrameId: 'child-frame-1', runCount: 2 })],
      latestRunEnvironments: { python: 'historical-python' },
      historyPage: {
        hasEarlierRuns: true,
        oldestCursor: { startedAt: 1, runId: 'legacy' }
      }
    })
  })

  it('keeps readable Notebook documents available when one Frame document is corrupt', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const projectId = 'default-project'
    const sessionId = 'session-1'
    await repository.loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane: createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    })
    const corruptLane = createFrameNotebookLane(projectId, sessionId, 'corrupt-frame')
    const corruptDocument = await repository.loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane: corruptLane
    })
    await writeFile(join(corruptDocument.notebookSessionRoot, 'run.json'), '{ not-json', 'utf8')

    await expect(
      new NotebookRunRepository(root).readSessionDocuments(projectId, sessionId)
    ).resolves.toEqual([expect.objectContaining({ projectId, sessionId })])
  })

  it('keeps readable Notebook documents available when one Frame has a corrupt shape', async () => {
    const root = await createStorageRoot()
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const repository = new NotebookRunRepository(root)
    await repository.loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane: createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    })
    const corruptDocument = await repository.loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane: createFrameNotebookLane(projectId, sessionId, 'corrupt-frame')
    })
    const filePath = join(corruptDocument.notebookSessionRoot, 'run.json')
    const malformed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    malformed.runs = [null]
    await writeFile(filePath, JSON.stringify(malformed), 'utf8')

    await expect(
      new NotebookRunRepository(root).readSessionDocuments(projectId, sessionId)
    ).resolves.toEqual([expect.objectContaining({ projectId, sessionId })])
  })

  it.each([
    ['helper modules', { helperModules: {} }],
    ['REPL marker value', { kernelKind: 'repl', replPersistentBindings: false }],
    ['REPL marker kernel', { kernelKind: 'python', replPersistentBindings: true }],
    ['helper evidence status', { helperEvidenceStatus: { state: 'unknown' } }]
  ])('rejects a run with malformed persisted %s', async (_label, malformedRun) => {
    const root = await createStorageRoot()
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    const repository = new NotebookRunRepository(root)
    const document = await repository.loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane
    })
    await repository.appendRun({ projectId, sessionId, lane, run: admittedRun() })
    const filePath = join(document.notebookSessionRoot, 'run.json')
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      runs: Array<Record<string, unknown>>
    }
    persisted.runs[0] = { ...persisted.runs[0], ...malformedRun }
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    await expect(repository.readSessionRuns(projectId, sessionId)).resolves.toEqual([])
  })

  it('does not treat an unversioned Notebook document as registered legacy data', async () => {
    const root = await createStorageRoot()
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const document = await new NotebookRunRepository(root).loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane: createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    })
    const filePath = join(document.notebookSessionRoot, 'run.json')
    const unversioned = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    delete unversioned.version
    await writeFile(filePath, JSON.stringify(unversioned), 'utf8')

    await expect(
      new NotebookRunRepository(root).readSessionDocuments(projectId, sessionId)
    ).resolves.toEqual([])
  })

  it('does not rewrite a Notebook document created by a newer app version', async () => {
    const root = await createStorageRoot()
    const projectId = 'default-project'
    const sessionId = 'session-1'
    const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-session-1')
    const document = await new NotebookRunRepository(root).loadOrCreate({
      projectId,
      sessionId,
      workspaceCwd: '/workspace',
      lane
    })
    const filePath = join(document.notebookSessionRoot, 'run.json')
    const futureDocument = {
      ...JSON.parse(await readFile(filePath, 'utf8')),
      version: 3,
      futureNotebookState: { mustSurvive: true }
    }
    const futureBytes = `${JSON.stringify(futureDocument, null, 2)}\n`
    await writeFile(filePath, futureBytes, 'utf8')

    await expect(
      new NotebookRunRepository(root).appendRun({
        projectId,
        sessionId,
        lane,
        run: {
          runId: 'new-run',
          cellId: 'cell-new-run',
          source: 'agent',
          kernelKind: 'python',
          script: '1',
          status: 'completed',
          startedAt: 1,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: []
        }
      })
    ).rejects.toThrow('Notebook document version is not supported.')
    await expect(readFile(filePath, 'utf8')).resolves.toBe(futureBytes)
  })

  it('creates run.json under the notebook session workspace with runtime and data roots', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    const document = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace',
      pythonPath: '/usr/bin/python3',
      kernelName: 'python3'
    })

    expect(document).toMatchObject({
      version: 1,
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      kernel: {
        pythonPath: '/usr/bin/python3',
        kernelName: 'python3',
        runtimeRoot: join(root, 'runtime'),
        lastKnownStatus: 'idle'
      },
      runs: []
    })
    const persisted = JSON.parse(
      await readFile(join(root, 'notebooks', 'default-project', 'session-1', 'run.json'), 'utf8')
    )
    expect(persisted).toMatchObject({
      projectId: 'default-project',
      sessionId: 'session-1'
    })
    expect(persisted.projectName).toBeUndefined()
  })

  it('appends completed runs with working file metadata but not file contents', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: "print('hello')",
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: {
          stdout: 'hello\n',
          stderr: '',
          traceback: '',
          plain: ['hello']
        },
        outputs: [],
        artifacts: [],
        workingFiles: [
          {
            path: join(root, 'notebooks', 'default-project', 'session-1', 'data', 'processed.csv'),
            relativePath: 'data/processed.csv',
            kind: 'other',
            size: 123,
            mtimeMs: 200,
            createdByRunId: 'run-1'
          }
        ]
      }
    })

    const rawJson = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )
    const document = JSON.parse(rawJson) as Awaited<
      ReturnType<NotebookRunRepository['loadOrCreate']>
    >

    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      text: {
        stdout: 'hello\n'
      },
      workingFiles: [
        {
          relativePath: 'data/processed.csv',
          kind: 'other',
          size: 123
        }
      ]
    })
    expect(rawJson).toContain('"relativePath": "data/processed.csv"')
    expect(rawJson).not.toContain('hello,file,contents')
  })

  it('updates an existing run without duplicating its history entry', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: "print('hello')",
        status: 'running',
        startedAt: 100,
        text: {
          stdout: '',
          stderr: '',
          traceback: '',
          plain: []
        },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })
    const document = await repository.updateRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: "print('hello')",
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: {
          stdout: 'hello\n',
          stderr: '',
          traceback: '',
          plain: ['hello']
        },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      endedAt: 200,
      text: {
        stdout: 'hello\n'
      }
    })
  })

  it('creates writable workspace dirs and the separate immutable-input sandbox root', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const sessionRoot = join(root, 'notebooks', 'default-project', 'session-1')

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })

    expect((await stat(join(sessionRoot, 'handoff'))).isDirectory()).toBe(true)
    expect((await stat(join(sessionRoot, 'outputs'))).isDirectory()).toBe(true)
    expect(
      (await stat(getNotebookInputRoot(root, 'default-project', 'session-1'))).isDirectory()
    ).toBe(true)

    await rm(getNotebookInputRoot(root, 'default-project', 'session-1'), {
      recursive: true,
      force: true
    })
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    expect(
      (await stat(getNotebookInputRoot(root, 'default-project', 'session-1'))).isDirectory()
    ).toBe(true)
  })

  it('persists an updated kernel lifecycle status without touching run history', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/workspace'
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: '1',
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    const restarting = await repository.updateKernelStatus({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      status: 'restarting'
    })
    expect(restarting.kernel.lastKnownStatus).toBe('restarting')
    expect(restarting.runs).toHaveLength(1) // run history untouched

    const pythonTerminated = await repository.markKernelTerminated({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'python', environment: 'analysis' }
    })
    expect(pythonTerminated.kernel).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: 'analysis' }]
    })

    await repository.markKernelTerminated({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'python', environment: 'analysis' }
    })
    await repository.markKernelTerminated({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'python', environment: 'default-python' }
    })
    const bothTerminated = await repository.markKernelTerminated({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'r', environment: 'default-r' }
    })
    expect(bothTerminated.kernel.terminatedKernelInstances).toEqual([
      { kind: 'python', environment: 'analysis' },
      { kind: 'python', environment: 'default-python' },
      { kind: 'r', environment: 'default-r' }
    ])

    const rStillTerminated = await repository.clearKernelTermination({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'python', environment: 'analysis' }
    })
    expect(rStillTerminated.kernel).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [
        { kind: 'python', environment: 'default-python' },
        { kind: 'r', environment: 'default-r' }
      ]
    })

    await repository.clearKernelTermination({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'python', environment: 'default-python' }
    })

    const recovered = await repository.clearKernelTermination({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'r', environment: 'default-r' }
    })
    expect(recovered.kernel.lastKnownStatus).toBe('idle')
    expect(recovered.kernel.terminatedKernelInstances).toBeUndefined()
    expect(recovered.runs).toHaveLength(1)

    await repository.markKernelTerminated({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      kernelInstance: { kind: 'repl' }
    })
    const restartingClean = await repository.clearKernelTerminations({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      status: 'restarting'
    })
    expect(restartingClean.kernel.lastKnownStatus).toBe('restarting')
    expect(restartingClean.kernel.terminatedKernelInstances).toBeUndefined()
  })

  it('defaults a legacy run record missing kernelKind to python when loaded from disk', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })

    // Simulate a pre-kernelKind run.json written before this field existed.
    const legacyDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    delete legacyDocument.projectId
    legacyDocument.projectName = 'default-project'
    legacyDocument.runs = [
      {
        runId: 'legacy-run-1',
        cellId: 'cell-1',
        source: 'agent',
        script: "print('hi')",
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: { stdout: 'hi\n', stderr: '', traceback: '', plain: ['hi'] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    ]
    await writeFile(runJsonPath, JSON.stringify(legacyDocument, null, 2), 'utf8')

    const reloaded = await repository.findExisting('default-project', 'session-1')

    expect(reloaded?.runs[0]).toMatchObject({ runId: 'legacy-run-1', kernelKind: 'python' })
  })

  it('reads legacy termination state without rewriting the historical document', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const projectId = 'default-project'
    const sessionId = 'legacy-termination'
    const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-legacy-termination')
    const document = await repository.loadOrCreate({
      projectId,
      sessionId,
      lane,
      workspaceCwd: '/workspace'
    })
    const runJsonPath = join(document.notebookSessionRoot, 'run.json')
    const legacyDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    legacyDocument.kernel = {
      ...legacyDocument.kernel,
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: 'analysis' }]
    }
    legacyDocument.runs = [
      {
        runId: 'legacy-run-termination',
        cellId: 'cell-legacy-termination',
        source: 'agent',
        script: "print('history')",
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: { stdout: 'history\n', stderr: '', traceback: '', plain: ['history'] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    ]
    await writeFile(runJsonPath, JSON.stringify(legacyDocument, null, 2), 'utf8')
    const before = await readFile(runJsonPath, 'utf8')

    const reloaded = await new NotebookRunRepository(root).findExisting(projectId, sessionId)

    expect(reloaded?.kernel).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: 'analysis' }]
    })
    expect(reloaded?.runs[0]).toMatchObject({
      runId: 'legacy-run-termination',
      kernelKind: 'python'
    })
    await expect(readFile(runJsonPath, 'utf8')).resolves.toBe(before)
  })

  it('loads canonical projectId values before legacy aliases', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const runJsonPath = join(root, 'notebooks', 'canonical-project', 'session-1', 'run.json')

    await repository.loadOrCreate({
      projectId: 'canonical-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('canonical-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })

    const persisted = JSON.parse(await readFile(runJsonPath, 'utf8'))
    persisted.projectId = 'canonical-project'
    persisted.projectName = 'renamed-project'
    persisted.runs = [
      {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: '1',
        status: 'completed',
        startedAt: 100,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [
          {
            id: 'artifact-1',
            projectId: 'canonical-project',
            projectName: 'renamed-project',
            sessionId: 'session-1',
            name: 'result.txt',
            path: '$DATA/notebooks/canonical-project/session-1/data/processed/result.txt',
            size: 1,
            mtimeMs: 1
          }
        ],
        workingFiles: []
      }
    ]
    await writeFile(runJsonPath, JSON.stringify(persisted, null, 2), 'utf8')

    const reloaded = await repository.findExisting('canonical-project', 'session-1')

    expect(reloaded).toMatchObject({
      projectId: 'canonical-project',
      notebookSessionRoot: join(root, 'notebooks', 'canonical-project', 'session-1')
    })
    expect(reloaded?.runs[0].artifacts?.[0]).toMatchObject({ projectId: 'canonical-project' })
  })

  it('keeps a matching legacy projectName document readable through loadOrCreate', async () => {
    const root = await createStorageRoot()
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/workspace'
    })
    const legacyDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    delete legacyDocument.projectId
    legacyDocument.projectName = 'default-project'
    legacyDocument.artifactSessionId = 'artifact-session-1'
    await writeFile(runJsonPath, JSON.stringify(legacyDocument, null, 2), 'utf8')

    const document = await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/relocated-workspace'
    })

    expect(document).toMatchObject({
      projectId: 'default-project',
      sessionId: 'session-1',
      artifactSessionId: 'artifact-session-1',
      workspaceCwd: '/relocated-workspace'
    })
  })

  it('rejects a project ownership mismatch before caching or changing the root document', async () => {
    const root = await createStorageRoot()
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')
    await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    const misplacedDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    misplacedDocument.projectId = 'other-project'
    const original = JSON.stringify(misplacedDocument, null, 2)
    await writeFile(runJsonPath, original, 'utf8')
    const repository = new NotebookRunRepository(root)

    await expect(repository.findExisting('default-project', 'session-1')).rejects.toThrow(
      'Notebook run document ownership mismatch: requested projectId "default-project", but run.json declares "other-project".'
    )

    expect(await readFile(runJsonPath, 'utf8')).toBe(original)
    const cache = repository as unknown as { documentCache: Map<string, unknown> }
    expect(cache.documentCache.size).toBe(0)
  })

  it('does not treat a session ownership mismatch as ENOENT in loadOrCreate', async () => {
    const root = await createStorageRoot()
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/workspace'
    })
    const misplacedDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    misplacedDocument.sessionId = 'other-session'
    misplacedDocument.runs = [{ sentinel: 'must-not-be-replaced' }]
    const original = JSON.stringify(misplacedDocument, null, 2)
    await writeFile(runJsonPath, original, 'utf8')
    const repository = new NotebookRunRepository(root)

    await expect(
      repository.loadOrCreate({
        projectId: 'default-project',
        sessionId: 'session-1',
        lane,
        workspaceCwd: '/workspace'
      })
    ).rejects.toThrow(
      'Notebook run document ownership mismatch: requested sessionId "session-1", but run.json declares "other-session".'
    )

    expect(await readFile(runJsonPath, 'utf8')).toBe(original)
  })

  it('rejects a canonical projectId mismatch even when legacy projectName matches', async () => {
    const root = await createStorageRoot()
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')
    await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    const misplacedDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    misplacedDocument.projectId = 'canonical-other-project'
    misplacedDocument.projectName = 'default-project'
    await writeFile(runJsonPath, JSON.stringify(misplacedDocument, null, 2), 'utf8')

    await expect(
      new NotebookRunRepository(root).findExisting('default-project', 'session-1')
    ).rejects.toThrow(/requested projectId "default-project".*"canonical-other-project"/)
  })

  it('rejects a mismatched Frame document before continuing a mutation', async () => {
    const root = await createStorageRoot()
    const lane = createFrameNotebookLane('default-project', 'session-1', 'child-frame-1')
    const runJsonPath = join(
      root,
      'notebooks',
      'default-project',
      'session-1',
      'frames',
      'child-frame-1',
      'run.json'
    )
    await new NotebookRunRepository(root).loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      workspaceCwd: '/workspace'
    })
    const misplacedDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    misplacedDocument.sessionId = 'other-session'
    const original = JSON.stringify(misplacedDocument, null, 2)
    await writeFile(runJsonPath, original, 'utf8')

    await expect(
      new NotebookRunRepository(root).appendRun({
        projectId: 'default-project',
        sessionId: 'session-1',
        lane,
        run: {
          runId: 'must-not-be-appended',
          cellId: 'cell-1',
          source: 'agent',
          kernelKind: 'python',
          script: '1',
          status: 'completed',
          startedAt: 1,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: []
        }
      })
    ).rejects.toThrow(/requested sessionId "session-1".*"other-session"/)

    expect(await readFile(runJsonPath, 'utf8')).toBe(original)
  })

  it('keeps an explicit kernelKind when loading a run record from disk', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const runJsonPath = join(root, 'notebooks', 'default-project', 'session-1', 'run.json')

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })

    const document = JSON.parse(await readFile(runJsonPath, 'utf8'))
    document.runs = [
      {
        runId: 'repl-run-1',
        cellId: 'cell-1',
        source: 'user',
        inputKind: 'terminal',
        kernelKind: 'repl',
        script: 'ls',
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    ]
    await writeFile(runJsonPath, JSON.stringify(document, null, 2), 'utf8')

    const reloaded = await repository.findExisting('default-project', 'session-1')

    expect(reloaded?.runs[0]).toMatchObject({ runId: 'repl-run-1', kernelKind: 'repl' })
    expect(reloaded?.runs[0]).not.toHaveProperty('fileEvidence')
  })

  it('rejects unsafe project and session path segments', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    expect(() => getNotebookSessionRoot(root, '../project', 'session-1')).toThrow(
      /Invalid notebook path segment/
    )
    await expect(
      repository.loadOrCreate({
        projectId: 'default-project',
        sessionId: 'session/1',
        lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
        workspaceCwd: '/workspace'
      })
    ).rejects.toThrow(/Invalid notebook path segment/)
  })

  it('reconciles a stale running run to interrupted (crash recovery)', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: '/workspace'
    })
    // A run left 'running' when the previous process died (no endedAt).
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: 'long()',
        status: 'running',
        startedAt: 100,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const reconciled = await repository.reconcileInterruptedRuns(
      'default-project',
      'session-1',
      lane
    )
    expect(reconciled.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'interrupted',
      environmentCapture: {
        state: 'unavailable',
        reason: 'environment-capture-failed'
      },
      interruptionReason: 'app-terminated'
    })
    expect(reconciled.runs[0].endedAt).toBeGreaterThanOrEqual(100)
    // A subsequent reconcile is a no-op (already interrupted).
    const again = await repository.reconcileInterruptedRuns('default-project', 'session-1', lane)
    expect(again.runs[0].status).toBe('interrupted')
  })

  it('rewrites the complete lane document and materializes every run before applying a window', async () => {
    const root = await createStorageRoot()
    const writer = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    await writer.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    const runCount = 8
    for (let index = 0; index < runCount; index += 1) {
      await writer.appendRun({
        projectId: 'default-project',
        sessionId: 'session-1',
        lane,
        run: {
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          kernelKind: 'python',
          script: `print(${index})`,
          status: 'completed',
          startedAt: index + 1,
          text: { stdout: `out-${index}`, stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: []
        }
      })
    }

    const runJsonPath = join(
      getNotebookSessionRoot(root, 'default-project', 'session-1'),
      'run.json'
    )
    const persisted = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
      runs: Array<{ runId: string }>
    }
    expect(persisted.runs.map((run) => run.runId)).toEqual(
      Array.from({ length: runCount }, (_, index) => `run-${index}`)
    )

    const reader = new NotebookRunRepository(root)
    const window = await reader.readSessionRunWindow('default-project', 'session-1', 2)
    expect(window.runs.map((run) => run.runId)).toEqual(['run-6', 'run-7'])
    expect(window.total).toBe(runCount)
    const index = await reader.readSessionRunIndex('default-project', 'session-1')
    expect(index).toHaveLength(runCount)
    expect(index[0]).toMatchObject({ runId: 'run-0', scriptCharacters: 8, hasOutput: true })
    expect(index[0]).not.toHaveProperty('script')
    expect(index[0]).not.toHaveProperty('text')
    expect(await reader.readSessionRun('default-project', 'session-1', 'run-6')).toMatchObject({
      script: 'print(6)'
    })
    expect(await reader.readSessionRun('default-project', 'session-1', 'missing')).toBeUndefined()

    const cache = reader as unknown as {
      documentCache: Map<string, { document: { runs: Array<{ runId: string }> } }>
    }
    expect([...cache.documentCache.values()][0]?.document.runs).toHaveLength(runCount)

    // Simulate a large imported archive and verify replacement invalidates the compact index.
    const largeDocument = JSON.parse(await readFile(runJsonPath, 'utf8'))
    largeDocument.runs = Array.from({ length: 2000 }, (_, i) => ({
      ...largeDocument.runs[0],
      runId: `large-${i}`,
      startedAt: i + 1,
      text: { stdout: 'x'.repeat(4096), stderr: '', traceback: '', plain: [] }
    }))
    await writeFile(runJsonPath, JSON.stringify(largeDocument))
    const largeIndex = await reader.readSessionRunIndex('default-project', 'session-1')
    expect(largeIndex).toHaveLength(2000)
    expect(Buffer.byteLength(JSON.stringify(largeIndex))).toBeLessThan(1024 * 1024)
    expect(await reader.readSessionRun('default-project', 'session-1', 'large-1999')).toMatchObject(
      { text: { stdout: 'x'.repeat(4096) } }
    )
    expect(await reader.readSessionRun('default-project', 'session-1', 'run-6')).toBeUndefined()
  })

  it('leaves Session workspace output files in place when another run is appended', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const lane = createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1')
    const document = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      lane
    })
    const leftoverPath = join(document.notebookSessionRoot, 'outputs', 'keep.bin')
    await writeFile(leftoverPath, Buffer.alloc(4096, 7))

    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane,
      run: {
        runId: 'run-keep-outputs',
        cellId: 'cell-keep-outputs',
        source: 'agent',
        kernelKind: 'python',
        script: '1',
        status: 'completed',
        startedAt: 1,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    await expect(stat(leftoverPath)).resolves.toMatchObject({ size: 4096 })
  })
})

describe('large immutable Notebook records', () => {
  it('keeps prior output files unchanged across append, restart, update and startup cleanup', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const scope = { projectId: 'default-project', sessionId: 'session-1' }
    const lane = createRootNotebookLane(scope.projectId, scope.sessionId, 'root-frame-session-1')
    const document = await repository.loadOrCreate({ ...scope, lane, workspaceCwd: root })
    const large = admittedRun({
      status: 'completed',
      text: { stdout: 'x'.repeat(1024 * 1024), stderr: '', traceback: '', plain: [] },
      cwdAfter: root
    })
    await repository.appendRun({ ...scope, lane, run: large })
    const manifestPath = join(document.notebookSessionRoot, 'run.json')
    const records = join(document.notebookSessionRoot, '.run-records')
    const first = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(first.version).toBe(2)
    expect((await stat(manifestPath)).size).toBeLessThan(4096)
    const recordPath = join(records, `${first.runs[0].sha256}.json`)
    const before = await stat(recordPath)
    const restarted = new NotebookRunRepository(root)
    await restarted.appendRun({
      ...scope,
      lane,
      run: admittedRun({ runId: 'run-2', submissionIdentity: 'submission-2' })
    })
    expect((await stat(recordPath)).mtimeMs).toBe(before.mtimeMs)
    expect(
      (await restarted.findExisting(scope.projectId, scope.sessionId))?.runs[0].text.stdout
    ).toBe(large.text.stdout)
    await restarted.updateRun({
      ...scope,
      lane,
      run: { ...large, text: { ...large.text, stdout: 'y'.repeat(1024 * 1024) } }
    })
    expect(await readdir(records)).toHaveLength(2)
    await writeFile(`${recordPath}.1700000000000-1.tmp`, 'interrupted write')
    await new NotebookRunRepository(root).recoverAllRunLifecycles()
    expect(await readdir(records)).toHaveLength(1)
    const recovered = await new NotebookRunRepository(root).findExisting(
      scope.projectId,
      scope.sessionId
    )
    expect(recovered?.runs[0].text.stdout).toBe('y'.repeat(1024 * 1024))
    expect(recovered?.runs[1].status).toBe('interrupted')
    expect(recovered?.runs[0].cwdAfter).toBe(root)
    const reads = vi.spyOn(durableFiles, 'readDurableJsonFile')
    try {
      await new NotebookRunRepository(root).recoverAllRunLifecycles()
      expect(reads.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(1)
    } finally {
      reads.mockRestore()
    }
  })

  it.each(['inline', 'external'])(
    'reads long scripts without reopening %s history',
    async (layout) => {
      const root = await createStorageRoot()
      const projectId = 'p'
      const sessionId = 's'
      const lane = createRootNotebookLane(projectId, sessionId, 'root-frame-s')
      const scope = { projectId, sessionId, lane }
      const repo = new NotebookRunRepository(root)
      const doc = await repo.loadOrCreate({ ...scope, workspaceCwd: root })
      const output = admittedRun({
        runId: 'historical-output',
        status: 'completed',
        text: { ...admittedRun().text, stdout: 'x'.repeat(33 * 1024 * 1024) }
      })
      if (layout === 'external') await repo.appendRun({ ...scope, run: output })
      const scripts = ['a'.repeat(320 * 1024), 'b'.repeat(320 * 1024)]
      for (const [i, script] of scripts.entries()) {
        await repo.appendRun({
          ...scope,
          run: admittedRun({
            runId: 'source-' + i,
            script,
            status: 'completed',
            text: { ...output.text, stdout: i === 0 ? '' : 'x'.repeat(200 * 1024) }
          })
        })
      }
      const manifest = join(doc.notebookSessionRoot, 'run.json')
      const stored = JSON.parse(await readFile(manifest, 'utf8'))
      if (layout === 'inline') stored.runs.unshift(output)
      // The reference-heavy fixture still has a manifest just above the 64 KiB hot slot limit.
      stored.runs.push(
        admittedRun({
          runId: 'inline',
          text: { ...output.text, stdout: 'x'.repeat(65536) },
          status: 'completed'
        })
      )
      await writeFile(manifest, JSON.stringify(stored))
      const reader = new NotebookRunRepository(root)
      await reader.findExisting(projectId, sessionId, lane)
      const reads = vi.spyOn(durableFiles, 'readDurableJsonFile')
      const bodies = vi.spyOn(durableFiles, 'readFileWithinLimit')
      try {
        const rows = await reader.readLaneAnalysisRuns(projectId, sessionId, lane)
        expect(
          rows.filter((run) => run.runId.startsWith('source-')).map((run) => run.script)
        ).toEqual(scripts)
        const cheaper = stored.runs.find((row: { runId: string }) => row.runId === 'source-0')
        expect(bodies.mock.calls.map(([path]) => path)).toEqual([
          join(doc.notebookSessionRoot, '.run-records', cheaper.sha256 + '.json')
        ])
        const index = await reader.readSessionRunIndex(projectId, sessionId)
        expect(index.find((r) => r.runId === 'source-1')?.scriptCharacters).toBe(scripts[1].length)
        expect(reads.mock.calls.some(([path]) => path === manifest)).toBe(false)
      } finally {
        bodies.mockRestore()
        reads.mockRestore()
      }
    }
  )

  it.each([2, 6])('batches large history with %i inline rows', async (inlineCount) => {
    const root = await createStorageRoot()
    const repo = new NotebookRunRepository(root)
    const request = {
      projectId: 'p',
      sessionId: 's',
      lane: createFrameNotebookLane('p', 's', 'f')
    }
    const doc = await repo.loadOrCreate({ ...request, workspaceCwd: root })
    await repo.appendRun({
      ...request,
      run: admittedRun({
        status: 'completed',
        script: inlineCount === 2 ? 's'.repeat(300000) : 'print(1)',
        text: { ...admittedRun().text, stdout: 'x'.repeat(33 * 1024 * 1024) }
      })
    })
    const manifest = join(doc.notebookSessionRoot, 'run.json')
    // Two inline rows fit the lifecycle view; six exceed its budget.
    const seed = JSON.parse(await readFile(manifest, 'utf8'))
    for (let i = 0; i < inlineCount; i++) {
      seed.runs.push(
        admittedRun({
          runId: 'inline-' + i,
          submissionIdentity: 'inline-' + i,
          startedAt: i + 2,
          status: 'completed',
          text: { ...admittedRun().text, stdout: 'y'.repeat(60000) }
        })
      )
    }
    await writeFile(manifest, JSON.stringify(seed))
    const reader = new NotebookRunRepository(root)
    await reader.findExisting('p', 's', request.lane)
    if (inlineCount === 2) await reader.setRuntimeBindings('p', 's', {}, request.lane)
    const before = await readFile(manifest, 'utf8')
    const beforeIndex = await reader.readSessionRunIndex('p', 's')
    const reads = vi.spyOn(durableFiles, 'readFileWithinLimit')
    try {
      const page = await reader.readCachedHistoryWindow('p', 's', {
        limit: 2,
        runIds: [],
        lane: request.lane
      })
      expect(page?.window.runs.map((r) => [r.runId, r.text.stdout])).toEqual(
        seed.runs.slice(-2).map((r: NotebookRunRecord) => [r.runId, r.text.stdout])
      )
      const run = admittedRun({ runId: 'new', submissionIdentity: 'new' })
      expect((await reader.appendOrGetRun({ ...request, run })).admitted).toBe(true)
      expect(await readFile(manifest, 'utf8')).toBe(before)
      await reader.checkpointPendingRuns()
      expect(
        (await reader.readSessionRunIndex('p', 's')).filter((row) => row.runId !== run.runId)
      ).toEqual(beforeIndex)
      expect(
        reads.mock.calls.some(
          ([path]) => dirname(path) === join(doc.notebookSessionRoot, '.run-records')
        )
      ).toBe(false)
    } finally {
      reads.mockRestore()
    }
    const saved = JSON.parse(await readFile(manifest, 'utf8'))
    expect(saved.runs[0]).toEqual(seed.runs[0])
    expect(saved.runs.slice(1, -1).map((r: NotebookRunRecord) => r.text)).toEqual(
      seed.runs.slice(1).map((r: NotebookRunRecord) => r.text)
    )
    const ids = saved.runs.map((row: NotebookRunRecord) => row.runId)
    expect(ids).toEqual([...seed.runs.map((row: NotebookRunRecord) => row.runId), 'new'])
  })

  it.each(['missing', 'corrupt', 'path'] as const)(
    'rejects a %s record without recreating the document',
    async (failure) => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const scope = { projectId: 'default-project', sessionId: 'session-1' }
      const lane = createRootNotebookLane(scope.projectId, scope.sessionId, 'root-frame-session-1')
      const document = await repository.loadOrCreate({ ...scope, lane, workspaceCwd: root })
      await repository.appendRun({
        ...scope,
        lane,
        run: admittedRun({
          text: { stdout: 'x'.repeat(100000), stderr: '', traceback: '', plain: [] }
        })
      })
      const manifestPath = join(document.notebookSessionRoot, 'run.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const recordPath = join(
        document.notebookSessionRoot,
        '.run-records',
        `${manifest.runs[0].sha256}.json`
      )
      const reopened = new NotebookRunRepository(root)
      const reader = new NotebookRunRepository(root)
      await reader.findExisting(scope.projectId, scope.sessionId, lane)
      const request = { ...scope, lane, workspaceCwd: root }
      const expectedKernel = (await reopened.loadOrCreate(request)).kernel
      const reads = vi.spyOn(durableFiles, 'readFileWithinLimit')
      try {
        expect(await reader.loadSessionKernel(request)).toEqual(expectedKernel)
        expect(reads).not.toHaveBeenCalled()
      } finally {
        reads.mockRestore()
      }
      await reopened.withinHistoryRead(scope.projectId, scope.sessionId, async () => {
        await reopened.loadOrCreate({ ...scope, lane, workspaceCwd: root })
        if (failure === 'missing') await rm(recordPath)
        if (failure === 'corrupt')
          await writeFile(recordPath, (await readFile(recordPath, 'utf8')).replace('xxx', 'yyy'))
        if (failure === 'path') {
          manifest.runs[0].sha256 = '../../outside'
          await writeFile(manifestPath, JSON.stringify(manifest))
        }
        await expect(reader.loadSessionKernel(request)).rejects.toThrow('corrupt')
        const bytes = await readFile(manifestPath, 'utf8')
        await expect(reopened.findExisting(scope.projectId, scope.sessionId)).rejects.toThrow(
          'corrupt'
        )
        await expect(reopened.loadOrCreate({ ...scope, lane, workspaceCwd: root })).rejects.toThrow(
          'corrupt'
        )
        expect(await readFile(manifestPath, 'utf8')).toBe(bytes)
      })
    }
  )
})

it('invalidates a foreground-only summary when another writer adds a background Run in a child Frame', async () => {
  const root = await createStorageRoot()
  const reader = new NotebookRunRepository(root)
  const writer = new NotebookRunRepository(root)
  const scope = { projectId: 'project', sessionId: 'session' }
  const rootLane = createRootNotebookLane('project', 'session', 'root-frame-session')
  const child = createFrameNotebookLane('project', 'session', 'child')
  for (const lane of [rootLane, child]) {
    await writer.loadOrCreate({ ...scope, lane, workspaceCwd: root })
  }
  await reader.readSessionRunIndex('project', 'session')
  expect(await reader.hasCachedForegroundOnlyHistory('project', 'session', rootLane)).toBe(true)
  const writing = writer.appendRun({
    ...scope,
    lane: child,
    run: admittedRun({ agentFrameId: 'child', executionMode: 'background' })
  })
  const foreground = reader.hasCachedForegroundOnlyHistory('project', 'session', rootLane)
  await writing
  expect(await foreground).toBe(false)
  expect(await reader.readSessionRunIndex('project', 'session')).toMatchObject([
    { runId: 'run-1', agentFrameId: 'child' }
  ])
})

it('counts external record bytes against the document cache budget and upgrades legacy large output lazily', async () => {
  const root = await createStorageRoot()
  const repository = new NotebookRunRepository(root)
  const scope = { projectId: 'default-project', sessionId: 'session-1' }
  const lane = createRootNotebookLane(scope.projectId, scope.sessionId, 'root-frame-session-1')
  const document = await repository.loadOrCreate({ ...scope, lane, workspaceCwd: root })
  const path = join(document.notebookSessionRoot, 'run.json')
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  legacy.runs = [
    admittedRun({
      status: 'completed',
      text: { stdout: 'x'.repeat(33 * 1024 * 1024), stderr: '', traceback: '', plain: [] }
    })
  ]
  await writeFile(path, JSON.stringify(legacy))
  const reopened = new NotebookRunRepository(root)
  expect(
    (await reopened.findExisting(scope.projectId, scope.sessionId))?.runs[0].text.stdout.length
  ).toBe(33 * 1024 * 1024)
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1)
  await reopened.updateKernelStatus({ ...scope, lane, status: 'idle' })
  expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2)
  const cache = reopened as unknown as {
    documentCacheBytes: number
    documentCache: Map<string, unknown>
  }
  expect(cache.documentCacheBytes).toBe(0)
  expect(cache.documentCache.size).toBe(0)
  const reader = new NotebookRunRepository(root)
  const bodyReads = vi.spyOn(durableFiles, 'readFileWithinLimit')
  try {
    const [full, header, initialization] = await Promise.all([
      reader.findExisting(scope.projectId, scope.sessionId),
      reader.findReferenceHeader(scope.projectId, scope.sessionId),
      reader.loadSessionInitialization({ ...scope, lane, workspaceCwd: root })
    ])
    expect(full?.runs[0].text.stdout.length).toBe(33 * 1024 * 1024)
    expect(header?.workspaceCwd).toBe(root)
    expect(initialization.runs).toHaveLength(1)
    const review = await reader.readLaneAnalysisRuns(scope.projectId, scope.sessionId, lane)
    expect(review.map((run) => run.script)).toEqual(full?.runs.map((run) => run.script))
    expect(bodyReads).toHaveBeenCalledTimes(1)
  } finally {
    bodyReads.mockRestore()
  }
  // Metadata remains usable if only an oversized record disappears. Opening the body still fails.
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  await rm(join(document.notebookSessionRoot, '.run-records', manifest.runs[0].sha256 + '.json'))
  await expect(reader.readLaneAnalysisRuns(scope.projectId, scope.sessionId, lane)).rejects.toThrow(
    'corrupt'
  )
  expect(await reader.readSessionRunIndex(scope.projectId, scope.sessionId)).toMatchObject([
    { runId: 'run-1' }
  ])
  expect(await reader.findReferenceHeader(scope.projectId, scope.sessionId)).toMatchObject({
    workspaceCwd: root
  })
  expect(await reader.hasCachedForegroundOnlyHistory(scope.projectId, scope.sessionId, lane)).toBe(
    true
  )
  expect(
    (await reader.loadSessionInitialization({ ...scope, lane, workspaceCwd: root })).runs
  ).toMatchObject([{ runId: 'run-1', status: 'completed' }])
  const target = { limit: 0, runIds: ['run-1'], lane }
  expect(
    await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, target)
  ).toBeUndefined()
  // Selection preserves the last matching frame, even if an unrelated body is gone.
  const child = createFrameNotebookLane(scope.projectId, scope.sessionId, 'child')
  await repository.loadOrCreate({ ...scope, lane: child, workspaceCwd: root })
  await repository.appendRun({ ...scope, lane: child, run: admittedRun({ agentFrameId: 'child' }) })
  expect(
    await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, target)
  ).toBeUndefined()
  await reader.findExisting(scope.projectId, scope.sessionId, child)
  const selected = await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, target)
  expect(selected?.window).toMatchObject({
    total: 2,
    runs: [{ runId: 'run-1', agentFrameId: 'child' }]
  })
  await repository.updateKernelStatus({ ...scope, lane: child, status: 'idle' })
  expect(
    await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, target)
  ).toBeUndefined()
  // A replaced manifest must invalidate initialization metadata as well as full-document reads.
  await writeFile(path, JSON.stringify({ ...manifest, updatedAt: manifest.updatedAt + 1 }))
  await expect(
    reader.loadSessionInitialization({ ...scope, lane, workspaceCwd: root })
  ).rejects.toThrow('corrupt')
  await expect(reader.loadOrCreate({ ...scope, lane, workspaceCwd: root })).rejects.toThrow(
    'corrupt'
  )
})

it('budgets background tasks across Frames without rereading verified output on each poll', async () => {
  const root = await createStorageRoot()
  const scope = { projectId: 'project', sessionId: 'session' }
  const lane = createRootNotebookLane('project', 'session', 'root-frame-session')
  const child = createFrameNotebookLane('project', 'session', 'child')
  const writer = new NotebookRunRepository(root)
  for (const current of [lane, child])
    await writer.loadOrCreate({ ...scope, lane: current, workspaceCwd: root })
  const run = admittedRun({
    runId: 'foreground',
    status: 'completed',
    script: '#'.repeat(145 * 1024),
    text: { ...admittedRun().text, stdout: '中\n"'.repeat(7 * 1024 * 1024) }
  })
  await writer.appendRun({ ...scope, lane, run })
  for (const startedAt of [0, 2]) {
    await writer.appendRun({
      ...scope,
      lane: child,
      run: admittedRun({
        runId: 'task-' + startedAt,
        agentFrameId: 'child',
        executionMode: 'background',
        startedAt,
        status: 'completed'
      })
    })
  }
  const reader = new NotebookRunRepository(root)
  const full = await reader.readSessionRuns(scope.projectId, scope.sessionId)
  const costs = new Map(full.map((row) => [row.runId, Buffer.byteLength(JSON.stringify(row))]))
  const reads = vi.spyOn(durableFiles, 'readFileWithinLimit')
  try {
    // With one byte less than the complete window, just the older background task falls out.
    for (const adjustment of [-1, 0]) {
      let budget = [...costs.values()].reduce((sum, bytes) => sum + bytes, adjustment)
      const result = await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, {
        lane,
        backgroundTaskMetadata: true,
        runIds: [],
        limit: 100,
        retain(row, _index, _count, omitted = 0) {
          const bytes = Buffer.byteLength(JSON.stringify(row)) + omitted
          expect(bytes).toBe(costs.get(row.runId))
          budget -= bytes
          return budget >= 0
        }
      })
      expect(
        result?.window.runs
          .filter((row) => row.executionMode === 'background')
          .map((row) => row.runId)
      ).toEqual(adjustment ? ['task-2'] : ['task-0', 'task-2'])
      expect(reads).toHaveBeenCalledTimes(adjustment ? 1 : 0)
      reads.mockClear()
    }
  } finally {
    reads.mockRestore()
  }
})

it('retains verified external records in place across concurrent admission and terminal CAS', async () => {
  const root = await createStorageRoot()
  const scope = { projectId: 'default-project', sessionId: 'session-1' }
  const lane = createRootNotebookLane(scope.projectId, scope.sessionId, 'adopted-root')
  const request = { ...scope, lane }
  const writer = new NotebookRunRepository(root)
  const document = await writer.loadOrCreate({ ...request, workspaceCwd: root })
  const path = join(document.notebookSessionRoot, 'run.json')
  const { manifest, checksum } = completedEnvironmentManifest()
  const old = admittedRun({
    environmentManifest: manifest,
    environmentManifestChecksum: checksum,
    runId: 'old',
    submissionIdentity: 'old-submission',
    status: 'completed',
    script: 'x'.repeat(300 * 1024),
    text: { stdout: 'x'.repeat(32 * 1024 * 1024), stderr: '', traceback: '', plain: [] }
  })
  const tiny = (id: string): NotebookRunRecord =>
    admittedRun({ runId: id, submissionIdentity: id, status: 'completed' })
  const queued = admittedRun({ runId: 'right', submissionIdentity: 'right' })
  for (const run of [tiny('left'), old, queued]) await writer.appendRun({ ...request, run })
  const reference = JSON.parse(await readFile(path, 'utf8')).runs[1]
  const body = join(document.notebookSessionRoot, '.run-records', reference.sha256 + '.json')

  const reader = new NotebookRunRepository(root)
  const reads = vi.spyOn(durableFiles, 'readFileWithinLimit')
  try {
    await reader.withinHistoryRead(scope.projectId, scope.sessionId, async () => {
      await reader.recoverAllRunLifecycles()
      await reader.findExisting(scope.projectId, scope.sessionId, lane)
    })
    expect(reads.mock.calls.filter(([path]) => path === body)).toHaveLength(1)
    reads.mockClear()
    const run = admittedRun({ cwdBefore: '/workspace', environment: undefined })
    const admissions = await Promise.all(
      [1, 2].map(() => reader.appendOrGetRun({ ...request, run }))
    )
    expect(admissions.map((result) => result.admitted)).toEqual([true, false])
    await reader.transitionRun({
      ...request,
      expectedStatus: 'queued',
      run: { ...run, status: 'running' }
    })
    const initializing = { ...request, workspaceCwd: root }
    const initialized = await reader.loadSessionInitialization(initializing)
    expect(initialized.runs.map(({ runId, status }) => [runId, status])).toEqual([
      ['left', 'completed'],
      [old.runId, 'completed'],
      [queued.runId, 'interrupted'],
      [run.runId, 'running']
    ])
    expect(reads).not.toHaveBeenCalled()
    const bindings = {
      python: {
        language: 'python',
        runtimeId: 'python-test',
        source: 'external',
        provenance: 'user-own',
        interpreterPath: join(root, 'python'),
        label: 'Test Python',
        status: 'active'
      }
    } as const
    const [winner, late] = await Promise.all([
      reader.commitTerminalRun({
        ...request,
        expectedStatus: 'running',
        run: { ...run, status: 'completed' }
      }),
      reader.transitionRun({
        ...request,
        expectedStatus: 'queued',
        run: { ...run, status: 'cancelled' }
      }),
      reader.setRuntimeBindings(scope.projectId, scope.sessionId, bindings, lane)
    ])
    expect(winner.run.status).toBe('completed')
    expect(late.transitioned).toBe(false)
    expect(reads).not.toHaveBeenCalled()
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.runs.map((entry: NotebookRunRecord) => entry.runId)).toEqual([
      'left',
      'old',
      'right',
      run.runId
    ])
    expect(stored.runs[1]).toEqual(reference)
    expect(stored.runs[3].status).toBe('completed')
    const args = [scope.projectId, scope.sessionId, { includeEnvironmentManifests: true }] as const
    const reopened = new NotebookRunRepository(root)
    expect(
      (await reopened.findExisting(scope.projectId, scope.sessionId, lane))?.runtimeBindings
    ).toEqual(bindings)
    const full = await reopened.readSessionRuns(...args)
    reads.mockClear()
    const analysis = await reader.readAnalysisRuns(...args)
    expect(analysis).toStrictEqual(
      full.map((row) =>
        row.runId === old.runId ? { ...row, text: admittedRun().text, outputs: [] } : row
      )
    )
    expect(analysis.find((row) => row.runId === old.runId)?.environmentManifest).toEqual(manifest)
    expect(reads.mock.calls.map(([path]) => path)).not.toContain(body)
    const target = { limit: 0, runIds: [old.runId], lane }
    const cached = await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, target)
    expect(cached?.window).toStrictEqual(
      await reopened.readSessionRunWindow(
        scope.projectId,
        scope.sessionId,
        target.limit,
        target.runIds
      )
    )
    await expect(
      reader.appendOrGetRun({
        ...request,
        run: {
          ...run,
          submissionIdentity: old.submissionIdentity,
          submissionFingerprint: 'different'
        }
      })
    ).rejects.toBeInstanceOf(NotebookRunSubmissionConflictError)
    await writeFile(body, Buffer.alloc(reference.bytes, 32))
    await expect(reader.loadSessionInitialization(initializing)).rejects.toThrow('corrupt')
    expect(
      await reader.readCachedHistoryWindow(scope.projectId, scope.sessionId, {
        limit: 1,
        runIds: [],
        lane
      })
    ).toBeUndefined()
    await expect(
      reader.setRuntimeBindings(scope.projectId, scope.sessionId, {}, lane)
    ).rejects.toThrow('corrupt')
    await expect(reader.appendOrGetRun({ ...request, run })).rejects.toThrow('corrupt')
    await expect(
      reader.readLaneAnalysisRuns(scope.projectId, scope.sessionId, lane)
    ).rejects.toThrow('corrupt')
    expect(await reader.readAnalysisRuns(scope.projectId, scope.sessionId)).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(stored)
  } finally {
    reads.mockRestore()
  }
})
