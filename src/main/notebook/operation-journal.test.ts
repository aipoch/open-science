import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  bootTokenProvesReboot,
  isValidBootToken,
  listOperationChildren,
  readOperationChild,
  recordOperationChildSync,
  recordSpawnIntentSync,
  removeOperationChildSync,
  RuntimeOperationJournal,
  UNREADABLE_RUNTIME_DIR,
  type RuntimeOperationRecord
} from './operation-journal'

const roots: string[] = []
const journalPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'op-journal-'))
  roots.push(dir)
  return join(dir, 'runtime', 'operation-journal.json')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const record = (over: Partial<RuntimeOperationRecord> = {}): RuntimeOperationRecord => ({
  operationId: 'op-1',
  kind: 'materialize',
  runtimeId: 'default-python',
  phase: 'solving',
  startedAt: 100,
  ...over
})

describe('RuntimeOperationJournal', () => {
  it('records intent with begin() and reads it back with pending()', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    expect(await journal.pending()).toEqual([])

    await journal.begin(record({ targetPath: '/rt/packs/.incoming-x' }))
    const pending = await journal.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      operationId: 'op-1',
      kind: 'materialize',
      runtimeId: 'default-python',
      targetPath: '/rt/packs/.incoming-x'
    })
  })

  it('complete() removes an operation and deletes the file once the last one clears', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await journal.begin(record({ operationId: 'a' }))
    await journal.begin(record({ operationId: 'b', runtimeId: 'my-analysis' }))
    expect(existsSync(path)).toBe(true)

    await journal.complete('a')
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['b'])
    expect(existsSync(path)).toBe(true)

    await journal.complete('b')
    expect(await journal.pending()).toEqual([])
    // The file is removed entirely, so "no file" unambiguously means "nothing in flight".
    expect(existsSync(path)).toBe(false)
    // complete() is idempotent.
    await journal.complete('b')
    expect(await journal.pending()).toEqual([])
  })

  it('begin() with an existing operationId replaces it (idempotent re-begin)', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    await journal.begin(record({ phase: 'solving' }))
    await journal.begin(record({ phase: 'downloading' }))
    const pending = await journal.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].phase).toBe('downloading')
  })

  it('update() patches an in-flight op (phase/childPid) and no-ops for an unknown id', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    await journal.begin(record())
    await journal.update('op-1', { phase: 'downloading', childPid: 4242, childStartedAt: 111 })
    expect(await journal.pending()).toEqual([
      expect.objectContaining({ operationId: 'op-1', phase: 'downloading', childPid: 4242 })
    ])

    await journal.update('missing', { phase: 'x' })
    expect((await journal.pending())[0].phase).toBe('downloading')
  })

  it('hasRuntimeOperation() guards against a second op on the same runtime', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    await journal.begin(record({ operationId: 'a', runtimeId: 'default-python' }))
    expect(await journal.hasRuntimeOperation('default-python')).toBe(true)
    expect(await journal.hasRuntimeOperation('default-r')).toBe(false)
  })

  it('treats a missing or corrupt journal as empty (best-effort recovery)', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    // Missing file.
    expect(await journal.pending()).toEqual([])
    // Corrupt content + non-record entries are dropped, never thrown.
    await journal.begin(record())
    await writeFile(path, '{ not json', 'utf8')
    expect(await journal.pending()).toEqual([])
  })

  it('begin() throws on a corrupt journal instead of overwriting it (fail closed)', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{ not json', 'utf8')
    // Overwriting would destroy the unreadable in-flight state; every prefix-writing caller begins
    // fail-closed, so begin() must refuse rather than clobber it.
    await expect(journal.begin(record({ operationId: 'op-1' }))).rejects.toThrow(
      /RUNTIME_JOURNAL_CORRUPT/
    )
    // The corrupt file is preserved (not overwritten) for a later boot / Reset.
    expect(await readFile(path, 'utf8')).toBe('{ not json')
  })

  it('readState distinguishes an absent journal from a corrupt one (recovery fail-safe)', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    // Absent -> empty records (nothing was in flight), NOT corrupt.
    expect(await journal.readState()).toEqual({ records: [] })
    // A readable JSON array -> its (valid) records.
    await journal.begin(record({ operationId: 'op-1' }))
    const ok = await journal.readState()
    expect(ok).not.toBe('corrupt')
    expect(ok === 'corrupt' ? [] : ok.records).toHaveLength(1)
    // Present but unparseable -> corrupt (recovery must fail safe, not read as "nothing in flight").
    await writeFile(path, '{ not json', 'utf8')
    expect(await journal.readState()).toBe('corrupt')
    // A non-array JSON value is also corrupt.
    await writeFile(path, '{"operationId":"x"}', 'utf8')
    expect(await journal.readState()).toBe('corrupt')
    // pending() still degrades to empty on corrupt (best-effort for the non-recovery callers).
    expect(await journal.pending()).toEqual([])
  })

  it('treats a journal with ANY invalid entry as corrupt, not a healthy journal missing that entry', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await mkdir(dirname(path), { recursive: true })
    // [{}] parses fine and is an array, but its one element isn't a valid record. Silently filtering it
    // out would read this as a healthy EMPTY journal — opening the recovery barrier and letting the next
    // begin() overwrite whatever evidence the invalid entry represented. Any bad element must corrupt
    // the WHOLE journal instead.
    await writeFile(path, JSON.stringify([{}]), 'utf8')
    expect(await journal.readState()).toBe('corrupt')
    expect(await journal.pending()).toEqual([])
    await expect(journal.begin(record({ operationId: 'op-1' }))).rejects.toThrow(
      /RUNTIME_JOURNAL_CORRUPT/
    )
  })

  it('treats a record with a PRESENT-but-malformed childStartToken as corrupt (fail-closed)', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await mkdir(dirname(path), { recursive: true })
    // A full child group but a token that isn't our decimal form. Accepting it would let a garbage token
    // reach the reuse check and spuriously read as 'dead' (reconcile under a live worker). It must
    // invalidate the record → whole journal corrupt (same rule as any other invalid entry).
    const child = { childPid: 4242, childStartedAt: 111 }
    await writeFile(
      path,
      JSON.stringify([{ ...record({ operationId: 'op-1' }), ...child, childStartToken: 'nope' }]),
      'utf8'
    )
    expect(await journal.readState()).toBe('corrupt')
    // A valid decimal token in a full child group is fine and round-trips.
    await writeFile(
      path,
      JSON.stringify([{ ...record({ operationId: 'op-1' }), ...child, childStartToken: '80877' }]),
      'utf8'
    )
    const ok = await journal.readState()
    expect(ok === 'corrupt' ? [] : ok.records[0].childStartToken).toBe('80877')
  })

  it('treats PARTIAL child metadata (a lifecycle field without childPid) as corrupt', async () => {
    // The child fields (childPid, childStartedAt, childStartToken) are written ATOMICALLY at spawn, so a
    // record has either NO child fields or the full group. A stray childStartedAt / childStartToken with
    // NO childPid can't be something we wrote — and worse, recovery treats "no childPid + no
    // spawnAttempted" as DEAD and reconciles, so orphaned start metadata would be silently reconciled as
    // "never spawned". It must corrupt the whole journal (block) instead. Likewise a pid with no start time.
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await mkdir(dirname(path), { recursive: true })
    const partials = [
      { childStartedAt: 1 },
      { childStartToken: '80877' },
      { childStartedAt: 1, childStartToken: '80877' },
      { childPid: 4242 } // pid without the start time it is always written with
    ]
    for (const partial of partials) {
      await writeFile(
        path,
        JSON.stringify([{ ...record({ operationId: 'op-1' }), ...partial }]),
        'utf8'
      )
      expect(await journal.readState()).toBe('corrupt')
    }
    // The all-absent shape (op never recorded a pid) is the OTHER valid shape and must round-trip.
    await writeFile(path, JSON.stringify([record({ operationId: 'op-1' })]), 'utf8')
    const ok = await journal.readState()
    expect(ok === 'corrupt' ? undefined : ok.records[0].childPid).toBeUndefined()
  })

  it('quarantineCorrupt moves the journal aside so a fresh begin() succeeds again', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await mkdir(dirname(path), { recursive: true })
    // Nothing to move yet -> false, not an error.
    expect(await journal.quarantineCorrupt()).toBe(false)
    await writeFile(path, '{ not json', 'utf8')
    expect(await journal.readState()).toBe('corrupt')

    expect(await journal.quarantineCorrupt()).toBe(true)

    // The corrupt content is preserved under a sibling path, not deleted...
    expect(existsSync(path)).toBe(false)
    // ...and begin() now succeeds against a clean (absent) journal.
    await journal.begin(record({ operationId: 'op-1' }))
    expect(await journal.pending()).toHaveLength(1)
  })

  it('serializes overlapping begins so concurrent writes never lose an entry', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        journal.begin(record({ operationId: `op-${i}`, runtimeId: `rt-${i}` }))
      )
    )
    const pending = await journal.pending()
    expect(pending).toHaveLength(8)
    // The persisted file is valid JSON (no torn write) with all 8 records.
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(8)
  })

  it('forPath() returns the one shared instance per path so callers share a save queue', async () => {
    const path = await journalPath()
    const a = RuntimeOperationJournal.forPath(path)
    const b = RuntimeOperationJournal.forPath(path)
    expect(a).toBe(b)
    expect(RuntimeOperationJournal.forPath(await journalPath())).not.toBe(a)
  })

  it('begins from separate forPath() callers on one path never lose an entry', async () => {
    const path = await journalPath()
    // Mimics the real callers (download / materialize / install) each resolving a journal for the same
    // path and beginning concurrently. With per-instance `new` their private queues would read the same
    // stale journal and clobber each other; the shared forPath() queue serializes them.
    await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        RuntimeOperationJournal.forPath(path).begin(
          record({ operationId: `op-${i}`, runtimeId: `rt-${i}` })
        )
      )
    )
    expect(await RuntimeOperationJournal.forPath(path).pending()).toHaveLength(8)
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(8)
  })
})

describe('operation child-PID sidecar', () => {
  const runtimeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'op-child-'))
    roots.push(dir)
    return dir
  }

  it('records a spawn intent (with a boot token when available), then converts it to a child PID', async () => {
    const root = await runtimeRoot()
    recordSpawnIntentSync(root, 'op-1')
    const intent = readOperationChild(root, 'op-1')
    // Always a spawning intent; on Linux it also carries a boot_id (a valid UUID), absent elsewhere. Not
    // asserting the exact bootToken keeps this green cross-platform and in a /proc-restricted sandbox.
    expect(intent).toMatchObject({ spawning: true })
    if (intent !== 'corrupt' && intent !== undefined && 'spawning' in intent && intent.bootToken)
      expect(isValidBootToken(intent.bootToken)).toBe(true)
    // onChild converts the intent to the real PID.
    recordOperationChildSync(root, 'op-1', { childPid: 4242, childStartedAt: 111 })
    expect(readOperationChild(root, 'op-1')).toEqual({ childPid: 4242, childStartedAt: 111 })
  })

  it('returns undefined when no sidecar exists (op never reached the spawn stage)', async () => {
    const root = await runtimeRoot()
    expect(readOperationChild(root, 'never')).toBeUndefined()
  })

  it('recording throws (fail-closed) when the sidecar cannot be written', async () => {
    // A path whose parent is a FILE can't hold a child file; the sync write must throw so the caller
    // refuses to spawn / kills the child rather than proceeding unrecorded.
    const root = await runtimeRoot()
    await writeFile(join(root, 'not-a-dir'), 'x')
    expect(() => recordSpawnIntentSync(join(root, 'not-a-dir'), 'op-1')).toThrow()
  })

  it('removeOperationChildSync clears the sidecar (and is a no-op when already gone)', async () => {
    const root = await runtimeRoot()
    recordOperationChildSync(root, 'op-1', { childPid: 7, childStartedAt: 1 })
    removeOperationChildSync(root, 'op-1')
    expect(readOperationChild(root, 'op-1')).toBeUndefined()
    expect(() => removeOperationChildSync(root, 'op-1')).not.toThrow()
  })

  it('reads an EXISTING but corrupt sidecar as "corrupt" (fail-safe -> block), not absent', async () => {
    const root = await runtimeRoot()
    await writeFile(join(root, 'operation-child-op-1.json'), '{ not valid json')
    expect(readOperationChild(root, 'op-1')).toBe('corrupt')
  })

  it('treats a non-number childStartedAt as corrupt (a string time would NaN the pid-reuse guard)', async () => {
    const root = await runtimeRoot()
    await writeFile(
      join(root, 'operation-child-op-1.json'),
      JSON.stringify({ childPid: 4242, childStartedAt: 'not-a-number' })
    )
    expect(readOperationChild(root, 'op-1')).toBe('corrupt')
  })

  it('reads a valid PID state only when BOTH fields are finite numbers', async () => {
    const root = await runtimeRoot()
    recordOperationChildSync(root, 'op-1', { childPid: 4242, childStartedAt: 111 })
    expect(readOperationChild(root, 'op-1')).toEqual({ childPid: 4242, childStartedAt: 111 })
  })

  it('carries a VALID decimal childStartToken through', async () => {
    const root = await runtimeRoot()
    recordOperationChildSync(root, 'op-1', {
      childPid: 4242,
      childStartedAt: 111,
      childStartToken: '80877'
    })
    expect(readOperationChild(root, 'op-1')).toEqual({
      childPid: 4242,
      childStartedAt: 111,
      childStartToken: '80877'
    })
  })

  it('treats a PRESENT-but-malformed childStartToken as corrupt (fail-closed), never tokenless', async () => {
    // "bad" is JSON-legal but not a token we could have produced (readProcessStartToken only emits
    // CANONICAL decimals). "000123" is the subtle one: a leading-zero decimal is equal-in-value to the
    // live pid's "123" but NOT string-equal, so the byte-comparison reuse check would spuriously mismatch
    // and misread a live child as reused → 'dead'. Dropping any of these to the tokenless path would let
    // it masquerade as a legitimately tokenless record; all must fail closed to 'corrupt' (block).
    const root = await runtimeRoot()
    for (const bad of ['bad', '80877x', '', '-5', '3.5', '000123', '007', '0x1f']) {
      await writeFile(
        join(root, 'operation-child-op-1.json'),
        JSON.stringify({ childPid: 4242, childStartedAt: 111, childStartToken: bad })
      )
      expect(readOperationChild(root, 'op-1')).toBe('corrupt')
    }
  })

  it('treats a CONTRADICTORY {spawning + childPid} sidecar as corrupt (mutually-exclusive states)', async () => {
    // A blob carrying BOTH spawning:true and a childPid is corruption/tampering: the two states are
    // mutually exclusive. Accepting the pid alongside spawning would let a forged pid ride in, probe
    // ESRCH, and let Reset SKIP the no-PID reboot gate. It must fail closed to 'corrupt' (block).
    const root = await runtimeRoot()
    await writeFile(
      join(root, 'operation-child-op-1.json'),
      JSON.stringify({ spawning: true, childPid: 4242, childStartedAt: 111 })
    )
    expect(readOperationChild(root, 'op-1')).toBe('corrupt')
  })

  it('treats a non-positive / non-integer childPid as corrupt (never a probeable pid)', async () => {
    // 0 and negatives have special process.kill semantics (process group / "any process"), and a
    // non-safe-integer is not a real pid — any of them could make a liveness probe signal the wrong
    // target or spuriously succeed, bypassing the reboot gate. All must fail closed to 'corrupt'.
    const root = await runtimeRoot()
    for (const bad of [0, -1, -4242, 3.5, Number.MAX_SAFE_INTEGER + 1, 'x']) {
      await writeFile(
        join(root, 'operation-child-op-1.json'),
        JSON.stringify({ childPid: bad, childStartedAt: 111 })
      )
      expect(readOperationChild(root, 'op-1')).toBe('corrupt')
    }
  })

  it('treats a neither-shape sidecar (no spawning, no childPid) as corrupt', async () => {
    const root = await runtimeRoot()
    await writeFile(join(root, 'operation-child-op-1.json'), JSON.stringify({ bootToken: 'x' }))
    expect(readOperationChild(root, 'op-1')).toBe('corrupt')
  })

  it('treats a non-finite childStartedAt as corrupt for a PID state', async () => {
    // JSON can't hold NaN/Infinity, but null / a string can appear via tampering; childStartedAt must be
    // a finite number when a pid is present (it is a real timestamp), else fail closed.
    const root = await runtimeRoot()
    for (const bad of [null, 'soon', {}]) {
      await writeFile(
        join(root, 'operation-child-op-1.json'),
        JSON.stringify({ childPid: 4242, childStartedAt: bad })
      )
      expect(readOperationChild(root, 'op-1')).toBe('corrupt')
    }
  })

  it('enforces EXACT shape: a bootToken on the PID variant is corrupt (intent-only field)', async () => {
    // bootToken belongs ONLY to the {spawning} intent variant. On a recorded pid it is a foreign field:
    // accepting it would let a pid ride alongside intent metadata, probe ESRCH, and skip the no-PID reboot
    // gate. A well-formed boot_id must NOT rescue it — the mere presence of the field is corruption.
    const root = await runtimeRoot()
    await writeFile(
      join(root, 'operation-child-op-1.json'),
      JSON.stringify({
        childPid: 4242,
        childStartedAt: 111,
        bootToken: '11111111-1111-4111-8111-111111111111'
      })
    )
    expect(readOperationChild(root, 'op-1')).toBe('corrupt')
  })

  it('enforces EXACT shape: a PID-variant field on the {spawning} intent is corrupt', async () => {
    // The intent variant carries ONLY {spawning, bootToken?}. A childStartedAt / childStartToken here is a
    // PID-variant field bleeding in (torn write / tampering); it must fail closed, never be salvaged into
    // a {spawning} intent that silently drops the stray pid metadata.
    const root = await runtimeRoot()
    for (const stray of [{ childStartedAt: 111 }, { childStartToken: '80877' }]) {
      await writeFile(
        join(root, 'operation-child-op-1.json'),
        JSON.stringify({ spawning: true, ...stray })
      )
      expect(readOperationChild(root, 'op-1')).toBe('corrupt')
    }
  })

  it('carries a VALID boot_id on the spawning intent, and fails a malformed one closed to corrupt', async () => {
    const root = await runtimeRoot()
    const boot = '11111111-1111-4111-8111-111111111111'
    await writeFile(
      join(root, 'operation-child-op-1.json'),
      JSON.stringify({ spawning: true, bootToken: boot })
    )
    expect(readOperationChild(root, 'op-1')).toEqual({ spawning: true, bootToken: boot })
    // Present-but-malformed boot token → corrupt (block), never silently dropped to a tokenless intent.
    await writeFile(
      join(root, 'operation-child-op-1.json'),
      JSON.stringify({ spawning: true, bootToken: 'nope' })
    )
    expect(readOperationChild(root, 'op-1')).toBe('corrupt')
  })
})

describe('listOperationChildren (journal-independent sidecar scan)', () => {
  const runtimeRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'op-list-'))
    roots.push(dir)
    return dir
  }

  it('returns [] when the root does not exist', async () => {
    expect(listOperationChildren(join(tmpdir(), 'op-list-absent-xyz'))).toEqual([])
  })

  it('enumerates every child sidecar by operationId, surfacing corrupt ones (fail-safe)', async () => {
    const root = await runtimeRoot()
    recordOperationChildSync(root, 'has-pid', { childPid: 7, childStartedAt: 1 })
    await writeFile(join(root, 'operation-child-spawn.json'), JSON.stringify({ spawning: true }))
    await writeFile(join(root, 'operation-child-bad.json'), '{ not json')
    await writeFile(join(root, 'operation-journal.json'), '[]') // NOT a child sidecar — must be ignored

    const found = listOperationChildren(root)
    expect(found).toHaveLength(3)
    expect(found.find((f) => f.operationId === 'has-pid')?.state).toEqual({
      childPid: 7,
      childStartedAt: 1
    })
    expect(found.find((f) => f.operationId === 'spawn')?.state).toEqual({ spawning: true })
    // A corrupt sidecar is surfaced (recovery/Reset must treat it as a possible live writer), not dropped.
    expect(found.find((f) => f.operationId === 'bad')?.state).toBe('corrupt')
  })

  it('fails CLOSED (corrupt sentinel) when the directory cannot be READ — NOT treated as empty', async () => {
    // Only ENOENT proves "nothing ever spawned". Any other errno (EACCES/EIO/EMFILE/ENOTDIR/…) is not
    // proof of absence — sidecars for live installers may exist but be unreadable — so listing must
    // surface a corrupt sentinel that makes the Reset guard REFUSE, never an empty list (the old bug that
    // let a corrupt-journal Reset quarantine + delete a prefix under a possibly-live writer). We simulate
    // a non-ENOENT failure by pointing at a FILE, not a directory (readdirSync → ENOTDIR).
    const asFile = join(await runtimeRoot(), 'not-a-dir')
    await writeFile(asFile, 'x')
    const found = listOperationChildren(asFile)
    expect(found).toHaveLength(1)
    expect(found[0].state).toBe('corrupt')
    expect(found[0].operationId).toBe(UNREADABLE_RUNTIME_DIR)
  })
})

describe('bootTokenProvesReboot (authoritative boot_id only — no wall-clock heuristic)', () => {
  const A = '11111111-1111-4111-8111-111111111111' // two distinct, well-formed boot_id UUIDs
  const B = '22222222-2222-4222-8222-222222222222'

  it('is false when either token is missing (absence can never ASSERT a reboot)', () => {
    expect(bootTokenProvesReboot(undefined, A)).toBe(false)
    expect(bootTokenProvesReboot(A, undefined)).toBe(false)
    expect(bootTokenProvesReboot(undefined, undefined)).toBe(false)
  })

  it('proves a reboot ONLY for two valid-but-DIFFERENT boot_id UUIDs; identical does not', () => {
    expect(bootTokenProvesReboot(A, B)).toBe(true)
    expect(bootTokenProvesReboot(A, A)).toBe(false)
  })

  it('is false when EITHER token is malformed (never compares garbage as a boot identity)', () => {
    // A different-but-malformed string must NOT read as a reboot — the old loose "any different value"
    // rule was exactly the P1 hole. Both sides must be well-formed boot_id UUIDs.
    expect(bootTokenProvesReboot('not-a-uuid', A)).toBe(false)
    expect(bootTokenProvesReboot(A, 'nope')).toBe(false)
    expect(bootTokenProvesReboot('up:1000', 'up:9000')).toBe(false) // legacy up: scheme no longer honored
    expect(bootTokenProvesReboot('', A)).toBe(false)
  })

  it('does NOT read a case-only difference as a reboot (same UUID, different letter case)', () => {
    // The kernel emits boot_id lowercase and the comparison is case-SENSITIVE. An uppercased copy of the
    // SAME UUID is the same boot, so it must never prove a reboot. We reject uppercase up front, so such a
    // token is malformed on BOTH sides and the guard stays false (never a spurious no-PID Reset).
    const upper = A.toUpperCase()
    expect(bootTokenProvesReboot(A, upper)).toBe(false) // recorded lowercase, "current" uppercased-same
    expect(bootTokenProvesReboot(upper, A)).toBe(false)
    expect(bootTokenProvesReboot(upper, upper)).toBe(false)
  })
})

describe('isValidBootToken', () => {
  it('accepts only a well-formed LOWERCASE boot_id UUID', () => {
    expect(isValidBootToken('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isValidBootToken('abcdef01-2345-6789-abcd-ef0123456789')).toBe(true)
    // Uppercase / mixed-case hex is rejected: the kernel never emits it, and accepting it would let a
    // case-only rewrite of the current boot_id compare unequal (case-sensitive) and fake a reboot.
    expect(isValidBootToken('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(false)
    expect(isValidBootToken('11111111-1111-4111-8111-11111111111A')).toBe(false)
    expect(isValidBootToken('up:1000')).toBe(false)
    expect(isValidBootToken('11111111-1111-4111-8111')).toBe(false)
    expect(isValidBootToken('')).toBe(false)
    expect(isValidBootToken(undefined)).toBe(false)
    expect(isValidBootToken(42)).toBe(false)
  })
})
