import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskSubmissions, taskContinuationRequestId } from './task-submissions'
import { TaskRunnerError } from './task-runner-error'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import type { TaskRun } from '../../shared/task-api'

vi.mock('@aipoch/durable-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/durable-files')>()
  return { ...actual, writeDurableJsonFile: vi.fn(actual.writeDurableJsonFile) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(writeDurableJsonFile).mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'task-submissions-'))
  roots.push(path)
  return path
}
const request = { project: 'project', prompt: 'Research' }
const run: TaskRun = {
  requestId: 'request-1',
  id: 'run-1',
  sessionId: 'session',
  projectId: 'project',
  cwd: tmpdir(),
  status: 'running',
  startedAt: 1,
  artifacts: [],
  preferredComputeHostIds: []
}

it('records one canonical app continuation before permitting dispatch, including after restart', async () => {
  const path = await root()
  const scope = {
    kind: 'plan',
    projectId: 'project',
    sessionId: 'session',
    attemptId: 'decision-1'
  } as const
  const startRun = vi.fn()
  const createRun = vi.fn(async (requestId: string) => {
    expect(await readFile(join(path, 'task-submissions.json'), 'utf8')).toContain(
      '"status":"pending"'
    )
    return { ...run, requestId, id: 'continued-run' }
  })
  const owner = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  const admitted = await owner.admitContinuation(scope, createRun)
  expect(admitted).toMatchObject({
    admitted: true,
    receipt: { status: 'accepted', runId: 'continued-run' }
  })
  await owner.dispose()

  const restarted = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  expect(await restarted.get(admitted.receipt.requestId)).toEqual(admitted.receipt)
  expect(await restarted.admitContinuation(scope, createRun)).toEqual({
    admitted: false,
    receipt: admitted.receipt
  })
  expect(createRun).toHaveBeenCalledOnce()
  expect(startRun).not.toHaveBeenCalled()
})

it.each([true, false])(
  'does not repeat continuation admission after a Run write error (known rejection: %s)',
  async (knownRejection) => {
    const path = await root()
    const scope = {
      kind: 'delegation_settlement',
      projectId: 'project',
      sessionId: 'session',
      attemptId: 'wake-1'
    } as const
    const requestId = taskContinuationRequestId(scope)
    const createRun = vi.fn(async () => {
      if (knownRejection) throw new TaskRunnerError('session_busy', 'Another Run owns the Session.')
      throw new Error('Run journal flush failed after the write.')
    })
    const startRun = vi.fn()
    const loadRuns = async (): Promise<TaskRun[]> => (knownRejection ? [] : [{ ...run, requestId }])
    const owner = new TaskSubmissions(path, { loadRuns, startRun })
    await expect(owner.admitContinuation(scope, createRun)).rejects.toThrow()
    const original = await owner.get(requestId)
    expect(original).toMatchObject(
      knownRejection ? { status: 'failed', error: { code: 'session_busy' } } : { status: 'pending' }
    )
    expect(original.runId).toBeUndefined()
    await expect(owner.admitContinuation(scope, createRun)).resolves.toEqual({
      admitted: false,
      receipt: original
    })
    await owner.dispose()

    const restarted = new TaskSubmissions(path, { loadRuns, startRun })
    await expect(restarted.admitContinuation(scope, createRun)).resolves.toEqual({
      admitted: false,
      receipt: knownRejection ? original : { ...original, status: 'accepted', runId: run.id }
    })
    expect(createRun).toHaveBeenCalledOnce()
    expect(startRun).not.toHaveBeenCalled()
  }
)

it('persists admission before slow preparation and deduplicates across retry and restart', async () => {
  const path = await root()
  let finish!: (run: TaskRun) => void
  const startRun = vi.fn(async () => {
    expect(
      JSON.parse(await readFile(join(path, 'task-submissions.json'), 'utf8')).submissions[0].status
    ).toBe('pending')
    return new Promise<TaskRun>((resolve) => {
      finish = resolve
    })
  })
  const owner = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  expect(await owner.submit('request-1', request)).toMatchObject({ status: 'pending' })
  expect(await owner.submit('request-1', { prompt: 'Research', project: 'project' })).toMatchObject(
    { status: 'pending' }
  )
  await expect(
    owner.submit('request-1', { ...request, prompt: 'Different' })
  ).rejects.toMatchObject({ code: 'submission_conflict' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  finish(run)
  await vi.waitFor(async () =>
    expect(await owner.get('request-1')).toMatchObject({ status: 'accepted', runId: run.id })
  )
  await owner.dispose()
  const restarted = new TaskSubmissions(path, { loadRuns: async () => [run], startRun })
  expect(await restarted.submit('request-1', request)).toMatchObject({
    status: 'accepted',
    runId: run.id
  })
  expect(startRun).toHaveBeenCalledTimes(1)
  expect(await readFile(join(path, 'task-submissions.json'), 'utf8')).not.toContain('Research')
})

it('recovers a sanitized provider sign-in failure on the original request after restart', async () => {
  const path = await root()
  const startRun = vi.fn(async () => {
    throw Object.assign(
      new Error('Authentication required', { cause: 'private provider detail' }),
      { name: 'RequestError', code: -32000 }
    )
  })
  const owner = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  await owner.submit('request-1', request)
  await vi.waitFor(async () => {
    expect(await owner.get('request-1')).toMatchObject({ status: 'failed' })
  })
  await owner.dispose()

  const restarted = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  const recovered = await restarted.submit('request-1', request)
  expect(recovered).toMatchObject({
    requestId: 'request-1',
    status: 'failed',
    error: { code: 'provider_auth_required' }
  })
  expect(recovered.runId).toBeUndefined()
  expect(JSON.stringify(recovered)).not.toContain('private provider detail')
  expect(startRun).toHaveBeenCalledOnce()
})

it.each([true, false])(
  'reconciles a pending receipt after restart (durable Run: %s)',
  async (hasRun) => {
    const path = await root()
    // The pending record is a real admission snapshot from before preparation returned.
    const owner = new TaskSubmissions(path, {
      loadRuns: async () => [],
      startRun: () => new Promise(() => {})
    })
    await owner.submit('request-1', request)
    await owner.dispose()
    const startRun = vi.fn()
    const restarted = new TaskSubmissions(path, {
      loadRuns: async () => (hasRun ? [run] : []),
      startRun
    })
    expect(await restarted.submit('request-1', request)).toMatchObject({
      status: hasRun ? 'accepted' : 'interrupted'
    })
    expect(startRun).not.toHaveBeenCalled()
  }
)

it('fails closed for corrupt receipts and capacity, preserving existing deduplication records', async () => {
  const path = await root()
  const startRun = vi.fn(async () => run)
  const owner = new TaskSubmissions(path, { loadRuns: async () => [], startRun, capacity: 1 })
  await owner.submit('request-1', request)
  await vi.waitFor(async () =>
    expect(await owner.get('request-1')).toMatchObject({ status: 'accepted' })
  )
  await owner.dispose()
  const restarted = new TaskSubmissions(path, { loadRuns: async () => [], startRun, capacity: 1 })
  await expect(restarted.submit('request-2', request)).rejects.toMatchObject({
    code: 'submission_unavailable'
  })
  expect(await restarted.get('request-1')).toMatchObject({ status: 'accepted' })
  await writeFile(join(path, 'task-submissions.json'), '{broken')
  const corrupt = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  await expect(corrupt.submit('request-2', request)).rejects.toThrow()
  expect(startRun).toHaveBeenCalledTimes(1)
  expect(await readFile(join(path, 'task-submissions.json'), 'utf8')).toBe('{broken')
})

it('does not recover an older receipt snapshot past a future-format recovery barrier', async () => {
  const path = await root()
  const target = join(path, 'task-submissions.json')
  await writeFile(`${target}.111.tmp`, JSON.stringify({ version: 1, submissions: [] }))
  await writeFile(`${target}.222.tmp`, JSON.stringify({ version: 2, submissions: [] }))
  const startRun = vi.fn()
  const owner = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
  await expect(owner.submit('request-1', request)).rejects.toThrow('unsupported')
  expect(startRun).not.toHaveBeenCalled()
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['pending', 'accepted'])(
  'fails closed after an ambiguous %s receipt write without repeating preparation',
  async (stage) => {
    const path = await root()
    const actual =
      await vi.importActual<typeof import('@aipoch/durable-files')>('@aipoch/durable-files')
    const write = vi.mocked(writeDurableJsonFile)
    write.mockImplementation(async (...args) => {
      await actual.writeDurableJsonFile(...args)
      if (JSON.parse(args[1]).submissions[0].status === stage)
        throw Object.assign(new Error('Receipt flush failed.'), { code: 'EIO' })
    })
    const startRun = vi.fn(async () => run)
    const owner = new TaskSubmissions(path, { loadRuns: async () => [], startRun })
    if (stage === 'pending') {
      await expect(owner.submit('request-1', request)).rejects.toThrow('Receipt flush failed')
    } else {
      await owner.submit('request-1', request)
      await vi.waitFor(async () => {
        await expect(owner.get('request-1')).rejects.toMatchObject({
          code: 'submission_unavailable'
        })
      })
    }
    await expect(owner.submit('request-1', request)).rejects.toMatchObject({
      code: 'submission_unavailable'
    })
    await owner.dispose()
    write.mockReset()
    const restarted = new TaskSubmissions(path, {
      loadRuns: async () => (stage === 'accepted' ? [run] : []),
      startRun
    })
    expect(await restarted.submit('request-1', request)).toMatchObject({
      status: stage === 'accepted' ? 'accepted' : 'interrupted'
    })
    expect(startRun).toHaveBeenCalledTimes(stage === 'accepted' ? 1 : 0)
  }
)
