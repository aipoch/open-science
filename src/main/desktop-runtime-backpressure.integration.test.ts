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
import { parseRpcJson, stringifyRpcJson } from './rpc-json'
import { createAcpRuntimeEventBroadcastCoalescer } from './acp/runtime-event-broadcast-coalescer'
import { toAcpRuntimeEvent } from './acp/runtime-events'

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: diagnostics.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

it.each([367001, 342122])(
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
    expect(
      Buffer.byteLength(
        stringifyRpcJson({
          kind: 'response',
          id: 1,
          protocolVersion: 1,
          ok: true,
          result: notebook
        })
      )
    ).toBeLessThan(16 * 1024 * 1024)
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = 0
    const server = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: {
        commandNames: () => ['notebook:state', 'sessions:load-one', 'settings:get'],
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
    await expect(client.invoke(document, 'settings:get', [])).resolves.toEqual(session)
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

it('isolates large Notebook and JSON-escaped file results amid mixed desktop commands and events', async () => {
  const stdout = 'x'.repeat(1.5 * 1024 * 1024)
  const runs = Array.from({ length: 3 }, (_, index) => ({
    runId: `run-${index}`,
    text: { stdout },
    outputs: [{ type: 'stream', name: 'stdout', text: stdout }]
  }))
  const oversized = { runs, recentRuns: runs }
  expect(
    Buffer.byteLength(
      stringifyRpcJson({ kind: 'response', id: 1, protocolVersion: 1, ok: true, result: oversized })
    )
  ).toBeGreaterThan(16 * 1024 * 1024)
  const events = new ApplicationEventHub()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    events,
    commands: {
      commandNames: () => [
        'notebook:state',
        'files:read',
        'files:search',
        'settings:get',
        'compute:list',
        'sessions:load-one'
      ],
      invoke: async (name, invocation) => {
        if (name === 'notebook:state') return oversized
        if (name === 'files:read')
          return invocation.args[0] === 'oversized'
            ? '\u0000'.repeat(3 * 1024 * 1024)
            : 'x'.repeat(256 * 1024)
        if (name === 'sessions:load-one') return { messages: ['s'.repeat(1024 * 1024)] }
        return { channel: name }
      }
    },
    hostCommands: { commandNames: () => ['large-host'], invoke: async () => oversized }
  })
  cleanups.push(server.close)
  const onEvent = vi.fn()
  const onDisconnect = vi.fn()
  const client = await connectDesktopRuntime({ endpoint: server.endpoint, onEvent, onDisconnect })
  cleanups.push(client.close)
  const document = randomUUID()
  const results = await Promise.allSettled([
    client.invoke(document, 'notebook:state', []),
    client.invoke(document, 'files:read', ['oversized']),
    client.invokeHost('large-host'),
    ...Array.from({ length: 4 }, () => client.invoke(document, 'files:read', [])),
    ...['files:search', 'settings:get', 'compute:list', 'sessions:load-one'].map((channel) =>
      client.invoke(document, channel, [])
    )
  ])
  expect(results.map((result) => result.status)).toEqual([
    ...Array(3).fill('rejected'),
    ...Array(8).fill('fulfilled')
  ])
  for (const result of results.slice(0, 3))
    if (result.status === 'rejected') expect(result.reason.message).toContain('response exceeds')
  events.publish('connectors:approval-settled', 'still connected')
  await vi.waitFor(() =>
    expect(onEvent).toHaveBeenCalledWith({
      channel: 'connectors:approval-settled',
      payload: 'still connected'
    })
  )
  await expect(client.invoke(document, 'settings:get', [])).resolves.toEqual({
    channel: 'settings:get'
  })
  expect(onDisconnect).not.toHaveBeenCalled()
})

it('delivers a burst of normalized agent text without dropping the shared desktop connection', async () => {
  const events = new ApplicationEventHub()
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    events,
    commands: { commandNames: () => ['projects:list'], invoke: async () => [] }
  })
  cleanups.push(server.close)
  const delivered: string[] = []
  const client = await connectDesktopRuntime({
    endpoint: server.endpoint,
    onEvent: (event) => {
      if (event.channel === 'acp:event')
        delivered.push(...(event.payload as Array<{ id: string }>).map(({ id }) => id))
    },
    onDisconnect: vi.fn()
  })
  cleanups.push(client.close)
  const coalescer = createAcpRuntimeEventBroadcastCoalescer({
    publish: (batch) => events.publish('acp:event', batch)
  })
  const chunks = Array.from({ length: 130 }, (_, index) =>
    toAcpRuntimeEvent(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'x'.repeat(64 * 1024) }
        }
      },
      `event-${index}`,
      index + 1
    )
  )
  // An already-buffered provider burst enters synchronously before the presentation timer fires.
  for (const chunk of chunks) coalescer.enqueue(chunk)
  coalescer.flush()
  const result = await client.invoke(randomUUID(), 'projects:list', []).then(
    () => 'available',
    (error: Error) => error.message
  )
  expect(result, JSON.stringify(diagnostics.warn.mock.calls)).toBe('available')
  expect(delivered).toEqual(chunks.map(({ id }) => id))
})
