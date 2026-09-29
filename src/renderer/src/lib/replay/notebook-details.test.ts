import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotebookRunRecord, NotebookSessionState } from '../../../../shared/notebook'
import type { ReplayNotebookRunDetails, ReplaySourceIdentity } from '../../../../shared/replay'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { indexReplayRun, estimateReplayBytes, replaySourceKey } from './run-index'
import { readReplayNotebookRun, ReplayNotebookRunCache } from './notebook-details'
import { loadReplayDocument, type ReplayReaderApi } from './source'

const source: ReplaySourceIdentity = {
  projectId: 'project',
  sessionId: 'source',
  title: 'Research',
  fingerprint: 'same-package',
  workspaceCwd: '/workspace'
}

const run = (id: string, extra: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 1,
  endedAt: 2,
  text: { stdout: '1', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: [],
  ...extra
})

const state = (
  runs: NotebookRunRecord[],
  extra: Partial<NotebookSessionState> = {}
): NotebookSessionState => ({
  id: 'notebook',
  sessionId: 'source',
  cwd: '/workspace',
  notebookSessionRoot: '/notebook',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  kernelStatus: 'idle',
  runJsonPath: '/notebook/run.json',
  cells: [],
  runCount: runs.length,
  latestRunEnvironments: {},
  runs,
  recentRuns: runs,
  environments: [],
  ...extra
})

const apiFor = (runs: NotebookRunRecord[]): ReplayReaderApi['notebook'] => ({
  getReference: vi.fn().mockResolvedValue({
    ...source,
    notebookSessionRoot: '/notebook',
    dataRoot: '/data',
    runtimeRoot: '/runtime',
    runJsonPath: '/notebook/run.json'
  }),
  state: vi.fn().mockResolvedValue(state(runs))
})

const ready = (record: NotebookRunRecord): ReplayNotebookRunDetails => ({
  status: 'ready',
  run: record,
  bytes: estimateReplayBytes(record)
})

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('complete compact Notebook index', () => {
  it('processes multiple pages without retaining their large scripts or outputs', async () => {
    const payload = 'x'.repeat(256 * 1024)
    const pageSize = 40
    let page = 0
    const notebook = apiFor([])
    vi.mocked(notebook.state).mockImplementation(async () => {
      const offset = page++ * pageSize
      return state(
        Array.from({ length: pageSize }, (_, index) =>
          run(String(offset + index), {
            script: payload,
            text: { stdout: payload, stderr: '', traceback: '', plain: [] },
            startedAt: 120 - offset - index
          })
        ),
        {
          runCount: 120,
          historyPage:
            page < 3
              ? {
                  hasEarlierRuns: true,
                  oldestCursor: { runId: String(offset + 39), startedAt: 120 - offset - 39 }
                }
              : { hasEarlierRuns: false }
        }
      )
    })
    const session: PersistedChatSession = {
      id: 'source',
      projectId: 'project',
      title: 'Research',
      cwd: '/workspace',
      status: 'idle',
      createdAt: 0,
      updatedAt: 2,
      messages: []
    }
    const api: ReplayReaderApi = {
      sessions: { loadOne: vi.fn().mockResolvedValue(session) },
      notebook,
      artifacts: { getLineage: vi.fn() }
    }
    const document = await loadReplayDocument(api, { projectId: 'project', sessionId: 'source' })
    const indexes = document.branches.flatMap((branch) => branch.steps.flatMap((step) => step.runs))
    expect(indexes).toHaveLength(120)
    expect(notebook.state).toHaveBeenCalledTimes(3)
    expect(indexes.every((index) => index.scriptCharacters === payload.length)).toBe(true)
    expect(
      indexes.every((index) => !('script' in index) && !('outputs' in index) && !('text' in index))
    ).toBe(true)
    expect(estimateReplayBytes(indexes)).toBeLessThan(180 * 1024)
    expect(JSON.stringify(document)).not.toContain(payload)
  })

  it('isolates local identities even for two imports of the same package', () => {
    expect(replaySourceKey(source)).not.toBe(
      replaySourceKey({ ...source, sessionId: 'another-import' })
    )
    expect(replaySourceKey(source)).not.toBe(
      replaySourceKey({ ...source, projectId: 'another-project' })
    )
  })
})

describe('on-demand Notebook detail reads', () => {
  it('uses exact runIds and preserves recorded details only', async () => {
    const original = run('one')
    const api = apiFor([original])
    const detail = await readReplayNotebookRun(api, source, indexReplayRun(original))
    expect(api.state).toHaveBeenCalledWith({
      projectId: 'project',
      sessionId: 'source',
      workspaceCwd: '/workspace',
      runIds: ['one']
    })
    expect(detail.status).toBe('ready')
    if (detail.status === 'ready') expect(detail.run.script).toBe(original.script)
  })

  it('bounds oversized display payloads and explicitly marks omitted output', async () => {
    const original = run('one', {
      script: 'x'.repeat(1024 * 1024),
      text: { stdout: 'y'.repeat(1024 * 1024), stderr: '', traceback: '', plain: [] },
      outputs: [{ type: 'display', data: { 'image/png': 'z'.repeat(1024 * 1024) } }]
    })
    const detail = await readReplayNotebookRun(
      apiFor([original]),
      source,
      indexReplayRun(original),
      { maxBytes: 64 * 1024 }
    )
    expect(detail.status).toBe('ready')
    if (detail.status === 'ready') {
      expect(detail.bytes).toBeLessThanOrEqual(64 * 1024)
      expect(detail.run.truncated).toBe(true)
      expect(original.script.startsWith(detail.run.script)).toBe(true)
      expect(detail.run.outputs).toEqual([])
    }
  })

  it('rejects changed run attribution rather than showing a different execution', async () => {
    const original = run('one', { promptMessageId: 'q' })
    expect(
      await readReplayNotebookRun(
        apiFor([{ ...original, promptMessageId: 'different' }]),
        source,
        indexReplayRun(original)
      )
    ).toEqual({ status: 'unavailable', reason: 'identity-mismatch' })
  })

  it('does not initialize a missing Notebook and rejects late results after cancellation', async () => {
    const api = apiFor([])
    vi.mocked(api.getReference).mockResolvedValue(null)
    expect(await readReplayNotebookRun(api, source, indexReplayRun(run('one')))).toEqual({
      status: 'unavailable',
      reason: 'not-recorded'
    })
    expect(api.state).not.toHaveBeenCalled()
    const second = apiFor([run('one')])
    const waiting = deferred<NotebookSessionState>()
    vi.mocked(second.state).mockReturnValue(waiting.promise)
    const controller = new AbortController()
    const promise = readReplayNotebookRun(second, source, indexReplayRun(run('one')), {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(second.state).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(promise).rejects.toThrow()
    waiting.resolve(state([run('one')]))
  })
})

describe('bounded playback-owned Notebook cache', () => {
  it('evicts least recent details and never exceeds its resident-byte budget', async () => {
    const bytes = estimateReplayBytes(run('a'))
    const reader = vi.fn(
      async (_source: ReplaySourceIdentity, index: ReturnType<typeof indexReplayRun>) =>
        ready(run(index.runId))
    )
    const cache = new ReplayNotebookRunCache(reader, { maxBytes: bytes * 2, maxEntries: 10 })
    for (const id of ['a', 'b', 'c']) {
      await cache.load(source, indexReplayRun(run(id)))
      expect(cache.stats.bytes).toBeLessThanOrEqual(bytes * 2)
    }
    expect(cache.stats.entries).toBe(2)
    await cache.load(source, indexReplayRun(run('a')))
    expect(reader).toHaveBeenCalledTimes(4)
    cache.clear()
    expect(cache.stats.bytes).toBe(0)
  })

  it('does not share a cached run across repeated imports with the same fingerprint', async () => {
    const reader = vi.fn(async (scope: ReplaySourceIdentity) =>
      ready(run('same-run', { script: scope.sessionId }))
    )
    const cache = new ReplayNotebookRunCache(reader)
    const one = await cache.load(source, indexReplayRun(run('same-run')))
    const two = await cache.load(
      { ...source, sessionId: 'second-import' },
      indexReplayRun(run('same-run'))
    )
    expect(reader).toHaveBeenCalledTimes(2)
    expect(one.status === 'ready' && one.run.script).toBe('source')
    expect(two.status === 'ready' && two.run.script).toBe('second-import')
  })

  it('limits concurrent reads and cancels queued work without leaking a slot', async () => {
    const gate = deferred<ReplayNotebookRunDetails>()
    const reader = vi
      .fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(ready(run('next')))
    const cache = new ReplayNotebookRunCache(reader, { concurrency: 1 })
    const first = cache.load(source, indexReplayRun(run('first')))
    const controller = new AbortController()
    const queued = cache.load(source, indexReplayRun(run('cancelled')), {
      signal: controller.signal
    })
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    expect(cache.stats.active).toBe(1)
    controller.abort()
    await expect(queued).rejects.toThrow()
    gate.resolve(ready(run('first')))
    await first
    await cache.load(source, indexReplayRun(run('next')))
    expect(reader).toHaveBeenCalledTimes(2)
    expect(cache.stats.active).toBe(0)
  })

  it('drops stale detail completion after the source generation is cleared', async () => {
    const gate = deferred<ReplayNotebookRunDetails>()
    const reader = vi
      .fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(ready(run('one')))
    const cache = new ReplayNotebookRunCache(reader)
    const old = cache.load(source, indexReplayRun(run('one')))
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
    cache.clear()
    await cache.load(source, indexReplayRun(run('one')))
    gate.resolve(ready(run('one', { script: 'old' })))
    await expect(old).rejects.toThrow()
    const detail = await cache.load(source, indexReplayRun(run('one')))
    expect(detail.status === 'ready' && detail.run.script).toBe('print(1)')
    expect(cache.stats.entries).toBe(1)
  })

  it('settles a hung reader as a stable unavailable result within the deadline', async () => {
    vi.useFakeTimers()
    const cache = new ReplayNotebookRunCache(() => new Promise(() => {}), { timeoutMs: 50 })
    const detail = cache.load(source, indexReplayRun(run('one')))
    await vi.advanceTimersByTimeAsync(50)
    expect(await detail).toEqual({ status: 'unavailable', reason: 'load-failed' })
    expect(cache.stats.active).toBe(0)
  })
})
