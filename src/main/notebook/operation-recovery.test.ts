import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeOperationJournal, type RuntimeOperationRecord } from './operation-journal'
import {
  defaultIsOperationChildAlive,
  reconcileInterruptedOperations,
  type OperationRecoveryDeps
} from './operation-recovery'

const roots: string[] = []
const newJournal = async (): Promise<RuntimeOperationJournal> => {
  const dir = await mkdtemp(join(tmpdir(), 'op-recovery-'))
  roots.push(dir)
  return new RuntimeOperationJournal(join(dir, 'operation-journal.json'))
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const record = (over: Partial<RuntimeOperationRecord> = {}): RuntimeOperationRecord => ({
  operationId: 'op-1',
  kind: 'download',
  runtimeId: 'python-3.12',
  phase: 'downloading',
  startedAt: 100,
  ...over
})

const makeDeps = (over: Partial<OperationRecoveryDeps> = {}): OperationRecoveryDeps => ({
  isOperationChildAlive: vi.fn().mockResolvedValue(false),
  terminateOperationChild: vi.fn().mockResolvedValue(undefined),
  cleanStaging: vi.fn().mockResolvedValue(undefined),
  verifyOrRebuildEnv: vi.fn().mockResolvedValue(undefined),
  markRepairRequired: vi.fn().mockResolvedValue(undefined),
  ...over
})

describe('reconcileInterruptedOperations', () => {
  it('dispatches each op kind to its reconcile action and clears the journal', async () => {
    const journal = await newJournal()
    await journal.begin(
      record({ operationId: 'd', kind: 'download', targetPath: '/rt/.incoming-a' })
    )
    await journal.begin(
      record({ operationId: 'm', kind: 'materialize', runtimeId: 'default-python' })
    )
    await journal.begin(record({ operationId: 'u', kind: 'upgrade', runtimeId: 'default-r' }))
    await journal.begin(
      record({ operationId: 'i', kind: 'install', runtimeId: '/usr/bin/python3' })
    )
    await journal.begin(
      record({ operationId: 'x', kind: 'disable', runtimeId: '/usr/bin/python3' })
    )

    const deps = makeDeps()
    const reconciled = await reconcileInterruptedOperations(journal, deps)

    expect(reconciled).toHaveLength(5)
    expect(deps.cleanStaging).toHaveBeenCalledTimes(1) // download
    expect(deps.verifyOrRebuildEnv).toHaveBeenCalledTimes(2) // materialize + upgrade
    expect(deps.markRepairRequired).toHaveBeenCalledTimes(1) // install
    // Every entry is cleared, so a second startup reconciles nothing.
    expect(await journal.pending()).toEqual([])
  })

  it('kills a surviving orphan child before reconciling', async () => {
    const journal = await newJournal()
    await journal.begin(record({ kind: 'download', childPid: 4242, targetPath: '/rt/.incoming-a' }))
    const order: string[] = []
    const deps = makeDeps({
      isOperationChildAlive: vi.fn().mockResolvedValue(true),
      terminateOperationChild: vi.fn().mockImplementation(async () => {
        order.push('kill')
      }),
      cleanStaging: vi.fn().mockImplementation(async () => {
        order.push('clean')
      })
    })

    await reconcileInterruptedOperations(journal, deps)

    expect(deps.terminateOperationChild).toHaveBeenCalledTimes(1)
    // Kill happens BEFORE cleaning staging (never clean under a live writer).
    expect(order).toEqual(['kill', 'clean'])
    expect(await journal.pending()).toEqual([])
  })

  it('does not check liveness or kill when no childPid was recorded', async () => {
    const journal = await newJournal()
    await journal.begin(record({ kind: 'materialize' })) // no childPid
    const deps = makeDeps()

    await reconcileInterruptedOperations(journal, deps)

    expect(deps.isOperationChildAlive).not.toHaveBeenCalled()
    expect(deps.terminateOperationChild).not.toHaveBeenCalled()
    expect(deps.verifyOrRebuildEnv).toHaveBeenCalledTimes(1)
  })

  it('leaves a failed op in the journal (retried next startup) without blocking the others', async () => {
    const journal = await newJournal()
    await journal.begin(record({ operationId: 'bad', kind: 'download' }))
    await journal.begin(record({ operationId: 'good', kind: 'materialize' }))
    const deps = makeDeps({
      cleanStaging: vi.fn().mockRejectedValue(new Error('rm failed'))
    })

    const reconciled = await reconcileInterruptedOperations(journal, deps)

    expect(reconciled.map((r) => r.operationId)).toEqual(['good'])
    // The failed op is retained for a later attempt; the good one is cleared.
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['bad'])
  })
})

describe('defaultIsOperationChildAlive (pid-reuse guard)', () => {
  it('reports a record with no childPid as not alive', async () => {
    expect(await defaultIsOperationChildAlive(record({ childPid: undefined }))).toBe(false)
  })

  it('reports a dead pid as not alive', async () => {
    // A pid that (essentially) never exists; process.kill(pid, 0) throws ESRCH.
    expect(await defaultIsOperationChildAlive(record({ childPid: 2_147_483_646 }))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'treats a live pid whose start time is far from childStartedAt as REUSED (not our child)',
    async () => {
      // This test process is alive, but we claim our child started in 1970 — ps will show a recent
      // start, so the guard must reject it rather than let recovery kill an unrelated process.
      expect(
        await defaultIsOperationChildAlive(record({ childPid: process.pid, childStartedAt: 0 }))
      ).toBe(false)
    }
  )
})
