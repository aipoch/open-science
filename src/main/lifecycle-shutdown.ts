// Coordinates a bounded, best-effort shutdown of the app's backend subsystems (agent runtime and
// notebook kernels). Kept free of Electron imports so it stays trivially unit-testable: callers inject
// the runtime/notebook handles. Every operation is time-bounded so app quit can never hang on a backend
// that refuses to settle, and reports { reaped } so the update-install gate can tell a clean teardown
// (all process trees gone, file handles released) from a degraded one (taskkill fell back to the parent).

export type ShutdownOutcome = {
  // The two backend teardowns settled within the budget (false = the deadline elapsed first).
  completed: boolean
  // Every process tree was cleanly reaped. Only meaningful when completed is true; false otherwise.
  reaped: boolean
}

type ShutdownLogger = { error: (msg: string, err?: unknown) => void }

// Deps for the quit/relaunch helper: only the latching teardown is needed. Kept narrow so the migration
// relaunch path (storage/ipc.ts) does not have to expose the non-latching gate method it never uses.
export type QuitShutdownDeps = {
  runtime: {
    // Latching quit teardown: sets the runtime's shutting-down flag so a mid-spawn connect self-aborts
    // instead of orphaning its freshly-spawned child. disconnect() alone does not set that latch.
    shutdownForQuit: () => Promise<{ reaped: boolean }>
  }
  notebook: { shutdownAll: () => Promise<{ reaped: boolean }> }
  log?: ShutdownLogger
  // Upper bound for the quit-path helpers; defaults to QUIT_SHUTDOWN_BUDGET_MS.
  timeoutMs?: number
}

// Deps for the coordinator, which drives BOTH paths, so it also needs the non-latching gate teardown.
export type BackendShutdownDeps = QuitShutdownDeps & {
  runtime: {
    // Non-latching pre-update-install teardown: reaps the agent tree but leaves the runtime usable so a
    // refused install does not wedge the app (the next prompt lazily reconnects).
    shutdownForUpdateGate: () => Promise<{ reaped: boolean }>
  }
}

// Normal quit/relaunch budget: keep it short so a stuck backend can't hang quit.
export const QUIT_SHUTDOWN_BUDGET_MS = 5000
// Pre-update-install budget: longer than a single tree's worst-case teardown (a notebook kernel can take
// up to ~6s for taskkill /T + ~5s waiting for the real exit). The installer's uninstall step deletes the
// running app's files, so releasing every handle first matters more here than finishing quickly.
export const UPDATE_SHUTDOWN_BUDGET_MS = 15000

// Runs two backend teardowns concurrently, never rejecting and never running longer than budgetMs. A
// failing backend is logged but does not block the other, and a hung backend is abandoned once the
// deadline elapses so the caller always makes progress. Returns whether both settled within budget and
// whether every process tree was cleanly reaped.
const runBounded = async (
  runtimeTeardown: Promise<{ reaped: boolean }>,
  notebookTeardown: Promise<{ reaped: boolean }>,
  budgetMs: number,
  log?: BackendShutdownDeps['log']
): Promise<ShutdownOutcome> => {
  let reaped = false

  // allSettled ensures one rejection never short-circuits the other.
  const settleAll = Promise.allSettled([runtimeTeardown, notebookTeardown]).then(
    ([runtimeResult, notebookResult]) => {
      if (runtimeResult.status === 'rejected') {
        log?.error('runtime shutdown failed during shutdown', runtimeResult.reason)
      }
      if (notebookResult.status === 'rejected') {
        log?.error('notebook shutdownAll failed during shutdown', notebookResult.reason)
      }

      // Optional chaining keeps the never-throw invariant even if a teardown resolves a malformed value.
      const runtimeReaped =
        runtimeResult.status === 'fulfilled' && runtimeResult.value?.reaped === true
      const notebookReaped =
        notebookResult.status === 'fulfilled' && notebookResult.value?.reaped === true
      reaped = runtimeReaped && notebookReaped
    }
  )

  // Race the work against a self-unreffing timer so a stuck backend can't keep the process alive or hang
  // quit; whichever finishes first resolves the caller.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs)
    timer.unref?.()
  })

  const result = await Promise.race([settleAll.then(() => 'done' as const), deadline])
  if (timer) clearTimeout(timer)

  const completed = result === 'done'
  return { completed, reaped: completed && reaped }
}

// Quit/relaunch helper (latching teardown). Kept as a standalone function for the data-root migration
// relaunch path (storage/ipc.ts); the app-quit path goes through BackendShutdownCoordinator instead.
// Returns void for backward compatibility — that caller only needs the bounded, never-throwing await.
export const shutdownBackends = async (deps: QuitShutdownDeps): Promise<void> => {
  await runBounded(
    deps.runtime.shutdownForQuit(),
    deps.notebook.shutdownAll(),
    deps.timeoutMs ?? QUIT_SHUTDOWN_BUDGET_MS,
    deps.log
  )
}

// Single shared owner of backend teardown, used by BOTH the before-quit handler and the pre-update-install
// gate so the two paths agree on the backend handles. The two entry points differ deliberately:
//   - runForQuit uses the LATCHING runtime teardown and a short budget (the app is going down regardless).
//   - runForUpdateGate uses the NON-LATCHING runtime teardown and a longer budget, so a degraded teardown
//     can be refused without wedging a runtime that must keep serving the still-open app.
// Idempotency across the two (gate runs, then before-quit) is natural: the gate clears the agent process
// and notebook sessions, so the subsequent quit teardown finds nothing left to kill and returns fast.
export class BackendShutdownCoordinator {
  constructor(private readonly deps: BackendShutdownDeps) {}

  runForQuit(
    budgetMs: number = this.deps.timeoutMs ?? QUIT_SHUTDOWN_BUDGET_MS
  ): Promise<ShutdownOutcome> {
    return runBounded(
      this.deps.runtime.shutdownForQuit(),
      this.deps.notebook.shutdownAll(),
      budgetMs,
      this.deps.log
    )
  }

  runForUpdateGate(budgetMs: number = UPDATE_SHUTDOWN_BUDGET_MS): Promise<ShutdownOutcome> {
    return runBounded(
      this.deps.runtime.shutdownForUpdateGate(),
      this.deps.notebook.shutdownAll(),
      budgetMs,
      this.deps.log
    )
  }
}
