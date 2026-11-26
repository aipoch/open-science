import { mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as durableFiles from '@aipoch/durable-files'
import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import { NotebookSessionReadModel, type NotebookSessionReadSource } from './session-read-model'
import type { NotebookDependencyProjection } from '@aipoch/notebook-analysis'
import type { NotebookSessionSnapshot } from './session-aggregate'
import { createFrameNotebookLane } from './lane-identity'
import type { NotebookRunRecord, NotebookSessionState } from '../../shared/notebook'

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
  it('reads only the requested public evidence, including from a historical frame', async () => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const readModel = makeReadModel(storageRoot, undefined, repository)
    const lane = createFrameNotebookLane('project', 'session', 'child')
    await repository.loadOrCreate({
      projectId: 'project',
      sessionId: 'session',
      workspaceCwd: storageRoot,
      lane
    })
    const run = makeRun({
      agentFrameId: 'child',
      kernelEpochId: 'epoch',
      submissionIdentity: 'internal'
    })
    await repository.appendRun({ projectId: 'project', sessionId: 'session', lane, run })
    const window = vi.spyOn(repository, 'readSessionRunWindow')
    const evidence = await readModel.runEvidence('project', 'session', run.runId)
    expect(window).toHaveBeenCalledWith('project', 'session', 0, [run.runId], undefined, undefined)
    expect(evidence).toEqual({ runId: run.runId, kernelEpochId: 'epoch' })
    await expect(readModel.runEvidence('project', 'session', 'absent')).resolves.toBeNull()
  })

  it('transfers figure descriptors first and only the selected capture on demand', async () => {
    const root = await createRoot()
    const session = makeSession(root)
    const { projectId, sessionId, lane } = session
    const request = { projectId, sessionId, workspaceCwd: session.cwd }
    const repository = new NotebookRunRepository(root)
    await repository.loadOrCreate({ ...request, lane })
    const outputs: NotebookRunRecord['outputs'] = [
      { type: 'display', data: { 'image/png': 'RklSU1Q=', 'text/plain': 'chart' } },
      { type: 'display', data: { 'image/png': 'U0VDT05E' } }
    ]
    await repository.appendRun({ projectId, sessionId, lane, run: makeRun({ outputs }) })
    const model = makeReadModel(root, session)
    const projected = await model.state(
      session,
      ['run-1'],
      undefined,
      undefined,
      100,
      undefined,
      true
    )
    expect(projected.runs[0].outputs).toEqual([
      { type: 'display', data: { 'text/plain': 'chart' }, deferredImageTypes: ['image/png'] },
      { type: 'display', data: {}, deferredImageTypes: ['image/png'] }
    ])
    const figure = { ...request, runId: 'run-1', outputIndex: 1, mimeType: 'image/png' }
    expect(await model.runFigure(projectId, sessionId, figure, session)).toBe('U0VDT05E')
    expect(
      await model.runFigure(projectId, sessionId, { ...figure, outputIndex: 2 }, session)
    ).toBeNull()
    expect((await model.state(session, ['run-1'])).runs[0].outputs).toEqual(outputs)
  })

  it('reuses the foreground summary populated during live kernel loading', async () => {
    const root = await createRoot()
    const session = makeSession(root)
    const { projectId, sessionId, lane } = session
    const writer = new NotebookRunRepository(root)
    await writer.loadOrCreate({ projectId, sessionId, lane, workspaceCwd: root })
    await writer.appendRun({ projectId, sessionId, lane, run: makeRun() })

    const reader = new NotebookRunRepository(root)
    const history = vi.spyOn(reader, 'readSessionRunWindow')
    const model = makeReadModel(root, session, reader)
    await expect(model.backgroundTasks(projectId, sessionId, session)).resolves.toEqual({
      runs: []
    })
    expect(history).not.toHaveBeenCalled()
  })

  it('projects only visible background task metadata within the same byte window', async () => {
    root = await createRoot()
    const repository = new NotebookRunRepository(root)
    const readModel = makeReadModel(root, undefined, repository)
    const background = makeRun({
      runId: 'bg',
      executionMode: 'background',
      agentFrameId: 'worker',
      script: '\r\n  ' + 'x'.repeat(100) + '\nprivate',
      cancellationRequestedAt: 12
    })
    const foreground = makeRun({ runId: 'fg' })
    const window = {
      runs: [background, foreground],
      total: 2,
      agentSummaries: [],
      latestRunEnvironments: {}
    }
    vi.spyOn(repository, 'readSessionRunWindow').mockResolvedValue(window)
    const result = await readModel.backgroundTasks('project', 'session')
    expect(result.runs).toEqual([
      {
        runId: 'bg',
        agentFrameId: 'worker',
        title: 'x'.repeat(80),
        status: 'completed',
        kernelKind: 'python',
        startedAt: 1,
        cancellationRequestedAt: 12
      }
    ])
    foreground.text.stdout = 'x'.repeat(32 * 1024 * 1024)
    await expect(readModel.backgroundTasks('project', 'session')).resolves.toEqual({ runs: [] })
  })

  it('polls validated large background history without rereading output and falls back if the file changes', async () => {
    const storageRoot = await createRoot()
    const scope = { projectId: 'project', sessionId: 'session' }
    const lane = createFrameNotebookLane('project', 'session', 'worker')
    const writer = new NotebookRunRepository(storageRoot)
    const doc = await writer.loadOrCreate({ ...scope, lane, workspaceCwd: storageRoot })
    const run = makeRun({ executionMode: 'background', agentFrameId: 'worker' })
    await writer.appendRun({ ...scope, lane, run })
    // Escaping makes this body exceed the 63 MiB budget when the recent Run is counted twice.
    await writer.appendRun({
      ...scope,
      lane,
      run: {
        ...run,
        runId: 'latest',
        startedAt: 2,
        text: { ...run.text, stdout: '"'.repeat(17 * 1024 * 1024) }
      }
    })
    const repository = new NotebookRunRepository(storageRoot)
    const session = { ...makeSession(storageRoot), ...scope, lane }
    const model = makeReadModel(storageRoot, session, repository)
    const history = vi.spyOn(repository, 'readSessionRunWindow')
    const initial = await model.backgroundTasks(scope.projectId, scope.sessionId, session)
    expect(initial.runs.map((row) => row.runId)).toEqual(['latest'])
    expect(history).not.toHaveBeenCalled()
    const reads = vi.spyOn(durableFiles, 'readFileWithinLimit')
    try {
      expect(
        (await model.backgroundTasks(scope.projectId, scope.sessionId)).runs.map((r) => r.runId)
      ).toEqual(['latest'])
      expect(reads).not.toHaveBeenCalled()
      const directory = join(doc.notebookSessionRoot, '.run-records')
      const [file] = await readdir(directory)
      const handle = await open(join(directory, file), 'r+')
      try {
        await handle.write('!', 0, 'utf8')
      } finally {
        await handle.close()
      }
      expect((await model.backgroundTasks(scope.projectId, scope.sessionId)).runs).toEqual([])
      expect(reads).toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  })

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
      agentSummaries: [
        {
          agentFrameId: 'frame-old',
          isRoot: false,
          runCount: 1,
          views: [
            { kernelKind: 'r', environment: 'historical-r', runCount: 1, latestRunId: 'old-run' }
          ]
        }
      ],
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
    const expectedAgents = [
      {
        agentFrameId: 'frame-old',
        isRoot: false,
        runCount: 1,
        views: [
          { kernelKind: 'r', environment: 'historical-r', runCount: 1, latestRunId: 'old-run' }
        ]
      }
    ]
    expect(state.agentSummaries).toEqual(expectedAgents)
    const imported = await makeReadModel(storageRoot, undefined, repository).importedState(
      { projectId: session.projectId, sessionId: session.sessionId, workspaceCwd: session.cwd },
      [],
      undefined,
      undefined,
      100
    )
    expect(imported.agentSummaries).toEqual(expectedAgents)
    expect(state.runCount).toBe(125)
    expect(state.latestRunEnvironments).toEqual({ python: 'historical-python' })
    expect(state.runs).toHaveLength(100)
    expect(state.runs[0]?.runId).toBe('run-25')
    expect(state.runs[0]).toHaveProperty('kernelDispatched', true)
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
      agentSummaries: [],
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
    const run = makeRun({
      runId: 'run-old',
      startedAt: 1,
      environmentManifestChecksum: 'manifest-checksum',
      environmentManifest: { packages: [] } as never
    })
    const readWindow = vi.spyOn(repository, 'readSessionRunWindow').mockResolvedValue({
      agentSummaries: [],
      runs: [run],
      total: 125,
      latestRunEnvironments: {}
    })

    const model = makeReadModel(storageRoot, session, repository)
    const state = await model.state(session, ['run-old'])

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
    expect(state.runs[0]).toHaveProperty('environmentManifest')

    const normalState = await model.state(session)
    expect(normalState.runs[0]).not.toHaveProperty('environmentManifest')
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

it.each(['live', 'imported'])(
  'keeps a complete latest Run under a preview byte budget for %s history',
  async (mode) => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot)
    const request = {
      projectId: session.projectId,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd
    }
    await repository.loadOrCreate({ ...request, lane: session.lane })
    const runs = [
      makeRun({ runId: 'older' }),
      makeRun({
        runId: 'latest',
        startedAt: 2,
        text: { stdout: 'x'.repeat(2048), stderr: '', traceback: '', plain: [] }
      })
    ]
    vi.spyOn(repository, 'readSessionRunWindow').mockResolvedValue({
      runs,
      total: 2,
      latestRunEnvironments: {},
      agentSummaries: []
    })
    const model = makeReadModel(storageRoot, session, repository)
    const read = (bytes?: number): Promise<NotebookSessionState> =>
      mode === 'live'
        ? model.state(session, [], undefined, undefined, 100, bytes)
        : model.importedState(request, [], undefined, undefined, 100, bytes)
    expect((await read()).runs).toHaveLength(2)
    const preview = await read(1024)
    expect(preview.runs.map((run) => run.runId)).toEqual(['latest'])
    expect(preview.runs[0].text.stdout).toBe(runs[1].text.stdout)
    expect(preview.historyPage).toEqual({
      hasEarlierRuns: true,
      oldestCursor: { startedAt: 2, runId: 'latest' }
    })
  }
)

it.each(['live', 'imported'])(
  'pages large %s Notebook history without losing complete run outputs',
  async (mode) => {
    const storageRoot = await createRoot()
    const repository = new NotebookRunRepository(storageRoot)
    const session = makeSession(storageRoot)
    await repository.loadOrCreate({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      workspaceCwd: session.cwd
    })
    const stdout = '\u0000'.repeat(2 * 1024 * 1024)
    for (let index = 0; index < 3; index++)
      await repository.appendRun({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lane: session.lane,
        run: makeRun({
          runId: `large-${index}`,
          cellId: `large-cell-${index}`,
          startedAt: index + 1,
          text: { stdout, stderr: '', traceback: '', plain: [] },
          outputs: [{ type: 'stream', name: 'stdout', text: stdout }]
        })
      })
    const model = makeReadModel(storageRoot, session, repository)
    const ids: string[] = []
    let before: import('../../shared/notebook').NotebookRunCursor | undefined
    for (let page = 0; page < 3; page++) {
      const state =
        mode === 'live'
          ? await model.state(session, [], undefined, before)
          : await model.importedState(
              {
                projectId: session.projectId,
                sessionId: session.sessionId,
                workspaceCwd: session.cwd
              },
              [],
              undefined,
              before,
              100
            )
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(64 * 1024 * 1024)
      if (page === 0) expect(state.runs).toHaveLength(1)
      for (const run of state.runs) {
        ids.push(run.runId)
        expect(run.text.stdout === stdout).toBe(true)
        expect(run.outputs[0]).toEqual({ type: 'stream', name: 'stdout', text: stdout })
      }
      if (!state.historyPage?.hasEarlierRuns) break
      expect(state.historyPage.oldestCursor).toBeDefined()
      before = state.historyPage.oldestCursor
    }
    expect(ids.sort()).toEqual(['large-0', 'large-1', 'large-2'])
  }
)

it('recovers an old Shell receipt from disk after a timeout and a fresh read model', async () => {
  const storageRoot = await createRoot()
  const session = makeSession(storageRoot)
  const { projectId, sessionId, lane } = session
  const writer = new NotebookRunRepository(storageRoot)
  await writer.loadOrCreate({ projectId, sessionId, lane, workspaceCwd: storageRoot })
  const stdout = JSON.stringify({ data: 'x'.repeat(18000), _handoff: { orderId: 'saved-order' } })
  await writer.appendRun({
    projectId,
    sessionId,
    lane,
    run: makeRun({
      runId: 'outline',
      kernelKind: 'bash',
      text: { stdout, stderr: '', traceback: '', plain: [] }
    })
  })
  for (let index = 0; index < 12; index++) {
    await writer.appendRun({
      projectId,
      sessionId,
      lane,
      run: makeRun({
        runId: `later-${index}`,
        startedAt: index + 2,
        kernelKind: 'bash',
        status: index === 11 ? 'timeout' : 'completed'
      })
    })
  }
  // Reopen the repository without any original interpreter or in-memory run cache.
  const reader = new NotebookRunRepository(storageRoot)
  const model = makeReadModel(storageRoot, undefined, reader)
  const recovered = await model.importedState(
    { projectId, sessionId, workspaceCwd: storageRoot },
    ['outline'],
    undefined,
    undefined,
    10
  )
  expect(recovered.runs.find((run) => run.runId === 'outline')?.text.stdout).toBe(stdout)
  const foreign = await model.importedState(
    { projectId, sessionId: 'other-session', workspaceCwd: storageRoot },
    ['outline'],
    undefined,
    undefined,
    10
  )
  expect(foreign.runs).toEqual([])
})
