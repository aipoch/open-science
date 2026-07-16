import type { UpdateStatus } from '../../shared/update'

// The platform-agnostic update contract the IPC layer and scheduler drive. Two implementations exist:
// UpdateService (macOS + fallback, manifest download + manual reinstall) and ElectronUpdaterStrategy
// (win/linux, in-place download/restart). Both broadcast the same UpdateStatus.
export interface UpdateStrategy {
  getStatus(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  // Applies a ready update: open the installer (mac) or quitAndInstall (win/linux).
  apply(): Promise<UpdateStatus>
}
