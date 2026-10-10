import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
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
import { connectToDesktopEndpoint } from './desktop-connection'
import { parseRpcJson } from './rpc-json'

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: diagnostics.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

it.each([Math.floor(0.35 * 1024 * 1024), Math.floor(4_105_467 / 12)])(
  'delivers concurrent legal Notebook and session responses with %i-byte outputs without disconnecting the desktop',
  async (outputBytes) => {
    // Every output is comfortably inside Notebook's per-run text cap. State publishes
    // full run records in both runs and recentRuns; no private incident data is copied.
    const stdout = 'x'.repeat(outputBytes)
    const runs: NotebookRunRecord[] = Array.from({ length: 3 }, (_, index) => ({
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
    expect(notebook.runs).toHaveLength(3)
    expect(notebook.recentRuns).toHaveLength(3)
    const session = { messages: [{ role: 'assistant', content: 's'.repeat(1024 * 1024) }] }
    expect(Buffer.byteLength(JSON.stringify(notebook))).toBeLessThan(16 * 1024 * 1024)
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = 0
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: {
        commandNames: () => ['notebook:state', 'sessions:load-one'],
        invoke: async (name) => {
          entered += 1
          if (entered === 5) release()
          await ready
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
      JSON.stringify(diagnostics.warn.mock.calls)
    ).toEqual(Array(5).fill('fulfilled'))
    expect(disconnected).not.toHaveBeenCalled()
    expect(diagnostics.warn).not.toHaveBeenCalled()
  }
)

it('flushes queued events and the shutdown reply in order before stopping the backend', async () => {
  const events = new ApplicationEventHub()
  const shutdown = vi.fn((): void => {
    void server.close()
  })
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => [], invoke: async () => undefined },
    events,
    requestShutdown: shutdown
  })
  cleanups.push(server.close)
  const socket = await connectToDesktopEndpoint(server.endpoint)
  const received: string[] = []
  socket.on('message', (bytes) => {
    const frame = parseRpcJson(bytes.toString()) as { kind: string; payload?: string }
    received.push(frame.kind === 'event' ? `event-${frame.payload![0]}` : frame.kind)
  })
  const bootstrap = once(socket, 'message')
  socket.send(JSON.stringify({ kind: 'bootstrap' }))
  await bootstrap
  const closed = once(socket, 'close')
  for (let index = 0; index < 4; index += 1)
    events.publish('connectors:approval-settled', `${index}${'x'.repeat(4 * 1024 * 1024)}`)
  socket.send(
    JSON.stringify({
      kind: 'shutdown',
      id: 1,
      generation: server.endpoint.generation,
      pid: process.pid
    })
  )
  await closed
  expect(shutdown).toHaveBeenCalledOnce()
  expect(received).toEqual(['bootstrap', 'event-0', 'event-1', 'event-2', 'event-3', 'response'])
  expect(diagnostics.warn).not.toHaveBeenCalled()
})

it('replays the full retained event window in order and keeps subsequent commands connected', async () => {
  const events = new ApplicationEventHub()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    commands: { commandNames: () => ['projects:list'], invoke: async () => [] },
    events
  })
  cleanups.push(server.close)
  for (let index = 0; index < 2048; index += 1)
    events.publish('connectors:approval-settled', String(index))
  const socket = await connectToDesktopEndpoint(server.endpoint)
  const bootstrap = once(socket, 'message')
  socket.send(JSON.stringify({ kind: 'bootstrap' }))
  const [bytes] = await bootstrap
  const frame = parseRpcJson(bytes.toString()) as { eventStream: { streamId: string } }
  const sequences: number[] = []
  let finishReplay!: () => void
  const ready = new Promise<void>((resolve) => {
    finishReplay = resolve
  })
  socket.on('message', (bytes) => {
    const received = parseRpcJson(bytes.toString()) as { kind: string; sequence: number }
    if (received.kind === 'event') sequences.push(received.sequence)
    if (received.kind === 'ready') finishReplay()
  })
  socket.send(JSON.stringify({ kind: 'resume', streamId: frame.eventStream.streamId, after: 0 }))
  await ready
  expect(sequences).toEqual(Array.from({ length: 2048 }, (_, index) => index + 1))
  const response = once(socket, 'message')
  socket.send(
    JSON.stringify({
      kind: 'invoke',
      protocolVersion: 1,
      id: 1,
      clientId: randomUUID(),
      channel: 'projects:list',
      args: []
    })
  )
  const [result] = await response
  expect(parseRpcJson(result.toString())).toMatchObject({
    kind: 'response',
    id: 1,
    ok: true,
    result: []
  })
  expect(diagnostics.warn).not.toHaveBeenCalled()
})
