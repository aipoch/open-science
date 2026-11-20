import { writeDurableJsonFile } from '@aipoch/durable-files'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { stringifyRpcJson } from '../../rpc-json'
import { LiteratureComparisons } from './owner'
import {
  comparisonResultSchema,
  type ComparisonTable,
  type ComparisonCell
} from '../../../shared/literature-comparison'
import {
  beginMigration,
  beginMigrationPreparation,
  cancelMigrationForQuit,
  clearMigrationPending,
  endMigration,
  endMigrationCopy,
  initializeDataRootWriteAvailability,
  reconcileDataRootWriteAvailability,
  waitForDataRootWriters,
  withDataRootWrite
} from '../../storage/migration-state'

vi.mock('@aipoch/durable-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/durable-files')>()
  return { ...actual, writeDurableJsonFile: vi.fn(actual.writeDurableJsonFile) }
})

vi.mock('electron', () => ({ dialog: { showMessageBoxSync: vi.fn() } }))
const roots: string[] = []
const owners: LiteratureComparisons[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  endMigration()
  initializeDataRootWriteAvailability(false)
  for (const release of releases.splice(0)) release()
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  releases.push(resolve)
  return { promise, resolve }
}
async function location(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'comparison-boundary-'))
  roots.push(root)
  return join(root, 'tables.json')
}

it('rejects an older configuration snapshot without replacing saved rules and accepts a fresh baseline', async () => {
  const path = await location()
  const options = {
    path: () => path,
    extractor: {
      member: async (itemId: string) => ({
        itemId,
        title: itemId,
        abstract: 'text',
        sourceKey: 'source'
      })
    },
    capture: async () => {
      throw new Error('not running')
    }
  }
  const owner = new LiteratureComparisons(options)
  owners.push(owner)
  await owner.start()
  const created = (
    await owner.run({
      action: 'create',
      name: 'Methods',
      language: 'en',
      sourcePolicy: 'abstract',
      fields: [
        { id: 'population', name: 'Population', rule: 'Report N' },
        { id: 'outcome', name: 'Outcome', rule: 'Report outcome' }
      ],
      itemIds: ['paper']
    })
  ).tables[0]
  // Two clients open the same saved configuration before either submits its full snapshot.
  const clientA = (await owner.run({ action: 'read', tableId: created.id })).tables[0]
  const clientB = (await owner.run({ action: 'read', tableId: created.id })).tables[0]
  const first = (
    await owner.run({
      action: 'update',
      tableId: created.id,
      expectedRevision: clientA.revision,
      name: clientA.name,
      sourcePolicy: clientA.sourcePolicy,
      fields: clientA.fields.map(({ id, name, rule }) => ({
        id,
        name,
        rule: id === 'population' ? 'Report the randomized population N' : rule
      }))
    })
  ).tables[0]
  const bytes = await readFile(path, 'utf8')
  const writes = vi.mocked(writeDurableJsonFile).mock.calls.length
  await expect(
    owner.run({
      action: 'update',
      tableId: created.id,
      expectedRevision: clientB.revision,
      name: 'Stale client title',
      sourcePolicy: 'full-text',
      fields: clientB.fields.map(({ id, name, rule }) => ({
        id,
        name,
        rule: id === 'outcome' ? 'Report the primary outcome' : rule
      }))
    })
  ).rejects.toThrow('comparison-config-changed')
  expect(vi.mocked(writeDurableJsonFile).mock.calls).toHaveLength(writes)
  expect((await owner.run({ action: 'read', tableId: created.id })).tables[0]).toEqual(first)
  expect(await readFile(path, 'utf8')).toBe(bytes)
  expect(first.fields).toEqual([
    {
      id: 'population',
      name: 'Population',
      rule: 'Report the randomized population N',
      version: 2
    },
    { id: 'outcome', name: 'Outcome', rule: 'Report outcome', version: 1 }
  ])

  await owner.dispose()
  const restarted = new LiteratureComparisons(options)
  owners.push(restarted)
  await restarted.start()
  const current = (await restarted.run({ action: 'read', tableId: created.id })).tables[0]
  expect(current).toEqual(first)
  expect(await readFile(path, 'utf8')).toBe(bytes)
  const merged = (
    await restarted.run({
      action: 'update',
      tableId: current.id,
      expectedRevision: current.revision,
      name: current.name,
      sourcePolicy: current.sourcePolicy,
      fields: current.fields.map(({ id, name, rule }) => ({
        id,
        name,
        rule: id === 'outcome' ? 'Report the primary outcome' : rule
      }))
    })
  ).tables[0]
  expect(merged).toMatchObject({
    name: 'Methods',
    sourcePolicy: 'abstract',
    revision: current.revision + 1,
    fields: [
      { id: 'population', rule: 'Report the randomized population N', version: 2 },
      { id: 'outcome', rule: 'Report the primary outcome', version: 2 }
    ]
  })
  const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
  expect(saved.fields).toEqual(merged.fields)
  expect(saved).toMatchObject({
    name: merged.name,
    sourcePolicy: merged.sourcePolicy,
    revision: merged.revision
  })
})

it.each([clearMigrationPending, endMigration])(
  'drains admitted cells and resumes without requests when %s reopens migration writes',
  async (reopen) => {
    const path = await location()
    const blocked = deferred()
    const extract = vi.fn(async () => {
      await blocked.promise
      return { status: 'succeeded' as const, sourceKey: 'source', value: 'result', evidence: [] }
    })
    const owner = new LiteratureComparisons({
      path: () => path,
      comparisonConcurrency: 1,
      extractor: {
        member: async (itemId) => ({ itemId, title: itemId, abstract: 'text', sourceKey: 'source' })
      },
      capture: async () => ({ extract })
    })
    owners.push(owner)
    await owner.start()
    const table = (
      await owner.run({
        action: 'create',
        name: 'Drain',
        language: 'en',
        sourcePolicy: 'abstract',
        fields: [{ id: 'f', name: 'F', rule: 'extract' }],
        itemIds: ['a', 'b']
      })
    ).tables[0]
    await withDataRootWrite(() => owner.run({ action: 'run', tableId: table.id }))
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    beginMigration()
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    blocked.resolve()
    await drain
    const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
    expect(saved.cells[0]).toMatchObject({ status: 'succeeded', history: [{ value: 'result' }] })
    expect(saved.cells[1]).toMatchObject({ status: 'pending', history: [] })
    const bytes = await readFile(path, 'utf8')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(extract).toHaveBeenCalledTimes(1)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    reopen()
    // Observe durable output only: no renderer request may be needed to wake the worker.
    await vi.waitFor(async () => {
      const completed = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
      expect(completed.state).toBe('completed')
      expect(completed.remainingCellIds).toEqual([])
      expect(completed.cells.map((cell) => cell.history.length)).toEqual([1, 1])
      expect(completed.cells[0]).toEqual(saved.cells[0])
    })
    expect(extract).toHaveBeenCalledTimes(2)
  }
)

type Extract = Awaited<
  ReturnType<ConstructorParameters<typeof LiteratureComparisons>[0]['capture']>
>['extract']

async function disposalFixture(): Promise<{
  owner: LiteratureComparisons
  table: ComparisonTable
  path: string
  blocked: ReturnType<typeof deferred>
  extract: Mock<Extract>
  onError: Mock<(error: unknown) => void>
}> {
  const path = await location()
  const blocked = deferred()
  const extract = vi.fn<Extract>(async () => {
    await blocked.promise
    return { status: 'succeeded' as const, sourceKey: 'source', value: 'result', evidence: [] }
  })
  const onError = vi.fn<(error: unknown) => void>()
  const owner = new LiteratureComparisons({
    path: () => path,
    comparisonConcurrency: 1,
    extractor: {
      member: async (itemId) => ({ itemId, title: itemId, abstract: 'text', sourceKey: 'source' })
    },
    capture: async () => ({ extract }),
    onError
  })
  owners.push(owner)
  await owner.start()
  const table = (
    await owner.run({
      action: 'create',
      name: 'Dispose',
      language: 'en',
      sourcePolicy: 'abstract',
      fields: [{ id: 'f', name: 'F', rule: 'extract' }],
      itemIds: ['a', 'b']
    })
  ).tables[0]
  return { owner, table, path, blocked, extract, onError }
}

it('preserves admitted checkpoint failures during migration and persists pause only after writes reopen', async () => {
  const { owner, table, path, blocked, extract, onError } = await disposalFixture()
  await owner.run({ action: 'run', tableId: table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce())
  const before = await readFile(path, 'utf8')
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  vi.mocked(writeDurableJsonFile).mockRejectedValueOnce(failure)
  beginMigration()
  blocked.resolve()
  await waitForDataRootWriters()
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
  const writes = vi.mocked(writeDurableJsonFile).mock.calls.length
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(vi.mocked(writeDurableJsonFile).mock.calls.length).toBe(writes)
  clearMigrationPending()
  await vi.waitFor(async () => {
    const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
    expect(saved).toMatchObject({ state: 'paused', issue: 'checkpoint-failed' })
    expect(saved.cells.every((cell) => cell.status === 'pending' && !cell.history.length)).toBe(
      true
    )
  })
  expect(extract).toHaveBeenCalledOnce()
  expect(onError).toHaveBeenCalledOnce()
  await owner.run({ action: 'resume', tableId: table.id })
  await vi.waitFor(async () => {
    const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
    expect(saved.state).toBe('completed')
    expect(saved.cells.map((cell) => cell.history.length)).toEqual([1, 1])
  })
  expect(extract).toHaveBeenCalledTimes(3)
})

it('retries migration admission rejected after waiting for a missing data root', async () => {
  const { owner, table, path, blocked, extract, onError } = await disposalFixture()
  await owner.run({ action: 'run', tableId: table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce())
  await reconcileDataRootWriteAvailability(true)
  blocked.resolve()
  await waitForDataRootWriters()
  await new Promise<void>((resolve) => setImmediate(resolve))
  beginMigration()
  await reconcileDataRootWriteAvailability(false)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(extract).toHaveBeenCalledOnce()
  expect(onError).not.toHaveBeenCalled()
  clearMigrationPending()
  await vi.waitFor(async () => {
    const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
    expect(saved.state).toBe('completed')
    expect(saved.cells.map((cell) => cell.history.length)).toEqual([1, 1])
  })
  expect(extract).toHaveBeenCalledTimes(2)
  expect(onError).not.toHaveBeenCalled()
})

it('disposes a failed checkpoint waiting for migration without holding the owner queue', async () => {
  const { owner, table, path, blocked, extract, onError } = await disposalFixture()
  await owner.run({ action: 'run', tableId: table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce())
  const bytes = await readFile(path, 'utf8')
  vi.mocked(writeDurableJsonFile).mockRejectedValueOnce(new Error('disk full'))
  beginMigration()
  blocked.resolve()
  await waitForDataRootWriters()
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
  // The pause is already queued even though its checkpoint needs migration to reopen writes.
  const queued = owner as unknown as { queue<T>(operation: () => Promise<T>): Promise<T> }
  let passed = false
  await queued.queue(async () => {
    passed = true
  })
  expect(passed).toBe(true)
  let disposed = false
  const closing = owner.dispose().then(() => {
    disposed = true
  })
  await vi.waitFor(() => expect(disposed).toBe(true), { timeout: 500 })
  await closing
  clearMigrationPending()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(extract).toHaveBeenCalledOnce()
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it.each(['pause', 'dispose', 'committed'] as const)(
  'does not restart migration-blocked work after %s',
  async (action) => {
    const { owner, table, path, blocked, extract } = await disposalFixture()
    await owner.run({ action: 'run', tableId: table.id })
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    if (action === 'pause') await owner.run({ action: 'pause', tableId: table.id })
    const preparation = action === 'committed' ? beginMigrationPreparation() : undefined
    beginMigration()
    blocked.resolve()
    await waitForDataRootWriters()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const bytes = await readFile(path, 'utf8')
    if (action === 'dispose') await owner.dispose()
    if (preparation) {
      preparation.markCommitted()
      const cancelling = cancelMigrationForQuit()
      preparation.finish()
      endMigrationCopy()
      await cancelling
    } else {
      clearMigrationPending()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(extract).toHaveBeenCalledTimes(1)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
)

it.each([false, true])(
  'disposes unavailable admission without new work (availability race: %s)',
  async (restoreBeforeClose) => {
    const { owner, table, path, blocked, extract } = await disposalFixture()
    await withDataRootWrite(() => owner.run({ action: 'run', tableId: table.id }))
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    await reconcileDataRootWriteAvailability(true)
    blocked.resolve()
    await waitForDataRootWriters()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const saved = await readFile(path, 'utf8')
    if (restoreBeforeClose) initializeDataRootWriteAvailability(false)
    let disposed = false
    const closing = owner.dispose().then(() => {
      disposed = true
    })
    await vi.waitFor(() => expect(disposed).toBe(true))
    await closing
    await reconcileDataRootWriteAvailability(false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(extract).toHaveBeenCalledTimes(1)
    expect(await readFile(path, 'utf8')).toBe(saved)
  }
)

it('checks closure when an admitted cell waits behind the serial queue', async () => {
  const { owner, table, path, blocked, extract } = await disposalFixture()
  // Hold the real owner queue after the run mutation but before kick queues selection.
  let serialBoundary: Promise<unknown> | undefined
  const queued = owner as unknown as {
    queue<T>(operation: () => Promise<T>): Promise<T>
    kick(): void
  }
  const kick = queued.kick.bind(owner)
  const hold = vi.spyOn(queued, 'kick').mockImplementationOnce(() => {
    serialBoundary = queued.queue(() => blocked.promise)
    kick()
  })
  await withDataRootWrite(() => owner.run({ action: 'run', tableId: table.id }))
  hold.mockRestore()
  const saved = await readFile(path, 'utf8')
  const closing = owner.dispose()
  blocked.resolve()
  await serialBoundary
  await closing
  expect(extract).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(saved)
})

it('checkpoints an already admitted cell during closure with missing storage and restores remaining work', async () => {
  const { owner, table, path, blocked, extract } = await disposalFixture()
  await owner.run({ action: 'run', tableId: table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
  await reconcileDataRootWriteAvailability(true)
  beginMigration()
  const closing = owner.dispose()
  blocked.resolve()
  await closing
  await waitForDataRootWriters()
  const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
  expect(saved.state).toBe('interrupted')
  expect(saved.remainingCellIds).toHaveLength(2)
  expect(saved.cells.every((cell) => cell.status === 'pending' && !cell.history.length)).toBe(true)
  endMigration()
  await reconcileDataRootWriteAvailability(false)
  const restored = new LiteratureComparisons({
    path: () => path,
    comparisonConcurrency: 1,
    extractor: {
      member: async (itemId) => ({ itemId, title: itemId, abstract: 'text', sourceKey: 'source' })
    },
    capture: async () => ({ extract })
  })
  owners.push(restored)
  await restored.start()
  await restored.run({ action: 'resume', tableId: table.id })
  await vi.waitFor(async () =>
    expect((await restored.run({ action: 'read', tableId: table.id })).tables[0].state).toBe(
      'completed'
    )
  )
  expect(extract).toHaveBeenCalledTimes(3)
})

it('drains four-way disposal and resumes only unfinished cells after restart', async () => {
  const path = await location()
  const pending = Array.from({ length: 4 }, () => deferred())
  const extract = vi.fn<Extract>(async (_table, _field, itemId) => {
    await pending[['a', 'b', 'c', 'd'].indexOf(itemId)].promise
    return { status: 'succeeded', sourceKey: 'source', value: `Saved ${itemId}`, evidence: [] }
  })
  const options = {
    path: () => path,
    comparisonConcurrency: 4,
    extractor: {
      member: async (itemId: string) => ({
        itemId,
        title: itemId,
        abstract: 'text',
        sourceKey: 'source'
      })
    },
    capture: vi.fn(async () => ({ extract }))
  }
  const owner = new LiteratureComparisons(options)
  owners.push(owner)
  await owner.start()
  const created = (
    await owner.run({
      action: 'create',
      name: 'Four-way restart',
      language: 'en',
      sourcePolicy: 'abstract',
      fields: [{ id: 'f', name: 'F', rule: 'extract' }],
      itemIds: ['a', 'b', 'c', 'd', 'e', 'f']
    })
  ).tables[0]
  const writesBeforeAdmission = vi.mocked(writeDurableJsonFile).mock.calls.length
  const admitted = (
    await withDataRootWrite(() => owner.run({ action: 'run', tableId: created.id }))
  ).tables[0]
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(4))
  expect(vi.mocked(writeDurableJsonFile).mock.calls.length - writesBeforeAdmission).toBe(1)
  const queued = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
  expect(queued.remainingCellIds).toHaveLength(6)
  expect(queued.cells.every((cell) => cell.status === 'pending')).toBe(true)
  pending[0].resolve()
  await vi.waitFor(async () => {
    const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
    expect(saved.cells[0]).toMatchObject({ status: 'succeeded', history: [{ value: 'Saved a' }] })
  })
  const savedFirst = (JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable)
    .cells[0]
  let disposed = false
  const closing = owner.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  expect(extract.mock.calls.every(([, , , signal]) => signal.aborted)).toBe(true)
  pending[3].resolve()
  pending[1].resolve()
  await vi.waitFor(async () => {
    const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
    expect(saved.cells[1].status).toBe('pending')
    expect(saved.cells[3].status).toBe('pending')
  })
  expect(disposed).toBe(false)
  pending[2].resolve()
  await closing
  await waitForDataRootWriters()
  const saved = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
  expect(saved).toMatchObject({
    state: 'interrupted',
    taskId: admitted.taskId,
    taskSources: admitted.taskSources
  })
  expect(saved.cells[0]).toEqual(savedFirst)
  expect(saved.remainingCellIds).toEqual(saved.cells.slice(1).map((cell) => cell.id))
  expect(
    saved.cells.slice(1).every((cell) => cell.status === 'pending' && cell.history.length === 0)
  ).toBe(true)
  expect(extract.mock.calls.map(([, , itemId]) => itemId)).toEqual(['a', 'b', 'c', 'd'])

  const resumedExtract = vi.fn<Extract>(async (_table, _field, itemId) => ({
    status: 'succeeded',
    sourceKey: 'source',
    value: `Resumed ${itemId}`,
    evidence: []
  }))
  const capture = vi.fn(async () => ({ extract: resumedExtract }))
  const restarted = new LiteratureComparisons({ ...options, capture })
  owners.push(restarted)
  await restarted.start()
  const restored = (await restarted.run({ action: 'read', tableId: created.id })).tables[0]
  expect(restored).toMatchObject({
    state: 'interrupted',
    taskId: admitted.taskId,
    remainingCellIds: saved.remainingCellIds
  })
  expect(restored.cells[0]).toEqual(savedFirst)
  expect(capture).not.toHaveBeenCalled()
  expect(resumedExtract).not.toHaveBeenCalled()
  await restarted.run({ action: 'resume', tableId: created.id })
  await vi.waitFor(async () =>
    expect((await restarted.run({ action: 'read', tableId: created.id })).tables[0].state).toBe(
      'completed'
    )
  )
  const completed = JSON.parse(await readFile(path, 'utf8')).tables[0] as ComparisonTable
  expect(completed.taskId).toBe(admitted.taskId)
  expect(completed.cells[0]).toEqual(savedFirst)
  expect(completed.remainingCellIds).toEqual([])
  expect(
    completed.cells.every((cell) => cell.status === 'succeeded' && cell.history.length === 1)
  ).toBe(true)
  expect(resumedExtract.mock.calls.map(([, , itemId]) => itemId)).toEqual(['b', 'c', 'd', 'e', 'f'])
  expect(capture).toHaveBeenCalledTimes(1)
})

it('pages a large evidence CSV from a valid store and keeps the matrix independently replayable', async () => {
  const path = await location()
  const members = Array.from({ length: 5 }, (_, index) => ({
    itemId: `paper-${index}`,
    title: `Paper ${index}`,
    abstract: '',
    sourceKey: 'source'
  }))
  const table: ComparisonTable = {
    id: 'evidence-heavy',
    name: 'Evidence heavy',
    language: 'en',
    sourcePolicy: 'abstract',
    revision: 1,
    fields: [{ id: 'field', name: 'Result', rule: 'extract', version: 1 }],
    members,
    itemIds: members.map((member) => member.itemId),
    cells: members.map((member) => ({
      id: `cell-${member.itemId}`,
      itemId: member.itemId,
      fieldId: 'field',
      status: 'succeeded',
      manual: {
        value: 'm'.repeat(8000),
        confirmed: false,
        fieldVersion: 1,
        sourceKey: 'source',
        updatedAt: 'now'
      },
      history: Array.from({ length: 30 }, (_, index) => ({
        id: `attempt-${index}`,
        fieldVersion: 1,
        sourceKey: 'source',
        at: 'now',
        status: 'succeeded',
        value: 'Machine result',
        evidence: Array.from({ length: 12 }, () => ({
          quote: 'q'.repeat(12_000),
          pageStart: null,
          pageEnd: null
        }))
      }))
    })),
    remainingCellIds: [],
    state: 'completed'
  }
  const content = JSON.stringify({ version: 1, tables: [table] })
  expect(Buffer.byteLength(content)).toBeLessThan(24_000_000)
  await writeFile(path, content)
  const owner = new LiteratureComparisons({
    path: () => path,
    extractor: { member: async (itemId) => members.find((member) => member.itemId === itemId)! },
    capture: async () => {
      throw new Error('not running')
    }
  })
  owners.push(owner)
  await owner.start()
  const matrix = await owner.run({ action: 'export', tableId: table.id, kind: 'matrix' })
  expect(matrix.csv!.split('\r\n')).toHaveLength(6)
  expect(matrix.nextOffset).toBeUndefined()
  let offset: number | undefined
  let length = 0
  let rowCount = 0
  let manualRows = 0
  let carry = ''
  do {
    const page = await owner.run({
      action: 'export',
      tableId: table.id,
      kind: 'evidence',
      exportToken: matrix.exportToken,
      offset
    })
    comparisonResultSchema.parse(page)
    const chunk = page.csv!
    length += chunk.length
    const lines = (carry + chunk).split('\r\n')
    carry = lines.pop()!
    rowCount += lines.length
    manualRows += lines.filter((line) => line.includes('m'.repeat(8000))).length
    offset = page.nextOffset
    if (offset !== undefined) expect(offset).toBe(length)
  } while (offset !== undefined)
  expect(manualRows + Number(carry.includes('m'.repeat(8000)))).toBe(members.length)
  expect(length).toBeGreaterThan(20_000_000)
  expect(rowCount + 1).toBe(1 + 5 * 30 * 12)
  const replay = await owner.run({
    action: 'export',
    tableId: table.id,
    kind: 'matrix',
    exportToken: matrix.exportToken
  })
  expect(replay.csv).toBe(matrix.csv)
})

it('transports a valid state above 16MB through summaries, current cells, lazy history and immutable CSV chunks', async () => {
  const path = await location()
  const members = Array.from({ length: 100 }, (_, i) => ({
    itemId: `p${i}`,
    title: `Paper ${i}`,
    abstract: 'a'.repeat(80_000),
    sourceKey: 'source'
  }))
  const fields = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i}`,
    name: `Field ${i}`,
    rule: 'extract',
    version: 1
  }))
  const cells: ComparisonCell[] = members.flatMap((member) =>
    fields.map((field) => ({
      id: `${member.itemId}-${field.id}`,
      itemId: member.itemId,
      fieldId: field.id,
      status: 'succeeded' as const,
      history: [
        {
          id: `${member.itemId}-${field.id}-attempt`,
          fieldVersion: 1,
          sourceKey: 'source',
          at: 'now',
          status: 'succeeded' as const,
          value: 'v'.repeat(8000),
          evidence: [] as { quote: string; pageStart: null; pageEnd: null }[]
        }
      ]
    }))
  )
  cells[0].history = Array.from({ length: 3 }, (_, i) => ({
    ...cells[0].history[0],
    id: `history-${i}`,
    evidence: Array.from({ length: 12 }, () => ({
      quote: '\u0000'.repeat(12000),
      pageStart: null,
      pageEnd: null
    }))
  }))
  const table: ComparisonTable = {
    id: 'large',
    name: 'Large',
    language: 'en',
    sourcePolicy: 'abstract',
    revision: 1,
    members,
    fields,
    cells,
    itemIds: members.map((member) => member.itemId),
    remainingCellIds: [],
    state: 'completed'
  }
  const content = JSON.stringify({ version: 1, tables: [table] })
  expect(Buffer.byteLength(content)).toBeGreaterThan(16 * 1024 * 1024)
  expect(Buffer.byteLength(content)).toBeLessThan(24_000_000)
  await writeFile(path, content)
  const owner = new LiteratureComparisons({
    path: () => path,
    extractor: { member: async (itemId) => members.find((member) => member.itemId === itemId)! },
    capture: async () => {
      throw new Error('not running')
    }
  })
  owners.push(owner)
  await owner.start()
  const check = (result: Awaited<ReturnType<typeof owner.run>>): void => {
    comparisonResultSchema.parse(result)
    expect(Buffer.byteLength(stringifyRpcJson({ result }))).toBeLessThan(8_000_000)
  }
  const list = await owner.run({ action: 'list' })
  check(list)
  expect(list.tables).toEqual([])
  expect(list.summaries?.[0]).toMatchObject({ total: 1200, succeeded: 1200, memberCount: 100 })
  const loaded: typeof cells = []
  let offset: number | undefined = 0
  let readToken: string | undefined
  do {
    const page = await owner.run({ action: 'read', tableId: table.id, offset, readToken })
    if (offset === 0) {
      readToken = page.readToken
      expect(readToken).toBeTruthy()
      await owner.run({ action: 'set-sample', tableId: table.id, itemIds: ['p0'] })
      expect(
        (await owner.run({ action: 'read', tableId: table.id })).tables[0].sampleItemIds
      ).toEqual(['p0'])
    }
    expect(page.tables[0].sampleItemIds).toBeUndefined()
    check(page)
    expect(page.tables[0].members.every((member) => member.abstract === '')).toBe(true)
    expect(page.tables[0].cells.length).toBeLessThanOrEqual(100)
    loaded.push(...page.tables[0].cells)
    offset = page.nextOffset
  } while (offset !== undefined)
  expect(loaded.map((cell) => cell.id)).toEqual(cells.map((cell) => cell.id))
  expect(loaded[0].history).toEqual([{ ...cells[0].history[2], evidence: [] }])
  const history = [] as (typeof cells)[0]['history']
  offset = 0
  do {
    const page = await owner.run({
      action: 'read-cell',
      tableId: table.id,
      cellId: cells[0].id,
      offset
    })
    check(page)
    history.push(...page.cell!.history)
    offset = page.nextOffset
  } while (offset !== undefined)
  expect(history).toEqual(cells[0].history)
  const first = await owner.run({ action: 'export', tableId: table.id, kind: 'matrix' })
  check(first)
  expect(first.nextOffset).toBe(100_000)
  await owner.run({
    action: 'edit-cell',
    tableId: table.id,
    cellId: cells[0].id,
    value: 'new manual',
    confirmed: false,
    expectedFieldVersion: 1,
    expectedSourceKey: 'source'
  })
  let csv = first.csv!
  offset = first.nextOffset
  do {
    const page = await owner.run({
      action: 'export',
      tableId: table.id,
      kind: 'matrix',
      offset,
      exportToken: first.exportToken
    })
    check(page)
    csv += page.csv
    offset = page.nextOffset
  } while (offset !== undefined)
  expect(csv.startsWith('\uFEFF"itemId","title"')).toBe(true)
  expect(csv).not.toContain('new manual')
  expect(csv.split('\r\n')).toHaveLength(101)
  expect(csv.split('"' + 'v'.repeat(8000) + '"')).toHaveLength(2401)
  const replay = await owner.run({
    action: 'export',
    tableId: table.id,
    kind: 'matrix',
    offset: 100_000,
    exportToken: first.exportToken
  })
  expect(replay.csv).toBe(csv.slice(100_000, 200_000))
  let evidence = ''
  offset = 0
  do {
    const page = await owner.run({
      action: 'export',
      tableId: table.id,
      kind: 'evidence',
      offset,
      exportToken: first.exportToken
    })
    check(page)
    expect(page.exportToken).toBe(first.exportToken)
    evidence += page.csv
    offset = page.nextOffset
  } while (offset !== undefined)
  expect(evidence).not.toContain('new manual')
  expect(evidence.split('\r\n')).toHaveLength(1236)
  await expect(
    owner.run({
      action: 'export',
      tableId: table.id,
      kind: 'matrix',
      offset: csv.length,
      exportToken: first.exportToken
    })
  ).rejects.toThrow('invalid-offset')
  await expect(owner.run({ action: 'read', tableId: table.id, offset: 1201 })).rejects.toThrow(
    'invalid-offset'
  )
  await expect(
    owner.run({ action: 'read-cell', tableId: table.id, cellId: cells[0].id, offset: 4 })
  ).rejects.toThrow('invalid-offset')
  await expect(
    owner.run({
      action: 'export',
      tableId: table.id,
      kind: 'matrix',
      offset: 100_000,
      exportToken: 'unknown'
    })
  ).rejects.toThrow('export-expired')
}, 30_000)

it('shrinks current-cell pages for worst escaped Unicode metadata while preserving the complete values', async () => {
  const path = await location()
  const escaped = (length: number): string => '\u0000'.repeat(length)
  const members = Array.from({ length: 100 }, (_, i) => ({
    itemId: escaped(253) + i,
    title: escaped(4000),
    abstract: '',
    sourceKey: escaped(4096)
  }))
  const fields = Array.from({ length: 12 }, (_, i) => ({
    id: escaped(253) + i,
    name: escaped(120),
    rule: escaped(4000),
    version: 1
  }))
  const cells: ComparisonCell[] = members.flatMap((member, m) =>
    fields.map((field, f) => ({
      id: escaped(250) + m + '-' + f,
      itemId: member.itemId,
      fieldId: field.id,
      status: 'pending',
      history: []
    }))
  )
  for (const cell of cells.slice(0, 10)) {
    cell.history = [
      {
        id: escaped(256),
        fieldVersion: 1,
        fieldSnapshot: fields[0],
        sourcePolicy: 'abstract',
        sourceKey: escaped(4096),
        at: 'now',
        status: 'succeeded',
        value: escaped(8000),
        evidence: []
      }
    ]
    cell.manual = {
      value: escaped(8000),
      sourceKey: escaped(4096),
      fieldVersion: 1,
      confirmed: false,
      updatedAt: 'now'
    }
  }
  const table: ComparisonTable = {
    id: 'escaped',
    name: 'Escaped',
    language: 'en',
    sourcePolicy: 'abstract',
    revision: 1,
    members,
    fields,
    cells,
    itemIds: members.map((member) => member.itemId),
    remainingCellIds: cells.map((cell) => cell.id),
    state: 'idle'
  }
  const content = JSON.stringify({ version: 1, tables: [table] })
  expect(Buffer.byteLength(content)).toBeLessThan(24_000_000)
  await writeFile(path, content)
  const owner = new LiteratureComparisons({
    path: () => path,
    extractor: { member: async (id) => members.find((member) => member.itemId === id)! },
    capture: async () => {
      throw new Error('not running')
    }
  })
  owners.push(owner)
  await owner.start()
  const first = await owner.run({ action: 'read', tableId: table.id })
  expect(first.tables[0].cells.length).toBeGreaterThan(0)
  expect(first.tables[0].cells.length).toBeLessThan(10)
  expect(Buffer.byteLength(stringifyRpcJson({ result: first }))).toBeLessThan(8_000_000)
  expect(first.tables[0].cells[0].manual?.value).toBe(escaped(8000))
  const second = await owner.run({ action: 'read', tableId: table.id, offset: first.nextOffset })
  expect(second.tables[0].cells[0].id).toBe(cells[first.nextOffset!].id)
  expect(Buffer.byteLength(stringifyRpcJson({ result: second }))).toBeLessThan(8_000_000)
})

it('cancels fallback checkpoint admission on disposal after storage goes missing', async () => {
  const { owner, table, path, blocked, extract } = await disposalFixture()
  await owner.run({ action: 'run', tableId: table.id })
  await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce())
  const before = await readFile(path, 'utf8')
  const failedWrite = vi.fn(async () => {
    initializeDataRootWriteAvailability(true)
    throw new Error('disk unavailable')
  })
  vi.mocked(writeDurableJsonFile).mockImplementationOnce(failedWrite)
  blocked.resolve()
  await vi.waitFor(() => expect(failedWrite).toHaveBeenCalledOnce())
  await waitForDataRootWriters()
  // The fallback now needs a fresh lease; it must not block owner shutdown.
  await new Promise<void>((resolve) => setImmediate(resolve))
  let disposed = false
  const closing = owner.dispose().then(() => {
    disposed = true
  })
  await vi.waitFor(() => expect(disposed).toBe(true), { timeout: 500 })
  await closing
  expect(await readFile(path, 'utf8')).toBe(before)
  initializeDataRootWriteAvailability(false)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(extract).toHaveBeenCalledOnce()
  expect(await readFile(path, 'utf8')).toBe(before)
})
