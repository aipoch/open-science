import { dialog, type App } from 'electron'

// Two module-level flags (not parameters) because the quit guard, the migrate IPC handler, and the
// ACP/notebook write paths live in different modules but must agree on a single truth.
//   - `copying`  drives the before-quit guard: true only while runDataRootMigration is actively copying.
//   - `pending`  drives the write-gate: true from the moment the copy starts until the switch is
//     committed (and the app relaunches) or the copy is cancelled/discarded. It stays true across the
//     copy→commit window — the exact interval during which a prompt or notebook cell writing to the
//     OLD root would be silently discarded by the commit's delete step.
let copying = false
let pending = false
let activeDataRootWriters = 0
const writerDrainWaiters = new Set<() => void>()

// Marks the start of a migration copy. Sets both flags. Pair with endMigrationCopy() in a finally.
export const beginMigration = (): void => {
  copying = true
  pending = true
}

// The copy finished (success, failure, or cancel): relax the quit guard, but leave `pending` untouched
// so a successful-but-uncommitted copy keeps blocking writes until commit or discard resolves it.
export const endMigrationCopy = (): void => {
  copying = false
}

// The migration is fully resolved without committing (copy failed/cancelled, discarded, or a
// switchover failure left the app on the old root): clear both flags so normal writes resume.
export const clearMigrationPending = (): void => {
  pending = false
  copying = false
}

// Clears both flags. Used by the quit-guard confirm path (the user is quitting anyway).
export const endMigration = (): void => {
  copying = false
  pending = false
}

export const isMigrationInProgress = (): boolean => copying

// True whenever a copy is staged-but-not-yet-committed; gates ACP prompts and notebook cell runs so
// they can't write into the old root during the copy→commit window.
export const isMigrationPending = (): boolean => pending

// Throws the standard user-facing error when a migration is pending. Called at every data-root write
// entry point (ACP prompt, notebook run/execute, uploads) so no new write can land in the old root
// during the copy→commit window and be lost on the commit's delete.
export const assertNoMigrationPending = (): void => {
  if (pending) {
    throw new Error(
      'Open Science is moving your data. Wait for the move to finish before running this.'
    )
  }
}

export const withDataRootWrite = async <Result>(write: () => Promise<Result>): Promise<Result> => {
  assertNoMigrationPending()
  activeDataRootWriters += 1
  try {
    return await write()
  } finally {
    activeDataRootWriters -= 1
    if (activeDataRootWriters === 0) {
      for (const resolve of writerDrainWaiters) resolve()
      writerDrainWaiters.clear()
    }
  }
}

export const waitForDataRootWriters = (): Promise<void> => {
  if (activeDataRootWriters === 0) return Promise.resolve()
  return new Promise((resolve) => writerDrainWaiters.add(resolve))
}

// Native confirm shown when the user tries to quit mid-migration. Returns true iff they chose to
// quit anyway. Kept as the injectable default so the guard's control flow stays unit-testable
// without a real Electron dialog.
const defaultConfirmQuit = (): boolean =>
  dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Keep waiting', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Move in progress',
    message: 'Open Science is still moving your data.',
    detail:
      'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.'
  }) === 1

// Installs a before-quit guard so an in-flight migration is not silently torn down by Cmd+Q / the
// window close button. The move itself is crash-safe (copy → verify → commit → delete leaves either
// the old or the new root fully intact), so this is about not making the user redo a move by
// accident, not about preventing data loss. On confirmation the flag is cleared and quit re-issued,
// so the second pass falls straight through. `confirmQuit` is injectable for tests.
export const installMigrationQuitGuard = (
  app: Pick<App, 'on' | 'quit'>,
  confirmQuit: () => boolean = defaultConfirmQuit
): void => {
  app.on('before-quit', (event) => {
    if (!isMigrationInProgress()) return
    event.preventDefault()
    if (confirmQuit()) {
      endMigration()
      app.quit()
    }
  })
}
