import { dialog, type App } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'

// Three module-level flags (not parameters) because the quit guard, the migrate IPC handler, and the
// ACP/notebook write paths live in different modules but must agree on a single truth.
//   - `preparing` drives the before-quit guard while target validation and durable handoff preparation
//     await, without closing the write gate before a copy is ready to start.
//   - `copying`  drives the before-quit guard: true only while runDataRootMigration is actively copying.
//   - `pending`  drives the write-gate: true from the moment the copy starts until the switch is
//     committed (and the app relaunches) or the copy is cancelled/discarded. It stays true across the
//     copy→commit window — the exact interval during which a prompt or notebook cell writing to the
//     OLD root would be silently discarded by the commit's delete step.
let preparing = false
let copying = false
let pending = false
let activeDataRootWriters = 0
const writerDrainWaiters = new Set<() => void>()
const dataRootWriteContext = new AsyncLocalStorage<boolean>()

// Reserves the lifecycle quit guard before the command's first asynchronous validation/preparation
// boundary. This intentionally leaves `pending` false so ordinary writes remain available until the
// copy is ready to start. Pair with beginMigration() or endMigrationCopy() in the command's finally.
export const beginMigrationPreparation = (): void => {
  preparing = true
}

// Marks the start of a migration copy. Transitions preparation into the copy + write gates. Pair
// with endMigrationCopy() in a finally.
export const beginMigration = (): void => {
  preparing = false
  copying = true
  pending = true
}

// The copy finished (success, failure, or cancel): relax the quit guard, but leave `pending` untouched
// so a successful-but-uncommitted copy keeps blocking writes until commit or discard resolves it.
export const endMigrationCopy = (): void => {
  preparing = false
  copying = false
}

// The migration is fully resolved without committing (copy failed/cancelled, discarded, or a
// switchover failure left the app on the old root): clear both flags so normal writes resume.
export const clearMigrationPending = (): void => {
  preparing = false
  pending = false
  copying = false
}

// Clears both flags. Used by the quit-guard confirm path (the user is quitting anyway).
export const endMigration = (): void => {
  preparing = false
  copying = false
  pending = false
}

export const isMigrationInProgress = (): boolean => preparing || copying

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

// Acquires one logical writer slot until the returned release callback is invoked. Long-lived
// multi-call operations (for example a chunked upload) keep this lease across their entire protocol
// so migration cannot begin in a gap between individual IPC requests. Release is idempotent.
export const acquireDataRootWriter = (): (() => void) => {
  assertNoMigrationPending()
  activeDataRootWriters += 1

  let released = false
  return () => {
    if (released) return
    released = true
    activeDataRootWriters -= 1
    if (activeDataRootWriters === 0) {
      for (const resolve of writerDrainWaiters) resolve()
      writerDrainWaiters.clear()
    }
  }
}

export const withDataRootWrite = async <Result>(write: () => Promise<Result>): Promise<Result> => {
  // Higher-level operations compose lower-level repositories that may independently protect their
  // own write boundary. Treat nested calls in the same async chain as one logical lease: migration
  // already waits for the outer lease, and rejecting the inner call after `pending` rises would abort
  // the very in-flight operation that the drain protocol is designed to let finish.
  if (dataRootWriteContext.getStore()) return write()
  const release = acquireDataRootWriter()
  try {
    return await dataRootWriteContext.run(true, write)
  } finally {
    release()
  }
}

export const waitForDataRootWriters = (): Promise<void> => {
  if (activeDataRootWriters === 0) return Promise.resolve()
  return new Promise((resolve) => writerDrainWaiters.add(resolve))
}

// Native confirm shown when the user tries to quit mid-migration. Returns true iff they chose to
// quit anyway. Kept as the injectable default so the guard's control flow stays unit-testable
// without a real Electron dialog.
const defaultConfirmQuit = (translate: NativeTranslator): boolean =>
  dialog.showMessageBoxSync({
    type: 'warning',
    buttons: [translate('Keep waiting'), translate('Quit anyway')],
    defaultId: 0,
    cancelId: 0,
    title: translate('Move in progress'),
    message: translate('Open Science is still moving your data.'),
    detail: translate(
      'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.'
    )
  }) === 1

// Installs a before-quit guard so an in-flight migration is not silently torn down by Cmd+Q / the
// window close button. The move itself is crash-safe (copy → verify → commit → delete leaves either
// the old or the new root fully intact), so this is about not making the user redo a move by
// accident, not about preventing data loss. On confirmation the flag is cleared and quit re-issued,
// so the second pass falls straight through. `confirmQuit` is injectable for tests.
export const installMigrationQuitGuard = (
  app: Pick<App, 'on' | 'quit'>,
  confirmQuit?: () => boolean,
  translate: NativeTranslator = englishNativeTranslator
): void => {
  app.on('before-quit', (event) => {
    if (!isMigrationInProgress()) return
    event.preventDefault()
    if ((confirmQuit ?? (() => defaultConfirmQuit(translate)))()) {
      endMigration()
      app.quit()
    }
  })
}
