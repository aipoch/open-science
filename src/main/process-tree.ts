import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

// Terminates a child process and every descendant it spawned. On Windows a plain child.kill() only
// signals the immediate child, orphaning grandchildren (e.g. conda / the claude CLI), so we hand the
// whole tree to taskkill /T /F and await its completion — the caller (before-quit → app.exit) can then
// be sure the tree is reaped before the app exits. On other platforms Node's own kill propagates well
// enough and the signal is delivered synchronously. This never rejects: a failed taskkill launch (or
// its own runtime error) must resolve to void rather than surface into the caller.
export const terminateProcessTree = (
  child: ChildProcess,
  signal?: NodeJS.Signals
): Promise<void> => {
  if (process.platform === 'win32') {
    if (child.pid === undefined) return Promise.resolve()
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true
      })
      // Resolve once taskkill finishes, however it finishes: normal exit, stream close, or a runtime
      // error. Guarded so we resolve exactly once regardless of which event fires first.
      return new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        killer.on('exit', done)
        killer.on('close', done)
        killer.on('error', done)
      })
    } catch {
      // spawn itself can throw synchronously (e.g. taskkill missing); resolve so a kill never fails.
      return Promise.resolve()
    }
  }

  try {
    child.kill(signal)
  } catch {
    // A kill on an already-exited child can throw; treat it as a no-op.
  }
  return Promise.resolve()
}
