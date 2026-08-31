import { dialog, type App } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import { currentApplicationShutdownTrigger } from '../application-shutdown-trigger'

// Module-level state (not parameters) because the quit guard, the migrate IPC handler, and the
// ACP/notebook write paths live in different modules but must agree on a single truth. The three
// flags describe the migration/write gates; activeQuitOperation joins a confirmed quit to the
// command that owns those flags.
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
type MigrationQuitOperation = {
  controller: AbortController
  settled: Promise<void>
  committed: boolean
  markCommitted: () => void
  finish: () => void
}
let activeQuitOperation: MigrationQuitOperation | undefined
let activeDataRootWriters = 0
const writerDrainWaiters = new Set<() => void>()
const dataRootWriteContext = new AsyncLocalStorage<boolean>()

// Reserves the lifecycle quit guard before the command's first asynchronous validation/preparation
// boundary. This intentionally leaves `pending` false so ordinary writes remain available until the
// copy is ready to start. The returned handle must be finished when the owning command settles.
export type MigrationPreparationOperation = {
  signal: AbortSignal
  markCommitted: () => void
  finish: () => void
}

export const beginMigrationPreparation = (
  controller = new AbortController()
): MigrationPreparationOperation => {
  preparing = true
  let resolveSettled: (() => void) | undefined
  const operation: MigrationQuitOperation = {
    controller,
    committed: false,
    settled: new Promise<void>((resolve) => {
      resolveSettled = resolve
    }),
    markCommitted: () => {
      operation.committed = true
    },
    finish: () => {
      if (activeQuitOperation !== operation) return
      activeQuitOperation = undefined
      resolveSettled?.()
    }
  }
  activeQuitOperation = operation
  return {
    signal: controller.signal,
    markCommitted: operation.markCommitted,
    finish: operation.finish
  }
}

// A recovered commit temporarily enters the copy/write gate while it drains writers, then returns
// to preparation without starting a second quit-cancellable operation.
export const resumeMigrationPreparation = (): void => {
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

// Clears all migration/write flags after the quit guard has joined the cancelled command.
export const endMigration = (): void => {
  preparing = false
  copying = false
  pending = false
}

// Quit-anyway must cancel and join the command that owns the preparation flag before the lifecycle
// reissues app.quit(). Clearing flags alone would let that command resume and persist a new pointer
// concurrently with ordinary shutdown. Once the command marks its pointer committed, retain the
// write gate: that path owns a mandatory relaunch/terminal handoff even though cancellation arrived.
export const cancelMigrationForQuit = async (): Promise<void> => {
  const operation = activeQuitOperation
  operation?.controller.abort()
  await operation?.settled
  if (!operation?.committed) endMigration()
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
// accident, not about preventing data loss. A system-owned shutdown skips the interactive choice and
// uses the same safe cancel/join path because the OS request must not leave a latent shutdown trigger.
// On confirmation/cancellation the active command is aborted and awaited before quit is re-issued.
// Pre-commit cancellation clears the flags; a command that commits while being joined keeps the write
// gate and performs its mandatory relaunch. `confirmQuit` is injectable for tests.
export const installMigrationQuitGuard = (
  app: Pick<App, 'on' | 'quit'>,
  confirmQuit?: () => boolean,
  translate: NativeTranslator = englishNativeTranslator
): void => {
  let quitCancellationPending = false
  app.on('before-quit', (event) => {
    if (!isMigrationInProgress()) return
    event.preventDefault()
    if (quitCancellationPending) return
    const systemShutdown = currentApplicationShutdownTrigger() === 'system'
    if (systemShutdown || (confirmQuit ?? (() => defaultConfirmQuit(translate)))()) {
      quitCancellationPending = true
      void cancelMigrationForQuit().then(() => {
        quitCancellationPending = false
        app.quit()
      })
    }
  })
}
