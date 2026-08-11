import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import { NotebookSessionReadModel, type NotebookSessionReadSource } from './session-read-model'
import type { NotebookSessionSnapshot } from './session-aggregate'
import { createFrameNotebookLane } from './lane-identity'
import type { NotebookRunRecord } from '../../shared/notebook'

let root: string | undefined

const createRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'notebook-read-model-'))
  return root
}

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const makeSession = (
  storageRoot: string,
  snapshotOverrides: Partial<NotebookSessionSnapshot> = {},
  withRuntimeBinding = false
): NotebookSessionReadSource => {
  const sessionId = 'session-1'
  const projectName = 'default-project'
  const notebookSessionRoot = join(storageRoot, 'notebooks', projectName, sessionId)
  const snapshot: NotebookSessionSnapshot = {
    id: `notebook-session-${sessionId}`,
    sessionId,
    projectName,
    cwd: join(storageRoot, 'workspace'),
    notebookSessionRoot,
    dataRoot: join(notebookSessionRoot, 'data'),
    runtimeRoot: getRuntimeRoot(storageRoot),
    runJsonPath: join(notebookSessionRoot, 'run.json'),
    cells: [],
    executionCount: 0,
    kernelStatuses: [],
    ...snapshotOverrides
  }
  return {
    id: snapshot.id,
    sessionId,
    projectName,
    cwd: snapshot.cwd,
    notebookSessionRoot,
    dataRoot: snapshot.dataRoot,
    runtimeRoot: snapshot.runtimeRoot,
    runJsonPath: snapshot.runJsonPath,
    lane: createFrameNotebookLane(projectName, sessionId, 'root-frame-session-1'),
    snapshot: () => snapshot,
    kernelStatusEntries: () => snapshot.kernelStatuses.map((entry) => [...entry]),
    runtimeBindingEntries: () =>
      withRuntimeBinding
        ? [
            [
              'python',
              {
                runtimeId: 'managed-python',
                language: 'python',
                label: 'Python 3.13',
                source: 'managed',
                provenance: 'app-managed',
                interpreterPath: join(getRuntimeRoot(storageRoot), 'python'),
                status: 'active'
              }
            ]
          ]
        : []
  }
}

const makeReadModel = (
  storageRoot: string,
  session: NotebookSessionReadSource | undefined,
  repository = new NotebookRunRepository(storageRoot)
): NotebookSessionReadModel<NotebookSessionReadSource> =>
  new NotebookSessionReadModel({
    storageRoot,
    defaultProjectName: 'default-project',
    repository,
    findSession: vi.fn(() => session),
    runtimeBindings: () => ({
      python: {
        runtimeId: 'managed-python',
        language: 'python',
        label: 'Python 3.13',
        source: 'managed',
        provenance: 'app-managed',
        interpreterPath: join(getRuntimeRoot(storageRoot), 'python'),
        status: 'active'
      }
    }),
    isRestartRecommended: (processKey) => processKey === 'r:analysis'
  })

describe('NotebookSessionReadModel', () => {
  it('returns only actionable live handoff data and never consults durable storage', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const findExisting = vi.spyOn(repository, 'findExisting')
    const empty = makeSession(storageRoot)

    expect(
      makeReadModel(storageRoot, undefined, repository).peekHandoffContext('missing')
    ).toBeUndefined()
    expect(
      makeReadModel(storageRoot, empty, repository).peekHandoffContext('session-1')
    ).toBeUndefined()

    const active = makeSession(
      storageRoot,
      {
        executionCount: 8,
        activeRunId: 'run-8',
        cells: [
          { id: 'cell-8', language: 'r', code: '1 + 1', status: 'running', latestRunId: 'run-8' }
        ],
        kernelStatuses: [
          ['python:default-python', 'terminated'],
          ['r:analysis', 'running']
        ]
      },
      true
    )
    expect(makeReadModel(storageRoot, active, repository).peekHandoffContext('session-1')).toEqual({
      activeRunId: 'run-8',
      executionCount: 8,
      cells: [{ id: 'cell-8', language: 'r', status: 'running', latestRunId: 'run-8' }],
      kernels: [{ kind: 'r', status: 'running' }],
      runtimes: [{ language: 'python', label: 'Python 3.13', status: 'active' }]
    })
    expect(findExisting).not.toHaveBeenCalled()
  })

  it('combines the live aggregate with durable history and preserves environment projection', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot, {
      cells: [{ id: 'cell-1', language: 'python', code: '1', status: 'completed' }],
      kernelStatuses: [
        ['repl', 'idle'],
        ['r:analysis', 'running']
      ]
    })
    await repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: session.cwd,
      pythonPath: join(getRuntimeRoot(storageRoot), 'python')
    })

    const state = await makeReadModel(storageRoot, session, repository).state(session)

    expect(state).toMatchObject({
      id: session.id,
      sessionId: session.sessionId,
      pythonPath: join(getRuntimeRoot(storageRoot), 'python'),
      cells: [{ id: 'cell-1', status: 'completed' }],
      runs: [],
      recentRuns: [],
      environments: [
        { processKey: 'repl', kind: 'repl', status: 'idle' },
        {
          processKey: 'r:analysis',
          kind: 'r',
          environment: 'analysis',
          status: 'running',
          restartRecommended: true
        }
      ],
      runtimeBindings: { python: { runtimeId: 'managed-python' } }
    })
  })

  it('prefers a live reference and otherwise falls back to normalized durable roots', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot, { cwd: String.raw`C:\Users\analyst\workspace` })
    const liveModel = makeReadModel(storageRoot, session, repository)

    await expect(
      liveModel.getSessionReference({
        sessionId: session.sessionId,
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toEqual(liveModel.toSessionReference(session))
    expect(liveModel.toSessionReference(session).workspaceCwd).toBe(
      String.raw`C:\Users\analyst\workspace`
    )

    const persistedWorkspace = join(storageRoot, 'persisted-workspace')
    await repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: persistedWorkspace
    })
    const durableModel = makeReadModel(storageRoot, undefined, repository)
    await expect(
      durableModel.getSessionReference({
        sessionId: session.sessionId,
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toEqual({
      sessionId: session.sessionId,
      projectName: session.projectName,
      workspaceCwd: persistedWorkspace,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(storageRoot, session.projectName, session.sessionId)
    })
    await expect(
      durableModel.getSessionReference({
        sessionId: 'missing',
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toBeNull()
  })

  it('exposes the one Session Notebook when only a child Frame has produced Runs', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const childLane = createFrameNotebookLane('default-project', 'session-1', 'frame-child')
    await repository.loadOrCreate({
      projectName: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/child-workspace',
      lane: childLane
    })
    await repository.appendRun({
      projectName: 'default-project',
      sessionId: 'session-1',
      lane: childLane,
      run: makeRun({ runId: 'child-run', agentFrameId: 'frame-child' })
    })

    const reference = await makeReadModel(storageRoot, undefined, repository).getSessionReference({
      sessionId: 'session-1',
      projectName: 'default-project',
      workspaceCwd: '/root-workspace'
    })

    expect(reference).toMatchObject({
      sessionId: 'session-1',
      projectName: 'default-project',
      workspaceCwd: '/root-workspace'
    })
  })
})
