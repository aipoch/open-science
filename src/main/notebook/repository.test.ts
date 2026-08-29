import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookRunRepository, getNotebookSessionRoot } from './repository'
import { createFrameNotebookLane, createRootNotebookLane } from './lane-identity'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-runs-'))
  return storageRoot
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('notebook run repository', () => {
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
          evidenceId: 'notebook-file-evidence-external-run',
          state: 'partial',
          checksum: 'a'.repeat(64),
          storageKey: 'file-evidence/runs/external-run.json',
          relationCount: 1,
          generationCount: 1,
          managedRootsFinalState: 'partial',
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
            evidenceId: 'notebook-file-evidence-external-run',
            state: 'partial',
            checksum: 'a'.repeat(64),
            storageKey: 'file-evidence/runs/external-run.json',
            relationCount: 1,
            generationCount: 1,
            managedRootsFinalState: 'partial',
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
      version: 2,
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
            kind: 'processed-data',
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
          kind: 'processed-data',
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

  it('creates the handoff and outputs cross-kernel workspace dirs alongside the other session dirs', async () => {
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
    expect(reloaded?.runs[0].artifacts[0]).toMatchObject({ projectId: 'canonical-project' })
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
})
