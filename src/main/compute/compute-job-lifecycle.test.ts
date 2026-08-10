import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
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
  await ensureProjectSchema(client)

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
    initialStatus: 'queued'
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

  it('keeps an applied promotion successful when its observer throws', async () => {
    publish.mockImplementation(() => {
      throw new Error('observer failed')
    })

    const result = await lifecycle.promoteQueued('queued-job')

    expect(result.kind).toBe('applied')
  })
})
