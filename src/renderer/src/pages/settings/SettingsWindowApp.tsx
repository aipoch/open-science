import { DesktopRuntimeRecovery } from '@/components/desktop-runtime-recovery'
import {
  getDesktopRuntimeEpoch,
  refreshDesktopRecoveryReaders
} from '@/stores/desktop-runtime-recovery-store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsPage, type SettingsPageHandle } from './SettingsPage'
import { settingsPanelRoute, type SettingsPanelId, type SettingsRoute } from './settings-navigation'
import type {
  SettingsWindowState,
  SettingsWorkspaceNavigation
} from '../../../../shared/settings-window'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { useSettingsSnapshotSync } from '@/hooks/useSettingsSnapshotSync'
import {
  deriveSessionCatalogRecovery,
  type SessionCatalogRecovery
} from '@/lib/session-persistence/session-catalog-recovery'
import { ActionToast, ActionToastStack } from '@/components/ActionToast'
import { ErrorNotice } from '@/components/error-notice'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import { useSettingsUndoPortal } from '@/components/use-settings-undo-portal'
import { LanguageSaveToast } from '@/components/LanguageControls'
import { useUpdateStore } from '@/stores/update-store'
import { UpdateDialog } from '@/components/UpdateDialog'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'

// Only navigation commands cross this boundary. No workspace startup, saver, quit flush or review
// hook is installed in this renderer, and no mutable workspace selection is copied back.
const navigate = (method: SettingsWorkspaceNavigation['method'], args: unknown[]): boolean => {
  void window.api.window.navigateWorkspace?.({ method, args }).catch((error: unknown) => {
    console.warn('Settings workspace navigation failed', error)
    window.dispatchEvent(new Event('settings-navigation-failed'))
  })
  return true
}
useNavigationStore.setState({
  openProject: (id) => navigate('openProject', [id]),
  openSessionById: (id) => navigate('openSessionById', [id]),
  openLiteratureItem: (id, origin, annotation) => {
    navigate('openLiteratureItem', [id, origin, annotation])
  },
  startCustomizeConversation: (id, goal) => {
    navigate('startCustomizeConversation', [id, goal])
  },
  startWslSupportConversation: (id, doc, token) =>
    navigate('startWslSupportConversation', [id, doc, token]),
  requestWslSetupProjectCreation: () => {
    navigate('requestWslSetupProjectCreation', [])
  }
})

const closeSettings = (): void => {
  void window.api.window.closeSettings!()
}

const retainSettingsDrafts = (): void => undefined

export const SettingsWindowApp = (): React.JSX.Element => {
  const { t } = useTranslation()
  const settingsPageRef = useRef<SettingsPageHandle>(null)
  useSettingsSnapshotSync()
  const loaded = useSettingsStore((s) => s.isLoaded)
  const error = useSettingsStore((s) => s.loadError)
  const open = useSettingsStore((s) => s.isSettingsOpen)
  const [navigationFailed, setNavigationFailed] = useState(false)
  const [catalog, setCatalog] = useState<{
    complete: boolean
    canDelete: boolean
    recovery: SessionCatalogRecovery
  }>({
    complete: false,
    canDelete: false,
    recovery: { kind: 'repairable', reason: 'session-scan' }
  })
  const refreshRef = useRef<() => Promise<void>>(async () => undefined)
  const retry = useCallback(() => {
    void refreshRef.current().catch(() => undefined)
  }, [])
  const reconcile = useCallback(async (epoch: number) => {
    // Settings reads summaries and recovery guards without acquiring the workspace save lease.
    await Promise.all([
      refreshDesktopRecoveryReaders(),
      refreshRef.current(),
      useSettingsStore
        .getState()
        .load({ force: true })
        .then((ok) => {
          if (!ok) throw new Error('Settings refresh failed.')
        })
    ])
    if (epoch !== getDesktopRuntimeEpoch()) throw new Error('Settings recovery was superseded.')
  }, [])
  const undo = useSettingsUndoPortal(<PermissionUndoSnackbar allowsArchiveShortcut={() => true} />)
  useEffect(() => {
    let active = true
    let revision = -1
    const accept = (state: SettingsWindowState): void => {
      if (!active || state.revision <= revision) return
      revision = state.revision
      useNavigationStore.setState({ activeProjectId: state.activeProjectId })
      useSettingsStore.setState({
        isSettingsOpen: state.visible !== false,
        ...(state.route
          ? {
              pendingSettingsIntent: {
                requestId: state.revision,
                route:
                  state.route.view === undefined
                    ? settingsPanelRoute(state.route.panel as SettingsPanelId)
                    : (state.route as SettingsRoute)
              }
            }
          : {})
      })
    }
    const failed = (): void => setNavigationFailed(true)
    window.addEventListener('settings-navigation-failed', failed)
    const removeOpen = window.api.window.onSettingsOpened!(accept)
    void window.api.window.settingsReady!().then(accept).catch(console.warn)
    void useSettingsStore.getState().load()
    const removePermissions = usePermissionGrantsStore.getState().listen()
    const removeUpdates = useUpdateStore.getState().init()
    const removeNativeClose = window.api.window.onSettingsCloseRequested!(() => {
      if (settingsPageRef.current) settingsPageRef.current.requestLeave(closeSettings)
      else closeSettings()
    })
    const removeClose = window.api.window.onCloseActivePane?.(() => {
      if (!settingsPageRef.current?.closeActivePane()) closeSettings()
    })
    // Subscribe before the initial read. Invalidation during a read causes a new read before any
    // result is applied, preventing a deleted/revised row from being resurrected by stale IPC.
    let generation = 0
    let pending: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): Promise<void> => {
      if (pending) return pending
      if (!active) return Promise.resolve()
      pending = (async () => {
        try {
          let current: number
          do {
            current = generation
            const epoch = getDesktopRuntimeEpoch()
            const result = await window.api.sessions.list()
            await Promise.all([
              useProjectStore.getState().loadProjects(),
              useProjectStore.getState().loadDeletionCleanup()
            ])
            if (!active) return
            if (epoch !== getDesktopRuntimeEpoch()) {
              generation++
              continue
            }
            if (current !== generation) continue
            if (useProjectStore.getState().loadError) throw new Error('Project refresh failed.')
            useSessionStore
              .getState()
              .hydrateSessionSummaries(result.sessions, undefined, undefined, {
                sessionId: undefined
              })
            const warnings =
              result.diagnostics?.warnings.filter((warning) => 'projectId' in warning) ?? []
            setCatalog({
              complete: result.diagnostics?.isComplete !== false && warnings.length === 0,
              canDelete: result.diagnostics?.isProjectDeletionRecoveryComplete === true,
              recovery: deriveSessionCatalogRecovery(result.diagnostics)
            })
          } while (current !== generation)
        } catch (error) {
          if (active)
            setCatalog({
              complete: false,
              canDelete: false,
              recovery: { kind: 'repairable', reason: 'session-scan' }
            })
          throw error
        }
      })().finally(() => {
        pending = undefined
      })
      return pending
    }
    const invalidate = (): void => {
      generation++
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void refresh().catch(() => undefined)
        }, 100)
    }
    refreshRef.current = () => {
      generation++
      return refresh()
    }
    const removers = [
      window.api.window.onSettingsCatalogChanged!(invalidate),
      window.api.projects.onCreated(invalidate),
      window.api.projects.onUpdated(invalidate),
      window.api.projects.onDeleted(invalidate),
      window.api.projects.onDeletionCleanupChanged?.(invalidate)
    ]
    void refresh().catch(() => undefined)
    return () => {
      active = false
      clearTimeout(timer)
      removeOpen()
      window.removeEventListener('settings-navigation-failed', failed)
      removePermissions()
      removeUpdates()
      removeClose?.()
      removeNativeClose()
      removers.forEach((remove) => remove?.())
    }
  }, [])
  const loading = !loaded ? (
    <main className="flex h-svh items-center justify-center bg-background text-foreground">
      {error ? (
        <ErrorNotice
          fullPage
          title={t('Settings could not be loaded')}
          description={error}
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              void useSettingsStore.getState().load({ force: true })
            }
          }}
        />
      ) : (
        <OpenScienceLogoLoader />
      )}
    </main>
  ) : null
  return (
    <>
      {loading ?? (
        <>
          <SettingsPage
            ref={settingsPageRef}
            standalone
            open={open}
            onClose={closeSettings}
            onOpenSession={(id) => {
              navigate('openSessionById', [id])
            }}
            undoHostRef={undo.settingsHostRef}
            canDeleteProjects={catalog.canDelete}
            hasCompleteSessionCatalog={catalog.complete}
            catalogRecovery={catalog.recovery}
            onRetryCatalogRecovery={retry}
          />
          <ActionToastStack>
            {navigationFailed ? (
              <ActionToast
                title={t('Something went wrong. Try again.')}
                level="error"
                dismissLabel={t('Close')}
                onDismiss={() => setNavigationFailed(false)}
              />
            ) : null}
            {undo.background}
          </ActionToastStack>
          <UpdateDialog active={open} />
          <LanguageSaveToast />
        </>
      )}
      <DesktopRuntimeRecovery reconcile={reconcile} flushDrafts={retainSettingsDrafts} />
    </>
  )
}
