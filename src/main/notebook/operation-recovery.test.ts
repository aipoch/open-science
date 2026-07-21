import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeOperationJournal, type RuntimeOperationRecord } from './operation-journal'
import {
  defaultOperationChildLiveness,
  reconcileInterruptedOperations,
  readProcessStartToken,
  type OperationRecoveryDeps,
  type ProcessStartTokenReader
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

const record = (over: Partial<RuntimeOperationRecord> = {}): RuntimeOperationRecord => {
  const base: RuntimeOperationRecord = {
    operationId: 'op-1',
    kind: 'download',
    runtimeId: 'python-3.12',
    phase: 'downloading',
    startedAt: 100,
    ...over
  }
  // Production writes childPid + childStartedAt ATOMICALLY (the journal now rejects a partial group), so
  // a fixture with a childPid must carry a start time too. Default it here unless the case set one
  // explicitly (including an explicit `undefined`, which the tokenless-liveness tests rely on).
  if (base.childPid !== undefined && !('childStartedAt' in over)) base.childStartedAt = 100
  return base
}

const makeDeps = (over: Partial<OperationRecoveryDeps> = {}): OperationRecoveryDeps => ({
  operationChildLiveness: vi.fn().mockResolvedValue('dead'),
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
    // Prefix-writing ops carry a childPid so liveness is probed (mock 'dead') and they reconcile; a
    // no-PID prefix-write would instead BLOCK (covered separately below).
    await journal.begin(
      record({ operationId: 'm', kind: 'materialize', runtimeId: 'default-python', childPid: 111 })
    )
    await journal.begin(
      record({ operationId: 'u', kind: 'upgrade', runtimeId: 'default-r', childPid: 112 })
    )
    await journal.begin(
      record({ operationId: 'i', kind: 'install', runtimeId: '/usr/bin/python3', childPid: 113 })
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

  it('BLOCKS (never kills or reconciles) a surviving orphan child instead of signalling it', async () => {
    // Design: recovery never auto-signals a possibly-live orphan (no strict "safe to kill" guarantee).
    // A live child surfaces as liveness 'unknown', so the op is blocked and its entry is LEFT for a
    // later boot that sees the pid gone — the env self-heals without recovery ever killing anything.
    const journal = await newJournal()
    await journal.begin(record({ kind: 'download', childPid: 4242, targetPath: '/rt/.incoming-a' }))
    const deps = makeDeps({
      operationChildLiveness: vi.fn().mockResolvedValue('unknown'),
      onReconciled: vi.fn()
    })

    await reconcileInterruptedOperations(journal, deps)

    expect(deps.blockUnknownChildTarget).toHaveBeenCalledTimes(1)
    expect(deps.cleanStaging).not.toHaveBeenCalled() // never reconcile under a possible writer
    expect(deps.onReconciled).toHaveBeenCalledWith(
      expect.objectContaining({ childPid: 4242 }),
      'skipped-child-unknown'
    )
    expect(await journal.pending()).toHaveLength(1) // entry left for a later boot
  })

  it('a no-childPid STAGING op (download) is treated dead and reconciled without a liveness probe', async () => {
    const journal = await newJournal()
    await journal.begin(record({ kind: 'download', targetPath: '/rt/.incoming-a' })) // no childPid
    const deps = makeDeps()

    await reconcileInterruptedOperations(journal, deps)

    // A download writes only throwaway staging, so a missing PID is safe to treat as dead: no probe,
    // no block, just clean the staging.
    expect(deps.operationChildLiveness).not.toHaveBeenCalled()
    expect(deps.cleanStaging).toHaveBeenCalledTimes(1)
    expect(await journal.pending()).toEqual([])
  })

  it('a no-childPid, no-sidecar PREFIX-WRITE is reconciled (child provably never spawned)', async () => {
    // The PID is persisted SYNCHRONOUSLY at spawn, so a record with neither a journaled PID nor a
    // sidecar reliably means the child never spawned — no live writer — safe to reconcile (no wall-clock
    // guessing, no permanent block).
    const journal = await newJournal()
    await journal.begin(
      record({
        kind: 'materialize',
        runtimeId: 'default-python',
        targetPath: '/rt/envs/default-python'
      })
    ) // no childPid, no hydrateInterruptedChild -> no sidecar
    const blocked: string[] = []
    const deps = makeDeps({
      blockUnknownChildTarget: vi.fn(async (r) => {
        blocked.push(r.runtimeId)
      })
    })

    const reconciled = await reconcileInterruptedOperations(journal, deps)

    expect(deps.operationChildLiveness).not.toHaveBeenCalled() // no PID to probe
    expect(deps.verifyOrRebuildEnv).toHaveBeenCalledTimes(1) // reconciled (rebuild-if-incomplete)
    expect(blocked).toEqual([]) // never blocked
    expect(reconciled.map((r) => r.operationId)).toEqual(['op-1'])
    expect(await journal.pending()).toEqual([]) // cleared
  })

  it('hydrates a missing childPid from the sidecar, then probes it (unknown -> BLOCK)', async () => {
    // A crash can lose the journal's async PID update; the synchronous sidecar still has it, so recovery
    // hydrates the record and probes — here liveness is unknown, so the target is blocked (not deleted).
    const journal = await newJournal()
    await journal.begin(
      record({
        kind: 'materialize',
        runtimeId: 'default-python',
        targetPath: '/rt/envs/default-python'
      })
    ) // no journaled childPid
    const blocked: string[] = []
    const deps = makeDeps({
      // The sidecar supplies the PID the async journal update lost.
      hydrateInterruptedChild: (r) =>
        r.childPid !== undefined ? r : { ...r, childPid: 4242, childStartedAt: 100 },
      operationChildLiveness: vi.fn().mockResolvedValue('unknown'),
      blockUnknownChildTarget: vi.fn(async (r) => {
        blocked.push(r.runtimeId)
      })
    })

    const reconciled = await reconcileInterruptedOperations(journal, deps)

    expect(deps.operationChildLiveness).toHaveBeenCalledTimes(1) // probed via the hydrated PID
    expect(deps.verifyOrRebuildEnv).not.toHaveBeenCalled() // not reconciled under a possible writer
    expect(blocked).toEqual(['default-python'])
    expect(reconciled).toEqual([])
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['op-1']) // retained
  })

  it('BLOCKS a spawn-intent record with no PID (spawned, PID never recorded) without probing', async () => {
    // The sidecar says { spawning: true } but no PID was ever converted — a crash in the spawn->record
    // window. A child MAY be live, so block (never reconcile), and do NOT probe (there is no PID).
    const journal = await newJournal()
    await journal.begin(
      record({
        kind: 'materialize',
        runtimeId: 'default-python',
        targetPath: '/rt/envs/default-python'
      })
    ) // no journaled childPid
    const blocked: string[] = []
    const deps = makeDeps({
      hydrateInterruptedChild: (r) =>
        r.childPid !== undefined ? r : { ...r, spawnAttempted: true },
      blockUnknownChildTarget: vi.fn(async (r) => {
        blocked.push(r.runtimeId)
      })
    })

    const reconciled = await reconcileInterruptedOperations(journal, deps)

    expect(deps.operationChildLiveness).not.toHaveBeenCalled() // no PID -> nothing to probe
    expect(deps.verifyOrRebuildEnv).not.toHaveBeenCalled()
    expect(blocked).toEqual(['default-python'])
    expect(reconciled).toEqual([])
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['op-1']) // retained
  })

  it('across two startups on the SAME journal: unknown blocks + retains, then dead reconciles + clears', async () => {
    // The block is a retained journal record, re-evaluated each startup. First startup can't confirm the
    // child died -> block + keep the record. A later startup, once the pid is gone, probes 'dead' ->
    // reconciles + clears the record, so it stops blocking. This is the bounded, PROVABLE recovery.
    const journal = await newJournal()
    await journal.begin(
      record({
        operationId: 'op-1',
        kind: 'materialize',
        runtimeId: 'default-python',
        targetPath: '/rt/envs/default-python',
        childPid: 4242,
        childStartedAt: 100
      })
    )

    // Startup 1: liveness unknown -> block, retain the record, do NOT reconcile.
    const blocked: string[] = []
    const first = await reconcileInterruptedOperations(
      journal,
      makeDeps({
        operationChildLiveness: vi.fn().mockResolvedValue('unknown'),
        blockUnknownChildTarget: vi.fn(async (r) => {
          blocked.push(r.runtimeId)
        })
      })
    )
    expect(first).toEqual([])
    expect(blocked).toEqual(['default-python'])
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['op-1']) // retained

    // Startup 2 (same journal): the pid is now gone -> dead -> reconcile + clear.
    const secondDeps = makeDeps({ operationChildLiveness: vi.fn().mockResolvedValue('dead') })
    const second = await reconcileInterruptedOperations(journal, secondDeps)
    expect(secondDeps.verifyOrRebuildEnv).toHaveBeenCalledTimes(1)
    expect(second.map((r) => r.operationId)).toEqual(['op-1'])
    expect(await journal.pending()).toEqual([]) // cleared -> no longer blocks
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

    // Not reconciled, not cleaned/rebuilt — but the target IS blocked so a fresh op can't race a
    // possible survivor after the barrier opens, and the journal entry survives for a later boot.
    expect(reconciled).toEqual([])
    expect(deps.cleanStaging).not.toHaveBeenCalled()
    expect(deps.verifyOrRebuildEnv).not.toHaveBeenCalled()
    expect(blocked).toEqual(['default-python'])
    expect(actions).toEqual(['skipped-child-unknown'])
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['op-1'])
  })

  it('leaves a failed op in the journal (retried next startup) without blocking the others', async () => {
    const journal = await newJournal()
    await journal.begin(record({ operationId: 'bad', kind: 'download' }))
    // 'good' carries a childPid so it's probed 'dead' and reconciled (a no-PID materialize would block).
    await journal.begin(record({ operationId: 'good', kind: 'materialize', childPid: 111 }))
    const deps = makeDeps({
      cleanStaging: vi.fn().mockRejectedValue(new Error('rm failed'))
    })

    const reconciled = await reconcileInterruptedOperations(journal, deps)

    expect(reconciled.map((r) => r.operationId)).toEqual(['good'])
    // The failed op is retained for a later attempt; the good one is cleared.
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['bad'])
  })
})

describe('defaultOperationChildLiveness (two-state pid-reuse guard: dead | unknown, never alive)', () => {
  it('reports a record with no childPid as dead', async () => {
    expect(await defaultOperationChildLiveness(record({ childPid: undefined }))).toBe('dead')
  })

  it('reports a gone pid as dead', async () => {
    // A pid that (essentially) never exists; process.kill(pid, 0) throws ESRCH.
    expect(await defaultOperationChildLiveness(record({ childPid: 2_147_483_646 }))).toBe('dead')
  })

  it('reports "unknown" (not dead) when the initial probe fails with something other than ESRCH/EPERM', async () => {
    // Only ESRCH (gone) and EPERM (exists, not ours to signal) justify 'dead'. An unexpected probe
    // failure (e.g. EINVAL) is NOT proof the child is gone — recovery/Reset must fail safe to 'unknown'
    // (block) rather than clean a prefix a live writer might still hold.
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('boom'), { code: 'EINVAL' })
    })
    try {
      expect(await defaultOperationChildLiveness(record({ childPid: 4242 }))).toBe('unknown')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports EPERM (exists, not ours) as dead just like ESRCH', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('perm'), { code: 'EPERM' })
    })
    try {
      expect(await defaultOperationChildLiveness(record({ childPid: 4242 }))).toBe('dead')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports a live pid with no recorded start time as unknown (cannot rule out reuse)', async () => {
    // The old boolean check returned alive here and would SIGKILL it; the two-state guard refuses to
    // guess — a live pid we can't prove reused is 'unknown' (block), never a signal.
    expect(
      await defaultOperationChildLiveness(
        record({ childPid: process.pid, childStartedAt: undefined })
      )
    ).toBe('unknown')
  })

  // A live pid (process.pid) with an injectable token reader, so the token branch is deterministic and
  // never depends on the sandbox's real /proc (and never signals a real process). The verdict is two-state
  // ('dead' | 'unknown'): a live pid is 'dead' ONLY on a monotonic-token MISMATCH (proven reuse), else it
  // is 'unknown' (block). There is NO wall-clock / ps fallback — that path was unsound (a clock step could
  // make a LIVE child look reused → wrongly reconciled), so it was removed entirely.
  const liveWith = (
    recordExtra: { childStartedAt?: number; childStartToken?: string },
    readToken: ProcessStartTokenReader = () => undefined
  ): Promise<'dead' | 'unknown'> =>
    defaultOperationChildLiveness(record({ childPid: process.pid, ...recordExtra }), readToken)

  describe('token path — a token can only FALSIFY (prove reuse), never authorize a kill', () => {
    it('reports DEAD when the live token DIFFERS (proven pid reuse)', async () => {
      // The one sound "dead" for a live pid: the boot-relative start tick changed → a different process
      // reused the pid → our child is provably gone → reconcile. (No signal is ever sent.)
      expect(await liveWith({ childStartToken: '80877' }, () => '99999')).toBe('dead')
    })

    it('reports UNKNOWN when the live token MATCHES (might be our orphan — block, never kill)', async () => {
      // A match means the pid COULD still be our orphan; the tick-coarse token is not strict identity, so
      // we never treat it as license to signal. Collapses to the same 'unknown' as an unreadable token.
      expect(await liveWith({ childStartToken: '80877' }, () => '80877')).toBe('unknown')
    })

    it('reports UNKNOWN when the recorded token cannot be re-read for the live pid', async () => {
      // Live read failed (permissions, race) → can't even falsify → block.
      expect(await liveWith({ childStartToken: '80877' }, () => undefined)).toBe('unknown')
    })

    it('DEMONSTRATES why non-canonical tokens must be rejected upstream: a raw compare misfires', async () => {
      // The liveness probe TRUSTS its input is canonical and compares tokens as raw strings. So a
      // leading-zero token "000123" reaches here it WOULD misread a value-equal live token "123" as a
      // mismatch → 'dead' (reconcile under a live worker). This is exactly why isValidChildStartToken
      // rejects "000123" as corrupt at the sidecar/journal boundary, so it can never reach this compare.
      expect(await liveWith({ childStartToken: '000123' }, () => '123')).toBe('dead') // the misfire we prevent upstream
      expect(await liveWith({ childStartToken: '123' }, () => '123')).toBe('unknown') // canonical: correctly blocks
    })
  })

  describe('tokenless live pid is ALWAYS unknown (no wall-clock fallback — the P1 fix)', () => {
    it('a live pid with no token is unknown regardless of any recorded start time', async () => {
      // The removed ps-window path used to call some of these 'dead' by comparing wall-clock times. That
      // was unsound: an NTP/manual clock step of a few seconds could push a still-running child outside
      // the window and get its prefix deleted/rebuilt underneath it. Now: tokenless live pid → unknown.
      expect(await liveWith({ childStartedAt: undefined })).toBe('unknown')
      expect(await liveWith({ childStartedAt: 1_700_000_000_000 })).toBe('unknown')
      expect(await liveWith({ childStartedAt: 0 })).toBe('unknown')
    })
  })

  it('never returns a kill-authorizing verdict for a real live pid (sandbox-safe smoke)', async () => {
    // Integration guard over the REAL token reader against this live test process (node/vitest). The
    // verdict must never be 'dead' — that would let recovery/Reset reconcile (delete/verify) under a live
    // process. We record THIS process's real token so on Linux the token path MATCHES → 'unknown'; on
    // macOS/Windows (or a /proc-restricted sandbox) there is no token → 'unknown'. Either way: 'unknown'.
    const verdict = await defaultOperationChildLiveness(
      record({ childPid: process.pid, childStartToken: readProcessStartToken(process.pid) })
    )
    expect(verdict).toBe('unknown')
  })

  describe('readProcessStartToken', () => {
    it('returns a stable non-empty token for a live pid on Linux, undefined elsewhere', () => {
      // Deterministic per platform: on Linux /proc/self/stat yields the same starttime tick on repeated
      // reads (identity is stable for a process's lifetime); off Linux there is no /proc so it is absent.
      const first = readProcessStartToken(process.pid)
      if (process.platform === 'linux') {
        expect(first).toMatch(/^\d+$/)
        expect(readProcessStartToken(process.pid)).toBe(first) // stable across reads
      } else {
        expect(first).toBeUndefined()
      }
    })

    it('returns undefined for a pid that does not exist', () => {
      expect(readProcessStartToken(2_147_483_646)).toBeUndefined()
    })
  })
})
