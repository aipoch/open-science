import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

// Optional sink for kill-path diagnostics; callers with a logger pass one, tests and the notebook path
// omit it. Kept minimal so process-tree stays free of the Electron logger's import graph.
export type ProcessTreeLogger = { error: (message: string, error?: unknown) => void }

// Upper bound for awaiting a direct child's real exit (POSIX) or taskkill's own completion (Windows).
// Bounded so a wedged process can never hang app teardown; the caller (before-quit) also time-bounds
// the whole shutdown, this is a second, tighter guard scoped to a single tree.
const TERMINATE_GRACE_MS = 3_000

// Shorter wait after escalating to SIGKILL: SIGKILL is uncatchable, so a process that survives it is a
// kernel-level unkillable (uninterruptible sleep) we cannot do anything about — don't wait the full grace.
const SIGKILL_GRACE_MS = 1_000

// Signals the direct child, tolerating an already-exited process or a handle with no pid. Skips a child
// already signaled so a first, graceful pass is a no-op on retry; escalation uses forceKillChild instead.
const killDirectChild = (child: ChildProcess, signal?: NodeJS.Signals): void => {
  try {
    if (!child.killed) child.kill(signal)
  } catch {
    // A kill on an already-exited child can throw; treat it as a no-op.
  }
}

// Hard-kills the direct child, bypassing the child.killed guard (a graceful pass already set it). Prefers
// process.kill(pid) so SIGKILL is delivered even after child.kill() flipped `killed`, falling back to the
// handle when no pid is exposed.
const forceKillChild = (child: ChildProcess): void => {
  try {
    if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    // Already gone, or we cannot signal it; nothing more to do.
  }
}

// True while the pid still exists. Signal 0 performs the permission/existence check without delivering a
// signal: ESRCH means gone, EPERM means alive but not ours to signal.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Sends a signal to each pid, ignoring processes that have already exited or that we cannot signal.
const signalPids = (pids: number[], signal: NodeJS.Signals): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited, or no permission; ignore and continue.
    }
  }
}

// Resolves true once the child actually exits, or false once the grace elapses without an exit — so the
// caller can decide whether to escalate. The timer is cleared on exit (and unref'd) so a settled wait
// never leaves a live timer to fire spuriously or keep the process alive.
const waitForExit = (child: ChildProcess, ms: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    let settled = false
    const done = (exited: boolean): void => {
      if (settled) return
      settled = true
      resolve(exited)
    }
    const timer = setTimeout(() => done(false), ms)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
    child.once('close', () => {
      clearTimeout(timer)
      done(true)
    })
  })

// Best-effort descendant discovery on POSIX. Node's child.kill() signals only the immediate child, so a
// grandchild (conda, the claude CLI, a package manager) would otherwise be orphaned exactly as it would
// on Windows without taskkill /T. `ps -A -o pid=,ppid=` is available on both macOS (BSD) and Linux
// (procps); any failure resolves to an empty list so we still fall back to killing the direct child.
const collectDescendantPids = (rootPid: number): Promise<number[]> =>
  new Promise<number[]>((resolve) => {
    let ps: ChildProcess
    try {
      ps = spawn('ps', ['-A', '-o', 'pid=,ppid='], { windowsHide: true })
    } catch {
      resolve([])
      return
    }

    let out = ''
    let settled = false
    const finish = (pids: number[]): void => {
      if (settled) return
      settled = true
      resolve(pids)
    }

    // A hung ps must not stall teardown; abandon it after the grace and fall back to the direct kill.
    // Created before the handlers so they can clear it (avoiding a forward reference from finish()).
    const timer = setTimeout(() => {
      try {
        ps.kill()
      } catch {
        // ps may have already exited.
      }
      finish([])
    }, TERMINATE_GRACE_MS)
    timer.unref?.()

    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    ps.on('error', () => {
      clearTimeout(timer)
      finish([])
    })
    ps.on('close', () => {
      clearTimeout(timer)
      try {
        const childrenByParent = new Map<number, number[]>()
        for (const line of out.split('\n')) {
          const [pidText, ppidText] = line.trim().split(/\s+/)
          const pid = Number(pidText)
          const ppid = Number(ppidText)
          if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
          const siblings = childrenByParent.get(ppid) ?? []
          siblings.push(pid)
          childrenByParent.set(ppid, siblings)
        }

        // Depth-first walk from the root; the root itself is excluded (the caller kills it via its handle).
        const descendants: number[] = []
        const stack = [rootPid]
        while (stack.length > 0) {
          const current = stack.pop() as number
          for (const kid of childrenByParent.get(current) ?? []) {
            descendants.push(kid)
            stack.push(kid)
          }
        }
        finish(descendants)
      } catch {
        finish([])
      }
    })
  })

// Windows tree teardown. taskkill /T /F reaps the whole tree in one shot; child.kill() alone would orphan
// grandchildren. If taskkill cannot be launched, errors, times out, or exits non-zero, the tree was NOT
// reaped, so we log and fall back to killing the direct child and awaiting its exit. Descendant cleanup on
// the fallback path is not possible without taskkill — an accepted platform limitation.
const terminateWindowsTree = async (
  child: ChildProcess,
  signal: NodeJS.Signals | undefined,
  log: ProcessTreeLogger | undefined
): Promise<void> => {
  if (child.pid === undefined) return

  let killer: ChildProcess
  try {
    killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } catch (error) {
    log?.error('taskkill failed to launch; falling back to direct kill', error)
    killDirectChild(child, signal)
    await waitForExit(child, TERMINATE_GRACE_MS)
    return
  }

  const reaped = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    // A wedged taskkill must not hang quit; abandon it after the grace and fall back. Cleared by the
    // exit/error handlers on the settle path so it never fires spuriously while the app keeps running.
    const timer = setTimeout(() => {
      log?.error('taskkill did not complete in time; falling back to direct kill')
      done(false)
    }, TERMINATE_GRACE_MS)
    timer.unref?.()
    // A non-zero exit means taskkill did not reap the tree (e.g. process not found). A null code (killed
    // by a signal) is treated as success to match prior behavior — it is vanishingly rare on Windows.
    killer.on('exit', (code) => {
      clearTimeout(timer)
      done(code === 0 || code === null)
    })
    killer.on('error', (error) => {
      clearTimeout(timer)
      log?.error('taskkill errored; falling back to direct kill', error)
      done(false)
    })
  })

  if (!reaped) {
    if (killer.exitCode !== null && killer.exitCode !== 0) {
      log?.error(`taskkill exited with code ${killer.exitCode}; falling back to direct kill`)
    }
    killDirectChild(child, signal)
    await waitForExit(child, TERMINATE_GRACE_MS)
  }
}

// POSIX tree teardown. child.kill() reaches only the immediate child, so descendants are discovered via
// `ps` and signaled alongside it. The graceful signal (SIGTERM by default) is given the grace to take
// effect, then anything still alive — the child that ignored it, or a reparented grandchild — is
// escalated to SIGKILL and confirmed, so the function does not return leaving the tree running.
const terminatePosixTree = async (
  child: ChildProcess,
  signal: NodeJS.Signals | undefined,
  log: ProcessTreeLogger | undefined
): Promise<void> => {
  const gracefulSignal = signal ?? 'SIGTERM'
  const descendants = child.pid === undefined ? [] : await collectDescendantPids(child.pid)

  signalPids(descendants, gracefulSignal)
  killDirectChild(child, gracefulSignal)

  const exited = await waitForExit(child, TERMINATE_GRACE_MS)
  const survivors = descendants.filter(isProcessAlive)

  if (exited && survivors.length === 0) return

  if (survivors.length > 0) {
    log?.error(
      `process tree left ${survivors.length} descendant(s) alive after ${gracefulSignal}; escalating to SIGKILL`
    )
    signalPids(survivors, 'SIGKILL')
  }
  if (!exited) {
    log?.error(
      `process ${child.pid ?? '(no pid)'} did not exit after ${gracefulSignal}; escalating to SIGKILL`
    )
    forceKillChild(child)
    await waitForExit(child, SIGKILL_GRACE_MS)
  }
}

// Terminates a child process and every descendant it spawned, then waits for the direct child to actually
// exit — escalating to SIGKILL anything still alive. On Windows the tree is reaped with taskkill /T /F
// (with a direct-kill fallback); on POSIX descendants are found via `ps`, signaled, and SIGKILL-escalated.
// This never rejects: any failure resolves to void so a kill can never surface into the caller
// (before-quit -> app.exit).
export const terminateProcessTree = async (
  child: ChildProcess,
  signal?: NodeJS.Signals,
  log?: ProcessTreeLogger
): Promise<void> => {
  if (process.platform === 'win32') {
    await terminateWindowsTree(child, signal, log)
    return
  }
  await terminatePosixTree(child, signal, log)
}
