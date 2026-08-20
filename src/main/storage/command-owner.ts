import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { app, dialog, shell } from 'electron'

import type {
  ActiveSessionInfo,
  DataRootInspection,
  DiscardMigratedCopyResult,
  MigrationOutcome,
  MigrationProgress,
  RevealAppStorageResult,
  StorageInfo,
  StorageStatus
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
  pauseDataRootWriters,
  runDataRootMigration,
  validateNewDataRoot,
  type ValidateResult
} from './migration-service'
import { readMigrationMarker } from './migration-marker'
import { availableBytes, computeStorageUsage } from './usage'
import { broadcastToRenderers } from '../renderer-broadcast'
import { RELOCATABLE_DATA_DIRS } from './data-directories'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { markApplicationShutdownTrigger } from '../application-shutdown-trigger'
import type { SetDataRootOptions } from '../settings/capabilities'

type LegacySessionSource = { projectId: string; sessionId: string }
type NotebookSessionSource = { projectId: string; sessionId: string }

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
    getActiveNotebookSessions: () => NotebookSessionSource[]
  }
  getActivePromptSessions: () => LegacySessionSource[]
  getActiveDelegatedSessions: () => LegacySessionSource[]
  settingsService: {
    setDataRoot: (path: string, options?: SetDataRootOptions) => Promise<void>
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
  discardStagedCopy?: typeof discardStagedCopy
  runDataRootMigration?: typeof runDataRootMigration
  pauseDataRootWriters?: typeof pauseDataRootWriters
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
  // The token + target of the active staged copy (set when this process verifies a copy, or recovered
  // from its durable marker after restart; cleared when the migration resolves).
  let activeStaged:
    { token: string; target: string; correlationId: string; recovered: boolean } | undefined
  let resolutionInProgress = false
  const cleanupRuntimeCache = deps.cleanupRuntimeCache ?? removeMicromambaCacheForRoot
  const discardStagedCopyImpl = deps.discardStagedCopy ?? discardStagedCopy
  const runDataRootMigrationImpl = deps.runDataRootMigration ?? runDataRootMigration
  const pauseDataRootWritersImpl = deps.pauseDataRootWriters ?? pauseDataRootWriters
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

  const getStatus = async (): Promise<StorageStatus> => {
    const dataRoot = resolveDataRoot()
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
      legacyDataMovePrompt
    }
  }

  const getInfo = async (): Promise<StorageInfo> => {
    const status = await getStatus()
    let available = 0
    try {
      available = await availableBytes(status.dataRoot)
    } catch (err) {
      logger.warn('available storage lookup failed', diagnosticErrorFields(err))
    }

    return {
      ...status,
      usage: await computeStorageUsage(status.dataRoot),
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
      throw err
    }
  }

  const detectActive = (): ActiveSessionInfo[] =>
    detectActiveSessions({
      runtime: { getActivePromptSessions: deps.getActivePromptSessions },
      delegated: { getActiveDelegatedSessions: deps.getActiveDelegatedSessions },
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
    // Re-check at the mutating boundary: a child can start after the modal's detect-active call, and
    // a stale or forged renderer must not bypass the user-owned stop flow.
    if (deps.getActiveDelegatedSessions().length > 0) {
      return {
        ok: false,
        error:
          'Subagents are still running. Return to their tasks and stop them before moving data.'
      }
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
      const result = await runDataRootMigrationImpl(
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
            activeStaged = { ...staged, correlationId, recovered: false }
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

  // Rehydrates the durable authority for a staging copy after process restart. The marker token is
  // never exposed to the renderer; source, target, and status are checked again at this command
  // boundary before commit/discard receives it. A fresh correlation id starts the recovery attempt's
  // diagnostics because the original process-local operation is gone.
  const recoverStagedFromMarker = async (
    target: string,
    allowedStatuses: ReadonlySet<'copying' | 'verified'>
  ): Promise<NonNullable<typeof activeStaged> | undefined> => {
    const marker = await readMigrationMarker(target)
    if (
      !marker ||
      !allowedStatuses.has(marker.status) ||
      !samePath(marker.source, resolveDataRoot()) ||
      !samePath(marker.target, target) ||
      samePath(target, resolveDataRoot())
    ) {
      return undefined
    }
    return { token: marker.token, target, correlationId: randomUUID(), recovered: true }
  }

  // Discards a completed-but-uncommitted copy at `<parent>/OpenScience` when the user picks "Keep
  // current location" on the done stage. Since the copy phase never touched settings.dataRoot or the
  // old root, this just removes the new copy and leaves the app on its current root. discardStagedCopy
  // refuses anything that isn't a marker-confirmed staging copy for the current root, so a misrouted
  // parent can't delete live data. Once a matching copy is logically abandoned, the write-gate is
  // lifted even if physical cleanup fails; the caller gets a warning and the marked copy stays inert.
  const discardMigratedCopy = async (
    request: StorageParentRequest
  ): Promise<DiscardMigratedCopyResult> => {
    if (activeMigration) {
      // A copy is still running; discarding would race the writer. Keep the modal open for retry.
      logger.warn('staged data root discard ignored', { reason: 'copy-in-progress' })
      return { ok: false, error: 'A migration copy is still in progress.' }
    }
    if (resolutionInProgress) {
      logger.warn('staged data root discard ignored', { reason: 'resolution-in-progress' })
      return { ok: false, error: 'A migration is already being resolved.' }
    }
    let target: string
    try {
      target = dataRootForPicked(request.parent)
    } catch (err) {
      logger.warn('staged data root discard ignored', {
        reason: 'invalid-request',
        ...diagnosticErrorFields(err)
      })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    resolutionInProgress = true
    try {
      const staged = activeStaged
        ? samePath(activeStaged.target, target)
          ? activeStaged
          : undefined
        : await recoverStagedFromMarker(target, new Set(['copying', 'verified']))
      if (!staged) {
        logger.warn('staged data root discard ignored', { reason: 'no-matching-copy' })
        return { ok: false, error: 'No matching staged data copy was found.' }
      }
      activeStaged = staged
      const result = await discardStagedCopyImpl(
        {
          currentDataRoot: resolveDataRoot(),
          expectedToken: staged.token,
          allowIncomplete: staged.recovered
        },
        request.parent
      )
      if (result.ok) {
        activeStaged = undefined
        clearMigrationPending()
        return { ok: true }
      }
      logger.warn('staged data root discard refused', { reason: 'validation-failed' })
      activeStaged = undefined
      clearMigrationPending()
      return {
        ok: true,
        cleanupWarning: result.error ?? 'The unused data copy could not be removed.'
      }
    } catch (err) {
      logger.error('staged data root discard failed', diagnosticErrorFields(err))
      activeStaged = undefined
      clearMigrationPending()
      return { ok: true, cleanupWarning: 'The unused data copy could not be removed.' }
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
    if (resolutionInProgress) {
      return { ok: false, error: 'A migration is already being resolved.' }
    }
    let target: string
    try {
      target = dataRootForPicked(request.parent)
    } catch (err) {
      logger.warn('staged data root commit refused', {
        reason: 'invalid-request',
        ...diagnosticErrorFields(err)
      })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    resolutionInProgress = true
    const staged = activeStaged
      ? samePath(activeStaged.target, target)
        ? activeStaged
        : undefined
      : await recoverStagedFromMarker(target, new Set(['verified']))
    if (!staged) {
      resolutionInProgress = false
      return { ok: false, error: 'No completed migration copy was found.' }
    }

    if (staged.recovered) {
      // Recovery happens in a fresh process: the original write gate and paused runtimes are gone.
      // Re-establish those invariants before inventory verification and pointer persistence.
      if (deps.getActiveDelegatedSessions().length > 0) {
        resolutionInProgress = false
        return {
          ok: false,
          error:
            'Subagents are still running. Return to their tasks and stop them before finishing the move.'
        }
      }
      beginMigration()
      try {
        await pauseDataRootWritersImpl({
          logger,
          runtime: deps.runtime,
          notebook: deps.notebook
        })
        activeStaged = staged
      } catch (err) {
        logger.error('recovered data root pause failed', diagnosticErrorFields(err))
        clearMigrationPending()
        activeStaged = undefined
        resolutionInProgress = false
        return {
          ok: false,
          error: 'Could not pause running work to finish moving your data safely. Please try again.'
        }
      } finally {
        // Keep the write gate pending through commit, but avoid treating the subsequent clean
        // relaunch as an in-progress copy in the quit guard.
        endMigrationCopy()
      }
    }

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
  // staged-copy resolution for 'recover', inline error for 'invalid') and display the derived
  // `<parent>/OpenScience` path regardless of kind. Never throws.
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
  // Unlike storage:migrate there is no copy phase and no session-interrupt step. Accepts only
  // 'move' and 'adopt' targets; a 'recover' target must use the marker-gated resolution flow. The
  // migration engine's own
  // validateNewDataRoot is stricter (move-only) and is never called here.
  //
  // `markOnboarding` is stamped here (not by a separate renderer completeOnboarding() call) so it
  // lands atomically with setDataRoot, in the same settings mutation before relaunch: App.tsx's
  // startup gate reads onboardingCompletedAt, and flipping it from the renderer before this IPC
  // resolves would swap the wizard for Home (showing the OLD data root, and burying any failure
  // below). Settings-adopt omits it (onboarding has already completed). Order is load-bearing:
  // classify -> mkdir -> persist settings -> relaunch. On an invalid parent, none of these run.
  const setDataRootAndRelaunch = async (request: StorageRootRequest): Promise<ValidateResult> => {
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-selection',
      fields: { onboarding: request.markOnboarding === true }
    })
    operation.phase('classify-target')
    try {
      const classification = await classifyDataRoot(request.parent, resolveDataRoot())
      if (classification.kind !== 'move' && classification.kind !== 'adopt') {
        operation.fail(new Error(classification.error ?? 'invalid target'), {
          mode: classification.kind
        })
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
      await deps.settingsService.setDataRoot(target, {
        completeOnboarding: request.markOnboarding === true
      })
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
    getStatus,
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
