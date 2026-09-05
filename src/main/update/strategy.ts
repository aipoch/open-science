import type {
  UpdateApplyOptions,
  UpdateBlocker,
  UpdateDownloadOptions,
  UpdateStatus
} from '../../shared/update'

// Readiness reported by the pre-install gate: whether the backend teardown completed within its budget
// and whether every process tree was cleanly reaped. Structurally matches lifecycle-shutdown's
// ShutdownOutcome so the coordinator satisfies it without coupling update code to that module.
export type InstallReadiness = {
  completed: boolean
  reaped: boolean
  blockedBy?: UpdateBlocker[]
}

// Runs backend teardown before an in-place install and reports whether it is safe to proceed. The
// in-place strategy receives it at construction and awaits it before quitAndInstall, so the installer
// never starts while a background process still holds app files open.
export type InstallGate = () => Promise<InstallReadiness>

const restoreAfterFinalRefusal = (restore: () => void): void => {
  try {
    restore()
  } catch {
    // Refusal remains authoritative if the best-effort renderer wake-up races a disappearing window.
  }
}

// Checks active research before teardown and once more at the final install boundary. Kept
// independent of Electron/runtime types so composition tests can prove both admission races close.
export const createActiveResearchSafeInstallGate =
  (
    detectBlockers: () => UpdateBlocker[],
    runTeardownGate: InstallGate,
    isExclusiveHandoffActive: () => boolean = () => false,
    onFinalRefusal: () => void = () => undefined
  ): InstallGate =>
  async () => {
    if (isExclusiveHandoffActive()) return { completed: false, reaped: false }
    const blockedBy = [...new Set(detectBlockers())]
    if (blockedBy.length > 0) return { completed: false, reaped: false, blockedBy }

    const readiness = await runTeardownGate()
    if (!readiness.completed || !readiness.reaped) return readiness
    if (isExclusiveHandoffActive()) {
      restoreAfterFinalRefusal(onFinalRefusal)
      return { completed: false, reaped: false }
    }
    const finalBlockedBy = [...new Set(detectBlockers())]
    if (finalBlockedBy.length === 0) return readiness
    restoreAfterFinalRefusal(onFinalRefusal)
    return { completed: false, reaped: false, blockedBy: finalBlockedBy }
  }

// Keeps the data-root teardown composition independently testable from the full IPC graph. Direct
// root switches have no confirmation step, so every producer must be absent before teardown starts.
export const createDataRootResearchSafeInstallGate = (
  detectBlockers: () => UpdateBlocker[],
  runTeardownGate: InstallGate,
  confirmedInterruption = false
): InstallGate =>
  createActiveResearchSafeInstallGate(() => {
    const blockers = detectBlockers()
    return confirmedInterruption
      ? blockers.filter(
          (blocker) =>
            blocker === 'delegated' || blocker === 'reviewer' || blocker === 'settings-install'
        )
      : blockers
  }, runTeardownGate)

// Confirms renderer-owned state is durable only after backend teardown has stopped producing runtime
// events. A refused durability check leaves the installer untouched, while the non-latching teardown
// allows the still-open app to reconnect on the next action.
export const createDurableInstallGate =
  (runTeardownGate: InstallGate, confirmRendererDurability: () => Promise<boolean>): InstallGate =>
  async () => {
    const readiness = await runTeardownGate()
    if (!readiness.completed || !readiness.reaped) return readiness
    return (await confirmRendererDurability()) ? readiness : { completed: false, reaped: false }
  }

// Shared admission invariant for every update provider. A failed transfer with a known release may
// retry; a completed ready artifact must remain authoritative until check() supersedes it.
export const canStartUpdateDownload = (status: UpdateStatus): boolean =>
  status.state === 'available' || (status.state === 'error' && Boolean(status.latest))

// Restores the release offer after a cancelled transfer. Build a fresh object so download-only
// fields are absent from the returned/broadcast payload rather than retained with stale values (or
// retained explicitly as undefined). totalBytes belongs to the offer itself and remains useful before
// a retry starts.
export const toAvailableUpdateStatus = ({
  current,
  latest,
  notes,
  localizedNotes,
  download,
  totalBytes,
  applyKind
}: UpdateStatus): UpdateStatus => ({
  state: 'available',
  current,
  ...(latest === undefined ? {} : { latest }),
  ...(notes === undefined ? {} : { notes }),
  ...(localizedNotes === undefined ? {} : { localizedNotes }),
  ...(download === undefined ? {} : { download }),
  ...(totalBytes === undefined ? {} : { totalBytes }),
  ...(applyKind === undefined ? {} : { applyKind })
})

// The platform-agnostic update contract the IPC layer and scheduler drive. Two implementations exist:
// ElectronUpdaterStrategy (win/linux, and signed stable macOS — in-place download/restart) and
// UpdateService (dev/nightly macOS + any other fallback — manifest download + manual reinstall). Both
// broadcast the same UpdateStatus. See create-strategy.ts for how the host is routed.
export interface UpdateStrategy {
  getStatus(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(options?: UpdateDownloadOptions): Promise<UpdateStatus>
  // Aborts an in-flight download, stops network activity, and returns the reset status (back to
  // 'available' when a download was running). A no-op when nothing is downloading.
  cancel(): Promise<UpdateStatus>
  // Applies a ready update: open the installer (mac) or quitAndInstall (win/linux).
  apply(options?: UpdateApplyOptions): Promise<UpdateStatus>
}
