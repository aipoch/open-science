// Coordinates a bounded, best-effort shutdown of the app's backend subsystems (agent runtime and
// notebook kernels). Kept free of Electron imports so it stays trivially unit-testable: callers inject
// the runtime/notebook handles. The whole operation is time-bounded so app quit can never hang on a
// backend that refuses to settle.

export type BackendShutdownDeps = {
  // shutdownForQuit (not disconnect): it latches the runtime's shutting-down flag before awaiting
  // teardown, so an agent connect that is mid-spawn when quit lands self-aborts instead of orphaning
  // its freshly-spawned child. disconnect() alone does not set that latch.
  runtime: { shutdownForQuit: () => Promise<void> }
  notebook: { shutdownAll: () => Promise<void> }
  log?: { error: (msg: string, err?: unknown) => void }
  // Upper bound for the whole shutdown; defaults to 5000ms.
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000

// Shuts down the runtime and notebook backends concurrently, never rejecting and never running longer
// than `timeoutMs`. A failing backend is logged but does not block the other, and a hung backend is
// abandoned once the timeout elapses so the caller (app quit) always makes progress.
export const shutdownBackends = async (deps: BackendShutdownDeps): Promise<void> => {
  const { runtime, notebook, log, timeoutMs = DEFAULT_TIMEOUT_MS } = deps

  // Run both backends together; allSettled ensures one rejection never short-circuits the other.
  const settleAll = Promise.allSettled([runtime.shutdownForQuit(), notebook.shutdownAll()]).then(
    ([runtimeResult, notebookResult]) => {
      if (runtimeResult.status === 'rejected') {
        log?.error('runtime.shutdownForQuit failed during shutdown', runtimeResult.reason)
      }
      if (notebookResult.status === 'rejected') {
        log?.error('notebook.shutdownAll failed during shutdown', notebookResult.reason)
      }
    }
  )

  // Race the work against a self-unreffing timer so a stuck backend can't keep the process alive or
  // hang quit; whichever finishes first resolves the caller.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })

  await Promise.race([settleAll, deadline])
  if (timer) clearTimeout(timer)
}
