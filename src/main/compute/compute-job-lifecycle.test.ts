import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import { ComputeJobRepository } from './job-repository'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined
let repository: ComputeJobRepository
let lifecycle: ComputeJobLifecycle
let publish: Mock

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-lifecycle-'))
  const client = createProjectDbClient(storageRoot)
  disconnect = () => client.$disconnect()
  await migrateApplicationDatabase(client)

  repository = new ComputeJobRepository(() => Promise.resolve(client))
  await repository.create({
    id: 'queued-job',
    providerId: 'ssh:test',
    shape: 'direct_ssh',
    sessionId: 'session-1',
    projectId: 'project-1',
    intent: 'test promotion',
    command: 'echo ok',
    commandHash: 'hash',
    initialStatus: 'queued',
    allowUnencryptedPersistence: true
  })
  await repository.create({
    id: 'submitted-job',
    providerId: 'ssh:test',
    shape: 'direct_ssh',
    sessionId: 'session-1',
    projectId: 'project-1',
    intent: 'test dispatch',
    command: 'echo ok',
    commandHash: 'hash',
    initialStatus: 'submitted',
    allowUnencryptedPersistence: true
  })
  await repository.create({
    id: 'running-job',
    providerId: 'ssh:test',
    shape: 'direct_ssh',
    sessionId: 'session-1',
    projectId: 'project-1',
    intent: 'test polling',
    command: 'echo ok',
    commandHash: 'hash',
    initialStatus: 'running',
    allowUnencryptedPersistence: true
  })
  publish = vi.fn()
  lifecycle = new ComputeJobLifecycle(repository, publish)
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('ComputeJobLifecycle', () => {
  it('promotes a queued job with its submission time and publishes the applied projection once', async () => {
    const result = await lifecycle.promoteQueued('queued-job')

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected an applied transition')
    expect(result.job.status).toBe('submitted')
    expect(result.job.submitted_at).toBeGreaterThan(0)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(result.job)
  })

  it('lets only one concurrent promotion apply and publish', async () => {
    const results = await Promise.all([
      lifecycle.promoteQueued('queued-job'),
      lifecycle.promoteQueued('queued-job')
    ])

    expect(results.map(({ kind }) => kind).sort()).toEqual(['applied', 'ignored'])
    expect(publish).toHaveBeenCalledOnce()
  })

  it('blocks later transitions and retains rows until owner deletion commits', async () => {
    const owner = { projectId: 'project-1', sessionId: 'session-1' }

    await lifecycle.beginOwnerDeletion(owner)

    await expect(lifecycle.promoteQueued('queued-job')).resolves.toEqual({ kind: 'ignored' })
    await expect(repository.get('queued-job')).resolves.toMatchObject({ status: 'queued' })
    await expect(repository.get('submitted-job')).resolves.not.toBeNull()

    await lifecycle.deleteOwnerRows(owner)

    await expect(repository.get('queued-job')).resolves.toBeNull()
    await expect(repository.get('submitted-job')).resolves.toBeNull()
    await expect(repository.get('running-job')).resolves.toBeNull()
  })

  it('reopens transitions when prepared owner deletion aborts', async () => {
    const owner = { projectId: 'project-1', sessionId: 'session-1' }

    await lifecycle.beginOwnerDeletion(owner)
    await lifecycle.abortOwnerDeletion(owner)

    await expect(lifecycle.promoteQueued('queued-job')).resolves.toMatchObject({ kind: 'applied' })
  })

  it('keeps an applied promotion successful when its observer throws', async () => {
    publish.mockImplementation(() => {
      throw new Error('observer failed')
    })

    const result = await lifecycle.promoteQueued('queued-job')

    expect(result.kind).toBe('applied')
  })

  it('records the running projection and publishes it after dispatch succeeds', async () => {
    const result = await lifecycle.dispatchRunning('submitted-job', '{"pid":123}')

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected an applied transition')
    expect(result.job.status).toBe('running')
    expect(result.job.remote_handle).toBe('{"pid":123}')
    expect(result.job.started_at).toBeGreaterThan(0)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(result.job)
  })

  it('records one dispatch error projection with its completion fields', async () => {
    const result = await lifecycle.dispatchError('submitted-job', {
      errorCode: 'host_unreachable',
      stderrTail: 'connection refused'
    })

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected an applied transition')
    expect(result.job.status).toBe('error')
    expect(result.job.error_code).toBe('host_unreachable')
    expect(result.job.stderr_tail).toBe('connection refused')
    expect(result.job.finished_at).toBeGreaterThan(0)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('ignores a late dispatcher result after another writer has made the job terminal', async () => {
    await repository.update('submitted-job', { status: 'success', finishedAt: new Date() })

    const results = await Promise.all([
      lifecycle.dispatchError('submitted-job', { errorCode: 'dispatch_failed' }),
      lifecycle.dispatchRunning('submitted-job', '{"pid":123}')
    ])

    expect(results).toEqual([{ kind: 'ignored' }, { kind: 'ignored' }])
    expect((await repository.get('submitted-job'))?.status).toBe('success')
    expect(publish).not.toHaveBeenCalled()
  })

  it('lets only one overlapping terminal poll observation apply and publish', async () => {
    const results = await Promise.all([
      lifecycle.finishPolled('running-job', {
        status: 'success',
        exitCode: 0,
        stdoutTail: 'done',
        stderrTail: null,
        errorCode: null
      }),
      lifecycle.finishPolled('running-job', {
        status: 'timeout',
        exitCode: 124,
        stdoutTail: 'late',
        stderrTail: null,
        errorCode: 'timeout'
      })
    ])

    expect(results.map(({ kind }) => kind).sort()).toEqual(['applied', 'ignored'])
    expect(publish).toHaveBeenCalledOnce()
    expect(['success', 'timeout']).toContain((await repository.get('running-job'))?.status)
  })

  it('updates active polling projections only while the observed status is current', async () => {
    const result = await lifecycle.observeRunning('running-job', 'running', {
      stdoutTail: 'progress',
      stderrTail: null
    })

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected an applied transition')
    expect(result.job.status).toBe('running')
    expect(result.job.stdout_tail).toBe('progress')
    expect(result.job.last_poll_error).toBeUndefined()
    expect(publish).toHaveBeenCalledOnce()
  })

  it('does not attach a late poll error or active projection to a terminal row', async () => {
    await repository.update('running-job', { status: 'failed', finishedAt: new Date() })

    const results = await Promise.all([
      lifecycle.recordPollError('running-job', 'running', 'connection lost'),
      lifecycle.observeRunning('running-job', 'running', {
        stdoutTail: 'late output',
        stderrTail: null
      })
    ])

    expect(results).toEqual([{ kind: 'ignored' }, { kind: 'ignored' }])
    expect((await repository.get('running-job'))?.last_poll_error).toBeUndefined()
    expect((await repository.get('running-job'))?.stdout_tail).toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
  })

  it('records the interrupted-dispatch recovery bundle once', async () => {
    const result = await lifecycle.recoverInterruptedDispatch('submitted-job')

    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected an applied transition')
    expect(result.job.status).toBe('error')
    expect(result.job.error_code).toBe('dispatch_failed')
    expect(result.job.stderr_tail).toBe('dispatch interrupted by restart')
    expect(result.job.finished_at).toBeGreaterThan(0)
    expect(publish).toHaveBeenCalledOnce()
  })
})
