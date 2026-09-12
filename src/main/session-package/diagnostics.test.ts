import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLogger, createLogger, flushLogs } from '../logger'
import { SessionPackageOperation } from './operation'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'package-diagnostics-'))
  initLogger({ logDir: root, mirrorToConsole: false })
  createLogger('probe').info('sink enabled')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await flushLogs()
  await rm(root, { recursive: true, force: true })
})
const records = async (): Promise<{ msg: string; data: Record<string, unknown> }[]> => {
  await flushLogs()
  return (await readFile(join(root, 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.scope === 'session-package')
}

describe('Session package device diagnostics', () => {
  it('records queue count and overflow transitions without logging duplicate requests or filenames', async () => {
    const owner = new SessionPackageOperation()
    const files = [{ id: 'private-request', filename: 'private-study.science' }]
    owner.setPendingImports(files)
    expect(owner.snapshot).toBeNull()
    for (let i = 0; i < 1000; i++) {
      owner.setPendingImports(files)
      owner.present()
    }
    owner.setPendingImports(files, true)
    owner.setPendingImports(files, true)
    owner.setPendingImports(files, false)
    owner.setPendingImports([])
    const log = await records()
    expect(log.map((record) => record.data)).toEqual([
      { pendingCount: 1, previousPendingCount: 0, full: false },
      { pendingCount: 1, previousPendingCount: 1, full: true },
      { pendingCount: 1, previousPendingCount: 1, full: false },
      { pendingCount: 0, previousPendingCount: 1, full: false }
    ])
    expect(log.every((record) => record.msg === 'Package import queue changed')).toBe(true)
    expect(JSON.stringify(log)).not.toContain('private-')
  })

  it('records a failed import phase without logging research content', async () => {
    const owner = new SessionPackageOperation()
    const secret = '/Users/private-study/patient.csv?token=secret-canary'
    const failure = Object.assign(new Error(secret), { code: 'EACCES' })
    await expect(
      owner.run('import', undefined, async () => {
        owner.report({
          phase: 'copying',
          completedBytes: 128,
          totalBytes: 256,
          currentFile: secret
        })
        throw failure
      })
    ).rejects.toBe(failure)
    expect(owner.snapshot?.state).toBe('failed')
    const log = await records()
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            operation: 'session-package.import',
            outcome: 'started',
            operationId: owner.snapshot!.id
          })
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            phase: 'copying',
            outcome: 'failed',
            completedBytes: 128,
            totalBytes: 256,
            errorCategory: 'permission',
            durationMs: expect.any(Number)
          })
        })
      ])
    )
    expect(JSON.stringify(log)).not.toContain('private-study')
    expect(JSON.stringify(log)).not.toContain('secret-canary')
    expect(log.filter((record) => record.data?.outcome === 'failed')).toHaveLength(1)
  })
  it('keeps latest phase counters without logging every progress update or presentation', async () => {
    const owner = new SessionPackageOperation()
    await expect(
      owner.run(
        'export',
        { projectId: 'private-project', sessionId: 'private-session' },
        async () => {
          for (let completedBytes = 0; completedBytes <= 1000; completedBytes++) {
            owner.report({
              phase: 'copying',
              completedBytes,
              totalBytes: 1000,
              completedFiles: 1,
              totalFiles: 1,
              currentFile: 'private-filename'
            })
            owner.present()
          }
          owner.report({ phase: 'saving', completedBytes: 0, totalBytes: 500 })
          owner.report({ phase: 'saving', completedBytes: 500, totalBytes: 500 })
          return 'published'
        }
      )
    ).resolves.toBe('published')
    const log = await records()
    expect(log).toHaveLength(5)
    expect(
      log.find((record) => record.data?.phase === 'saving' && record.msg === 'operation phase')
        ?.data
    ).toMatchObject({
      previousPhase: 'copying',
      previousCompletedBytes: 1000,
      previousCompletedFiles: 1,
      completedBytes: 0
    })
    expect(log.at(-1)?.data).toMatchObject({
      outcome: 'completed',
      phase: 'saving',
      completedBytes: 500,
      cleanupPending: false
    })
    expect(JSON.stringify(log)).not.toContain('private-')
  })

  it('records user selection and cancellation without changing the rejected operation', async () => {
    const owner = new SessionPackageOperation()
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const run = owner.run('import', undefined, () =>
      owner.waitForImport({ filename: 'private-study.science' })
    )
    const rejection = expect(run).rejects.toThrow('Package operation cancelled.')
    now = 1000
    owner.cancel()
    await rejection
    const log = await records()
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ phase: 'selecting', state: 'awaiting-selection' })
        }),
        expect.objectContaining({
          data: expect.objectContaining({ outcome: 'cancelled', durationMs: 1000 })
        })
      ])
    )
    expect(log.filter((record) => record.data?.outcome === 'failed')).toHaveLength(0)
    expect(owner.snapshot?.state).toBe('cancelled')
    expect(JSON.stringify(log)).not.toContain('private-study')
  })

  it('keeps cleanup retry outcomes separate from a completed export', async () => {
    const owner = new SessionPackageOperation()
    await owner.run('export', undefined, async () => {
      owner.setCleanupPending(true)
    })
    const failure = Object.assign(new Error('private-path'), { code: 'EPERM' })
    await expect(
      owner.retryCleanup(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(owner.snapshot).toMatchObject({ state: 'succeeded', cleanupPending: true })
    await owner.retryCleanup(async () => undefined)
    expect(owner.snapshot).toMatchObject({ state: 'succeeded', cleanupPending: false })
    const log = await records()
    const terminal = log
      .filter((record) =>
        ['completed', 'failed', 'cancelled'].includes(String(record.data?.outcome))
      )
      .map((record) => record.data)
    expect(terminal).toEqual([
      expect.objectContaining({
        operation: 'session-package.export',
        outcome: 'completed',
        cleanupPending: true
      }),
      expect.objectContaining({
        operation: 'session-package.cleanup',
        outcome: 'failed',
        transferOutcome: 'succeeded',
        cleanupPending: true,
        errorCategory: 'permission'
      }),
      expect.objectContaining({
        operation: 'session-package.cleanup',
        outcome: 'completed',
        transferOutcome: 'succeeded',
        cleanupPending: false
      })
    ])
    expect(new Set(terminal.map((record) => record.operationId))).toEqual(
      new Set([owner.snapshot!.id])
    )
    expect(JSON.stringify(log)).not.toContain('private-path')
  })

  it('does not change outcomes when the diagnostic sink throws', async () => {
    initLogger({ logDir: root, mirrorToConsole: true })
    for (const method of ['info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation(() => {
        throw new Error('sink unavailable')
      })
    }
    const changed = vi.fn()
    const owner = new SessionPackageOperation(changed)
    await expect(owner.run('export', undefined, async () => 'saved')).resolves.toBe('saved')
    const failure = new Error('validation failure')
    await expect(
      owner.run('import', undefined, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(owner.snapshot?.state).toBe('failed')
    expect(owner.active).toBe(false)
    const files = [{ id: 'request', filename: 'research.science' }]
    changed.mockClear()
    owner.setPendingImports(files, true)
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed', pendingImports: files, importQueueFull: true })
    )
    changed.mockClear()
    const replacement = [{ id: 'next', filename: 'next.science' }]
    owner.setPendingImports(replacement, true)
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ pendingImports: replacement, importQueueFull: true })
    )
  })
})
