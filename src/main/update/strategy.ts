import type { UpdateStatus } from '../../shared/update'

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
}
