import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import type { DataRootInspection, MigrationOutcome, MigrationProgress } from '../../shared/storage'
import {
  computeDefaultDataRoot,
  dataRootForPicked,
  defaultDataParent,
  resolveConfigRoot,
  resolveDataRoot,
  samePath
} from '../storage-root'
import { resolveMicromamba } from '../notebook/micromamba'
import { captureMicromamba } from '../notebook/provisioner-runtime'
import { exportRuntimeLocks } from '../notebook/runtime-relocation'
import { detectActiveSessions } from './detect-active'
import { beginMigration, endMigration } from './migration-state'
import {
  classifyDataRoot,
  commitDataRootSwitch,
  runDataRootMigration,
  validateNewDataRoot,
  type ValidateResult
} from './migration-service'
import { availableBytes, computeStorageUsage } from './usage'

type SessionSource = { projectName: string; sessionId: string }

type StorageIpcDeps = {
  runtime: { disconnect: () => Promise<unknown> }
  notebook: { shutdownAll: () => Promise<void>; getActiveNotebookSessions: () => SessionSource[] }
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
}

// Pushes migration progress to every live window, mirroring the acp/update broadcast pattern.
const defaultBroadcast = (progress: MigrationProgress): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('storage:migrate-progress', progress)
  }
}

// Registers the renderer-callable data-root storage commands: info/usage, active-session
// detection, folder picker, and migrate/cancel. Only one migration may run at a time; the
// in-flight AbortController is held in this closure so cancel can reach it.
const registerStorageIpcHandlers = (deps: StorageIpcDeps): void => {
  let activeMigration: AbortController | undefined

  ipcMain.handle('storage:get-info', async () => {
    const dataRoot = resolveDataRoot()
    let available = 0
    try {
      available = await availableBytes(dataRoot)
    } catch (err) {
      console.error('[storage-ipc] availableBytes failed', err)
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
      dataRootMissing = Boolean(storedSettings.dataRoot) && !existsSync(dataRoot)

      const configRoot = resolveConfigRoot()
      const legacyInPlace = !storedSettings.dataRoot && samePath(dataRoot, configRoot)
      const hasUserData = ['artifacts', 'notebooks', 'uploads'].some((dir) =>
        existsSync(join(configRoot, dir))
      )
      legacyDataMovePrompt =
        legacyInPlace && hasUserData && storedSettings.legacyDataMovePromptDismissedAt === undefined
    } catch (err) {
      console.error('[storage-ipc] dataRootMissing/legacy detection failed', err)
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
  })

  // The user answered the one-time legacy-data-move prompt without moving (declined, or chose "keep
  // it here"). Persist that so getInfo's legacyDataMovePrompt stays false and it's never shown again.
  // (Moving/relocating instead sets settings.dataRoot, which already disqualifies the prompt.)
  ipcMain.handle('storage:dismiss-legacy-move-prompt', async (): Promise<void> => {
    try {
      await deps.settingsService.dismissLegacyDataMovePrompt()
    } catch (err) {
      console.error('[storage-ipc] dismiss-legacy-move-prompt failed', err)
    }
  })

  ipcMain.handle('storage:detect-active', () =>
    detectActiveSessions({
      runtime: { getActivePromptSessions: deps.getActivePromptSessions },
      // Call as a method (arrow wrapper), never a bare reference: the real notebook service is a
      // class whose getActiveNotebookSessions reads `this.sessions`, so extracting it loose would
      // drop `this` and throw "Cannot read properties of undefined (reading 'values')".
      notebook: { getActiveNotebookSessions: () => deps.notebook.getActiveNotebookSessions() }
    })
  )

  ipcMain.handle('storage:pick-directory', async (): Promise<string | null> => {
    try {
      if (deps.showOpenDialog) return await deps.showOpenDialog()
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      })
      return result.filePaths[0] ?? null
    } catch (err) {
      // Never let a picker failure surface as a raw rejection to the renderer; Browse
      // becomes a no-op instead.
      console.error('[storage-ipc] pick-directory failed', err)
      return null
    }
  })

  ipcMain.handle(
    'storage:migrate',
    async (_event, request: { parent: string }): Promise<MigrationOutcome> => {
      if (activeMigration) {
        return { ok: false, error: 'A migration is already in progress.' }
      }

      const controller = new AbortController()
      activeMigration = controller
      // Flag the copy so the before-quit guard (app lifecycle) can warn on Cmd+Q mid-copy.
      beginMigration()
      try {
        // Phase 1 only: copy+verify into the new root. Nothing is committed (no setDataRoot, no
        // delete) — the old root and settings.dataRoot stay intact, so this is fully reversible.
        // Commit happens later, on the user's "Restart now" (storage:commit-and-relaunch).
        return await runDataRootMigration(
          {
            currentDataRoot: resolveDataRoot(),
            runtime: deps.runtime,
            notebook: deps.notebook,
            // Preserve the runtime across the move by exporting each env to an offline lock at the
            // new root; the copied pkgs cache lets the provisioner rebuild them offline on relaunch.
            exportRuntimeLocks: (fromDataRoot, toDataRoot) =>
              exportRuntimeLocks(fromDataRoot, toDataRoot, {
                mm: resolveMicromamba({ resourcesPath: process.resourcesPath }),
                capture: captureMicromamba
              })
          },
          request.parent,
          {
            signal: controller.signal,
            onProgress: (progress) => (deps.broadcastProgress ?? defaultBroadcast)(progress)
          }
        )
      } catch (err) {
        // runDataRootMigration never rejects; guard the IPC boundary anyway so a renderer call
        // never sees a raw thrown error.
        console.error('[storage-ipc] migrate failed unexpectedly', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        activeMigration = undefined
        endMigration()
      }
    }
  )

  ipcMain.handle('storage:cancel-migrate', () => {
    activeMigration?.abort()
  })

  // Discards a completed-but-uncommitted copy at `<parent>/OpenScience` when the user picks "Keep
  // current location" on the done stage. Since the copy phase never touched settings.dataRoot or the
  // old root, this just removes the new copy and leaves the app on its current root. Never throws.
  ipcMain.handle(
    'storage:discard-migrated-copy',
    async (_event, request: { parent: string }): Promise<void> => {
      const target = dataRootForPicked(request.parent)
      try {
        await rm(target, { recursive: true, force: true })
      } catch (err) {
        console.error('[storage-ipc] discard-migrated-copy failed', err)
      }
    }
  )

  // Phase 2 (commit): invoked by the modal's "Restart now" once the copy is done. Flips
  // settings.dataRoot to the new root, deletes the old dirs, then relaunches. Ordered so an
  // interruption during the delete only orphans the old root (never data loss); see
  // commitDataRootSwitch. On switchoverFailed it returns without relaunching so the modal can show
  // the error (copy intact, old root untouched).
  ipcMain.handle(
    'storage:commit-and-relaunch',
    async (_event, request: { parent: string }): Promise<MigrationOutcome> => {
      let outcome: MigrationOutcome
      try {
        outcome = await commitDataRootSwitch(
          {
            currentDataRoot: resolveDataRoot(),
            // Arrow-wrapped so setDataRoot is called as a method (it reads `this.repository`).
            setDataRoot: (path) => deps.settingsService.setDataRoot(path)
          },
          request.parent
        )
      } catch (err) {
        console.error('[storage-ipc] commit-and-relaunch failed unexpectedly', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      if (outcome.ok) {
        if (deps.relaunch) {
          deps.relaunch()
        } else {
          app.relaunch()
          app.exit(0)
        }
      }
      return outcome
    }
  )

  // Onboarding's first-run location step: check a candidate parent before letting the user commit
  // to it. Never throws: validateNewDataRoot already guards fs errors, this catch only covers
  // anything unexpected escaping that contract.
  ipcMain.handle(
    'storage:validate-data-root',
    async (_event, request: { parent: string }): Promise<ValidateResult> => {
      try {
        return await validateNewDataRoot(request.parent, resolveDataRoot())
      } catch (err) {
        console.error('[storage-ipc] validate-data-root failed unexpectedly', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Settings + onboarding recovery: classify a candidate parent without committing to it, so the
  // caller can route to the right UI (migrate confirm for 'move', adopt confirm for 'adopt',
  // inline error for 'invalid') and display the derived `<parent>/OpenScience` path regardless of
  // kind. Never throws.
  ipcMain.handle(
    'storage:inspect-data-root',
    async (_event, request: { parent: string }): Promise<DataRootInspection> => {
      const dataRoot = dataRootForPicked(request.parent)
      try {
        const result = await classifyDataRoot(request.parent, resolveDataRoot())
        return { ...result, dataRoot }
      } catch (err) {
        console.error('[storage-ipc] inspect-data-root failed unexpectedly', err)
        return {
          kind: 'invalid',
          dataRoot,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

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
  // adopt omits it (onboarding has already completed). Order is load-bearing: classify ->
  // setDataRoot -> [markOnboardingComplete] -> relaunch. On an invalid parent, none of these run.
  ipcMain.handle(
    'storage:set-data-root-and-relaunch',
    async (
      _event,
      request: { parent: string; markOnboarding?: boolean }
    ): Promise<ValidateResult> => {
      try {
        const classification = await classifyDataRoot(request.parent, resolveDataRoot())
        if (classification.kind === 'invalid') {
          return { ok: false, error: classification.error ?? 'The selected folder is not usable.' }
        }

        const target = dataRootForPicked(request.parent)
        await deps.settingsService.setDataRoot(target)
        if (request.markOnboarding) {
          await deps.settingsService.markOnboardingComplete()
        }
        ;(
          deps.relaunch ??
          (() => {
            app.relaunch()
            app.exit(0)
          })
        )()

        return { ok: true }
      } catch (err) {
        console.error('[storage-ipc] set-data-root-and-relaunch failed unexpectedly', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export { registerStorageIpcHandlers }
export type { StorageIpcDeps }
