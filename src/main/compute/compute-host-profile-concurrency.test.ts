import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() }
}))

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeHostRepository } from './repository'
import { ComputeHostProfileOwner } from './compute-host-profile-owner'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'

let root: string
let client: ReturnType<typeof createProjectDbClient>
let repository: ComputeHostRepository
const providerId = 'ssh:cluster'
const output = {
  exitCode: 0,
  stdout: 'os=Linux\ncpus=8\nsbatch=no\nqsub=no\nbsub=no\nscratch=/auto/scratch',
  stderr: '',
  timedOut: false,
  truncated: false
}
const owner = (run = vi.fn(async () => output)): ComputeHostProfileOwner =>
  new ComputeHostProfileOwner(
    { acquire: async () => ({ run }) } as unknown as ComputeConnectionBrokerAcquirer,
    repository
  )

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-profile-'))
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  repository = new ComputeHostRepository(async () => client)
  await repository.create({ sshAlias: 'cluster', detailsDoc: 'base' })
})
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

// Hold the first two public reads until both writers have the same database snapshot.
const synchronizeReads = (): void => {
  const get = repository.get.bind(repository)
  let arrivals = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(repository, 'get').mockImplementation(async (id) => {
    const host = await get(id)
    if (++arrivals <= 2) {
      if (arrivals === 2) release()
      await ready
    }
    return host
  })
}

it('rejects one simultaneous replacement instead of acknowledging a lost save', async () => {
  synchronizeReads()
  const service = owner()
  const results = await Promise.allSettled(
    ['first', 'second'].map((text) =>
      service.replaceDetails(providerId, { text, oldText: 'base', author: 'user' })
    )
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: expect.objectContaining({ message: expect.stringMatching(/conflict|old_text/i) })
  })
})

it('preserves both simultaneous appends', async () => {
  synchronizeReads()
  const service = owner()
  await Promise.all(
    ['first', 'second'].map((text) => service.appendDetails(providerId, { text, author: 'agent' }))
  )
  expect((await repository.get(providerId))?.detailsDoc.split('\n').sort()).toEqual([
    'base',
    'first',
    'second'
  ])
})

it('allows the first document save after a successful probe refresh', async () => {
  const service = owner()
  await client.computeHost.update({ where: { providerId }, data: { detailsDoc: '' } })

  await service.probe(providerId)
  const details = await service.getDetails(providerId)

  expect(details).toMatchObject({
    doc: '',
    probeResult: { ok: true, cpus: 8, detectedScheduler: 'none' }
  })
  await service.replaceDetails(providerId, {
    text: 'Use the gpu partition.',
    oldText: details.doc,
    author: 'user'
  })

  await expect(service.getDetails(providerId)).resolves.toMatchObject({
    doc: 'Use the gpu partition.',
    probeResult: { ok: true, cpus: 8, detectedScheduler: 'none' }
  })
})

it('preserves an existing host and its historical details document across read and replace', async () => {
  const historicalDoc = '## Resources\ncpus: 4\n\n## Usage Policy\nUse the batch queue.'
  const legacy = await repository.create({
    sshAlias: 'legacy',
    displayName: 'NIH Legacy Cluster',
    executionMode: 'slurm',
    sshOverrides: { user: 'researcher', port: 2202, identityFile: '~/.ssh/legacy' },
    detailsDoc: historicalDoc
  })
  await repository.updateScratchPinned(legacy.providerId, '/cluster/scratch/researcher')
  await repository.updateConcurrencyLimit(legacy.providerId, 17)
  const probeResult = {
    ok: true,
    probedAt: '2025-06-01T12:00:00.000Z',
    exitCode: 0,
    errorTail: null,
    authenticationRevision: legacy.authentication?.revision ?? 1,
    os: 'Linux',
    cpus: 96,
    memMib: 512000,
    detectedScheduler: 'slurm' as const
  }
  expect(
    await repository.updateProbeResult(
      legacy.providerId,
      probeResult,
      'scheduler_cluster',
      legacy.id
    )
  ).toBe(true)
  const service = owner()
  const beforeRead = await repository.get(legacy.providerId)
  if (!beforeRead) throw new Error('Expected the seeded legacy host to exist.')

  const details = await service.getDetails(legacy.providerId)

  expect(details).toEqual({ doc: historicalDoc, probeResult })
  expect(await repository.get(legacy.providerId)).toEqual(beforeRead)

  await service.replaceDetails(legacy.providerId, {
    text: `${historicalDoc}\nBring your own container.`,
    oldText: details.doc,
    author: 'agent'
  })

  const afterReplace = await repository.get(legacy.providerId)
  expect(afterReplace).toEqual({
    ...beforeRead,
    detailsDoc: `${historicalDoc}\nBring your own container.`,
    detailsUpdatedBy: 'agent',
    detailsUpdatedAt: expect.any(Number),
    updatedAt: expect.any(Number)
  })
})

it('rechecks the length limit after a competing append', async () => {
  await client.computeHost.update({
    where: { providerId },
    data: { detailsDoc: 'x'.repeat(32760) }
  })
  synchronizeReads()
  const service = owner()
  const results = await Promise.allSettled(
    ['first', 'second'].map((text) => service.appendDetails(providerId, { text, author: 'agent' }))
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: expect.objectContaining({ message: expect.stringContaining('32768') })
  })
})

it('preserves a scratch path pinned while the remote probe is running', async () => {
  const service = owner(
    vi.fn(async () => {
      await repository.updateScratchPinned(providerId, '/user/pinned')
      return output
    })
  )
  await service.probe(providerId)
  expect(await repository.get(providerId)).toMatchObject({
    scratchPinned: true,
    scratchRoot: '/user/pinned'
  })
})

it('rejects probe side effects after authentication changes between SSH completion and persistence', async () => {
  const persist = repository.updateProbeResult.bind(repository)
  vi.spyOn(repository, 'updateProbeResult').mockImplementation(async (...args) => {
    await client.computeHost.update({
      where: { providerId },
      data: { authenticationRevision: { increment: 1 } }
    })
    return persist(...args)
  })
  const error = await owner()
    .probe(providerId)
    .then(
      () => undefined,
      (error: unknown) => error
    )
  expect(await repository.get(providerId)).toMatchObject({
    probeResult: undefined,
    scratchRoot: undefined
  })
  expect(error).toMatchObject({ code: 'credential_conflict' })
})

it.each([2, 0])(
  'does not report incomplete remote output as a successful probe (exit %s)',
  async (exitCode) => {
    const result = await owner(
      vi.fn(async () => ({ ...output, exitCode, stdout: '', stderr: 'sh: syntax error' }))
    ).probe(providerId)
    expect(result.ok).toBe(false)
    expect(result.detectedScheduler).toBeUndefined()
    expect(result.errorTail).toContain('syntax error')
    expect((await repository.get(providerId))?.probeResult?.ok).toBe(false)
  }
)

it('round trips independent health facts while keeping legacy observations unknown', async () => {
  const host = (await repository.get(providerId))!
  const legacy = {
    ok: true,
    probedAt: new Date().toISOString(),
    exitCode: 0,
    errorTail: null,
    authenticationRevision: host.authentication!.revision
  }
  await repository.updateProbeResult(providerId, legacy, host.shape, host.id)
  expect((await repository.get(providerId))!.probeResult?.scratchWritable).toBeUndefined()
  const checked = {
    ...legacy,
    ok: false,
    sshConnected: true,
    commandExecutable: true,
    scratchWritable: false,
    scratchPath: '/readonly',
    schedulerAvailable: false
  }
  await repository.updateProbeResult(providerId, checked, host.shape, host.id)
  expect((await repository.get(providerId))!.probeResult).toEqual(checked)
})
