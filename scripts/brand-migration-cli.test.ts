import { afterEach, expect, it, vi } from 'vitest'

// Only the native UI lifetime and migration failure are substituted. Exercise the CLI timer and
// error lifecycle directly without opening a real profile or touching an operator's journal.
const boundary = vi.hoisted(() => ({
  fail: vi.fn(),
  migrate: vi.fn(),
  update: vi.fn()
}))
vi.mock('../resources/brand-migration/transaction.mjs', () => ({ runMigration: boundary.migrate }))
vi.mock('../resources/brand-migration/paths.mjs', () => ({ readJson: async () => ({}) }))
vi.mock('../resources/brand-migration/startup-progress.mjs', () => ({
  openProgressWindow: async () => ({ pids: [], fail: boundary.fail, update: boundary.update })
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it('stops verification heartbeats while the failed progress window waits to close', async () => {
  vi.useFakeTimers()
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  let close!: () => void
  boundary.fail.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        close = resolve
      })
  )
  boundary.migrate.mockImplementation(async (_options, deps) => {
    deps.onProgress({ phase: 'verifying', completed: 5, total: 5 })
    throw new Error('integrity changed')
  })
  const { main } = await import('../resources/brand-migration/cli.mjs')
  const task = main([
    '--home',
    '/fixture',
    '--app-data',
    '/fixture/appData',
    '--mode',
    'dev',
    '--execute',
    '--startup-owner',
    String(process.ppid),
    '--show-progress-window'
  ])
  const failure = expect(task).rejects.toThrow('integrity changed')
  await vi.waitFor(() => expect(close).toBeTypeOf('function'))
  await vi.advanceTimersByTimeAsync(20000)
  const output = stderr.mock.calls.map((call) => String(call[0])).join('')
  close()
  await failure
  expect(output).toContain('Brand migration stopped: integrity changed')
  expect(output).not.toContain('"heartbeat":true')
})
