import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { startDesktopRuntimeTransport } from '../desktop-runtime-transport'
import { connectToDesktopEndpoint } from '../desktop-connection'
import { ApplicationEventHub } from '../application-events'
import { parseRpcJson, stringifyRpcJson } from '../rpc-json'
import type { ApplicationInvocation } from '../application-command-router'
import type { NotebookSessionState, NotebookSessionStateRequest } from '../../shared/notebook'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookRunRepository } from './repository'
import { createFrameNotebookLane } from './lane-identity'
import { NotebookSessionReadModel } from './session-read-model'
import type { NotebookContentCursor, NotebookRunRecord } from '../../shared/notebook'

const io = vi.hoisted(() => ({ reads: 0, bytes: 0 }))
vi.mock('@aipoch/durable-files', async (original) => {
  const actual = await original<typeof import('@aipoch/durable-files')>()
  return {
    ...actual,
    readDurableJsonFile: async (...args: Parameters<typeof actual.readDurableJsonFile>) => {
      io.reads++
      io.bytes += await stat(args[0])
        .then((entry) => entry.size)
        .catch(() => 0)
      return actual.readDurableJsonFile(...args)
    }
  }
})
let root = ''
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('bounded durable Notebook reading', () => {
  it('browses all persisted large output, crosses history pages, and measures cold/hot reads', async () => {
    root = await mkdtemp(join(tmpdir(), 'notebook-bounded-'))
    const repository = new NotebookRunRepository(root)
    const request = {
      projectId: 'p',
      sessionId: 's',
      workspaceCwd: root,
      readMode: 'bounded' as const
    }
    const document = await repository.loadOrCreate({
      ...request,
      lane: createFrameNotebookLane('p', 's', 'frame')
    })
    const text = 'x'.repeat(1.5 * 1024 * 1024 - 20) + 'complete-output-end'
    document.runs = Array.from({ length: 125 }, (_, index): NotebookRunRecord => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'user',
      kernelKind: 'python',
      script: 'print(value)',
      status: 'completed',
      startedAt: index,
      endedAt: index + 1,
      text: {
        stdout:
          index === 124
            ? '\0'.repeat(1.5 * 1024 * 1024 - 20) + '中文🧬complete'
            : index >= 122
              ? text
              : 'short',
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [],
      workingFiles: []
    }))
    await writeFile(join(document.notebookSessionRoot, 'run.json'), JSON.stringify(document))
    const reader = new NotebookRunRepository(root)
    const model = new NotebookSessionReadModel({
      storageRoot: root,
      defaultProjectId: 'p',
      repository: reader,
      dependencyAnalyzer: { project: vi.fn() },
      findSession: () => undefined,
      runtimeBindings: () => ({}),
      isRestartRecommended: () => false
    })
    io.reads = 0
    io.bytes = 0
    const startRss = process.memoryUsage().rss
    const coldStart = performance.now()
    const first = await model.importedState(request, [], undefined, undefined, 100, request)
    const cold = { ms: performance.now() - coldStart, ...io, rss: process.memoryUsage().rss }
    const warmStart = performance.now()
    const second = await model.importedState(request, [], undefined, undefined, 100, request)
    const warm = {
      ms: performance.now() - warmStart,
      reads: io.reads - cold.reads,
      bytes: io.bytes - cold.bytes,
      rss: process.memoryUsage().rss
    }
    expect(first.runs).toHaveLength(100)
    expect(first.recentRuns).toEqual([])
    expect(second.readRevision).toBe(first.readRevision)
    const earlier = await model.importedState(
      request,
      [],
      undefined,
      first.historyPage!.oldestCursor,
      100,
      request
    )
    expect(earlier.runs).toHaveLength(25)
    expect(new Set([...first.runs, ...earlier.runs].map((record) => record.runId)).size).toBe(125)
    let largestResponse = 0
    const transport = await startDesktopRuntimeTransport({
      version: 'test',
      events: new ApplicationEventHub(),
      commands: {
        commandNames: () => ['notebook:state'],
        invoke: async (_name: string, invocation: ApplicationInvocation<readonly unknown[]>) => {
          const query = invocation.args[0] as NotebookSessionStateRequest
          return model.importedState(
            query,
            query.contentRead ? [query.contentRead.runId] : [],
            undefined,
            undefined,
            0,
            query
          )
        }
      }
    })
    const socket = await connectToDesktopEndpoint(transport.endpoint)
    const bootstrap = once(socket, 'message')
    socket.send(JSON.stringify({ kind: 'bootstrap' }))
    await bootstrap
    let requestId = 0
    const clientId = randomUUID()
    const readOverSocket = async (
      query: NotebookSessionStateRequest
    ): Promise<NotebookSessionState> => {
      const received = once(socket, 'message')
      socket.send(
        stringifyRpcJson({
          kind: 'invoke',
          protocolVersion: 1,
          id: ++requestId,
          clientId,
          channel: 'notebook:state',
          args: [query]
        })
      )
      const [bytes] = await received
      largestResponse = Math.max(largestResponse, bytes.byteLength)
      const envelope = parseRpcJson(bytes.toString()) as {
        ok: boolean
        result: NotebookSessionState
      }
      expect(envelope.ok).toBe(true)
      return envelope.result
    }
    try {
      for (const record of first.runs.slice(-3)) {
        let cursor: NotebookContentCursor | undefined = { part: 1, offset: 0 }
        let collected = ''
        while (cursor?.part === 1) {
          const boundedRequest = {
            ...request,
            contentRead: { runId: record.runId, revision: record.contentRead!.revision, cursor }
          }
          const result = await readOverSocket(boundedRequest)
          largestResponse = Math.max(
            largestResponse,
            Buffer.byteLength(JSON.stringify({ type: 'response', id: 'test', result }))
          )
          collected += result.contentChunk!.data
          cursor = result.contentChunk!.next
        }
        expect(collected).toBe(document.runs.find((run) => run.runId === record.runId)!.text.stdout)
      }
    } finally {
      socket.close()
      await transport.close()
    }
    expect(largestResponse).toBeLessThan(16 * 1024 * 1024)
    expect(warm.bytes).toBe(0)
    const measurement = {
      cold,
      warm,
      startRss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      largestResponse,
      rendererTextCharacters: 65536,
      rendererImageBase64Characters: 8 * 1024 * 1024
    }
    if (process.env.NOTEBOOK_READ_MEASUREMENTS)
      await writeFile(process.env.NOTEBOOK_READ_MEASUREMENTS, JSON.stringify(measurement, null, 2))
  })
})
