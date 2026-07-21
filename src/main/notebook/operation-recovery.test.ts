import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeOperationJournal, type RuntimeOperationRecord } from './operation-journal'
import {
  defaultOperationChildLiveness,
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
  operationChildLiveness: vi.fn().mockResolvedValue('dead'),
  terminateOperationChild: vi.fn().mockResolvedValue(undefined),
  cleanStaging: vi.fn().mockResolvedValue(undefined),
  verifyOrRebuildEnv: vi.fn().mockResolvedValue(undefined),
  markRepairRequired: vi.fn().mockResolvedValue(undefined),
  blockUnknownChildTarget: vi.fn().mockResolvedValue(undefined),
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
      operationChildLiveness: vi.fn().mockResolvedValue('alive'),
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

    expect(deps.operationChildLiveness).not.toHaveBeenCalled()
    expect(deps.terminateOperationChild).not.toHaveBeenCalled()
    expect(deps.verifyOrRebuildEnv).toHaveBeenCalledTimes(1)
  })

  it('on unknown liveness: BLOCKS the target, retains the journal, never cleans under a maybe-live writer', async () => {
    const journal = await newJournal()
    const rec = record({
      operationId: 'op-1',
      kind: 'materialize',
      runtimeId: 'default-python',
      childPid: 4242,
      targetPath: '/rt/envs/default-python'
    })
    await journal.begin(rec)
    const actions: string[] = []
    const blocked: string[] = []
    const deps = makeDeps({
      operationChildLiveness: vi.fn().mockResolvedValue('unknown'),
      blockUnknownChildTarget: vi.fn(async (r) => {
        blocked.push(r.runtimeId)
      }),
      onReconciled: (_r, action) => actions.push(action)
    })

    const reconciled = await reconcileInterruptedOperations(journal, deps)

    // Not reconciled, not killed, not cleaned/rebuilt — but the target IS blocked so a fresh op can't
    // race a possible survivor after the barrier opens, and the journal entry survives for a later boot.
    expect(reconciled).toEqual([])
    expect(deps.terminateOperationChild).not.toHaveBeenCalled()
    expect(deps.cleanStaging).not.toHaveBeenCalled()
    expect(deps.verifyOrRebuildEnv).not.toHaveBeenCalled()
    expect(blocked).toEqual(['default-python'])
    expect(actions).toEqual(['skipped-child-unknown'])
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['op-1'])
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

describe('defaultOperationChildLiveness (tri-state pid-reuse guard)', () => {
  it('reports a record with no childPid as dead', async () => {
    expect(await defaultOperationChildLiveness(record({ childPid: undefined }))).toBe('dead')
  })

  it('reports a gone pid as dead', async () => {
    // A pid that (essentially) never exists; process.kill(pid, 0) throws ESRCH.
    expect(await defaultOperationChildLiveness(record({ childPid: 2_147_483_646 }))).toBe('dead')
  })

  it('reports a live pid with no recorded start time as unknown (cannot rule out reuse)', async () => {
    // The old boolean check returned alive here and would SIGKILL it; tri-state refuses to guess.
    expect(
      await defaultOperationChildLiveness(
        record({ childPid: process.pid, childStartedAt: undefined })
      )
    ).toBe('unknown')
  })

  // Whether THIS environment can actually verify a pid's start time via `ps`. It can't on Windows (no
  // ps) and can't in a locked-down sandbox where `ps -o etime` is denied ("operation not permitted") —
  // in both, defaultOperationChildLiveness must return 'unknown' rather than guess. We probe it directly
  // (a live pid whose recorded start time matches the pid's real start resolves 'alive' only when ps
  // works) so the assertion below tracks the real capability instead of assuming it from
  // process.platform. Keeps the test green on Windows AND in a ps-restricted sandbox, per the repo's
  // sandbox-safe test rule.
  //
  // childStartedAt MUST be this worker's real start (Date.now() - uptime*1000), NOT Date.now(): the
  // guard compares the recorded value against the start time `ps` reports and only says 'alive' within
  // PID_REUSE_TOLERANCE_MS (10s). Passing Date.now() drifts by uptime*1000, so once the worker has run
  // >10s the probe would wrongly read 'dead' and conclude ps is unavailable — flaky on slow/long workers.
  // Using the real start keeps the delta ~0 so a working ps resolves 'alive' regardless of worker age.
  const canVerifyPidStartTime = async (): Promise<boolean> =>
    (await defaultOperationChildLiveness(
      record({ childPid: process.pid, childStartedAt: Date.now() - process.uptime() * 1000 })
    )) === 'alive'

  it('classifies a live pid whose start time is far from childStartedAt as REUSED when ps is available, else unknown', async () => {
    // This process is alive but we claim its child started in 1970. When ps can read the real (recent)
    // start time, the guard rejects the reused pid as 'dead' (never SIGKILLs an unrelated process). When
    // ps is unavailable/denied, it cannot verify identity and must fail safe to 'unknown'.
    const expected = (await canVerifyPidStartTime()) ? 'dead' : 'unknown'
    expect(
      await defaultOperationChildLiveness(record({ childPid: process.pid, childStartedAt: 0 }))
    ).toBe(expected)
  })
})
