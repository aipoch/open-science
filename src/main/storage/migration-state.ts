import { dialog, type App } from 'electron'

// Whether a data-root migration is copying/verifying/deleting right now. A module-level flag (not a
// parameter) because the quit guard in the app lifecycle and the migrate IPC handler live in
// different modules but must agree on a single truth. Set for the whole duration of runDataRootMigration.
let migrationInProgress = false

// Marks the start of a migration. Pair every call with endMigration() in a finally block.
export const beginMigration = (): void => {
  migrationInProgress = true
}

// Marks the end of a migration (success, failure, or cancel).
export const endMigration = (): void => {
  migrationInProgress = false
}

export const isMigrationInProgress = (): boolean => migrationInProgress

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
