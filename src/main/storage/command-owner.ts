import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { app, dialog, shell } from 'electron'

import type {
  ActiveSessionInfo,
  DataRootInspection,
  MigrationOutcome,
  MigrationProgress,
  RevealAppStorageResult,
  StorageInfo
} from '../../shared/storage'
import {
  computeDefaultDataRoot,
  dataRootForPicked,
  defaultDataParent,
  resolveConfigRoot,
  resolveDataRoot,
  samePath
} from '../storage-root'
import { resolveMicromamba } from '../notebook/micromamba'
import type { MicromambaRunner } from '../notebook/windows-micromamba-runner'
import { captureMicromamba } from '../notebook/provisioner-runtime'
import { exportRuntimeLocks } from '../notebook/runtime-relocation'
import { removeMicromambaCacheForRoot } from '../notebook/micromamba-cache'
import { detectActiveSessions } from './detect-active'
import { isDataRootMissing } from './path-presence'
import { beginMigration, clearMigrationPending, endMigrationCopy } from './migration-state'
import {
  classifyDataRoot,
  commitDataRootSwitch,
  discardStagedCopy,
  runDataRootMigration,
  validateNewDataRoot,
  type ValidateResult
} from './migration-service'
import { availableBytes, computeStorageUsage } from './usage'
import { broadcastToRenderers } from '../renderer-broadcast'
import { RELOCATABLE_DATA_DIRS } from './data-directories'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { markApplicationShutdownTrigger } from '../application-shutdown-trigger'

type SessionSource = { projectName: string; sessionId: string }

type StorageCommandOwnerDeps = {
  // disconnect/shutdownAll drive the reusable migration session-interrupt; shutdownForQuit/dispose are
  // the terminal teardown used by cleanRelaunch (via shutdownBackends).
  runtime: {
    disconnect: () => Promise<unknown>
    shutdownForQuit: () => Promise<{ reaped: boolean }>
  }
  notebook: {
    shutdownAll: () => Promise<{ reaped: boolean }>
    dispose: () => Promise<{ reaped: boolean }>
    getActiveNotebookSessions: () => SessionSource[]
  }
  getActivePromptSessions: () => SessionSource[]
  settingsService: {
    setDataRoot: (path: string) => Promise<void>
    // Stamps onboardingCompletedAt. Injected (rather than importing the renderer store action)
    // so the marker can be persisted in the same main-process step as setDataRoot, before the
    // renderer's startup gate ever has a chance to flip.
    markOnboardingComplete: () => Promise<unknown>
    // Marks the one-time legacy-data-move prompt as answered so it is never shown again.
    dismissLegacyDataMovePrompt: () => Promise<unknown>
    // Read to detect an explicitly-configured-but-now-gone data root (see dataRootMissing below)
    // and to gate the one-time legacy-data-move prompt (legacyDataMovePromptDismissedAt).
    getStoredSettings: () => Promise<{
      dataRoot?: string
      legacyDataMovePromptDismissedAt?: number
    }>
  }
  // Injectable for tests; production defaults are Electron-backed.
  showOpenDialog?: () => Promise<string | null>
  relaunch?: () => void
  broadcastProgress?: (progress: MigrationProgress) => void
  cleanupRuntimeCache?: (runtimeRoot: string) => void
  logger?: Logger
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  exportRuntimeLocks?: typeof exportRuntimeLocks
}

type StorageParentRequest = Readonly<{ parent: string }>
type StorageRootRequest = Readonly<{ parent: string; markOnboarding?: boolean }>

// Pushes migration progress to every live window, mirroring the acp/update broadcast pattern.
const defaultBroadcast = (progress: MigrationProgress): void => {
  broadcastToRenderers('storage:migrate-progress', progress)
}

// Owns the renderer-callable data-root storage commands and their migration state. One instance can
// serve both legacy IPC and the Host command router, so cancellation and staged-copy resolution use
// the same AbortController, token, and transition gates regardless of the caller surface.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const createStorageCommandOwner = (deps: StorageCommandOwnerDeps) => {
  let activeMigration: AbortController | undefined
  // The token + target of the copy THIS session staged (set when a copy verifies, cleared when the
  // migration resolves). commit/discard require it so a stale renderer call can't act on a foreign copy.
  let activeStaged: { token: string; target: string; correlationId: string } | undefined
  let resolutionInProgress = false
  const cleanupRuntimeCache = deps.cleanupRuntimeCache ?? removeMicromambaCacheForRoot
  const unsafeLogger = deps.logger ?? createLogger('storage:ipc')
  const emitSafely = (level: keyof Logger, message: string, data?: unknown): void => {
    try {
      unsafeLogger[level](message, data)
    } catch {
      // Storage behavior and return values remain authoritative when diagnostics are unavailable.
    }
  }
  const logger: Logger = {
    debug: (message, data) => emitSafely('debug', message, data),
    info: (message, data) => emitSafely('info', message, data),
    warn: (message, data) => emitSafely('warn', message, data),
    error: (message, data) => emitSafely('error', message, data)
  }

  const getInfo = async (): Promise<StorageInfo> => {
    const dataRoot = resolveDataRoot()
    let available = 0
    try {
      available = await availableBytes(dataRoot)
    } catch (err) {
      logger.warn('available storage lookup failed', diagnosticErrorFields(err))
    }

    // Only an explicitly-configured-but-now-gone root counts as "missing"; a fresh install's unset
    // dataRoot (default `~/OpenScience` not created yet) is normal and must never nag the user.
    let dataRootMissing = false
    // A pre-§20 legacy install still keeps its data in the hidden config root: settings.dataRoot is
    // unset (using the default), that default resolved to the config root itself, and real user data
    // lives there. Offer the one-time "move to the visible OpenScience folder" prompt until answered.
    let legacyDataMovePrompt = false
    try {
      const storedSettings = await deps.settingsService.getStoredSettings()
      // Only an explicitly-configured root that stat proves is gone (ENOENT/ENOTDIR) counts as
      // missing. isDataRootMissing deliberately does NOT collapse other stat errors into "missing"
      // the way a bare existsSync would, so a non-ENOENT failure (seen with non-ASCII paths on some
      // Windows setups, or a transient drive/IO hiccup) can't nag the user to abandon real data.
      dataRootMissing = Boolean(storedSettings.dataRoot) && (await isDataRootMissing(dataRoot))

      const configRoot = resolveConfigRoot()
      const legacyInPlace = !storedSettings.dataRoot && samePath(dataRoot, configRoot)
      const hasUserData = RELOCATABLE_DATA_DIRS.some((dir) => existsSync(join(configRoot, dir)))
      legacyDataMovePrompt =
        legacyInPlace && hasUserData && storedSettings.legacyDataMovePromptDismissedAt === undefined
    } catch (err) {
      logger.warn('data root status detection failed', diagnosticErrorFields(err))
    }

    return {
      dataRoot,
      isDefault: samePath(dataRoot, computeDefaultDataRoot()),
      defaultDataRoot: computeDefaultDataRoot(),
      defaultParent: defaultDataParent(),
      dataRootMissing,
      legacyDataMovePrompt,
      usage: await computeStorageUsage(dataRoot),
      availableBytes: available
    }
  }

  const revealAppStorage = async (): Promise<RevealAppStorageResult> => {
    // The renderer supplies no path: main resolves the single trusted config root at invocation time.
    try {
      const error = await shell.openPath(resolveConfigRoot())
      if (error) logger.warn('application storage reveal failed', { errorCategory: 'shell' })
      return error ? { revealed: false, error } : { revealed: true }
    } catch (error) {
      logger.warn('application storage reveal failed', diagnosticErrorFields(error))
      return {
        revealed: false,
        error: error instanceof Error ? error.message : 'Could not reveal application storage.'
      }
    }
  }

  // The user answered the one-time legacy-data-move prompt without moving (declined, or chose "keep
  // it here"). Persist that so getInfo's legacyDataMovePrompt stays false and it's never shown again.
  // (Moving/relocating instead sets settings.dataRoot, which already disqualifies the prompt.)
  const dismissLegacyMovePrompt = async (): Promise<void> => {
    try {
      await deps.settingsService.dismissLegacyDataMovePrompt()
    } catch (err) {
      logger.warn('legacy move prompt dismissal failed', diagnosticErrorFields(err))
    }
  }

  const detectActive = (): ActiveSessionInfo[] =>
    detectActiveSessions({
      runtime: { getActivePromptSessions: deps.getActivePromptSessions },
      // Call as a method (arrow wrapper), never a bare reference: the real notebook service is a
      // class whose getActiveNotebookSessions reads `this.sessions`, so extracting it loose would
      // drop `this` and throw "Cannot read properties of undefined (reading 'values')".
      notebook: { getActiveNotebookSessions: () => deps.notebook.getActiveNotebookSessions() }
    })

  const pickDirectory = async (): Promise<string | null> => {
    try {
      if (deps.showOpenDialog) return await deps.showOpenDialog()
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      })
      return result.filePaths[0] ?? null
    } catch (err) {
      // Never let a picker failure surface as a raw rejection to the renderer; Browse
      // becomes a no-op instead.
      logger.warn('directory picker failed', diagnosticErrorFields(err))
      return null
    }
  }

  const migrate = async (request: StorageParentRequest): Promise<MigrationOutcome> => {
    if (activeStaged || resolutionInProgress) {
      return {
        ok: false,
        error: 'A completed migration is waiting to be committed or discarded.'
      }
    }
    if (activeMigration) {
      return { ok: false, error: 'A migration is already in progress.' }
    }

    const controller = new AbortController()
    const correlationId = randomUUID()
    activeMigration = controller
    // Flag the copy: sets both the quit guard (Cmd+Q warning) and the write-gate (blocks ACP/notebook
    // writes to the old root for the whole copy→commit window).
    beginMigration()
    try {
      // Phase 1 only: copy+verify into the new root. Nothing is committed (no setDataRoot, no
      // delete) — the old root and settings.dataRoot stay intact, so this is fully reversible.
      // Commit happens later, on the user's "Restart now" (storage:commit-and-relaunch).
      const result = await runDataRootMigration(
        {
          currentDataRoot: resolveDataRoot(),
          logger,
          diagnosticCorrelationId: correlationId,
          runtime: deps.runtime,
          notebook: deps.notebook,
          // Preserve the runtime across the move by exporting each env to an offline lock at the
          // new root; the copied pkgs cache lets the provisioner rebuild them offline on relaunch.
          exportRuntimeLocks: async (fromDataRoot, toDataRoot) =>
            (deps.exportRuntimeLocks ?? exportRuntimeLocks)(fromDataRoot, toDataRoot, {
              mm: deps.micromambaRunner
                ? await deps.micromambaRunner.resolve()
                : resolveMicromamba({ resourcesPath: process.resourcesPath }),
              capture: captureMicromamba
            })
        },
        request.parent,
        {
          signal: controller.signal,
          onProgress: (progress) => (deps.broadcastProgress ?? defaultBroadcast)(progress),
          onVerified: (staged) => {
            activeStaged = { ...staged, correlationId }
          }
        }
      )
      if (!result.ok) {
        // A failed/cancelled copy leaves the app on the old root, so clear the write-gate now.
        clearMigrationPending()
        activeStaged = undefined
      }
      return result
    } catch (err) {
      // runDataRootMigration never rejects; guard the IPC boundary anyway so a renderer call
      // never sees a raw thrown error. Nothing was committed, so lift the write-gate.
      logger.error('data root copy boundary failed', diagnosticErrorFields(err))
      clearMigrationPending()
      activeStaged = undefined
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      activeMigration = undefined
      // Relax the quit guard now the copy is done; `pending` (write-gate) persists on success.
      endMigrationCopy()
    }
  }

  const cancelMigrate = (): void => {
    // Once a copy has completed (activeStaged set), only commit/discard may resolve it: a late cancel
    // (renderer still showing Cancel during the copy→done transition) must NOT clear the gate/token and
    // leave a committable-but-unfrozen copy behind.
    if (activeStaged) return
    activeMigration?.abort()
  }

  // Discards a completed-but-uncommitted copy at `<parent>/OpenScience` when the user picks "Keep
  // current location" on the done stage. Since the copy phase never touched settings.dataRoot or the
  // old root, this just removes the new copy and leaves the app on its current root. discardStagedCopy
  // refuses anything that isn't a marker-confirmed staging copy for the current root, so a misrouted
  // parent can't delete live data. On a successful discard the write-gate is lifted. Never throws.
  const discardMigratedCopy = async (request: StorageParentRequest): Promise<void> => {
    if (activeMigration || resolutionInProgress) {
      // A copy is still running; discarding would race the writer. Ignore the (stale) request.
      logger.warn('staged data root discard ignored', { reason: 'copy-in-progress' })
      return
    }
    if (!activeStaged || !samePath(activeStaged.target, dataRootForPicked(request.parent))) {
      logger.warn('staged data root discard ignored', { reason: 'no-matching-copy' })
      return
    }
    const staged = activeStaged
    resolutionInProgress = true
    try {
      const result = await discardStagedCopy(
        { currentDataRoot: resolveDataRoot(), expectedToken: staged.token },
        request.parent
      )
      if (result.ok) {
        clearMigrationPending()
        activeStaged = undefined
      } else {
        logger.warn('staged data root discard refused', { reason: 'validation-failed' })
      }
    } catch (err) {
      logger.error('staged data root discard failed', diagnosticErrorFields(err))
    } finally {
      resolutionInProgress = false
    }
  }

  // Production relaunches through app.quit(), allowing the single application lifecycle owner to
  // drain usage, flush renderer persistence, stop backends, write a terminal diagnostic, and flush
  // main.log before exit. The injected callback remains a narrow test seam.
  const cleanRelaunch = async (): Promise<void> => {
    if (deps.relaunch) {
      deps.relaunch()
      return
    }
    app.relaunch()
    const rollbackTrigger = markApplicationShutdownTrigger('migration-relaunch')
    try {
      app.quit()
    } catch (error) {
      rollbackTrigger()
      throw error
    }
  }

  // Phase 2 (commit): invoked by the modal's "Restart now" once the copy is done. Flips
  // settings.dataRoot to the new root, deletes the old dirs, then relaunches. Ordered so an
  // interruption during the delete only orphans the old root (never data loss); see
  // commitDataRootSwitch. On switchoverFailed it returns without relaunching so the modal can show
  // the error (copy intact, old root untouched).
  const commitAndRelaunch = async (request: StorageParentRequest): Promise<MigrationOutcome> => {
    if (activeMigration) {
      return { ok: false, error: 'A migration copy is still in progress.' }
    }
    if (!activeStaged || !samePath(activeStaged.target, dataRootForPicked(request.parent))) {
      return { ok: false, error: 'No completed migration from this app session was found.' }
    }
    if (resolutionInProgress) {
      return { ok: false, error: 'A migration is already being resolved.' }
    }
    const staged = activeStaged
    resolutionInProgress = true
    const previousDataRoot = resolveDataRoot()
    let outcome: MigrationOutcome
    try {
      outcome = await commitDataRootSwitch(
        {
          currentDataRoot: resolveDataRoot(),
          // Arrow-wrapped so setDataRoot is called as a method (it reads `this.repository`).
          setDataRoot: (path) => deps.settingsService.setDataRoot(path),
          // Prove the on-disk copy is the one this session staged (guards against a stale marker).
          expectedToken: staged.token,
          logger,
          diagnosticCorrelationId: staged.correlationId
        },
        request.parent
      )
    } catch (err) {
      logger.error('data root commit boundary failed', diagnosticErrorFields(err))
      // The commit didn't complete; keep the app usable on the old root by lifting the write-gate.
      clearMigrationPending()
      activeStaged = undefined
      resolutionInProgress = false
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (outcome.ok) {
      // On success the write-gate stays set through relaunch: the fresh process starts with
      // pending=false, so writes naturally resume against the now-live new root.
      activeStaged = undefined
      cleanupRuntimeCache(join(previousDataRoot, 'runtime'))
      await cleanRelaunch()
    } else {
      // The commit did not switch over (switchoverFailed, or a no-op refusal: no verified copy /
      // mismatch). The UI's error stage offers no retry, so never leave the app soft-locked: on a
      // switchover failure discard the now-orphan staged copy (best-effort), then lift the write-gate
      // in every case. The old root is untouched and immediately usable.
      if ('switchoverFailed' in outcome) {
        await discardStagedCopy(
          { currentDataRoot: resolveDataRoot(), expectedToken: staged.token },
          request.parent
        ).catch(() => undefined)
      }
      clearMigrationPending()
      activeStaged = undefined
      resolutionInProgress = false
    }
    return outcome
  }

  // Onboarding's first-run location step: check a candidate parent before letting the user commit
  // to it. Never throws: validateNewDataRoot already guards fs errors, this catch only covers
  // anything unexpected escaping that contract.
  const validateDataRoot = async (request: StorageParentRequest): Promise<ValidateResult> => {
    try {
      return await validateNewDataRoot(request.parent, resolveDataRoot())
    } catch (err) {
      logger.warn('data root validation boundary failed', diagnosticErrorFields(err))
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Settings + onboarding recovery: classify a candidate parent without committing to it, so the
  // caller can route to the right UI (migrate confirm for 'move', adopt confirm for 'adopt',
  // inline error for 'invalid') and display the derived `<parent>/OpenScience` path regardless of
  // kind. Never throws.
  const inspectDataRoot = async (request: StorageParentRequest): Promise<DataRootInspection> => {
    const dataRoot = dataRootForPicked(request.parent)
    try {
      const result = await classifyDataRoot(request.parent, resolveDataRoot())
      return { ...result, dataRoot }
    } catch (err) {
      logger.warn('data root inspection boundary failed', diagnosticErrorFields(err))
      return {
        kind: 'invalid',
        dataRoot,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  // A no-move pointer switch: sets dataRoot and relaunches, without invoking the migration engine
  // - used both for onboarding's first-run apply (no data exists yet to move) and for adopting an
  // existing data folder from Settings (data already lives at the derived target; only the
  // pointer changes).
  // Unlike storage:migrate there is no copy phase and no session-interrupt step. Accepts both
  // 'move' and 'adopt' targets (classify != 'invalid') - the migration engine's own
  // validateNewDataRoot is stricter (move-only) and is never called here.
  //
  // `markOnboarding` is stamped here (not by a separate renderer completeOnboarding() call) so it
  // lands atomically with setDataRoot, in the same step as the relaunch: App.tsx's startup gate
  // reads onboardingCompletedAt, and flipping it from the renderer before this IPC resolves would
  // swap the wizard for Home (showing the OLD data root, and burying any failure below). Settings-
  // adopt omits it (onboarding has already completed). Order is load-bearing: classify -> mkdir ->
  // setDataRoot -> [markOnboardingComplete] -> relaunch. On an invalid parent, none of these run.
  const setDataRootAndRelaunch = async (request: StorageRootRequest): Promise<ValidateResult> => {
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-selection',
      fields: { onboarding: request.markOnboarding === true }
    })
    operation.phase('classify-target')
    try {
      const classification = await classifyDataRoot(request.parent, resolveDataRoot())
      if (classification.kind === 'invalid') {
        operation.fail(new Error(classification.error ?? 'invalid target'), { mode: 'invalid' })
        return { ok: false, error: classification.error ?? 'The selected folder is not usable.' }
      }

      const target = dataRootForPicked(request.parent)
      // Create the data root now, before persisting the pointer. Unlike storage:migrate there is no
      // copy phase to mkdir it, so a fresh onboarding folder ('move') would be recorded in
      // settings.dataRoot without ever existing on disk - and the next launch's startup guard would
      // read that explicitly-configured-but-absent root as deleted and wrongly show "Data folder not
      // found". For an 'adopt' target the folder already exists, so this is a no-op. classifyDataRoot
      // has already proven the parent writable, so failure here is genuinely unexpected.
      operation.phase('prepare-target', { mode: classification.kind })
      await mkdir(target, { recursive: true })
      operation.phase('persist-pointer', { mode: classification.kind })
      await deps.settingsService.setDataRoot(target)
      if (request.markOnboarding) {
        await deps.settingsService.markOnboardingComplete()
      }
      operation.phase('request-relaunch', { mode: classification.kind })
      await cleanRelaunch()
      operation.complete({ mode: classification.kind })

      return { ok: true }
    } catch (err) {
      operation.fail(err)
      logger.error('data root selection boundary failed', diagnosticErrorFields(err))
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return Object.freeze({
    getInfo,
    revealAppStorage,
    dismissLegacyMovePrompt,
    detectActive,
    pickDirectory,
    migrate,
    cancelMigrate,
    discardMigratedCopy,
    commitAndRelaunch,
    validateDataRoot,
    inspectDataRoot,
    setDataRootAndRelaunch
  })
}

type StorageCommandOwner = ReturnType<typeof createStorageCommandOwner>

export { createStorageCommandOwner }
export type { StorageCommandOwner, StorageCommandOwnerDeps }
