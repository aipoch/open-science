import { mkdir, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import { app, dialog, shell } from 'electron'

import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootValidationResult,
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
import { removeNotebookWorkloadCache } from '../notebook/notebook-workload-cache-paths'
import { detectActiveSessions } from './detect-active'
import { hasAnyExistingPath, isDataRootMissing } from './path-presence'
import {
  beginMigration,
  beginMigrationPreparation,
  clearMigrationPending,
  endMigrationCopy,
  resumeMigrationPreparation
} from './migration-state'
import {
  classifyDataRoot,
  commitDataRootSwitch,
  discardStagedCopy,
  pauseDataRootWriters,
  runDataRootMigration,
  validateNewDataRoot
} from './migration-service'
import { readMigrationMarker } from './migration-marker'
import { availableBytes } from './usage'
import { computeStorageUsageWithOwnership } from './usage-ownership'
import { broadcastToRenderers } from '../renderer-broadcast'
import { MIGRATABLE_DATA_DIRS } from './data-directories'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { markApplicationShutdownTrigger } from '../application-shutdown-trigger'
import type { SetDataRootOptions } from '../settings/capabilities'
import { toErrorMessage } from '../error-message'
import type { RendererSessionPersistenceTarget } from '../session-persistence/renderer-flush'
import type { SessionPersistenceFlushResponse } from '../../shared/session-persistence-flush'
import { DataRootCleanupJournal } from './data-root-cleanup'
import { DEFAULT_UPLOAD_PROJECT_ID } from '../../shared/uploads'
import { STAGING_UPLOAD_SESSION_ID, UPLOADS_DIR } from '../uploads/storage-helpers'

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
  getActiveSideChatSessions: () => LegacySessionSource[]
  getActiveDelegatedSessions: () => LegacySessionSource[]
  hasActiveReviewerWork: () => boolean
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
  cleanupRuntimeCache?: (runtimeRoot: string) => boolean
  logger?: Logger
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  exportRuntimeLocks?: typeof exportRuntimeLocks
  discardStagedCopy?: typeof discardStagedCopy
  runDataRootMigration?: typeof runDataRootMigration
  pauseDataRootWriters?: typeof pauseDataRootWriters
  // Windows classification probes volume capabilities; inject only when a host-independent command
  // boundary test needs to reach the pointer mutation without depending on its temporary drive.
  classifyDataRoot?: typeof classifyDataRoot
  validateNewDataRoot?: typeof validateNewDataRoot
  // Stops data producers and proves renderer-owned Session state is durable before any data-root
  // pointer can be persisted. Optional only for isolated storage tests and non-desktop adapters.
  prepareDataRootHandoff?: (
    target: RendererSessionPersistenceTarget,
    confirmedInterruption: boolean
  ) => Promise<boolean>
  acknowledgeWebRendererFlush?: (
    response: SessionPersistenceFlushResponse,
    lifecycleClientId: string
  ) => void
  notifyDataRootHandoffAborted?: () => void
  cleanupJournal?: DataRootCleanupJournal
  hasAnyExistingPath?: typeof hasAnyExistingPath
  // Injectable for candidate-capacity tests; production uses the same statfs probe as getInfo.
  availableBytes?: typeof availableBytes
}

type StorageParentRequest = Readonly<{ parent: string }>
type StorageRootRequest = Readonly<{ parent: string; markOnboarding?: boolean }>

const NON_UPLOAD_DATA_ROOT_DIRS = [...MIGRATABLE_DATA_DIRS, 'runtime'].filter(
  (dir) => dir !== UPLOADS_DIR
)

const readDirectoryIfPresent = async (path: string): Promise<Dirent[] | undefined> => {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Uploads initializes this empty directory chain before onboarding asks for storage information.
// It is infrastructure, not user data, so it must not pin a fresh install to the system drive. Any
// additional entry (including an in-flight staged file or a symlink) still fails closed as data.
const hasUploadDataBeyondStartupScaffold = async (dataRoot: string): Promise<boolean> => {
  const uploads = await readDirectoryIfPresent(join(dataRoot, UPLOADS_DIR))
  if (!uploads || uploads.length === 0) return false
  if (
    uploads.length !== 1 ||
    uploads[0].name !== DEFAULT_UPLOAD_PROJECT_ID ||
    !uploads[0].isDirectory()
  ) {
    return true
  }

  const defaultProject = await readDirectoryIfPresent(
    join(dataRoot, UPLOADS_DIR, DEFAULT_UPLOAD_PROJECT_ID)
  )
  if (!defaultProject || defaultProject.length === 0) return false
  if (
    defaultProject.length !== 1 ||
    defaultProject[0].name !== STAGING_UPLOAD_SESSION_ID ||
    !defaultProject[0].isDirectory()
  ) {
    return true
  }

  const staging = await readDirectoryIfPresent(
    join(dataRoot, UPLOADS_DIR, DEFAULT_UPLOAD_PROJECT_ID, STAGING_UPLOAD_SESSION_ID)
  )
  return Boolean(staging?.length)
}

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
  const cleanupRuntimeCache =
    deps.cleanupRuntimeCache ??
    ((runtimeRoot: string): boolean => {
      const workloadRemoved = removeNotebookWorkloadCache(runtimeRoot)
      const micromambaRemoved = removeMicromambaCacheForRoot(runtimeRoot)
      return workloadRemoved && micromambaRemoved
    })
  const discardStagedCopyImpl = deps.discardStagedCopy ?? discardStagedCopy
  const runDataRootMigrationImpl = deps.runDataRootMigration ?? runDataRootMigration
  const pauseDataRootWritersImpl = deps.pauseDataRootWriters ?? pauseDataRootWriters
  const classifyDataRootImpl = deps.classifyDataRoot ?? classifyDataRoot
  const validateNewDataRootImpl = deps.validateNewDataRoot ?? validateNewDataRoot
  const availableBytesImpl = deps.availableBytes ?? availableBytes
  const cleanupJournal = deps.cleanupJournal ?? new DataRootCleanupJournal(resolveConfigRoot())
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
  const prepareDataRootHandoff = async (
    target: RendererSessionPersistenceTarget,
    confirmedInterruption: boolean
  ): Promise<MigrationOutcome | undefined> => {
    try {
      if ((await deps.prepareDataRootHandoff?.(target, confirmedInterruption)) !== false) {
        return undefined
      }
    } catch (error) {
      logger.error('data root handoff preparation failed', diagnosticErrorFields(error))
    }
    return {
      ok: false,
      error: 'Could not prepare the app to switch data locations safely. Please try again.'
    }
  }

  const notifyDataRootHandoffAborted = (): void => {
    try {
      deps.notifyDataRootHandoffAborted?.()
    } catch (error) {
      logger.warn('data root handoff abort notification failed', diagnosticErrorFields(error))
    }
  }

  const getStatusSnapshot = async (): Promise<{
    status: StorageStatus
    canAutoSelectDataDrive: boolean
  }> => {
    const dataRoot = resolveDataRoot()
    // Only an explicitly-configured-but-now-gone root counts as "missing"; a fresh install's unset
    // dataRoot (default `~/OpenScience` not created yet) is normal and must never nag the user.
    let dataRootMissing = false
    // A pre-§20 legacy install still keeps its data in the hidden config root: settings.dataRoot is
    // unset (using the default), that default resolved to the config root itself, and real user data
    // lives there. Offer the one-time "move to the visible OpenScience folder" prompt until answered.
    let legacyDataMovePrompt = false
    // Fail closed: only the same main-owned filesystem/settings snapshot that identifies an empty,
    // unconfigured root may authorize onboarding's pointer-only default-drive selection.
    let canAutoSelectDataDrive = false
    const cleanupPending = await cleanupJournal.hasPending().catch(() => true)
    try {
      const storedSettings = await deps.settingsService.getStoredSettings()
      // Only an explicitly-configured root that stat proves is gone (ENOENT/ENOTDIR) counts as
      // missing. isDataRootMissing deliberately does NOT collapse other stat errors into "missing"
      // the way a bare existsSync would, so a non-ENOENT failure (seen with non-ASCII paths on some
      // Windows setups, or a transient drive/IO hiccup) can't nag the user to abandon real data.
      dataRootMissing = Boolean(storedSettings.dataRoot) && (await isDataRootMissing(dataRoot))

      const configRoot = resolveConfigRoot()
      const legacyInPlace = !storedSettings.dataRoot && samePath(dataRoot, configRoot)
      const hasUserData = await (deps.hasAnyExistingPath ?? hasAnyExistingPath)(
        MIGRATABLE_DATA_DIRS.map((dir) => join(configRoot, dir))
      )
      legacyDataMovePrompt =
        legacyInPlace && hasUserData && storedSettings.legacyDataMovePromptDismissedAt === undefined
      // Include runtime/: unlike legacy detection, onboarding must not pointer-switch away from a
      // managed environment that was prepared before an interrupted setup resumed.
      const currentRootHasData =
        (await (deps.hasAnyExistingPath ?? hasAnyExistingPath)(
          NON_UPLOAD_DATA_ROOT_DIRS.map((dir) => join(dataRoot, dir))
        )) || (await hasUploadDataBeyondStartupScaffold(dataRoot))
      canAutoSelectDataDrive = !storedSettings.dataRoot && !currentRootHasData && !dataRootMissing
    } catch (err) {
      logger.warn('data root status detection failed', diagnosticErrorFields(err))
    }

    return {
      status: {
        dataRoot,
        isDefault: samePath(dataRoot, computeDefaultDataRoot()),
        defaultDataRoot: computeDefaultDataRoot(),
        defaultParent: defaultDataParent(),
        dataRootMissing,
        legacyDataMovePrompt,
        cleanupPending
      },
      canAutoSelectDataDrive
    }
  }

  const getStatus = async (): Promise<StorageStatus> => (await getStatusSnapshot()).status

  const getInfo = async (): Promise<StorageInfo> => {
    const { status, canAutoSelectDataDrive } = await getStatusSnapshot()
    let available = 0
    try {
      available = await availableBytesImpl(status.dataRoot)
    } catch (err) {
      logger.warn('available storage lookup failed', diagnosticErrorFields(err))
    }

    return {
      ...status,
      canAutoSelectDataDrive,
      usage: await computeStorageUsageWithOwnership(status.dataRoot),
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
      sideChat: { getActivePromptSessions: deps.getActiveSideChatSessions },
      delegated: { getActiveDelegatedSessions: deps.getActiveDelegatedSessions },
      // Call as a method (arrow wrapper), never a bare reference: the real notebook service is a
      // class whose getActiveNotebookSessions reads `this.sessions`, so extracting it loose would
      // drop `this` and throw "Cannot read properties of undefined (reading 'values')".
      notebook: { getActiveNotebookSessions: () => deps.notebook.getActiveNotebookSessions() }
    })

  const directHandoffBlocker = (): string | undefined => {
    const activeSessions = detectActive()
    const reviewerActive = deps.hasActiveReviewerWork()
    if (activeSessions.length === 0 && !reviewerActive) return undefined
    return !reviewerActive && activeSessions.every((session) => session.kind === 'delegated')
      ? 'Subagents are still running. Return to their tasks and stop them before moving data.'
      : 'Research work is still running. Stop active agents, notebooks, subagents, or reviews before moving data.'
  }

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

  const migrate = async (
    request: StorageParentRequest,
    handoffTarget: RendererSessionPersistenceTarget = { surface: 'electron-renderer' }
  ): Promise<MigrationOutcome> => {
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
    if (deps.hasActiveReviewerWork()) {
      return { ok: false, error: 'A review is still running. Stop it before moving data.' }
    }

    const controller = new AbortController()
    const correlationId = randomUUID()
    // Reserve before the first await: a second IPC call must not enter handoff preparation and later
    // overwrite this operation's controller or staging authority. Reserve the shared lifecycle guard
    // at the same boundary so an ordinary quit cannot start while validation/preparation is awaiting.
    activeMigration = controller
    const quitOperation = beginMigrationPreparation(controller)
    let rendererPrepared = false
    let handoffPending = false
    try {
      // Reject stale/invalid requests before stopping any producer. The migration engine validates
      // again at its own filesystem boundary, but ordinary invalid targets must have no teardown side
      // effects at the command boundary.
      const validation = await validateNewDataRootImpl(request.parent, resolveDataRoot())
      if (controller.signal.aborted) {
        return { ok: false, error: 'migration cancelled', cancelled: true }
      }
      if (!validation.ok) return validation
      // Reviewer activity is not represented in the migration confirmation modal. Recheck after
      // validation's await so a newly-started review cannot be silently stopped by preparation.
      if (deps.hasActiveReviewerWork()) {
        return { ok: false, error: 'A review is still running. Stop it before moving data.' }
      }

      const preparationFailure = await prepareDataRootHandoff(handoffTarget, true)
      rendererPrepared = preparationFailure === undefined
      if (controller.signal.aborted) {
        return { ok: false, error: 'migration cancelled', cancelled: true }
      }
      if (preparationFailure) return preparationFailure

      if (deps.hasActiveReviewerWork()) {
        return { ok: false, error: 'A review is still running. Stop it before moving data.' }
      }

      // The preparation gate is intentionally non-latching. A delegated task can appear during its
      // await, so recheck before synchronously raising the write gate and entering the copy engine.
      if (deps.getActiveDelegatedSessions().length > 0) {
        return {
          ok: false,
          error:
            'Subagents are still running. Return to their tasks and stop them before moving data.'
        }
      }

      // Flag the copy: sets both the quit guard (Cmd+Q warning) and the write-gate (blocks ACP/notebook
      // writes to the old root for the whole copy→commit window).
      beginMigration()
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
          cleanupRuntimeCache,
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
      } else {
        handoffPending = true
      }
      return result.ok ? { ...result, cleanupPending: false } : result
    } catch (err) {
      // runDataRootMigration never rejects; guard the IPC boundary anyway so a renderer call
      // never sees a raw thrown error. Nothing was committed, so lift the write-gate.
      logger.error('data root copy boundary failed', diagnosticErrorFields(err))
      clearMigrationPending()
      activeStaged = undefined
      return { ok: false, error: toErrorMessage(err) }
    } finally {
      activeMigration = undefined
      // Relax the quit guard now the copy is done; `pending` (write-gate) persists on success.
      endMigrationCopy()
      quitOperation.finish()
      if (rendererPrepared && !handoffPending) notifyDataRootHandoffAborted()
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
      return { ok: false, error: toErrorMessage(err) }
    }
    resolutionInProgress = true
    let handoffAbandoned = false
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
      handoffAbandoned = true
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
      if (handoffAbandoned) notifyDataRootHandoffAborted()
    }
  }

  // Production relaunches through app.quit(), allowing the single application lifecycle owner to
  // drain usage, flush renderer persistence, stop backends, write a terminal diagnostic, and flush
  // main.log before exit. The injected callback remains a narrow test seam. This runs only after the
  // pointer commits; if relaunch scheduling or quit itself throws, the durable handoff cannot safely
  // return to the cached old-root process, so app.exit is the terminal fallback.
  const cleanRelaunch = async (): Promise<void> => {
    if (deps.relaunch) {
      try {
        deps.relaunch()
      } catch (error) {
        app.exit(1)
        throw error
      }
      return
    }
    try {
      app.relaunch()
    } catch (error) {
      app.exit(1)
      throw error
    }
    markApplicationShutdownTrigger('migration-relaunch')
    try {
      app.quit()
    } catch (error) {
      // Producer teardown and renderer durability were already confirmed before the pointer commit.
      // Bypass the failed graceful path rather than leaving this process alive on its cached old root.
      app.exit(1)
      throw error
    }
  }

  // Phase 2 (commit): invoked by the modal's "Restart now" once the copy is done. Flips
  // settings.dataRoot to the new root, deletes the old dirs, then relaunches. Ordered so an
  // interruption during the delete only orphans the old root (never data loss); see
  // commitDataRootSwitch. On switchoverFailed it returns without relaunching so the modal can show
  // the error (copy intact, old root untouched).
  const commitAndRelaunch = async (
    request: StorageParentRequest,
    handoffTarget: RendererSessionPersistenceTarget = { surface: 'electron-renderer' }
  ): Promise<MigrationOutcome> => {
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
      return { ok: false, error: toErrorMessage(err) }
    }
    resolutionInProgress = true
    const quitOperation = beginMigrationPreparation()
    const { signal } = quitOperation
    let rendererPrepared = false
    let pointerCommitted = false
    try {
      const staged = activeStaged
        ? samePath(activeStaged.target, target)
          ? activeStaged
          : undefined
        : await recoverStagedFromMarker(target, new Set(['verified'])).catch((error) => {
            resolutionInProgress = false
            endMigrationCopy()
            throw error
          })
      if (signal.aborted) {
        endMigrationCopy()
        resolutionInProgress = false
        return { ok: false, error: 'migration cancelled', cancelled: true }
      }
      if (!staged) {
        endMigrationCopy()
        resolutionInProgress = false
        return { ok: false, error: 'No completed migration copy was found.' }
      }

      // A recovered commit has no process-local migration gate, while a staged commit may have been
      // waiting in its modal long enough for an unexpected delegated writer to appear. Refuse before
      // either case can persist the new pointer.
      if (deps.getActiveDelegatedSessions().length > 0) {
        endMigrationCopy()
        resolutionInProgress = false
        return {
          ok: false,
          error:
            'Subagents are still running. Return to their tasks and stop them before finishing the move.'
        }
      }
      if (deps.hasActiveReviewerWork()) {
        endMigrationCopy()
        resolutionInProgress = false
        return { ok: false, error: 'A review is still running. Stop it before finishing the move.' }
      }

      const preparationFailure = await prepareDataRootHandoff(handoffTarget, true)
      rendererPrepared = preparationFailure === undefined
      if (signal.aborted) {
        endMigrationCopy()
        resolutionInProgress = false
        return { ok: false, error: 'migration cancelled', cancelled: true }
      }
      if (preparationFailure) {
        endMigrationCopy()
        resolutionInProgress = false
        return preparationFailure
      }
      if (deps.hasActiveReviewerWork()) {
        endMigrationCopy()
        resolutionInProgress = false
        return { ok: false, error: 'A review is still running. Stop it before finishing the move.' }
      }

      if (staged.recovered) {
        // Recovery happens in a fresh process: the original write gate and paused runtimes are gone.
        // Re-establish those invariants before inventory verification and pointer persistence.
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
            error:
              'Could not pause running work to finish moving your data safely. Please try again.'
          }
        } finally {
          endMigrationCopy()
        }
        // Keep the write gate pending through commit, but transition the quit guard from active copy
        // back to pre-commit handoff preparation until the pointer mutation resolves.
        resumeMigrationPreparation()
        if (signal.aborted) {
          resolutionInProgress = false
          return { ok: false, error: 'migration cancelled', cancelled: true }
        }
      }

      // Both the renderer/backend handoff and recovered-writer drain are non-latching awaits. Refuse a
      // delegated task that appeared in either window immediately before the pointer/delete boundary.
      if (deps.getActiveDelegatedSessions().length > 0) {
        if (staged.recovered) {
          clearMigrationPending()
          activeStaged = undefined
        } else {
          endMigrationCopy()
        }
        resolutionInProgress = false
        return {
          ok: false,
          error:
            'Subagents are still running. Return to their tasks and stop them before finishing the move.'
        }
      }
      if (deps.hasActiveReviewerWork()) {
        if (staged.recovered) {
          clearMigrationPending()
          activeStaged = undefined
        } else {
          endMigrationCopy()
        }
        resolutionInProgress = false
        return { ok: false, error: 'A review is still running. Stop it before finishing the move.' }
      }
      if (signal.aborted) {
        endMigrationCopy()
        resolutionInProgress = false
        return { ok: false, error: 'migration cancelled', cancelled: true }
      }

      let outcome: MigrationOutcome
      try {
        const currentDataRoot = resolveDataRoot()
        outcome = await commitDataRootSwitch(
          {
            currentDataRoot,
            // Arrow-wrapped so setDataRoot is called as a method (it reads `this.repository`).
            setDataRoot: (path) =>
              deps.settingsService.setDataRoot(path, { previousDataRoot: currentDataRoot }),
            // Prove the on-disk copy is the one this session staged (guards against a stale marker).
            expectedToken: staged.token,
            cleanupJournal,
            cleanupRuntimeCache: (sourceRoot) => cleanupRuntimeCache(join(sourceRoot, 'runtime')),
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
        return { ok: false, error: toErrorMessage(err) }
      }

      if (outcome.ok) {
        // On success the write-gate stays set through relaunch: the fresh process starts with
        // pending=false, so writes naturally resume against the now-live new root.
        activeStaged = undefined
        pointerCommitted = true
        quitOperation.markCommitted()
        // The pointer has committed. Let the migration-relaunch trigger own the non-cancellable quit;
        // leaving the preparation guard raised would make app-lifecycle reject its own relaunch.
        endMigrationCopy()
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
    } finally {
      quitOperation.finish()
      if (rendererPrepared && !pointerCommitted) notifyDataRootHandoffAborted()
    }
  }

  // Onboarding's first-run location step: check a candidate parent before letting the user commit
  // to it. Never throws: validateNewDataRoot already guards fs errors, this catch only covers
  // anything unexpected escaping that contract.
  const validateDataRoot = async (
    request: StorageParentRequest
  ): Promise<DataRootValidationResult> => {
    try {
      return await validateNewDataRoot(request.parent, resolveDataRoot())
    } catch (err) {
      logger.warn('data root validation boundary failed', diagnosticErrorFields(err))
      return { ok: false, error: toErrorMessage(err) }
    }
  }

  // Settings + onboarding recovery: classify a candidate parent without committing to it, so the
  // caller can route to the right UI (migrate confirm for 'move', adopt confirm for 'adopt',
  // staged-copy resolution for 'recover', inline error for 'invalid') and display the derived
  // `<parent>/OpenScience` path regardless of kind. Never throws.
  const inspectDataRoot = async (request: StorageParentRequest): Promise<DataRootInspection> => {
    let dataRoot = ''
    try {
      if (typeof request?.parent !== 'string') throw new Error('The selected folder is not usable.')
      dataRoot = dataRootForPicked(request.parent)
      const result = await classifyDataRootImpl(request.parent, resolveDataRoot())
      if (result.kind === 'invalid') return { ...result, dataRoot }

      const targetWasAbsent = result.kind === 'move' ? await isDataRootMissing(dataRoot) : undefined
      const capacityPath = targetWasAbsent ? resolve(request.parent) : dataRoot

      let targetAvailableBytes: number | undefined
      try {
        const available = await availableBytesImpl(capacityPath)
        if (Number.isFinite(available) && available >= 0) targetAvailableBytes = available
      } catch (error) {
        logger.warn('candidate storage capacity lookup failed', diagnosticErrorFields(error))
      }

      return {
        ...result,
        dataRoot,
        ...(targetWasAbsent === undefined ? {} : { targetWasAbsent }),
        ...(targetAvailableBytes === undefined ? {} : { targetAvailableBytes })
      }
    } catch (err) {
      logger.warn('data root inspection boundary failed', diagnosticErrorFields(err))
      return {
        kind: 'invalid',
        dataRoot,
        error: toErrorMessage(err)
      }
    }
  }

  // A no-move pointer switch: sets dataRoot and relaunches, without invoking the migration engine
  // - used both for onboarding's first-run apply (no data exists yet to move) and for adopting an
  // existing data folder from Settings (data already lives at the derived target; only the
  // pointer changes).
  // Unlike storage:migrate there is no copy phase. It still shares the pre-commit producer teardown,
  // renderer durability check, and write gate because the current process retains the old root until
  // relaunch. Accepts only 'move' and 'adopt' targets; a 'recover' target must use the marker-gated
  // resolution flow. The migration engine's own
  // validateNewDataRoot is stricter (move-only) and is never called here.
  //
  // `markOnboarding` is stamped here (not by a separate renderer completeOnboarding() call) so it
  // lands atomically with setDataRoot, in the same settings mutation before relaunch: App.tsx's
  // startup gate reads onboardingCompletedAt, and flipping it from the renderer before this IPC
  // resolves would swap the wizard for Home (showing the OLD data root, and burying any failure
  // below). Settings-adopt omits it (onboarding has already completed). Order is load-bearing:
  // classify -> durable preparation -> write gate -> mkdir -> persist settings -> relaunch. On an
  // invalid parent, none of the mutating steps run.
  const setDataRootAndRelaunch = async (
    request: StorageRootRequest,
    handoffTarget: RendererSessionPersistenceTarget = { surface: 'electron-renderer' }
  ): Promise<DataRootValidationResult> => {
    const operation = startDiagnosticOperation(logger, {
      operation: 'data-root-selection',
      fields: { onboarding: request.markOnboarding === true }
    })
    if (activeMigration || activeStaged || resolutionInProgress) {
      operation.fail(new Error('data root change is already in progress'))
      return { ok: false, error: 'A data-root change is already in progress.' }
    }
    // Serialize direct pointer switches with copy commit/discard and reserve before classification's
    // first await. Reserve the shared lifecycle guard at the same boundary; unlike the write gate it
    // does not block ordinary data-root writes during classification or durable preparation. The
    // successful path intentionally keeps the process-local resolution slot until relaunch.
    resolutionInProgress = true
    const quitOperation = beginMigrationPreparation()
    const { signal } = quitOperation
    let pointerCommitted = false
    let writeGateHeld = false
    let rendererPrepared = false
    operation.phase('classify-target')
    try {
      const classification = await classifyDataRootImpl(request.parent, resolveDataRoot())
      if (signal.aborted) {
        operation.fail(new Error('data root change cancelled'))
        return { ok: false, error: 'Data-root change cancelled.' }
      }
      if (classification.kind !== 'move' && classification.kind !== 'adopt') {
        operation.fail(new Error(classification.error ?? 'invalid target'), {
          mode: classification.kind
        })
        return { ok: false, error: classification.error ?? 'The selected folder is not usable.' }
      }

      // Unlike migration, this direct switch has no confirmation stage. Refuse every active data
      // producer before the teardown gate so adopting a root never silently terminates current work.
      const activeWorkError = directHandoffBlocker()
      if (activeWorkError) {
        operation.fail(new Error('active work blocks direct data-root handoff'), {
          mode: classification.kind
        })
        return {
          ok: false,
          error: activeWorkError
        }
      }
      const preparationFailure = await prepareDataRootHandoff(handoffTarget, false)
      if (signal.aborted) {
        operation.fail(new Error('data root change cancelled'), { mode: classification.kind })
        return { ok: false, error: 'Data-root change cancelled.' }
      }
      if (preparationFailure) {
        operation.fail(new Error('handoff durability was not confirmed'), {
          mode: classification.kind
        })
        return preparationFailure
      }
      rendererPrepared = true

      // Preparation stops current producers and flushes renderer state. Raise the shared write gate
      // synchronously when that await resolves, before mkdir or settings persistence can yield and let
      // a new old-root writer enter. On success `pending` remains raised until the fresh process starts.
      beginMigration()
      writeGateHeld = true
      operation.phase('pause-writers', { mode: classification.kind })
      try {
        await pauseDataRootWritersImpl({
          logger,
          runtime: deps.runtime,
          notebook: deps.notebook
        })
      } catch (err) {
        operation.fail(err, { mode: classification.kind })
        return {
          ok: false,
          error: 'Could not pause running work to switch data locations safely. Please try again.'
        }
      }
      if (signal.aborted) {
        operation.fail(new Error('data root change cancelled'), { mode: classification.kind })
        return { ok: false, error: 'Data-root change cancelled.' }
      }

      // Work can appear while the non-latching preparation/drain awaits. Recheck every producer
      // immediately before persistence; the finally block releases the write gate on refusal.
      const racedActiveWorkError = directHandoffBlocker()
      if (racedActiveWorkError) {
        operation.fail(new Error('active work appeared during direct data-root handoff'), {
          mode: classification.kind
        })
        return {
          ok: false,
          error: racedActiveWorkError
        }
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
      if (signal.aborted) {
        operation.fail(new Error('data root change cancelled'), { mode: classification.kind })
        return { ok: false, error: 'Data-root change cancelled.' }
      }
      const preparedClassification = await classifyDataRootImpl(request.parent, resolveDataRoot())
      if (signal.aborted) {
        operation.fail(new Error('data root change cancelled'), { mode: classification.kind })
        return { ok: false, error: 'Data-root change cancelled.' }
      }
      if (preparedClassification.kind !== 'move' && preparedClassification.kind !== 'adopt') {
        operation.fail(new Error(preparedClassification.error ?? 'invalid target'), {
          mode: preparedClassification.kind
        })
        return {
          ok: false,
          error: preparedClassification.error ?? 'The selected folder is not usable.'
        }
      }
      operation.phase('persist-pointer', { mode: classification.kind })
      await deps.settingsService.setDataRoot(target, {
        completeOnboarding: request.markOnboarding === true,
        previousDataRoot: resolveDataRoot()
      })
      pointerCommitted = true
      quitOperation.markCommitted()
      // The copy-phase quit warning is not appropriate after the pointer commits, but keep `pending`
      // raised so no writer can reopen against this process's cached old root before app.quit().
      endMigrationCopy()
      operation.phase('request-relaunch', { mode: classification.kind })
      await cleanRelaunch()
      operation.complete({ mode: classification.kind })

      return { ok: true }
    } catch (err) {
      operation.fail(err)
      logger.error('data root selection boundary failed', diagnosticErrorFields(err))
      return { ok: false, error: toErrorMessage(err) }
    } finally {
      quitOperation.finish()
      if (!pointerCommitted) {
        if (rendererPrepared) notifyDataRootHandoffAborted()
        if (writeGateHeld) clearMigrationPending()
        else endMigrationCopy()
        resolutionInProgress = false
      }
    }
  }

  return Object.freeze({
    acknowledgeDataRootHandoffFlush: (
      response: SessionPersistenceFlushResponse,
      lifecycleClientId: string
    ): void => deps.acknowledgeWebRendererFlush?.(response, lifecycleClientId),
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
