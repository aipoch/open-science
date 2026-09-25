import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  SessionDiagnosticWorkerInput,
  SessionDiagnosticWorkerResult
} from '../../shared/session-diagnostics'
import { createSessionDiagnosticsDesktop } from './desktop'
import * as fsPromises from 'node:fs/promises'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>())
}))

let root: string
const request = { projectId: 'project-1', sessionId: 'session-1', operationId: 'operation-1' }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'diagnostic-desktop-test-'))
  await Promise.all(
    ['data', 'config', 'logs', 'output', 'temp'].map((name) => mkdir(join(root, name)))
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { force: true, recursive: true })
})

type TestWorker = EventEmitter & { terminate: Mock<() => Promise<number>> }
function setup(
  options: {
    target?: string
    response?: SessionDiagnosticWorkerResult
    hang?: boolean
    timeoutMs?: number
    noArchive?: boolean
    beforeResult?: () => Promise<void>
  } = {}
): {
  owner: ReturnType<typeof createSessionDiagnosticsDesktop>
  createWorker: Mock<(options: WorkerOptions) => Worker>
  chooseDestination: Mock<(defaultName: string) => Promise<string | undefined>>
  workers: TestWorker[]
  inputs: SessionDiagnosticWorkerInput[]
  target: string
} {
  const workers: TestWorker[] = []
  const inputs: SessionDiagnosticWorkerInput[] = []
  const target = options.target ?? join(root, 'output', 'result.tar.gz')
  const chooseDestination = vi.fn<(defaultName: string) => Promise<string | undefined>>(
    async () => target
  )
  const createWorker = vi.fn((workerOptions: WorkerOptions) => {
    const input = workerOptions.workerData as SessionDiagnosticWorkerInput
    inputs.push(input)
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) })
    workers.push(worker)
    if (!options.hang) {
      void (async () => {
        try {
          if (input.action === 'export' && !options.noArchive)
            await writeFile(join(input.directory!, 'archive.tar.gz'), 'completed archive')
          await options.beforeResult?.()
          worker.emit(
            'message',
            options.response ??
              (input.action === 'inspect'
                ? { kind: 'inspection', inspection: { items: [] } }
                : { kind: 'archive', partial: false, report: 'collection finished' })
          )
        } catch (error) {
          worker.emit('error', error)
        }
      })()
    }
    return worker as unknown as Worker
  })
  const owner = createSessionDiagnosticsDesktop({
    createWorker,
    chooseDestination,
    temporaryRoot: join(root, 'temp'),
    timeoutMs: options.timeoutMs ?? 1000,
    resolveSources: () => ({
      dataRoot: join(root, 'data'),
      configRoot: join(root, 'config'),
      logPath: join(root, 'logs', 'main.log'),
      appVersion: '1.0'
    })
  })
  return { owner, createWorker, chooseDestination, workers, inputs, target }
}

describe('isolated diagnostic desktop lifecycle', () => {
  it('survives StrictMode setup-cleanup-setup before the first worker starts', async () => {
    const { owner, inputs } = setup()
    const first = owner.inspect(request)
    const cleanup = owner.cancel({ operationId: request.operationId })
    const remount = owner.inspect({ ...request, operationId: 'strict-remount' })
    await cleanup
    await first
    expect(await remount).toEqual({ items: [] })
    expect(inputs).toHaveLength(1)
    expect(inputs[0].directory).toBeUndefined()
    expect(await readdir(join(root, 'temp'))).toEqual([])
  })

  it('does not launch a replacement cancelled while waiting for earlier cleanup', async () => {
    const { owner, workers } = setup({ hang: true })
    const first = owner.inspect(request)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    let release!: () => void
    workers[0].terminate.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(0)
        })
    )
    const cleanup = owner.cancel({ operationId: request.operationId })
    const replacement = owner.inspect({ ...request, operationId: 'replacement' })
    await owner.cancel({ operationId: 'replacement' })
    await vi.waitFor(() => expect(workers[0].terminate).toHaveBeenCalledOnce())
    release()
    await Promise.all([first, cleanup, replacement])
    expect(workers).toHaveLength(1)
    expect(await readdir(join(root, 'temp'))).toEqual([])
  })
  it('admits an immediate remount only after cancelled worker cleanup finishes', async () => {
    const { owner, workers, inputs } = setup({ hang: true })
    const first = owner.inspect(request)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    let release!: () => void
    workers[0].terminate.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(0)
        })
    )
    const cancelled = owner.cancel({ operationId: request.operationId })
    const second = owner.inspect({ ...request, operationId: 'remount' })
    await vi.waitFor(() => expect(workers[0].terminate).toHaveBeenCalledOnce())
    expect(inputs).toHaveLength(1)
    release()
    await cancelled
    await first
    await vi.waitFor(() => expect(inputs).toHaveLength(2))
    await owner.cancel({ operationId: 'remount' })
    expect(await second).toEqual({ items: [], error: undefined })
    expect(await readdir(join(root, 'temp'))).toEqual([])
  })

  it('still rejects a competing request while a live operation is running', async () => {
    const { owner, workers } = setup({ hang: true })
    const first = owner.inspect(request)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    expect((await owner.inspect({ ...request, operationId: 'other' })).error).toContain(
      'in progress'
    )
    await owner.cancel({ operationId: request.operationId })
    await first
  })
  it('publishes a completed archive without changing sources and cleans both staging directories', async () => {
    const source = join(root, 'data', 'evidence.json')
    await writeFile(source, 'original evidence')
    const { owner, target, chooseDestination, workers, inputs } = setup()
    expect(await owner.export({ ...request, selectedItems: ['session'] })).toEqual({
      status: 'exported',
      path: target
    })
    expect(await readFile(target, 'utf8')).toBe('completed archive')
    expect(await readFile(source, 'utf8')).toBe('original evidence')
    expect(await readdir(join(root, 'data'))).toEqual(['evidence.json'])
    expect(await readdir(join(root, 'config'))).toEqual([])
    expect(await readdir(join(root, 'logs'))).toEqual([])
    expect(await readdir(join(root, 'temp'))).toEqual([])
    expect(await readdir(join(root, 'output'))).toEqual(['result.tar.gz'])
    expect(chooseDestination.mock.calls[0]?.[0]).toMatch(
      /^project-1-session-1-\d{8}T\d{9}Z\.tar\.gz$/
    )
    expect(inputs[0].selectedItems).toEqual(['session'])
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })

  it('adds the archive suffix when a renamed export omits it', async () => {
    const target = join(root, 'output', 'renamed-diagnostics')
    const { owner } = setup({ target })

    const result = await owner.export({ ...request, selectedItems: ['session'] })

    expect(result).toEqual({ status: 'exported', path: `${target}.tar.gz` })
    expect(await readFile(`${target}.tar.gz`, 'utf8')).toBe('completed archive')
    await expect(readFile(target)).rejects.toThrow()
  })

  it('continues to reject a renamed export with a different extension', async () => {
    const { owner } = setup({ target: join(root, 'output', 'renamed.zip') })

    const result = await owner.export({ ...request, selectedItems: ['session'] })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Choose a new .tar.gz file.')
  })

  it('refuses destinations inside source roots including symlink aliases', async () => {
    await symlink(join(root, 'data'), join(root, 'alias'), 'dir')
    const { owner, createWorker } = setup({ target: join(root, 'alias', 'result.tar.gz') })
    const result = await owner.export({ ...request, selectedItems: [] })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('outside application data')
    expect(createWorker).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'data'))).toEqual([])
  })

  it('never replaces an existing file even when it appears during collection', async () => {
    const target = join(root, 'output', 'result.tar.gz')
    const { owner } = setup({ beforeResult: () => writeFile(target, 'user file') })
    expect((await owner.export({ ...request, selectedItems: [] })).status).toBe('failed')
    expect(await readFile(target, 'utf8')).toBe('user file')
    expect(await readdir(join(root, 'output'))).toEqual(['result.tar.gz'])
  })

  it('terminates a cancelled worker, cleans its export staging, and permits another task', async () => {
    const { owner, inputs, workers } = setup({ hang: true })
    const pending = owner.export({ ...request, selectedItems: ['database'] })
    await vi.waitFor(() => expect(inputs).toHaveLength(1))
    await writeFile(join(inputs[0].directory!, 'export.log'), 'sanitized staging log')
    await owner.cancel({ operationId: request.operationId })
    expect((await pending).status).toBe('cancelled')
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(await readdir(join(root, 'temp'))).toEqual([])
    expect(await readdir(join(root, 'output'))).toEqual([])
    const next = owner.inspect({ ...request, operationId: 'next' })
    await vi.waitFor(() => expect(inputs).toHaveLength(2))
    await owner.cancel({ operationId: 'next' })
    expect((await next).items).toEqual([])
  })

  it('terminates an inspection timeout and returns a local error without touching business files', async () => {
    const { owner, workers } = setup({ hang: true, timeoutMs: 10 })
    const result = await owner.inspect(request)
    expect(result).toEqual({ items: [], error: 'Diagnostic operation timed out.' })
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(await readdir(join(root, 'temp'))).toEqual([])
    expect(await readdir(join(root, 'config'))).toEqual([])
  })

  it('keeps the collector report but excludes private worker error details', async () => {
    const { owner, target } = setup({
      response: {
        kind: 'error',
        ...{ error: 'password=do-not-leak' },
        report: 'collection failed: source unavailable'
      }
    })
    const result = await owner.export({ ...request, selectedItems: [] })
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('do-not-leak')
    expect(await readFile(result.reportPath!, 'utf8')).not.toContain('do-not-leak')
    await expect(readFile(target)).rejects.toThrow()
    const remaining = await readdir(join(root, 'temp'))
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatch(/^open-science-diagnostic-report-/)
  })

  it('publication failure leaves no output and preserves the independent export report', async () => {
    const { owner } = setup({ noArchive: true })
    const result = await owner.export({ ...request, selectedItems: [] })
    expect(result.status).toBe('failed')
    expect(result.report).toContain('collection finished')
    expect(await readdir(join(root, 'output'))).toEqual([])
  })

  it.each(['exported', 'cancelled'] as const)(
    'reports cleanup failure after %s without copying private error text',
    async (status) => {
      const original = fsPromises.rm
      vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
        if (basename(String(path)).startsWith('open-science-diagnostics-'))
          throw Object.assign(new Error('private path and secret credential'), { code: 'EACCES' })
        return original(path, options)
      })
      const { owner, inputs } = setup({ hang: status === 'cancelled' })
      const pending = owner.export({ ...request, selectedItems: ['session'] })
      if (status === 'cancelled') {
        await vi.waitFor(() => expect(inputs).toHaveLength(1))
        await owner.cancel({ operationId: request.operationId })
      }
      const result = await pending
      expect(result.status).toBe(status === 'exported' ? 'partial' : 'cancelled')
      expect(result.report).toContain('collection staging cleanup failed')
      expect(result.report).toContain('EACCES')
      expect(result.report).not.toContain('secret credential')
      expect(await readFile(result.reportPath!, 'utf8')).toBe(result.report)
    }
  )

  it('keeps a copyable report and removes its empty directory when report writing fails', async () => {
    const original = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes('open-science-diagnostic-report-'))
        throw Object.assign(new Error('private destination'), { code: 'ENOSPC' })
      return original(...args)
    })
    const { owner } = setup({ noArchive: true })
    const result = await owner.export({ ...request, selectedItems: [] })
    expect(result.status).toBe('failed')
    expect(result.report).toContain('publication failed')
    expect(result.reportPath).toBeUndefined()
    expect(await readdir(join(root, 'temp'))).toEqual([])
    expect(await readdir(join(root, 'output'))).toEqual([])
  })

  it('close terminates active work without invoking a save or restore path', async () => {
    const { owner, workers } = setup({ hang: true })
    const pending = owner.inspect(request)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    await owner.close()
    await pending
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect((await owner.inspect(request)).error).toContain('unavailable')
  })

  it('shutdown does not wait for an unanswered native save dialog', async () => {
    const { owner, chooseDestination, createWorker } = setup()
    let choose!: (path: string) => void
    chooseDestination.mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve
        })
    )
    const pending = owner.export({ ...request, selectedItems: [] })
    await vi.waitFor(() => expect(chooseDestination).toHaveBeenCalledOnce())
    await owner.close()
    expect((await pending).status).toBe('cancelled')
    choose(join(root, 'output', 'late.tar.gz'))
    expect(createWorker).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'output'))).toEqual([])
    expect(await readdir(join(root, 'temp'))).toEqual([])
  })
})
