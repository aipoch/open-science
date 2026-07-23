import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The journal file for a runtime root (<storageRoot>/runtime). Derived from the root so the write side
// (provisioner/fetch) and the startup recovery side agree on one path without sharing an instance.
export const operationJournalPath = (runtimeRoot: string): string =>
  join(runtimeRoot, 'operation-journal.json')

// A childStartToken is ONLY ever written by readProcessStartToken as a CANONICAL decimal string (Linux
// /proc/<pid>/stat field 22, which the kernel emits with no leading zeros). So the ONLY value we accept
// back is that exact canonical shape. A present-but-other value — the JSON-legal string "bad", OR a
// non-canonical decimal like "000123" — is NOT a token we could have produced. Leading zeros are the
// subtle case: "000123" reads as equal-in-value to the live pid's "123" but is NOT string-equal, so the
// reuse check (a byte comparison) would spuriously MISMATCH and misread a live child as reused → 'dead',
// reconciling/deleting under a possibly-live worker. Rejecting non-canonical decimals up front closes
// that. Callers treat an invalid token as: sidecar → 'corrupt' (block), journal record → invalid (whole
// journal corrupt). Fail-closed.
export const isValidChildStartToken = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)

// A recorded childPid must be a POSITIVE safe integer — a real OS pid. Rejecting 0/negative/non-integer
// (0 and negatives have special process.kill semantics — process groups / "any process" — and would make
// a liveness probe signal the wrong target or spuriously succeed) closes a forgery path: a corrupt sidecar
// can't smuggle a bogus pid that probes ESRCH and lets Reset skip the reboot gate.
export const isValidChildPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

// An AUTHORITATIVE machine-boot identity, used as the sole proof force-Reset accepts that an unprobeable
// no-PID orphan is gone. We use ONLY the Linux kernel boot_id (/proc/sys/kernel/random/boot_id) — a random
// UUID the kernel regenerates on every boot, so a changed value is hard proof the box rebooted. We do NOT
// derive anything from the wall clock or uptime: `now − uptime()` moves when NTP/manual time steps within
// a single boot, and os.uptime() on macOS is itself wall-clock-derived, so either could FALSELY read as a
// reboot and delete a prefix a live orphan still holds. Returns undefined off Linux or when boot_id can't
// be read; callers MUST then refuse (never assume a reboot). This means the no-PID force-Reset escape
// hatch is Linux-only — macOS/Windows have no pure-runtime authoritative boot identity, so there we keep
// the record blocked rather than risk a wrong deletion.
//
// LOWERCASE ONLY, deliberately: the kernel emits boot_id as a lowercase UUID, and bootTokenProvesReboot
// compares the two tokens as raw strings (case-SENSITIVE). If we accepted uppercase hex here, a persisted
// token that differs from the current one by letter case alone would be the SAME boot yet compare unequal
// — a spurious "reboot" that would wrongly clear a no-PID orphan's block. Restricting the accepted shape
// to the kernel's actual lowercase output makes the string comparison exact without a normalization step.
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const readBootToken = (): string | undefined => {
  if (process.platform !== 'linux') return undefined
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return BOOT_ID_RE.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

// A persisted bootToken must be exactly a kernel boot_id UUID. Anything else (present but malformed) is
// corruption/tampering and is rejected up front, so a garbage value can never be compared as if it were a
// real boot identity (which could otherwise read as a spurious reboot).
export const isValidBootToken = (value: unknown): value is string =>
  typeof value === 'string' && BOOT_ID_RE.test(value)

// Whether `current` proves the machine rebooted since `recorded`. Fail-CLOSED: both must be present and
// well-formed boot_id UUIDs; a reboot is proven ONLY by two valid-but-different UUIDs. Missing or malformed
// either side → false (Reset refuses rather than delete a prefix a survivor might hold). This is exact
// (no heuristic, no timing window): boot_id cannot repeat across boots, so there are no false positives.
export const bootTokenProvesReboot = (
  recorded: string | undefined,
  current: string | undefined
): boolean => isValidBootToken(recorded) && isValidBootToken(current) && recorded !== current

// A per-operation SYNCHRONOUS sidecar that tracks the spawn lifecycle so recovery can tell, without a
// live wall-clock guess, whether a crashed op could still have a live child:
//   - absent            -> the op never reached the spawn stage (crashed during begin/prep) — no child.
//   - { spawning: true } -> we were about to spawn / had just spawned but never recorded a PID — a child
//                          MAY be alive, so recovery must BLOCK (never reconcile under a possible writer).
//   - { childPid, … }    -> the child's PID is provably persisted — recovery probes it (tri-state).
// Writes are synchronous (durable before the spawning code path yields) and FAIL-CLOSED: recording
// throws on failure so the caller can refuse to spawn / kill the child rather than proceed unrecorded.
// childStartToken (when present): a per-boot-stable kernel process identity captured at spawn (see
// readProcessStartToken). It is used ONLY to FALSIFY reuse (a mismatch proves the pid is gone); a match is
// never treated as license to signal. childStartedAt is retained for diagnostics but is NOT used for
// liveness (a wall-clock value can't soundly prove a live pid dead). Both optional (absent off Linux /
// legacy).
// bootToken (on the {spawning} intent): the machine boot_id at spawn time (see readBootToken). It lives in
// the sidecar — not just the journal — so force-Reset can prove a reboot even when the journal is corrupt/
// unreadable. Absent off Linux (there the no-PID escape stays blocked).
export type OperationChildState =
  | { spawning: true; bootToken?: string }
  | { childPid: number; childStartedAt: number; childStartToken?: string }

const operationChildPath = (runtimeRoot: string, operationId: string): string =>
  join(runtimeRoot, `operation-child-${operationId}.json`)

const writeChildStateSync = (
  runtimeRoot: string,
  operationId: string,
  state: OperationChildState
): void => {
  // Atomic temp+rename so a crash mid-write can't leave a torn sidecar that reads as neither state.
  mkdirSync(runtimeRoot, { recursive: true })
  const path = operationChildPath(runtimeRoot, operationId)
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(state), 'utf8')
  renameSync(temp, path)
}

// Records the intent to spawn BEFORE spawning. Throws on failure (fail-closed): if we can't record the
// intent we must not spawn, or a crash would leave a live child recovery can't account for. Captures the
// machine boot_id (Linux) so a later force-Reset can prove the box rebooted — and thus that a crash-window
// orphan whose PID never landed is gone — WITHOUT depending on the (possibly corrupt) journal.
export const recordSpawnIntentSync = (runtimeRoot: string, operationId: string): void => {
  writeChildStateSync(runtimeRoot, operationId, { spawning: true, bootToken: readBootToken() })
}

// Records the spawned child's PID, converting the intent. Throws on failure (fail-closed): the caller
// must then kill the just-spawned child and fail, rather than leave an unrecorded orphan.
export const recordOperationChildSync = (
  runtimeRoot: string,
  operationId: string,
  child: { childPid: number; childStartedAt: number; childStartToken?: string }
): void => {
  writeChildStateSync(runtimeRoot, operationId, child)
}

// Reads a sidecar, distinguishing three cases the recovery side treats differently:
//   - undefined  : the file is genuinely ABSENT (ENOENT) — the op never reached the spawn stage, so it
//                  is safe to reconcile.
//   - 'corrupt'  : the file EXISTS but couldn't be read/parsed or has an invalid shape. This is NOT
//                  proof of "never spawned", so recovery must fail SAFE and BLOCK (a child may be live).
//   - a state    : { spawning: true } or a fully-valid { childPid, childStartedAt } (BOTH must be finite
//                  numbers — a string/NaN start time would break the pid-reuse guard and misjudge dead).
export const readOperationChild = (
  runtimeRoot: string,
  operationId: string
): OperationChildState | 'corrupt' | undefined => {
  let raw: string
  try {
    raw = readFileSync(operationChildPath(runtimeRoot, operationId), 'utf8')
  } catch (error) {
    // Only a genuine "not found" means the op never spawned. Any other read failure (permissions, I/O)
    // is not proof of absence — fail safe to corrupt so recovery blocks rather than assuming no child.
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    return 'corrupt'
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return 'corrupt'
    const { spawning, childPid, childStartedAt, childStartToken, bootToken } = parsed as {
      spawning?: unknown
      childPid?: unknown
      childStartedAt?: unknown
      childStartToken?: unknown
      bootToken?: unknown
    }
    // The two states are MUTUALLY EXCLUSIVE: a sidecar is either a {spawning} intent (no pid yet) or a
    // recorded {childPid} — never both. A blob carrying spawning:true AND a childPid is contradictory
    // (corruption/tampering) and must fail CLOSED, or a forged pid could ride alongside spawning:true,
    // probe ESRCH, and let Reset skip the no-PID reboot gate. Decide by which key is present, then require
    // that state's shape to be exactly valid; any mismatch → 'corrupt' (block), never "never spawned".
    const hasSpawning = spawning !== undefined
    const hasPid = childPid !== undefined
    if (hasSpawning === hasPid) return 'corrupt' // neither, or both → not a recognized single state
    if (hasSpawning) {
      if (spawning !== true) return 'corrupt'
      // EXACT shape: the intent variant carries ONLY {spawning, bootToken?}. A childStartedAt/childStartToken
      // here is a PID-variant field bleeding into an intent (corruption/tampering); fail CLOSED so a torn
      // or forged blob can never be salvaged into a state it doesn't cleanly match.
      if (childStartedAt !== undefined || childStartToken !== undefined) return 'corrupt'
      // A bootToken PRESENT but not a valid boot_id is corruption — fail CLOSED. Absent is fine (off
      // Linux): the no-PID escape then just stays blocked (bootTokenProvesReboot needs both sides).
      if (bootToken !== undefined && !isValidBootToken(bootToken)) return 'corrupt'
      return bootToken !== undefined ? { spawning: true, bootToken } : { spawning: true }
    }
    // EXACT shape: the PID variant carries ONLY {childPid, childStartedAt, childStartToken?}. A bootToken
    // belongs to the {spawning} intent variant, never a recorded pid — its presence here means a pid could
    // otherwise ride alongside intent metadata, probe ESRCH, and skip the no-PID reboot gate. Fail CLOSED.
    // childPid must be a real (positive, safe-integer) pid and childStartedAt a finite number.
    if (bootToken !== undefined) return 'corrupt'
    if (!isValidChildPid(childPid)) return 'corrupt'
    if (typeof childStartedAt !== 'number' || !Number.isFinite(childStartedAt)) return 'corrupt'
    // A childStartToken PRESENT but not our decimal shape is corruption/tampering, not "no token": fail
    // CLOSED rather than drop it to the tokenless path, so a malformed token can never masquerade as a
    // legitimately tokenless record. Absent is fine (legacy / non-Linux).
    if (childStartToken !== undefined && !isValidChildStartToken(childStartToken)) return 'corrupt'
    return childStartToken !== undefined
      ? { childPid, childStartedAt, childStartToken }
      : { childPid, childStartedAt }
  } catch {
    return 'corrupt' // present but unparseable
  }
}

export const removeOperationChildSync = (runtimeRoot: string, operationId: string): void => {
  try {
    rmSync(operationChildPath(runtimeRoot, operationId), { force: true })
  } catch {
    // Best-effort cleanup; a leftover sidecar for a cleared journal record is inert (recovery only
    // processes records still in the journal).
  }
}

// Enumerates every child-state sidecar in a runtime root, keyed by operationId, INDEPENDENT of the
// journal. This is the journal-free view force-Reset needs when the journal itself is corrupt/unreadable:
// the sidecars are separate files (written synchronously before each spawn), so they still tell us which
// operations reached the spawn stage and whether a child MAY be live. A sidecar that can't be read is
// surfaced as 'corrupt' (fail-safe → treat as a possible live writer), never silently dropped.
const CHILD_FILE_RE = /^operation-child-(.+)\.json$/
// Sentinel operationId for a directory we could NOT enumerate. It carries a 'corrupt' state so the Reset
// guard treats an unreadable runtime root as "a live writer MAY exist" and refuses — see below.
export const UNREADABLE_RUNTIME_DIR = ' unreadable-runtime-dir'
export const listOperationChildren = (
  runtimeRoot: string
): Array<{ operationId: string; state: OperationChildState | 'corrupt' }> => {
  let names: string[]
  try {
    names = readdirSync(runtimeRoot)
  } catch (error) {
    // ONLY a genuine "not found" means nothing ever spawned here (safe → empty). Any other failure
    // (EACCES/EIO/EMFILE/…) is NOT proof of absence: sidecars for live installers may exist but be
    // unreadable, so we must fail CLOSED — surface a corrupt sentinel that makes the Reset guard refuse
    // rather than quarantine + delete a prefix under a possibly-live writer.
    if ((error as { code?: string }).code === 'ENOENT') return []
    return [{ operationId: UNREADABLE_RUNTIME_DIR, state: 'corrupt' }]
  }
  const out: Array<{ operationId: string; state: OperationChildState | 'corrupt' }> = []
  for (const name of names) {
    const m = CHILD_FILE_RE.exec(name)
    if (!m) continue
    const state = readOperationChild(runtimeRoot, m[1])
    if (state !== undefined) out.push({ operationId: m[1], state }) // undefined = raced-away; skip
  }
  return out
}

// One in-flight, crash-recoverable runtime operation. Persisted BEFORE the operation runs (write
// intent) and removed only after it commits, so a process that dies mid-operation leaves a record the
// next startup can reconcile (redownload/verify/repair). See notebook-runtime-crash-recovery.
export type RuntimeOperationKind = 'download' | 'materialize' | 'upgrade' | 'install' | 'disable'

export type RuntimeOperationRecord = {
  operationId: string
  kind: RuntimeOperationKind
  // The runtime the operation targets (env id / pack id). Used to reject a second concurrent op on the
  // same runtime and to scope recovery.
  runtimeId: string
  sessionId?: string
  phase: string
  startedAt: number
  // Staging/prefix the op writes into, so recovery can clean a partial ".incoming-*" or verify a prefix.
  targetPath?: string
  // The OS pid of the child (micromamba/pip/R) doing the work + when it started, so recovery can
  // confirm the recorded process is still the ORIGINAL op process (not a pid reused after a crash)
  // before cleaning staging / verifying / retrying.
  childPid?: number
  childStartedAt?: number
  // The child's kernel start-time token (see readProcessStartToken), captured at spawn. Used ONLY as a
  // pid-reuse FALSIFIER: a mismatch against the live pid's current token proves the pid was reused (our
  // child is gone → 'dead'); a match is NOT treated as proof we may signal the pid (the token is tick-
  // coarse), so it stays 'unknown' (block). Must be our decimal shape when present (isValidChildStartToken
  // — a malformed value fails closed). Absent off Linux / on legacy records — a live pid with no token is
  // then always 'unknown' (a wall-clock start time can't soundly prove a live pid dead).
  childStartToken?: string
  // TRANSIENT, recovery-only: set from the child-state sidecar during hydration when the op reached the
  // spawn stage ({ spawning: true }) but no PID was ever recorded. It is never persisted to the journal;
  // it tells recovery "a child MAY be live, PID unknown" so it blocks rather than reconciles.
  spawnAttempted?: boolean
}

// One shared journal instance per journal path, so every caller (download / materialize / install)
// serializes through the SAME save queue. Without this, each caller constructing its own instance for
// the same path would keep a private queue: concurrent begin()s would read the same stale journal,
// write over each other, and (before the temp-name hardening) could even collide on a temp file so one
// rename hit ENOENT — silently dropping an in-flight operation from recovery. Keyed by the resolved
// journal path; all runtime journals for one storage root live in the main process, so an in-process
// registry is sufficient (a second OS process would need a real file lock, but nothing spawns one).
const journalRegistry = new Map<string, RuntimeOperationJournal>()

// Durable, crash-recoverable journal of in-flight runtime operations for one app storage root. Writes
// are atomic (temp file + rename) and serialized through a save queue so concurrent begins/completions
// can never race a torn file; a missing or corrupt journal reads as empty (best-effort). The consumer
// persists intent with begin() BEFORE performing an operation and calls complete() only after it has
// committed, so pending() on the next startup is exactly the set of operations that were interrupted.
//
// Obtain instances via RuntimeOperationJournal.forPath(path) — never `new` directly — so all callers on
// the same path share the one queue that makes the serialization guarantee hold.
export class RuntimeOperationJournal {
  private saveQueue: Promise<void> = Promise.resolve()
  private saveSequence = 0

  // The shared instance for a journal path. Returns the same object for the same path so every
  // begin/update/complete across the app funnels through a single save queue.
  static forPath(journalPath: string): RuntimeOperationJournal {
    let instance = journalRegistry.get(journalPath)
    if (!instance) {
      instance = new RuntimeOperationJournal(journalPath)
      journalRegistry.set(journalPath, instance)
    }
    return instance
  }

  // journalPath: absolute path to the journal file (e.g. <runtimeRoot>/operation-journal.json).
  // Prefer forPath() — a direct construction opts out of the shared-queue serialization guarantee.
  constructor(private readonly journalPath: string) {}

  // The journal's on-disk state, distinguishing a genuinely-absent journal from a corrupt one so the
  // startup-recovery side can fail SAFE instead of open:
  //   - { records }     : the file is absent (ENOENT -> nothing was in flight) or a readable JSON array
  //                       (invalid entries are filtered out).
  //   - 'corrupt'       : the file EXISTS but could not be read (permissions/I/O) or does not parse to a
  //                       JSON array. This is NOT proof that nothing was in flight, so recovery must
  //                       treat it as "unknown in-flight work" and block rather than reconcile nothing.
  async readState(): Promise<{ records: RuntimeOperationRecord[] } | 'corrupt'> {
    let raw: string
    try {
      raw = await readFile(this.journalPath, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return { records: [] }
      return 'corrupt' // present but unreadable — not proof of "nothing in flight"
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return 'corrupt'
      // ANY invalid entry makes the WHOLE journal suspect: we write only valid records, so a bad element
      // means corruption/tampering. Filtering it out would silently treat a damaged journal as healthy
      // (and let the next begin() overwrite the surviving evidence), so fail safe to 'corrupt' instead.
      if (!parsed.every(isOperationRecord)) return 'corrupt'
      return { records: parsed as RuntimeOperationRecord[] }
    } catch {
      return 'corrupt' // present but unparseable
    }
  }

  // Moves a corrupt journal aside (preserved as evidence) so a fresh begin() can proceed after an
  // explicit user recovery. Returns true if a file was moved, false if there was nothing to move
  // (ENOENT). Throws on any other rename failure so the caller can REFUSE a destructive reset rather
  // than delete a prefix it then can't rebuild (begin() would keep throwing on the still-present file).
  async quarantineCorrupt(): Promise<boolean> {
    try {
      await rename(this.journalPath, `${this.journalPath}.corrupt-${Date.now()}`)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false
      throw error
    }
  }

  // The operations currently recorded as in-flight (empty when the journal is missing OR corrupt). The
  // recovery path uses readState() instead, so it can fail safe on a corrupt journal; the runtime
  // callers (begin/update/complete/hasRuntimeOperation) keep the best-effort empty-on-corrupt behavior.
  async pending(): Promise<RuntimeOperationRecord[]> {
    const state = await this.readState()
    return state === 'corrupt' ? [] : state.records
  }

  // Whether an operation for this runtime is already in flight — the concurrency guard so no two
  // operations ever touch the same runtime at once.
  async hasRuntimeOperation(runtimeId: string): Promise<boolean> {
    return (await this.pending()).some((record) => record.runtimeId === runtimeId)
  }

  // Records the intent to run an operation, written BEFORE the operation performs anything. Replacing
  // an existing record with the same operationId is idempotent (e.g. re-begin after a phase change).
  async begin(record: RuntimeOperationRecord): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readState()
      // Fail CLOSED on a corrupt journal: reading it as empty and writing would OVERWRITE (destroy) the
      // unreadable in-flight state, and every prefix-writing caller (materialize/named create/install)
      // begins fail-closed, so throwing here refuses the whole operation rather than stranding a worker
      // whose recovery record we just clobbered. The corrupt file is preserved for a later boot / Reset.
      if (state === 'corrupt') {
        throw new Error(
          'RUNTIME_JOURNAL_CORRUPT: the operation journal is unreadable; refusing to overwrite it'
        )
      }
      await this.write([
        ...state.records.filter((entry) => entry.operationId !== record.operationId),
        record
      ])
    })
  }

  // Updates progress (phase / childPid / …) for an existing operation without changing its identity.
  // A no-op when the operationId is not present (already completed, or never began).
  async update(operationId: string, patch: Partial<RuntimeOperationRecord>): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.pending()
      if (!current.some((entry) => entry.operationId === operationId)) return
      await this.write(
        current.map((entry) =>
          entry.operationId === operationId ? { ...entry, ...patch, operationId } : entry
        )
      )
    })
  }

  // Removes an operation once it has COMMITTED (cleared from the journal). Idempotent; deletes the
  // journal file entirely once the last operation clears, so an absent file means "nothing in flight".
  async complete(operationId: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.pending()
      const next = current.filter((entry) => entry.operationId !== operationId)
      if (next.length === current.length) return
      if (next.length === 0) await rm(this.journalPath, { force: true })
      else await this.write(next)
    })
  }

  private async write(records: RuntimeOperationRecord[]): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true })
    this.saveSequence += 1
    // Globally-unique temp name: pid + a random uuid + a per-instance sequence, so even two writers
    // that ever end up on the same path (misuse, or a stray direct construction) can't collide on a
    // temp file and have one's rename hit ENOENT because the other already renamed it away.
    const temporaryPath = `${this.journalPath}.${process.pid}-${randomUUID()}-${this.saveSequence}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.journalPath)
  }

  // Serializes every mutation through one chain so overlapping begins/updates/completions can't race a
  // stale read against another writer's rename. Keeps the chain moving even if a turn throws.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.saveQueue.then(operation)
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

// The child-identity fields (childPid, childStartedAt, childStartToken) are written ATOMICALLY together
// in one journal update at spawn time (childStartToken only on Linux). So a record has exactly one of two
// valid shapes: NO child fields at all (op never recorded a pid), or a full {childPid + childStartedAt}
// group (+ optional childStartToken). Any partial subset — childStartedAt or childStartToken WITHOUT a
// childPid, or a childPid WITHOUT childStartedAt — cannot be something we wrote; it means corruption/
// tampering and must invalidate the record. This matters because recovery treats "no childPid + no
// spawnAttempted" as DEAD and reconciles: a stray childStartedAt/childStartToken with no childPid would
// otherwise be silently reconciled as if the op never spawned. Grouping fails the whole journal to
// 'corrupt' instead (readState's "any invalid record → corrupt" rule), so recovery blocks, never guesses.
const hasValidChildGroup = (record: Record<string, unknown>): boolean => {
  const { childPid, childStartedAt, childStartToken } = record
  if (childPid === undefined) {
    // No pid → the whole group must be absent. A lone start time / token is orphaned metadata → corrupt.
    return childStartedAt === undefined && childStartToken === undefined
  }
  // Pid present → require a real pid AND a finite start time (both are written together); token optional
  // but, when present, must be our exact decimal shape.
  return (
    isValidChildPid(childPid) &&
    typeof childStartedAt === 'number' &&
    Number.isFinite(childStartedAt) &&
    (childStartToken === undefined || isValidChildStartToken(childStartToken))
  )
}

const isOperationRecord = (value: unknown): value is RuntimeOperationRecord => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.operationId === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.runtimeId === 'string' &&
    typeof record.phase === 'string' &&
    typeof record.startedAt === 'number' &&
    // Child fields are validated as a lifecycle GROUP (parity with the sidecar's exact-shape rule):
    // all-absent or a complete {childPid + childStartedAt (+ token?)}, never a partial subset.
    hasValidChildGroup(record)
  )
}
