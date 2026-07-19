// Startup orchestration for the UI process, kept as a dependency-injected unit (no Electron imports) so
// the single-instance gate, the second-instance-during-startup handoff, and the ordering of the
// migration quit-guard relative to the lifecycle can be exercised together in a unit test — the real
// combination, not just each helper in isolation.

// A late-bound relay for OS 'second-instance' events. The lock's handler must be supplied at lock time,
// but the handler a second launch needs (surface the window, or start the web service for a --serve
// request) does not exist until the lifecycle is installed. The relay queues the forwarded argv of any
// request that arrives during that window and drains it, in order, once a target is bound.
export type SecondInstanceRelay = {
  // Wired into the single-instance lock as its onSecondInstance handler; carries the launch's argv so the
  // bound handler can tell a plain re-launch (surface the window) from a CLI --serve request.
  signal: (argv: string[]) => void
  // Bind the second-instance handler once it exists; immediately drains any requests queued during startup.
  bind: (handler: (argv: string[]) => void) => void
}

export const createSecondInstanceRelay = (): SecondInstanceRelay => {
  const pending: string[][] = []
  let handler: ((argv: string[]) => void) | undefined

  return {
    signal: (argv) => {
      if (handler) handler(argv)
      else pending.push(argv)
    },
    bind: (next) => {
      handler = next
      while (pending.length > 0) handler(pending.shift() as string[])
    }
  }
}

export type AppStartupDeps<Context> = {
  // Acquires the OS single-instance lock, wiring the relay's signal as the second-instance handler.
  // Returns false for a secondary launch (the caller must quit) and true for the primary.
  acquireSingleInstanceLock: (opts: { onSecondInstance: (argv: string[]) => void }) => boolean
  // Quits this launch when it is a secondary instance.
  quit: () => void
  // Heavy post-lock preparation (backend module imports, app.whenReady, logger, IPC registration). Runs
  // ONLY after the lock is held so a doomed secondary instance never imports the backend or spawns a
  // duplicate process tree. Returns the context the guard/lifecycle installers need.
  prepare: () => Promise<Context>
  // Installs the migration quit-guard. Must run before the lifecycle so its before-quit fires first: a
  // migration-cancelled quit leaves defaultPrevented set, which the lifecycle's quit cleanup honors.
  installMigrationQuitGuard: (context: Context) => void
  // Installs the tray/window/quit lifecycle; returns the second-instance handler for the relay to drain.
  // The handler decides per forwarded argv whether to surface the window or start the web service.
  installAppLifecycle: (context: Context) => { onSecondInstance: (argv: string[]) => void }
}

// Runs the ordered startup sequence: gate on the single-instance lock (quitting a secondary launch
// before any backend work), prepare the backend, install the migration guard, then the lifecycle, and
// finally bind the second-instance relay to the window — draining any handoff that arrived mid-startup.
export const orchestrateAppStartup = async <Context>(
  deps: AppStartupDeps<Context>
): Promise<void> => {
  const relay = createSecondInstanceRelay()

  if (!deps.acquireSingleInstanceLock({ onSecondInstance: relay.signal })) {
    deps.quit()
    return
  }

  const context = await deps.prepare()
  deps.installMigrationQuitGuard(context)
  const { onSecondInstance } = deps.installAppLifecycle(context)
  relay.bind(onSecondInstance)
}
