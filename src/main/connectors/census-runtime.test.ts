import { EventEmitter } from 'node:events'
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { NotebookSandboxedSpawn } from '../notebook/process-sandbox'
import { terminateProcessTree } from '../process-tree'
import { createCensusHandler } from './census-runtime'

vi.mock('../process-tree', () => ({
  createPosixProcessTreeOwnership: (env: NodeJS.ProcessEnv) => ({ env, token: 'owned' }),
  trackOwnedPosixProcessTree: vi.fn(),
  terminateProcessTree: vi.fn(async () => ({ reaped: true }))
}))
const context = { sessionId: 'session-1', projectId: 'project-1' }
const complete = { processesTerminated: true, networkClosed: true, temporaryResourcesRemoved: true }
type WrappedFixture = NotebookSandboxedSpawn & {
  [K in 'beginExecution' | 'beginSpawn' | 'cleanup']: Mock<NonNullable<NotebookSandboxedSpawn[K]>>
}
type Fixture = {
  child: ChildProcessWithoutNullStreams
  wrapped: WrappedFixture
  wrap: Mock<() => Promise<WrappedFixture>>
  spawnProcess: Mock<() => ChildProcessWithoutNullStreams>
  handler: ReturnType<typeof createCensusHandler>
  start: (signal?: AbortSignal) => Promise<{ result: Promise<unknown> }>
  respond: (response?: unknown) => boolean
}
const fixture = (): Fixture => {
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
  const wrapped = {
    executable: 'python3',
    args: ['bridge'],
    env: {},
    beginExecution: vi.fn(() => vi.fn()),
    beginSpawn: vi.fn(() => ({ started: vi.fn(), notStarted: vi.fn() })),
    annotateStderr: (s: string) => s,
    cleanup: vi.fn(async () => ({ ...complete }))
  } satisfies NotebookSandboxedSpawn
  const wrap = vi.fn(async () => wrapped)
  const spawnProcess = vi.fn(() => child)
  const handler = createCensusHandler({
    action: 'query_cells',
    processSandbox: { wrap },
    spawnProcess: spawnProcess as unknown as typeof spawn
  })
  const start = async (signal?: AbortSignal): Promise<{ result: Promise<unknown> }> => {
    const result = handler({ tissue: 'liver' }, context, signal)
    // Attach immediately so cancellation tests cannot produce unhandled rejections.
    void result.catch(() => {})
    await Promise.resolve()
    return { result }
  }
  const respond = (response: unknown = { id: 1, ok: true, result: { cells: [] } }): boolean =>
    child.stdout.emit('data', JSON.stringify(response) + '\n')
  return { child, wrapped, wrap, spawnProcess, handler, start, respond }
}
beforeEach(() => {
  vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Census Python runtime lifecycle', () => {
  it('fails closed without sandbox or session scope', async () => {
    await expect(createCensusHandler()({}, context)).rejects.toThrow('network sandbox')
    const f = fixture()
    await expect(f.handler({})).rejects.toThrow('Session and Project')
    expect(f.wrap).not.toHaveBeenCalled()
  })
  it('grants only Census hosts and dispatches one action through the sandbox', async () => {
    const f = fixture()
    const { result } = await f.start()
    f.respond()
    await expect(result).resolves.toEqual({ cells: [] })
    expect(f.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        ...context,
        runtime: 'python',
        signal: expect.any(AbortSignal),
        allowedNetworkHosts: [
          'census.cellxgene.cziscience.com',
          'cellxgene-census-public-us-west-2.s3.amazonaws.com',
          'cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com'
        ]
      })
    )
    expect(JSON.parse(vi.mocked(f.child.stdin.write).mock.calls[0][0] as string)).toMatchObject({
      action: 'query_cells',
      tissue: 'liver'
    })
    expect(f.wrapped.cleanup).toHaveBeenCalledWith(
      'exit',
      expect.objectContaining({ processesTerminated: true })
    )
  })
  it('does not report success before process termination completes', async () => {
    let release!: (v: { reaped: boolean }) => void
    vi.mocked(terminateProcessTree).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const f = fixture()
    const { result } = await f.start()
    f.respond()
    const settled = vi.fn()
    void result.then(settled)
    await Promise.resolve()
    expect(f.wrapped.cleanup).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    release({ reaped: true })
    await result
    expect(settled).toHaveBeenCalledTimes(1)
  })
  it.each(['processesTerminated', 'networkClosed', 'temporaryResourcesRemoved'] as const)(
    'rejects incomplete cleanup: %s',
    async (field) => {
      const f = fixture()
      f.wrapped.cleanup.mockResolvedValue({ ...complete, [field]: false })
      const { result } = await f.start()
      f.respond()
      await expect(result).rejects.toThrow(/cleanup.*incomplete/i)
    }
  )
  it('passes unconfirmed termination to cleanup and rejects the result', async () => {
    vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: false })
    const f = fixture()
    const { result } = await f.start()
    f.respond()
    await expect(result).rejects.toThrow(/termination|cleanup/i)
    expect(f.wrapped.cleanup).toHaveBeenCalledWith(
      'exit',
      expect.objectContaining({ processesTerminated: false })
    )
  })
  it('preserves the primary error when cleanup throws', async () => {
    const f = fixture()
    f.wrapped.cleanup.mockRejectedValue(new Error('cleanup failed'))
    const { result } = await f.start()
    f.respond({ id: 1, ok: false, error: 'upstream failed' })
    await expect(result).rejects.toThrow('upstream failed (sandbox cleanup failed: cleanup failed)')
  })
  it('requires the native supervisor receipt even when the launcher was reaped', async () => {
    const f = fixture()
    const confirm = vi.fn(async () => false)
    Object.assign(f.wrapped, { confirmProcessTreeTermination: confirm })
    const { result } = await f.start()
    f.respond()
    await expect(result).rejects.toThrow(/cleanup.*incomplete/i)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('exit', {
      processesTerminated: false,
      confirmTermination: confirm
    })
  })
  it('still asks the sandbox to clean up when process termination throws', async () => {
    vi.mocked(terminateProcessTree).mockRejectedValue(new Error('termination failed'))
    const f = fixture()
    const { result } = await f.start()
    f.respond()
    await expect(result).rejects.toThrow('termination failed')
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('exit', { processesTerminated: false })
  })
  it('cancels an active child and ignores late responses', async () => {
    const f = fixture()
    const controller = new AbortController()
    const { result } = await f.start(controller.signal)
    controller.abort(new Error('user stop'))
    f.respond()
    await expect(result).rejects.toThrow('user stop')
    expect(f.wrapped.cleanup).toHaveBeenCalledTimes(1)
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('cancel', expect.anything())
  })
  it('times out a silent child at 180 seconds', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { result } = await f.start()
    await vi.advanceTimersByTimeAsync(180_000)
    await expect(result).rejects.toThrow('timed out')
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('timeout', expect.anything())
    expect(vi.getTimerCount()).toBe(0)
  })
  it('passes the deadline to sandbox preparation and never launches after it expires', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let release!: () => void
    f.wrap.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(f.wrapped)
        })
    )
    const { result } = await f.start()
    await vi.advanceTimersByTimeAsync(180_000)
    release()
    await expect(result).rejects.toThrow('timed out')
    expect(f.spawnProcess).not.toHaveBeenCalled()
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('timeout', expect.anything())
  })
  it.each(['beginExecution', 'beginSpawn'] as const)(
    'cleans prepared resources if %s fails',
    async (hook) => {
      vi.useFakeTimers()
      const f = fixture()
      f.wrapped[hook].mockImplementation(() => {
        throw new Error('admission failed')
      })
      const { result } = await f.start()
      await expect(result).rejects.toThrow('admission failed')
      expect(f.wrapped.cleanup).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('does not spawn if beginSpawn cancels synchronously', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.wrapped.beginSpawn.mockImplementation(() => {
      controller.abort(new Error('launch cancelled'))
      return { started: vi.fn(), notStarted: vi.fn() }
    })
    const { result } = await f.start(controller.signal)
    await expect(result).rejects.toThrow('launch cancelled')
    expect(f.spawnProcess).not.toHaveBeenCalled()
  })
  it('clears the deadline when wrap rejects', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.wrap.mockRejectedValue(new Error('sandbox unavailable'))
    const { result } = await f.start()
    await expect(result).rejects.toThrow('sandbox unavailable')
    expect(f.spawnProcess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['spawn', 'stdin'] as const)('cleans up after %s failure', async (failure) => {
    const f = fixture()
    if (failure === 'spawn')
      f.spawnProcess.mockImplementation(() => {
        throw new Error('spawn failure')
      })
    const { result } = await f.start()
    if (failure === 'stdin') f.child.stdin.emit('error', new Error('stdin failure'))
    await expect(result).rejects.toThrow(`${failure} failure`)
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('spawn-failed', expect.anything())
  })
  it('rejects oversized stdout and cleans up', async () => {
    const f = fixture()
    const { result } = await f.start()
    f.child.stdout.emit('data', 'x'.repeat(8 * 1024 * 1024 + 1))
    await expect(result).rejects.toThrow('8 MiB')
    expect(f.wrapped.cleanup).toHaveBeenCalledTimes(1)
  })
  it('ignores protocol noise and unrelated response ids', async () => {
    const f = fixture()
    const { result } = await f.start()
    f.child.stdout.emit('data', 'warning\nnull\n{"id":2,"ok":true}\n')
    f.respond()
    await expect(result).resolves.toEqual({ cells: [] })
  })
  it('accepts a response whose final stdout chunk arrives after exit', async () => {
    const f = fixture()
    const { result } = await f.start()
    f.child.stdout.emit('data', '{"id":1,"ok":true,')
    f.child.emit('exit', 0, null)
    expect(f.wrapped.cleanup).not.toHaveBeenCalled()
    f.child.stdout.emit('data', '"result":{"cells":[]}}\n')
    f.child.emit('close', 0, null)
    await expect(result).resolves.toEqual({ cells: [] })
    expect(f.wrapped.cleanup).toHaveBeenCalledTimes(1)
  })
  it('keeps the deadline active when an exited child has not closed its pipes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { result } = await f.start()
    f.child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(180_000)
    await expect(result).rejects.toThrow('timed out')
    expect(f.wrapped.cleanup).toHaveBeenCalledWith('timeout', expect.anything())
    f.child.emit('close', 0, null)
    expect(f.wrapped.cleanup).toHaveBeenCalledTimes(1)
  })
  it('reports an early runtime exit only after collecting the final stderr', async () => {
    const f = fixture()
    const { result } = await f.start()
    f.child.emit('exit', 1, null)
    expect(f.wrapped.cleanup).not.toHaveBeenCalled()
    f.child.stderr.emit('data', 'interpreter import failed')
    f.child.emit('close', 1, null)
    await expect(result).rejects.toThrow('interpreter import failed')
    await expect(result).rejects.not.toThrow('Install the supported')
    expect(f.wrapped.cleanup).toHaveBeenCalledTimes(1)
  })
  it.each(['stderr', 'response', 'cleanup', 'spawn'] as const)(
    'redacts encoded and decoded proxy credentials from %s failures',
    async (failure) => {
      const f = fixture()
      const proxy = 'http://census-review-user:review%40secret@localhost:4567'
      f.wrapped.env.HTTPS_PROXY = proxy
      const diagnostic = `${proxy} user=census-review-user password=review@secret encoded=review%40secret`
      if (failure === 'cleanup') f.wrapped.cleanup.mockRejectedValue(new Error(diagnostic))
      if (failure === 'spawn')
        f.spawnProcess.mockImplementation(() => {
          throw new Error(diagnostic)
        })
      const { result } = await f.start()
      if (failure === 'stderr') {
        f.child.stderr.emit('data', diagnostic)
        f.child.emit('close', 1, null)
      } else if (failure === 'response') {
        f.respond({ id: 1, ok: false, error: diagnostic })
      } else if (failure === 'cleanup') {
        f.respond()
      }
      const error = await result.catch((error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      for (const secret of [proxy, 'census-review-user', 'review%40secret', 'review@secret']) {
        expect(message).not.toContain(secret)
      }
      expect(message).toContain('[redacted]')
    }
  )
  it('redacts stderr before truncating the returned diagnostic', async () => {
    const f = fixture()
    f.wrapped.env.HTTPS_PROXY = 'http://review-user:review-secret@localhost:4567'
    const { result } = await f.start()
    f.child.stderr.emit('data', `${'x'.repeat(3995)}review-secret`)
    f.child.emit('close', 1, null)
    const error = await result.catch((error: Error) => error)
    expect((error as Error).message).not.toContain('revie')
    expect((error as Error).message).toContain('[reda')
  })
  it('handles split protocol lines and reports runtime failure diagnostics', async () => {
    const f = fixture()
    const { result } = await f.start()
    f.child.stdout.emit('data', '{"id":1,"ok":false,')
    f.child.stdout.emit('data', '"error":"CENSUS_RUNTIME_UNAVAILABLE"}\n')
    await expect(result).rejects.toThrow('CENSUS_RUNTIME_UNAVAILABLE')
  })
})
