import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import { NotebookSessionReadModel, type NotebookSessionReadSource } from './session-read-model'
import type { NotebookDependencyProjection } from './dependency-analysis'
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
  const projectId = 'default-project'
  const notebookSessionRoot = join(storageRoot, 'notebooks', projectId, sessionId)
  const snapshot: NotebookSessionSnapshot = {
    id: `notebook-session-${sessionId}`,
    sessionId,
    projectId,
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
    projectId,
    cwd: snapshot.cwd,
    notebookSessionRoot,
    dataRoot: snapshot.dataRoot,
    runtimeRoot: snapshot.runtimeRoot,
    runJsonPath: snapshot.runJsonPath,
    lane: createFrameNotebookLane(projectId, sessionId, 'root-frame-session-1'),
    snapshot: () => snapshot,
    kernelStatus: (processKey) => snapshot.kernelStatuses.find(([key]) => key === processKey)?.[1],
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
  repository = new NotebookRunRepository(storageRoot),
  dependencyProjection: NotebookDependencyProjection = {
    stalenessByRunId: {},
    invalidatedByRunId: {}
  }
): NotebookSessionReadModel<NotebookSessionReadSource> =>
  new NotebookSessionReadModel({
    storageRoot,
    defaultProjectId: 'default-project',
    repository,
    dependencyAnalyzer: {
      project: vi.fn(async () => dependencyProjection)
    },
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
    runtimeEnvironment: (_session, language) => (language === 'r' ? 'analysis' : 'default-python'),
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
      projectId: session.projectId,
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
      executionEnvironments: { python: 'default-python', r: 'analysis' },
      runtimeBindings: { python: { runtimeId: 'managed-python' } }
    })
  })

  it('prefers live kernel statuses while projecting persisted offline terminations', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot, {
      kernelStatuses: [
        ['python:default-python', 'running'],
        ['r:analysis', 'running']
      ]
    })
    await repository.loadOrCreate({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: session.cwd
    })
    await repository.markKernelTerminated({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      kernelInstance: { kind: 'r', environment: 'analysis' }
    })
    await repository.markKernelTerminated({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      kernelInstance: { kind: 'python', environment: 'default-python' }
    })
    await repository.markKernelTerminated({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      kernelInstance: { kind: 'repl' }
    })

    const state = await makeReadModel(storageRoot, session, repository).state(session)

    expect(state.kernelStatus).toBe('running')
    expect(state.environments).toEqual([
      {
        processKey: 'python:default-python',
        kind: 'python',
        environment: 'default-python',
        status: 'running',
        restartRecommended: false
      },
      {
        processKey: 'r:analysis',
        kind: 'r',
        environment: 'analysis',
        status: 'running',
        restartRecommended: true
      },
      {
        processKey: 'repl',
        kind: 'repl',
        status: 'terminated'
      }
    ])
  })

  it('returns only the most recent 100 runs while reporting the durable total', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot, {
      cells: Array.from({ length: 125 }, (_, index) => ({
        id: `cell-${index}`,
        language: 'python',
        code: String(index),
        status: 'completed'
      }))
    })
    await repository.loadOrCreate({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: session.cwd
    })
    const readWindow = vi.spyOn(repository, 'readSessionRunWindow').mockResolvedValue({
      runs: Array.from({ length: 100 }, (_, index) =>
        makeRun({
          runId: `run-${index + 25}`,
          cellId: `cell-${index + 25}`,
          startedAt: index + 25,
          kernelDispatched: true,
          runtimeId: '/external/python'
        })
      ),
      total: 125,
      latestRunEnvironments: { python: 'historical-python' }
    })

    const allRunIds = Array.from({ length: 125 }, (_, index) => `run-${index}`)
    const state = await makeReadModel(storageRoot, session, repository, {
      stalenessByRunId: Object.fromEntries(
        allRunIds.map((runId) => [
          runId,
          runId === 'run-124'
            ? {
                state: 'stale' as const,
                causedByRunId: 'run-0',
                names: ['x'],
                path: allRunIds
              }
            : { state: 'clear' as const }
        ])
      ),
      invalidatedByRunId: {}
    }).state(session)

    expect(readWindow).toHaveBeenCalledWith(
      session.projectId,
      session.sessionId,
      100,
      [],
      undefined,
      undefined
    )
    expect(state.runCount).toBe(125)
    expect(state.latestRunEnvironments).toEqual({ python: 'historical-python' })
    expect(state.runs).toHaveLength(100)
    expect(state.runs[0]?.runId).toBe('run-25')
    expect(state.runs[0]).not.toHaveProperty('kernelDispatched')
    expect(state.runs[0]).not.toHaveProperty('runtimeId')
    expect(state.recentRuns).toHaveLength(20)
    expect(state.cells).toHaveLength(100)
    expect(state.cells[0]?.id).toBe('cell-25')
    expect(Object.keys(state.runStaleness ?? {})).toEqual(
      Array.from({ length: 100 }, (_, index) => `run-${index + 25}`)
    )
    expect(state.runStaleness?.['run-124']).toEqual({
      state: 'stale',
      causedByRunId: 'run-0',
      names: ['x'],
      path: Array.from({ length: 100 }, (_, index) => `run-${index + 25}`)
    })
  })

  it('returns complete-history discovery metadata without returning the recent run window', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot)
    await repository.loadOrCreate({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: session.cwd
    })
    const historySummary = {
      agentFrameId: 'frame-child',
      runCount: 7,
      kernelCounts: { python: 3, r: 2, repl: 1, bash: 1 },
      latestDataKernel: 'r' as const
    }
    const readWindow = vi.spyOn(repository, 'readSessionRunWindow').mockResolvedValue({
      runs: [],
      total: 125,
      latestRunEnvironments: {},
      historySummary
    })

    const state = await makeReadModel(storageRoot, session, repository).state(
      session,
      [],
      'frame-child'
    )

    expect(readWindow).toHaveBeenCalledWith(
      session.projectId,
      session.sessionId,
      0,
      [],
      'frame-child',
      undefined
    )
    expect(state.historySummary).toEqual(historySummary)
    expect(state.runs).toEqual([])
    expect(state.recentRuns).toEqual([])
    expect(state.cells).toEqual([])
  })

  it('adds explicitly requested historical runs without widening the default window', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot)
    await repository.loadOrCreate({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: session.cwd
    })
    const readWindow = vi.spyOn(repository, 'readSessionRunWindow').mockResolvedValue({
      runs: [makeRun({ runId: 'run-old', startedAt: 1 })],
      total: 125,
      latestRunEnvironments: {}
    })

    const state = await makeReadModel(storageRoot, session, repository).state(session, ['run-old'])

    expect(readWindow).toHaveBeenCalledWith(
      session.projectId,
      session.sessionId,
      0,
      ['run-old'],
      undefined,
      undefined
    )
    expect(state.runs.map((run) => run.runId)).toEqual(['run-old'])
    expect(state.recentRuns).toEqual([])
    expect(state.cells).toEqual([])
    expect(state.runCount).toBe(125)
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
      projectId: session.projectId,
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
      projectId: session.projectId,
      workspaceCwd: persistedWorkspace,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(storageRoot, session.projectId, session.sessionId)
    })
    await expect(
      durableModel.getSessionReference({
        sessionId: 'missing',
        workspaceCwd: join(storageRoot, 'ignored')
      })
    ).resolves.toBeNull()
  })

  it.each([
    { projectId: 'another-project', sessionId: 'session-1' },
    { projectId: 'default-project', sessionId: 'another-session' }
  ])(
    'N05 rejects a live reference with mismatched identity $projectId/$sessionId',
    async (identity) => {
      const storageRoot = await createRoot()
      const session = { ...makeSession(storageRoot), ...identity }
      await expect(
        makeReadModel(storageRoot, session).getSessionReference({
          projectId: 'default-project',
          sessionId: 'session-1',
          workspaceCwd: storageRoot
        })
      ).resolves.toBeNull()
    }
  )

  it('exposes the one Session Notebook when only a child Frame has produced Runs', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const childLane = createFrameNotebookLane('default-project', 'session-1', 'frame-child')
    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/child-workspace',
      lane: childLane
    })
    await repository.appendRun({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: childLane,
      run: makeRun({ runId: 'child-run', agentFrameId: 'frame-child' })
    })

    const reference = await makeReadModel(storageRoot, undefined, repository).getSessionReference({
      sessionId: 'session-1',
      projectId: 'default-project',
      workspaceCwd: '/root-workspace'
    })

    expect(reference).toMatchObject({
      sessionId: 'session-1',
      projectId: 'default-project',
      workspaceCwd: '/root-workspace'
    })
  })
})
