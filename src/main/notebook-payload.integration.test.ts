import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationEventHub } from './application-events'
import { connectDesktopRuntime } from './desktop-runtime-client'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import type { NotebookRunRecord } from '../shared/notebook'
import {
  NotebookRunRepository,
  getNotebookSessionRoot,
  getNotebookRunJsonPath,
  getRuntimeRoot
} from './notebook/repository'
import {
  NotebookSessionReadModel,
  type NotebookSessionReadSource
} from './notebook/session-read-model'
import { createFrameNotebookLane } from './notebook/lane-identity'

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: diagnostics.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

it.each([
  { outputBytes: 2097152, text: '\u0000', count: 1 },
  { outputBytes: 1572864, text: 'x', count: 3 }
])(
  'delivers concurrent legal Notebook and session responses with $outputBytes-byte outputs without disconnecting the desktop',
  async ({ outputBytes, text, count }) => {
    // Every output is comfortably inside Notebook's per-run text cap. State publishes
    // full run records in both runs and recentRuns; no private incident data is copied.
    const stdout = text.repeat(outputBytes)
    const runs: NotebookRunRecord[] = Array.from({ length: count }, (_, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      kernelKind: 'python',
      script: 'print("synthetic output")',
      status: 'completed',
      startedAt: index + 1,
      text: { stdout, stderr: '', traceback: '', plain: [] },
      outputs: [{ type: 'stream', name: 'stdout', text: stdout }],
      artifacts: [],
      workingFiles: []
    }))
    const storageRoot = await mkdtemp(join(tmpdir(), 'desktop-state-burst-'))
    cleanups.push(() => rm(storageRoot, { recursive: true, force: true }))
    const projectId = 'project-1'
    const sessionId = 'session-1'
    const lane = createFrameNotebookLane(projectId, sessionId, 'frame-1')
    const repository = new NotebookRunRepository(storageRoot)
    const cwd = join(storageRoot, 'workspace')
    await repository.loadOrCreate({ projectId, sessionId, lane, workspaceCwd: cwd })
    for (const run of runs) await repository.appendRun({ projectId, sessionId, lane, run })
    const fields = {
      id: 'notebook-1',
      projectId,
      sessionId,
      cwd,
      notebookSessionRoot: getNotebookSessionRoot(storageRoot, projectId, sessionId, lane),
      dataRoot: storageRoot,
      runtimeRoot: getRuntimeRoot(storageRoot),
      runJsonPath: getNotebookRunJsonPath(storageRoot, projectId, sessionId, lane)
    }
    const source: NotebookSessionReadSource = {
      ...fields,
      lane,
      snapshot: () => ({ ...fields, cells: [], executionCount: runs.length, kernelStatuses: [] }),
      kernelStatus: () => undefined,
      kernelStatusEntries: () => [],
      runtimeBindingEntries: () => []
    }
    const readModel = new NotebookSessionReadModel({
      storageRoot,
      defaultProjectId: projectId,
      repository,
      dependencyAnalyzer: {
        project: async () => ({ stalenessByRunId: {}, invalidatedByRunId: {} })
      },
      findSession: () => source,
      runtimeBindings: () => ({}),
      isRestartRecommended: () => false
    })
    const notebook = await readModel.state(source)
    expect(notebook.runs).toHaveLength(count)
    expect(notebook.recentRuns).toHaveLength(count)
    const session = { messages: [{ role: 'assistant', content: 's'.repeat(1024 * 1024) }] }
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: {
        commandNames: () => ['notebook:state', 'sessions:load-one', 'settings:get'],
        invoke: async (name) => {
          return name === 'notebook:state' ? notebook : session
        }
      }
    })
    cleanups.push(server.close)
    const disconnected = vi.fn()
    const client = await connectDesktopRuntime({
      endpoint: server.endpoint,
      onEvent: vi.fn(),
      onDisconnect: disconnected
    })
    cleanups.push(() => client.close())
    const document = randomUUID()
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => client.invoke(document, 'notebook:state', [])),
      client.invoke(document, 'sessions:load-one', [])
    ])
    expect(
      results.map((result) => result.status),
      JSON.stringify({
        diagnostics: diagnostics.warn.mock.calls,
        errors: results.map((result) =>
          result.status === 'rejected' ? result.reason.message : null
        )
      })
    ).toEqual(Array(5).fill('fulfilled'))
    for (const result of results.slice(0, 4)) {
      if (result.status !== 'fulfilled') throw new Error('Notebook load failed.')
      expect(JSON.stringify(result.value) === JSON.stringify(notebook)).toBe(true)
    }
    await expect(client.invoke(document, 'settings:get', [])).resolves.toEqual(session)
    expect(disconnected).not.toHaveBeenCalled()
    expect(diagnostics.warn).not.toHaveBeenCalled()
  }
)
