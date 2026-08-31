import { useCallback, useEffect, useState } from 'react'

import type { StorageInfo, StorageStatus } from '../../../shared/storage'
import { useDeepLinkNavigation } from '@/lib/deep-link'
import {
  useSessionPersistence,
  type SessionPersistenceState
} from '@/lib/session-persistence/session-persistence'
import { resolveStartupView, type StartupView } from '@/pages/onboarding/startup-gate'
import type { ProvisionUiState } from '@/pages/workspace/provisioning-view'
import {
  useQuitPersistenceFlush,
  type QuitPersistenceFlushProjection
} from '@/hooks/useQuitPersistenceFlush'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import { useUpdateStore } from '@/stores/update-store'

type LegacyDataMove = Readonly<{
  currentDataRoot: string
  defaultParent: string
}>

type ApplicationStartupProjection = Readonly<{
  settings: Readonly<{
    isLoaded: boolean
    isLoading: boolean
    loadError: string | undefined
    startupView: StartupView | undefined
    retry: () => Promise<void>
  }>
  sessions: SessionPersistenceState
  quitPersistence: QuitPersistenceFlushProjection
  environment: Readonly<{
    ui: ProvisionUiState
    retry: () => Promise<void>
  }>
  storageRecovery: Readonly<{
    missingDataRoot: string | undefined
    legacyMove: LegacyDataMove | undefined
    loadInfo: () => Promise<StorageInfo>
    resolveMissingDataRoot: () => void
    dismissLegacyMove: () => void
  }>
}>

// Owns application initialization order while projecting only the startup state and commands the
// presentation and event-binding modules need.
const useApplicationStartup = (): ApplicationStartupProjection => {
  const sessions = useSessionPersistence()
  const quitPersistence = useQuitPersistenceFlush()
  useDeepLinkNavigation({ isHydrated: sessions.isHydrated, isReady: sessions.isReady })

  const loadProjects = useProjectStore((state) => state.loadProjects)
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded)
  const isSettingsLoading = useSettingsStore((state) => state.isLoading)
  const settingsLoadError = useSettingsStore((state) => state.loadError)
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const loadSettings = useSettingsStore((state) => state.load)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const initUpdates = useUpdateStore((state) => state.init)
  const initEnvironment = useNotebookEnvStore((state) => state.init)
  const environmentUi = useNotebookEnvStore((state) => state.ui)
  const retryEnvironment = useNotebookEnvStore((state) => state.retry)
  const [missingDataRoot, setMissingDataRoot] = useState<string>()
  const [legacyMove, setLegacyMove] = useState<LegacyDataMove>()

  const applyStorageStatus = useCallback((status: StorageStatus): void => {
    if (status.dataRootMissing) setMissingDataRoot(status.dataRoot)
    else if (status.legacyDataMovePrompt) {
      setLegacyMove({
        currentDataRoot: status.dataRoot,
        defaultParent: status.defaultParent
      })
    }
  }, [])
  const loadStorageStatus = useCallback(async (): Promise<StorageStatus> => {
    const status = await useStorageInfoStore.getState().loadStatus()
    applyStorageStatus(status)
    return status
  }, [applyStorageStatus])
  const loadStorageInfo = useCallback(async (): Promise<StorageInfo> => {
    const info = await useStorageInfoStore.getState().load()
    applyStorageStatus(info)
    return info
  }, [applyStorageStatus])
  const retrySettings = useCallback(async (): Promise<void> => {
    if (await loadSettings({ force: true })) await checkEnvironment()
  }, [checkEnvironment, loadSettings])
  const resolveMissingDataRoot = useCallback(() => setMissingDataRoot(undefined), [])
  const dismissLegacyMove = useCallback(() => setLegacyMove(undefined), [])

  useEffect(() => initUpdates(), [initUpdates])

  // Mirrors the main-process provisioner once at launch. The returned UI projection drives the
  // top-level upgrade/error banner.
  useEffect(() => {
    void initEnvironment()
  }, [initEnvironment])

  // This lightweight status request deliberately does not calculate directory usage. Onboarding
  // requests the full StorageInfo independently when it needs location details.
  useEffect(() => {
    void Promise.resolve()
      .then(loadStorageStatus)
      .catch(() => undefined)
  }, [loadStorageStatus])

  // A successful Session retry re-runs this effect and clears a Project-list error caused by the
  // same transient storage outage.
  useEffect(() => {
    if (!isSettingsLoaded || !sessions.isHydrated || sessions.isLoading) return
    void loadProjects()
  }, [isSettingsLoaded, loadProjects, sessions.isHydrated, sessions.isLoading])

  // Hydrate the persisted framework before checking it so the launch probe uses the selected runtime.
  useEffect(() => {
    let active = true
    void loadSettings().then((loaded) => {
      if (active && loaded) void checkEnvironment()
    })
    return () => {
      active = false
    }
  }, [checkEnvironment, loadSettings])

  return {
    settings: {
      isLoaded: isSettingsLoaded,
      isLoading: isSettingsLoading,
      loadError: settingsLoadError,
      startupView: isSettingsLoaded
        ? resolveStartupView({ onboardingDone: onboardingCompletedAt !== undefined })
        : undefined,
      retry: retrySettings
    },
    sessions,
    quitPersistence,
    environment: { ui: environmentUi, retry: retryEnvironment },
    storageRecovery: {
      missingDataRoot,
      legacyMove,
      loadInfo: loadStorageInfo,
      resolveMissingDataRoot,
      dismissLegacyMove
    }
  }
}

export { useApplicationStartup }
export type { ApplicationStartupProjection }
