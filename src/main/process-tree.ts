import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

// Optional sink for kill-path diagnostics; callers with a logger pass one, tests and the notebook path
// omit it. Kept minimal so process-tree stays free of the Electron logger's import graph.
export type ProcessTreeLogger = { error: (message: string, error?: unknown) => void }

// Upper bound for awaiting a direct child's real exit (POSIX) or taskkill's own completion (Windows).
// Bounded so a wedged process can never hang app teardown; the caller (before-quit) also time-bounds
// the whole shutdown, this is a second, tighter guard scoped to a single tree.
const TERMINATE_GRACE_MS = 3_000

// Signals the direct child, tolerating an already-exited process or a handle with no pid.
const killDirectChild = (child: ChildProcess, signal?: NodeJS.Signals): void => {
  try {
    if (!child.killed) child.kill(signal)
  } catch {
    // A kill on an already-exited child can throw; treat it as a no-op.
  }
}

// Resolves once the child actually exits (or the grace elapses), so a caller that follows with
// app.exit is guaranteed the child is gone — not merely signaled. The timer is unref'd so it never
// keeps the process alive on its own.
const waitForExit = (child: ChildProcess, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('exit', done)
    child.once('close', done)
    const timer = setTimeout(done, ms)
    timer.unref?.()
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
    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    ps.on('error', () => resolve([]))
    ps.on('close', () => {
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
        resolve(descendants)
      } catch {
        resolve([])
      }
    })

    // A hung ps must not stall teardown; abandon it after the grace and fall back to the direct kill.
    const timer = setTimeout(() => {
      try {
        ps.kill()
      } catch {
        // ps may have already exited.
      }
      resolve([])
    }, TERMINATE_GRACE_MS)
    timer.unref?.()
  })

// Terminates a child process and every descendant it spawned, then waits for the direct child to
// actually exit. On Windows a plain child.kill() only signals the immediate child, orphaning
// grandchildren, so the whole tree is handed to taskkill /T /F; if taskkill cannot be launched, errors,
// or exits non-zero we log and still kill the direct child so it never survives. On POSIX child.kill()
// likewise reaches only the immediate child, so descendants are discovered via `ps` and signaled before
// the child, and we await the child's real exit. This never rejects: any failure resolves to void so a
// kill can never surface into the caller (before-quit -> app.exit).
export const terminateProcessTree = async (
  child: ChildProcess,
  signal?: NodeJS.Signals,
  log?: ProcessTreeLogger
): Promise<void> => {
  if (process.platform === 'win32') {
    if (child.pid === undefined) return

    let killer: ChildProcess
    try {
      killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch (error) {
      // spawn itself can throw synchronously (e.g. taskkill missing); fall back to the direct kill.
      log?.error('taskkill failed to launch; falling back to direct kill', error)
      killDirectChild(child, signal)
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      // Non-zero exit means taskkill did not reap the tree (e.g. process not found); back it up by
      // signaling the direct child so it never outlives the app.
      killer.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          log?.error(`taskkill exited with code ${code}; falling back to direct kill`)
          killDirectChild(child, signal)
        }
        done()
      })
      killer.on('close', done)
      killer.on('error', (error) => {
        log?.error('taskkill errored; falling back to direct kill', error)
        killDirectChild(child, signal)
        done()
      })
      // A wedged taskkill must not hang quit; abandon it after the grace, backing up with a direct kill.
      const timer = setTimeout(() => {
        log?.error('taskkill did not complete in time; falling back to direct kill')
        killDirectChild(child, signal)
        done()
      }, TERMINATE_GRACE_MS)
      timer.unref?.()
    })
    return
  }

  if (child.pid === undefined) {
    killDirectChild(child, signal)
    await waitForExit(child, TERMINATE_GRACE_MS)
    return
  }

  const descendants = await collectDescendantPids(child.pid)
  // Signal descendants first so they can't be re-parented and outlive the tree once the child dies.
  for (const pid of descendants) {
    try {
      process.kill(pid, signal)
    } catch {
      // The descendant may have already exited, or we may lack permission; ignore and continue.
    }
  }
  killDirectChild(child, signal)
  await waitForExit(child, TERMINATE_GRACE_MS)
}
