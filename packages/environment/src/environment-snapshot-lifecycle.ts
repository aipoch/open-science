import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  bootTokenProvesReboot,
  operationJournalPath,
  readBootToken,
  readOperationChild,
  recordOperationChildSync,
  recordSpawnIntentSync,
  removeOperationChildSync,
  RuntimeOperationJournal,
  type RuntimeOperationRecord
} from './operation-journal'
import { readProcessStartToken } from './operation-recovery'
import { EnvironmentSnapshotInUseError, removeEnvironmentSnapshot } from './environment-snapshot'

export type EnvironmentSnapshotProcessObserver = {
  beforeSpawn(): void
  childStarted(pid: number): void
}
export type EnvironmentSnapshotLease = EnvironmentSnapshotProcessObserver & {
  root: string
  activate(): Promise<void>
  release(error?: unknown): Promise<void>
}

const active = new Set<string>()
const cleaning = new Map<string, Promise<void>>()
const retained = new Map<string, { retry: () => Promise<boolean>; timer?: NodeJS.Timeout }>()

const forgetRetained = (operationId: string): void => {
  const retry = retained.get(operationId)
  if (retry?.timer) clearTimeout(retry.timer)
  retained.delete(operationId)
}

/** The recorded root identity and process-tree evidence must both authorize deletion. */
const cleanSnapshotOperation = async (
  runtimeRoot: string,
  record: RuntimeOperationRecord
): Promise<void> => {
  if (active.has(record.operationId)) throw new Error('Environment snapshot is still in use.')
  runtimeRoot = await realpath(runtimeRoot)
  const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
  const state = await journal.readState()
  if (state === 'corrupt') throw new Error('Runtime operation journal is corrupt.')
  const current = state.records.find(({ operationId }) => operationId === record.operationId)
  if (!current) {
    forgetRetained(record.operationId)
    return
  }
  record = current
  if (record.kind !== 'snapshot-restore' || !record.snapshotIdentity || !record.targetPath)
    throw new Error('Invalid environment snapshot cleanup record.')
  const scratch = join(dirname(runtimeRoot), '.e')
  if (
    dirname(resolve(record.targetPath)) !== scratch ||
    !/^[sr]-[A-Za-z0-9]{6}$/.test(basename(record.targetPath))
  )
    throw new Error('Environment snapshot cleanup path is invalid.')
  const child = readOperationChild(runtimeRoot, record.operationId)
  const retry = retained.get(record.operationId)
  const neverStarted = record.phase === 'preparing' && child === undefined
  const reaped = record.phase === 'reaped' && child === undefined
  const confirmed = !reaped && retry && (await retry.retry().catch(() => false))
  if (
    !confirmed &&
    !neverStarted &&
    !reaped &&
    !bootTokenProvesReboot(record.snapshotIdentity.bootToken, readBootToken())
  )
    throw new EnvironmentSnapshotInUseError(undefined)
  if (confirmed) {
    await RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot)).update(
      record.operationId,
      { phase: 'reaped' }
    )
    record.phase = 'reaped'
    removeOperationChildSync(runtimeRoot, record.operationId)
  }
  const identity = await lstat(record.targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (identity) {
    const expected = record.snapshotIdentity
    if (
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      identity.dev !== expected.dev ||
      identity.ino !== expected.ino ||
      identity.birthtimeMs !== expected.birthtimeMs ||
      (await realpath(scratch)) !== scratch
    )
      throw new Error('Environment snapshot cleanup identity changed.')
    await removeEnvironmentSnapshot(record.targetPath)
  }
  await RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot)).complete(
    record.operationId
  )
  removeOperationChildSync(runtimeRoot, record.operationId)
  forgetRetained(record.operationId)
}

// Timer, startup recovery and migration may converge on the same retained clone.
export const cleanEnvironmentSnapshotOperation = (
  runtimeRoot: string,
  record: RuntimeOperationRecord
): Promise<void> => {
  const previous = cleaning.get(record.operationId)
  if (previous) return previous
  const task = cleanSnapshotOperation(runtimeRoot, record).finally(() => {
    cleaning.delete(record.operationId)
  })
  cleaning.set(record.operationId, task)
  return task
}

export const reconcileEnvironmentSnapshotOperations = async (
  runtimeRoot: string
): Promise<void> => {
  const state = await RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot)).readState()
  if (state === 'corrupt') throw new Error('Runtime operation journal is corrupt.')
  for (const record of state.records) {
    if (record.kind !== 'snapshot-restore' || active.has(record.operationId)) continue
    try {
      await cleanEnvironmentSnapshotOperation(runtimeRoot, record)
    } catch (error) {
      // Keep uncertain clones journaled. They must not disable unrelated captures; every new
      // materialization is separately bounded by available disk space. Migration still sees
      // the pending record and refuses to move a potentially active clone.
      if (!(error instanceof EnvironmentSnapshotInUseError)) throw error
    }
  }
}

export const createEnvironmentSnapshotLease = async (
  runtimeRoot: string,
  scratchRoot: string,
  prefix: 's-' | 'r-'
): Promise<EnvironmentSnapshotLease> => {
  await mkdir(runtimeRoot, { recursive: true })
  runtimeRoot = await realpath(runtimeRoot)
  await reconcileEnvironmentSnapshotOperations(runtimeRoot)
  const scratch = join(dirname(runtimeRoot), '.e')
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
  if ((await realpath(scratchRoot)) !== scratch)
    throw new Error('Invalid environment snapshot scratch root.')
  const root = await mkdtemp(join(scratch, prefix))
  const identity = await lstat(root)
  const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
  const record: RuntimeOperationRecord = {
    operationId: randomUUID(),
    kind: 'snapshot-restore',
    runtimeId: `snapshot:${basename(root)}`,
    phase: 'preparing',
    startedAt: Date.now(),
    targetPath: root,
    snapshotIdentity: {
      dev: identity.dev,
      ino: identity.ino,
      birthtimeMs: identity.birthtimeMs,
      bootToken: readBootToken()
    }
  }
  try {
    await journal.begin(record)
  } catch (error) {
    await removeEnvironmentSnapshot(root)
    throw error
  }
  active.add(record.operationId)
  const beforeSpawn = (): void => recordSpawnIntentSync(runtimeRoot, record.operationId)
  const release = async (error?: unknown): Promise<void> => {
    if (error instanceof EnvironmentSnapshotInUseError) {
      // An injected verifier may not have supplied a PID. The active phase still forbids deletion.
      await journal.update(record.operationId, { phase: 'active' })
      record.phase = 'active'
      active.delete(record.operationId)
      if (error.retryTermination && !retained.has(record.operationId)) {
        const retry = {
          retry: error.retryTermination,
          timer: undefined as NodeJS.Timeout | undefined
        }
        retained.set(record.operationId, retry)
        const attempt = (): void => {
          retry.timer = setTimeout(() => {
            void cleanEnvironmentSnapshotOperation(runtimeRoot, record).catch(attempt)
          }, 30_000)
          retry.timer.unref()
        }
        attempt()
      }
      return
    }
    // This call is allowed only after the caller confirms all verification/replay children are reaped.
    await journal.update(record.operationId, { phase: 'reaped' })
    record.phase = 'reaped'
    removeOperationChildSync(runtimeRoot, record.operationId)
    active.delete(record.operationId)
    await cleanEnvironmentSnapshotOperation(runtimeRoot, record)
  }
  return {
    root,
    beforeSpawn,
    childStarted: (pid) =>
      recordOperationChildSync(runtimeRoot, record.operationId, {
        childPid: pid,
        childStartedAt: Date.now(),
        childStartToken: readProcessStartToken(pid)
      }),
    activate: async () => {
      await journal.update(record.operationId, { phase: 'active' })
      record.phase = 'active'
      beforeSpawn()
    },
    release
  }
}
