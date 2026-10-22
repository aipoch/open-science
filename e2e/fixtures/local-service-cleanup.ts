import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { processBirthIdentity } from '../../src/main/process-birth-identity'
import { DelegatedProcessOwnership } from '../../src/main/delegation/process-ownership'
import { acquireRuntimeDirectorySync } from '../../src/main/runtime-ownership'
import { isRuntimeProcessAlive } from '../../src/main/runtime-stop-confirmation'

type CapturedProcess = { pid: number; birthToken: string }
export type CapturedFixtureProcess = CapturedProcess & { child: ChildProcess }
export type CapturedService = CapturedProcess & { configRoot: string; generation: string }
export type CapturedFixtureAgent = CapturedProcess & { receiptId: string }
export type CapturedFixtureRoot = Readonly<{
  path: string
  canonicalRoot: string
  dev: number
  ino: number
}>

const capturedRoots = new WeakSet<CapturedFixtureRoot>()

/** Capture only the private directory just returned by this fixture's mkdtemp, before launch. */
export async function captureFixtureRoot(root: string): Promise<CapturedFixtureRoot> {
  if (!isAbsolute(root) || resolve(root, '..') === resolve(root))
    throw new Error('Fixture cleanup requires its own private temporary root.')
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Fixture cleanup root must be a real directory, not a symbolic link.')
  const target = Object.freeze({
    path: resolve(root),
    canonicalRoot: await realpath(root),
    dev: metadata.dev,
    ino: metadata.ino
  })
  capturedRoots.add(target)
  return target
}

/** After process/receipt/lock checks, restore only directory access inside this captured root. */
export async function makeCapturedFixtureDirectoriesWritable(
  target: CapturedFixtureRoot | undefined
): Promise<void> {
  if (!target || !capturedRoots.has(target))
    throw new Error('Fixture cleanup root was not captured by this fixture.')
  const root = await lstat(target.path)
  if (
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    root.dev !== target.dev ||
    root.ino !== target.ino ||
    (await realpath(target.path)) !== target.canonicalRoot
  )
    throw new Error('Fixture cleanup root identity changed; preserve the root.')
  // Windows deletion uses ACL/read-only handling, not POSIX directory write/search bits.
  if (process.platform === 'win32') return
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return
    const canonical = await realpath(path)
    const within = relative(target.canonicalRoot, canonical)
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Fixture cleanup directory escaped its captured root.')
    if (path === target.path && (metadata.dev !== target.dev || metadata.ino !== target.ino))
      throw new Error('Fixture cleanup root identity changed; preserve the root.')
    const directory = await open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      const opened = await directory.stat()
      if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino)
        throw new Error('Fixture cleanup directory identity changed; preserve the root.')
      await directory.chmod((opened.mode & 0o7777) | 0o300)
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(path, entry.name))
    } finally {
      await directory.close()
    }
  }
  await visit(target.path)
}

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/** Call immediately after spawn, before awaiting startup. Never rediscover a child by PID/name. */
export function captureFixtureProcess(child: ChildProcess): CapturedFixtureProcess | undefined {
  // A failed spawn has no process to clean up. Its caller still observes the spawn error.
  if (!child.pid) return undefined
  const birthToken = processBirthIdentity(child.pid)
  if (!birthToken) throw new Error(`Fixture child identity cannot be captured (PID ${child.pid}).`)
  return { child, pid: child.pid, birthToken }
}

export async function captureFixtureService(
  configRoot: string
): Promise<CapturedService | undefined> {
  try {
    const record = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !uuid.test(record.generation) ||
      (record.desktop && !uuid.test(record.desktop.generation))
    )
      throw new Error(`Fixture service owner is invalid; preserve ${configRoot}`)
    if (!isRuntimeProcessAlive(record.pid)) return undefined
    const birthToken = processBirthIdentity(record.pid)
    if (!birthToken || record.birthToken !== birthToken)
      throw new Error(`Fixture service identity cannot be captured; preserve ${configRoot}`)
    return {
      configRoot,
      pid: record.pid,
      generation: record.desktop?.generation ?? record.generation,
      birthToken
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function stillOwned(target: CapturedProcess): boolean {
  if (!isRuntimeProcessAlive(target.pid)) return false
  if (processBirthIdentity(target.pid) !== target.birthToken)
    throw new Error(`Fixture process identity changed or is unreadable (PID ${target.pid}).`)
  return true
}

function childExited(child: ChildProcess | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null)
}

async function waitForExit(
  target: CapturedProcess,
  timeoutMs: number,
  child?: ChildProcess
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!childExited(child) && isRuntimeProcessAlive(target.pid)) {
    // Exit can race a birth-identity read. Observation may wait through an unreadable identity;
    // every signal still goes through the strict ownership check below.
    const birthToken = processBirthIdentity(target.pid)
    if (birthToken !== undefined && birthToken !== target.birthToken)
      throw new Error(`Fixture process identity changed (PID ${target.pid}).`)
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

/** Only identities captured by this fixture may be signaled, including direct test children. */
async function cleanupCapturedProcess(
  target: CapturedProcess,
  child?: ChildProcess
): Promise<void> {
  if (childExited(child) || !stillOwned(target)) return
  const signal = (mode: NodeJS.Signals): void => {
    if (childExited(child) || !stillOwned(target)) return
    try {
      process.kill(target.pid, mode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  signal('SIGTERM')
  if (await waitForExit(target, 22_000, child)) return
  signal('SIGKILL')
  if (!(await waitForExit(target, 1500, child)))
    throw new Error(`Fixture process did not exit (PID ${target.pid}).`)
}

export async function cleanupFixtureProcess(
  target: CapturedFixtureProcess | undefined
): Promise<void> {
  if (!target || childExited(target.child)) return
  await cleanupCapturedProcess(target, target.child)
}

export async function cleanupFixtureService(target: CapturedService | undefined): Promise<void> {
  if (!target) return
  await cleanupCapturedProcess(target)
  // Prove release using the real lock. Never delete ownership records to make a test pass.
  acquireRuntimeDirectorySync(target.configRoot).release()
}

/** Persisted ownership, as well as birth identity, proves independently grouped agent leaders. */
export function captureFixtureAgents(target: CapturedService): CapturedFixtureAgent[] {
  // Once the captured service dies, its receipts remain authority for known agents. Fence the
  // root while reading so a replacement generation cannot publish work into this snapshot.
  const lease = stillOwned(target) ? undefined : acquireRuntimeDirectorySync(target.configRoot)
  try {
    return ['main-agent-process-ownership', 'delegation-process-ownership'].flatMap((directory) =>
      new DelegatedProcessOwnership(target.configRoot, directory).receipts().flatMap((receipt) => {
        const leader = receipt.ownership?.leader
        if (!leader?.birthToken || !isRuntimeProcessAlive(leader.pid)) return []
        if (processBirthIdentity(leader.pid) !== leader.birthToken)
          throw new Error(`Fixture agent identity changed; preserve ${target.configRoot}`)
        return [{ ...leader, birthToken: leader.birthToken, receiptId: receipt.receiptId }]
      })
    )
  } finally {
    lease?.release()
  }
}

/** Receipt presence is unresolved tree/Job evidence even when its leader has already exited. */
export function remainingFixtureAgentReceipts(
  configRoot: string
): { receiptId: string; namespace: string; phase: string }[] {
  const lease = acquireRuntimeDirectorySync(configRoot)
  try {
    return ['main-agent-process-ownership', 'delegation-process-ownership'].flatMap((namespace) =>
      new DelegatedProcessOwnership(configRoot, namespace).receipts().map((receipt) => ({
        receiptId: receipt.receiptId,
        namespace,
        phase: receipt.phase
      }))
    )
  } finally {
    lease.release()
  }
}

export async function cleanupFixtureAgent(target: CapturedFixtureAgent): Promise<void> {
  await cleanupCapturedProcess(target)
}

/** A desktop close failure must not skip service/child cleanup or erase the original failure. */
export async function runFixtureCleanup(
  steps: (() => Promise<unknown>)[],
  failure?: unknown
): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) {
    if (failure !== undefined) errors.unshift(failure)
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Fixture cleanup failed.')
  }
}
