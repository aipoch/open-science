import type { UpdateStatus } from '../../shared/update'

// Readiness reported by the pre-install gate: whether the backend teardown completed within its budget
// and whether every process tree was cleanly reaped. Structurally matches lifecycle-shutdown's
// ShutdownOutcome so the coordinator satisfies it without coupling update code to that module.
export type InstallReadiness = { completed: boolean; reaped: boolean }

// Runs backend teardown before an in-place install and reports whether it is safe to proceed. Injected
// after the runtime exists; the in-place (NSIS/Squirrel) strategy awaits it before quitAndInstall so it
// never triggers the installer's uninstall step while a background process still holds app files open.
export type InstallGate = () => Promise<InstallReadiness>

// The platform-agnostic update contract the IPC layer and scheduler drive. Two implementations exist:
// ElectronUpdaterStrategy (win/linux, and signed stable macOS — in-place download/restart) and
// UpdateService (dev/nightly macOS + any other fallback — manifest download + manual reinstall). Both
// broadcast the same UpdateStatus. See create-strategy.ts for how the host is routed.
export interface UpdateStrategy {
  getStatus(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  // Applies a ready update: open the installer (mac) or quitAndInstall (win/linux).
  apply(): Promise<UpdateStatus>
  // Optional: inject the pre-install backend-shutdown gate. Only the in-place strategy uses it; the
  // manifest fallback (which opens an installer without quitting the running app) leaves it unset.
  setInstallGate?(gate: InstallGate): void
}
