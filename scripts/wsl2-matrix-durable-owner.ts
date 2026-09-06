import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { posix } from 'node:path'

export const DURABLE_OWNERSHIP_SCHEMA_VERSION = 1 as const
export const DEFAULT_DURABLE_OWNERSHIP_DIRECTORY = join(
  process.env.LOCALAPPDATA ?? join(homedir(), '.open-science'),
  'OpenScience',
  'wsl2-matrix-ownership'
)
export const DEFAULT_ACTIVE_LEASE_TIMEOUT_MS = 60_000

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface DurableProcessIdentity {
  token: string
  receiptPath: string
  completionPath: string
  leaderPid: number | null
  startTimeTicks: string | null
  sid: number | null
  pgid: number | null
  descendants: Array<{
    pid: number
    startTimeTicks: string
    sid: number
    pgid: number
  }>
}

export interface DurableDirectoryIdentity {
  device: string
  inode: string
  birthTimeSeconds: string
}

export interface DurableOwnershipRecord {
  schemaVersion: typeof DURABLE_OWNERSHIP_SCHEMA_VERSION
  runId: string
  distro: string
  user: string
  guestRoot: string
  ownerToken: string
  leaseId: string
  heartbeatAtMs: number
  phase: 'preparing' | 'launching' | 'running'
  guestRootTransition: {
    quarantinePath: string
    ownerToken: string
    phase: 'prepared' | 'verified'
    identity: DurableDirectoryIdentity
  } | null
  preparingRootIdentity: DurableDirectoryIdentity | null
  processes: DurableProcessIdentity[]
}

export interface DurableOwnershipJournal {
  path: string
  record: DurableOwnershipRecord
}

export interface InvalidDurableOwnershipJournal {
  path: string
  error: Error
}

export interface DurableOwnershipListing {
  valid: DurableOwnershipJournal[]
  invalid: InvalidDurableOwnershipJournal[]
}

export interface DurableOwnershipOperations {
  proveOwnership(record: DurableOwnershipRecord): boolean | Promise<boolean>
  stopProcess(
    identity: DurableProcessIdentity,
    record: DurableOwnershipRecord
  ): boolean | Promise<boolean>
  removeGuestRoot(record: DurableOwnershipRecord): boolean | Promise<boolean>
}

export type DurableOwnershipReconcileResult =
  | { status: 'cleaned'; path: string; runId: string }
  | { status: 'preserved-invalid'; path: string; error: Error }
  | { status: 'preserved-unowned'; path: string; runId: string }
  | { status: 'preserved-active'; path: string; runId: string }
  | { status: 'preserved-retryable'; path: string; runId: string; error: Error }

export interface DurableOwnershipStoreOptions {
  directory?: string
  activeLeaseId?: string
  nowMs?: number
  activeLeaseTimeoutMs?: number
  globallyFenced?: boolean
}

function ownKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptySingleLine(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  )
}

function validateDirectoryIdentity(value: unknown): DurableDirectoryIdentity {
  if (
    !isPlainObject(value) ||
    !ownKeys(value, ['birthTimeSeconds', 'device', 'inode']) ||
    ![value.device, value.inode, value.birthTimeSeconds].every(
      (field) => typeof field === 'string' && /^[0-9]+$/.test(field)
    )
  ) {
    throw new Error('Invalid durable directory identity.')
  }
  return {
    device: value.device as string,
    inode: value.inode as string,
    birthTimeSeconds: value.birthTimeSeconds as string
  }
}

export function canonicalDurableGuestRoot(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid durable ownership runId.')
  return `/tmp/open-science-wsl2-matrix-${runId}`
}

export function canonicalDurableOwnerToken(runId: string, nonce = randomUUID()): string {
  if (!RUN_ID_PATTERN.test(runId) || !IDENTITY_PATTERN.test(nonce)) {
    throw new Error('Invalid durable ownership token input.')
  }
  return `open-science-owner-${runId}-${nonce}`
}

export function canonicalDurableReceiptPath(runId: string, token: string): string {
  if (!RUN_ID_PATTERN.test(runId) || !isNonEmptySingleLine(token, 256)) {
    throw new Error('Invalid durable process identity input.')
  }
  return `${canonicalDurableGuestRoot(runId)}/receipts/${encodeURIComponent(token)}.receipt`
}

function isCanonicalGuestPath(value: string): boolean {
  if (!value.startsWith('/') || value.includes('\\') || value.includes('//')) return false
  return posix.normalize(value) === value && !value.split('/').includes('..')
}

function validateProcessIdentity(
  value: unknown,
  runId: string,
  guestRoot: string
): DurableProcessIdentity {
  if (
    !isPlainObject(value) ||
    !ownKeys(value, [
      'descendants',
      'completionPath',
      'leaderPid',
      'pgid',
      'receiptPath',
      'sid',
      'startTimeTicks',
      'token'
    ]) ||
    !isNonEmptySingleLine(value.token, 256) ||
    !isNonEmptySingleLine(value.receiptPath, 4096) ||
    !isCanonicalGuestPath(value.receiptPath) ||
    !value.receiptPath.startsWith(`${guestRoot}/`) ||
    !isNonEmptySingleLine(value.completionPath, 4096) ||
    value.completionPath !== `${value.receiptPath}.completion` ||
    !Array.isArray(value.descendants)
  ) {
    throw new Error(`Invalid durable process identity for run ${JSON.stringify(runId)}.`)
  }

  const pending =
    value.leaderPid === null &&
    value.startTimeTicks === null &&
    value.sid === null &&
    value.pgid === null
  const complete =
    Number.isSafeInteger(value.leaderPid) &&
    (value.leaderPid as number) > 0 &&
    typeof value.startTimeTicks === 'string' &&
    /^[0-9]+$/.test(value.startTimeTicks) &&
    Number.isSafeInteger(value.sid) &&
    (value.sid as number) > 0 &&
    Number.isSafeInteger(value.pgid) &&
    (value.pgid as number) > 0
  if (!pending && !complete) {
    throw new Error(`Incomplete durable process identity for run ${JSON.stringify(runId)}.`)
  }
  const descendants = value.descendants.map((descendant) => {
    if (
      !isPlainObject(descendant) ||
      !ownKeys(descendant, ['pgid', 'pid', 'sid', 'startTimeTicks']) ||
      !Number.isSafeInteger(descendant.pid) ||
      (descendant.pid as number) <= 0 ||
      typeof descendant.startTimeTicks !== 'string' ||
      !/^[0-9]+$/.test(descendant.startTimeTicks) ||
      !Number.isSafeInteger(descendant.sid) ||
      (descendant.sid as number) <= 0 ||
      !Number.isSafeInteger(descendant.pgid) ||
      (descendant.pgid as number) <= 0
    ) {
      throw new Error(`Invalid durable descendant identity for run ${JSON.stringify(runId)}.`)
    }
    return {
      pid: descendant.pid as number,
      startTimeTicks: descendant.startTimeTicks,
      sid: descendant.sid as number,
      pgid: descendant.pgid as number
    }
  })
  if (pending && descendants.length > 0) {
    throw new Error(`Pending durable identity has descendants for run ${JSON.stringify(runId)}.`)
  }

  return {
    token: value.token,
    receiptPath: value.receiptPath,
    completionPath: value.completionPath,
    leaderPid: value.leaderPid as number | null,
    startTimeTicks: value.startTimeTicks as string | null,
    sid: value.sid as number | null,
    pgid: value.pgid as number | null,
    descendants
  }
}

/**
 * Parses a journal without accepting unknown fields or identities that are not bound to the run.
 * This deliberately fails closed: callers must preserve a journal that cannot be parsed.
 */
export function parseDurableOwnershipRecord(value: unknown): DurableOwnershipRecord {
  const expectedKeys = [
    'distro',
    'guestRoot',
    'guestRootTransition',
    'heartbeatAtMs',
    'leaseId',
    'ownerToken',
    'phase',
    'preparingRootIdentity',
    'processes',
    'runId',
    'schemaVersion',
    'user'
  ]
  if (!isPlainObject(value) || !ownKeys(value, expectedKeys)) {
    throw new Error('Invalid durable ownership journal shape.')
  }
  if (value.schemaVersion !== DURABLE_OWNERSHIP_SCHEMA_VERSION) {
    throw new Error('Unsupported durable ownership journal schema version.')
  }
  if (typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)) {
    throw new Error('Invalid durable ownership runId.')
  }
  if (
    !isNonEmptySingleLine(value.distro, 256) ||
    !isNonEmptySingleLine(value.user, 256) ||
    !isNonEmptySingleLine(value.guestRoot, 4096) ||
    !isCanonicalGuestPath(value.guestRoot) ||
    value.guestRoot !== canonicalDurableGuestRoot(value.runId) ||
    !isNonEmptySingleLine(value.ownerToken, 256) ||
    !IDENTITY_PATTERN.test(value.ownerToken) ||
    !value.ownerToken.startsWith(`open-science-owner-${value.runId}-`) ||
    !isNonEmptySingleLine(value.leaseId, 256) ||
    !IDENTITY_PATTERN.test(value.leaseId) ||
    !Number.isSafeInteger(value.heartbeatAtMs) ||
    (value.heartbeatAtMs as number) < 0 ||
    !['preparing', 'launching', 'running'].includes(value.phase as string) ||
    !Array.isArray(value.processes)
  ) {
    throw new Error(`Invalid durable ownership identity for run ${JSON.stringify(value.runId)}.`)
  }

  const processes = value.processes.map((process) =>
    validateProcessIdentity(process, value.runId as string, value.guestRoot as string)
  )
  if (new Set(processes.map(({ token }) => token)).size !== processes.length) {
    throw new Error(`Duplicate durable process token for run ${JSON.stringify(value.runId)}.`)
  }
  if (new Set(processes.map(({ receiptPath }) => receiptPath)).size !== processes.length) {
    throw new Error(`Duplicate durable process receipt for run ${JSON.stringify(value.runId)}.`)
  }
  let guestRootTransition: DurableOwnershipRecord['guestRootTransition'] = null
  if (value.guestRootTransition !== null) {
    if (
      !isPlainObject(value.guestRootTransition) ||
      !ownKeys(value.guestRootTransition, ['identity', 'ownerToken', 'phase', 'quarantinePath']) ||
      value.guestRootTransition.ownerToken !== value.ownerToken ||
      value.guestRootTransition.quarantinePath !==
        `${value.guestRoot}.quarantine-${value.ownerToken}` ||
      !['prepared', 'verified'].includes(value.guestRootTransition.phase as string)
    ) {
      throw new Error(`Invalid guest-root transition for run ${JSON.stringify(value.runId)}.`)
    }
    guestRootTransition = {
      quarantinePath: value.guestRootTransition.quarantinePath,
      ownerToken: value.guestRootTransition.ownerToken,
      phase: value.guestRootTransition.phase as 'prepared' | 'verified',
      identity: validateDirectoryIdentity(value.guestRootTransition.identity)
    }
  }
  const preparingRootIdentity =
    value.preparingRootIdentity === null
      ? null
      : validateDirectoryIdentity(value.preparingRootIdentity)

  return {
    schemaVersion: DURABLE_OWNERSHIP_SCHEMA_VERSION,
    runId: value.runId,
    distro: value.distro,
    user: value.user,
    guestRoot: value.guestRoot,
    ownerToken: value.ownerToken,
    leaseId: value.leaseId,
    heartbeatAtMs: value.heartbeatAtMs,
    phase: value.phase as DurableOwnershipRecord['phase'],
    guestRootTransition,
    preparingRootIdentity,
    processes
  }
}

export function durableOwnershipJournalPath(
  runId: string,
  options: DurableOwnershipStoreOptions = {}
): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid durable ownership runId.')
  return join(options.directory ?? DEFAULT_DURABLE_OWNERSHIP_DIRECTORY, `${runId}.json`)
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  let file
  try {
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(contents, { encoding: 'utf8' })
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync().catch((error: NodeJS.ErrnoException) => {
        // Windows does not support fsync on directory handles. The journal file itself was
        // flushed before the atomic rename; keep POSIX directory fsync where it is available.
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
      })
    } finally {
      await directory.close()
    }
  } catch (error) {
    await file?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function persistDurableOwnership(
  record: DurableOwnershipRecord,
  options: DurableOwnershipStoreOptions = {}
): Promise<DurableOwnershipJournal> {
  const validated = parseDurableOwnershipRecord(record)
  const path = durableOwnershipJournalPath(validated.runId, options)
  await atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`)
  return { path, record: validated }
}

export async function updateDurableOwnership(
  runId: string,
  update: (current: DurableOwnershipRecord) => DurableOwnershipRecord,
  options: DurableOwnershipStoreOptions = {}
): Promise<DurableOwnershipJournal> {
  const path = durableOwnershipJournalPath(runId, options)
  const current = parseDurableOwnershipRecord(JSON.parse(await readFile(path, 'utf8')))
  if (current.runId !== runId) throw new Error('Durable ownership journal filename mismatch.')
  const next = parseDurableOwnershipRecord(update(current))
  if (next.runId !== runId) throw new Error('Cannot change a durable ownership runId.')
  await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`)
  return { path, record: next }
}

export async function listDurableOwnership(
  options: DurableOwnershipStoreOptions = {}
): Promise<DurableOwnershipListing> {
  const directory = options.directory ?? DEFAULT_DURABLE_OWNERSHIP_DIRECTORY
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { valid: [], invalid: [] }
    throw error
  }

  const valid: DurableOwnershipJournal[] = []
  const invalid: InvalidDurableOwnershipJournal[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const isJournal = entry.name.endsWith('.json')
    const isInterruptedAtomicWrite = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json\..+\.tmp$/.test(
      entry.name
    )
    if (!isJournal && !isInterruptedAtomicWrite) continue
    const path = join(directory, entry.name)
    try {
      if (isInterruptedAtomicWrite) {
        throw new Error('Interrupted durable ownership atomic write preserved for review.')
      }
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error('Durable ownership journal is not an exclusive regular file.')
      }
      const record = parseDurableOwnershipRecord(JSON.parse(await readFile(path, 'utf8')))
      if (entry.name !== `${record.runId}.json`) {
        throw new Error('Durable ownership journal filename mismatch.')
      }
      valid.push({ path, record })
    } catch (error) {
      invalid.push({ path, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return { valid, invalid }
}

export async function reconcileDurableOwnership(
  operations: DurableOwnershipOperations,
  options: DurableOwnershipStoreOptions = {}
): Promise<DurableOwnershipReconcileResult[]> {
  const listing = await listDurableOwnership(options)
  const results: DurableOwnershipReconcileResult[] = listing.invalid.map(({ path, error }) => ({
    status: 'preserved-invalid',
    path,
    error
  }))

  for (const { path, record } of listing.valid) {
    try {
      const nowMs = options.nowMs ?? Date.now()
      const leaseTimeoutMs = options.activeLeaseTimeoutMs ?? DEFAULT_ACTIVE_LEASE_TIMEOUT_MS
      if (
        !options.globallyFenced &&
        record.leaseId !== options.activeLeaseId &&
        nowMs - record.heartbeatAtMs < leaseTimeoutMs
      ) {
        results.push({ status: 'preserved-active', path, runId: record.runId })
        continue
      }
      if (!(await operations.proveOwnership(record))) {
        results.push({ status: 'preserved-unowned', path, runId: record.runId })
        continue
      }
      // The guest root must remain in place until every process identity has been stopped.
      for (const identity of record.processes) {
        if (!(await operations.stopProcess(identity, record))) {
          throw new Error(`Failed to stop durable process ${JSON.stringify(identity.token)}.`)
        }
      }
      if (!(await operations.removeGuestRoot(record))) {
        throw new Error(
          `Failed to remove durable guest root for run ${JSON.stringify(record.runId)}.`
        )
      }
      await rm(path)
      results.push({ status: 'cleaned', path, runId: record.runId })
    } catch (error) {
      results.push({
        status: 'preserved-retryable',
        path,
        runId: record.runId,
        error: error instanceof Error ? error : new Error(String(error))
      })
    }
  }
  return results
}

/** Startup-friendly name for the same idempotent reconciliation operation. */
export const reconcileDurableOwnershipAtStartup = reconcileDurableOwnership
