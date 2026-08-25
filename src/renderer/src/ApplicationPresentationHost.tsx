import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { CloseConfirmModal } from '@/components/CloseConfirmModal'
import { ConnectorAuthToast } from '@/components/ConnectorAuthToast'
import { DataRootMissingDialog } from '@/components/DataRootMissingDialog'
import { GlobalSearchDialog } from '@/components/global-search/GlobalSearchDialog'
import { LegacyDataMoveDialog } from '@/components/LegacyDataMoveDialog'
import { LifecycleToast } from '@/components/LifecycleToast'
import { NotificationLiveToast } from '@/components/NotificationLiveToast'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import { SessionCatalogRecoveryAlert } from '@/components/SessionCatalogRecoveryAlert'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { UpdateDialog } from '@/components/UpdateDialog'
import { Button } from '@/components/ui/button'
import { WebEventRecoveryDialog } from '@/components/WebEventRecoveryDialog'
import { useApplicationEventBindings } from '@/hooks/useApplicationEventBindings'
import { useApplicationStartup } from '@/hooks/useApplicationStartup'
import { WorkspaceAgentRuntimeProvider } from '@/lib/acp/useWorkspaceAgentRuntime'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { ComputeApprovalDialog } from '@/pages/settings/ComputeApprovalDialog'
import { ConnectorApprovalDialog } from '@/pages/settings/ConnectorApprovalDialog'
import { SettingsPage, type SettingsPageHandle } from '@/pages/settings/SettingsPage'
import { SkillImportApprovalDialog } from '@/pages/settings/SkillImportApprovalDialog'
import { EnvStatusBanner } from '@/pages/workspace/EnvStatusBanner'
import { WorkspacePage } from '@/pages/workspace/WorkspacePage'
import {
  WorkspaceMessageQueueProvider,
  WorkspaceMessageQueueRuntimeBridge
} from '@/pages/workspace/workspace-message-queue-controller'

const ApplicationPresentationHost = (): React.JSX.Element => {
  const { t } = useTranslation()
  const settingsPageRef = useRef<SettingsPageHandle>(null)
  const closeActiveSettingsPane = useCallback(() => settingsPageRef.current?.closeActivePane(), [])
  const startup = useApplicationStartup()
  const events = useApplicationEventBindings({
    startupView: startup.settings.startupView,
    sessionPersistence: startup.sessions,
    hasDataRootRecovery: startup.storageRecovery.missingDataRoot !== undefined,
    hasLegacyDataMove: startup.storageRecovery.legacyMove !== undefined,
    closeActiveSettingsPane
  })
  const { sessions } = startup
  const { presentation } = events

  if (
    !startup.settings.isLoaded ||
    (startup.settings.startupView === 'onboarding' && startup.settings.isLoading)
  ) {
    if (startup.settings.loadError) {
      return (
        <main
          role="alert"
          className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm">
            <h1 className="text-base font-semibold text-foreground">
              {t('Settings could not be loaded')}
            </h1>
            <p className="mt-2 break-words text-sm text-muted-foreground">
              {startup.settings.loadError}
            </p>
            <Button
              type="button"
              variant="outline"
              data-testid="settings-startup-retry"
              disabled={startup.settings.isLoading}
              onClick={() => void startup.settings.retry()}
              className="mt-4"
            >
              {startup.settings.isLoading ? t('Retrying…') : t('Retry')}
            </Button>
          </div>
        </main>
      )
    }

    return (
      <main
        data-testid="settings-startup-loading"
        role="status"
        className="flex min-h-svh items-center justify-center bg-background text-foreground"
      >
        <div className="flex flex-col items-center gap-14">
          <OpenScienceLogoLoader />
          <span className="text-sm text-muted-foreground">{t('Loading settings…')}</span>
        </div>
      </main>
    )
  }

  if (startup.settings.startupView === 'onboarding') {
    return (
      <>
        <EnvStatusBanner
          ui={startup.environment.ui}
          onRetry={() => void startup.environment.retry()}
        />
        <OnboardingWizard loadStorageInfo={startup.storageRecovery.loadInfo} />
      </>
    )
  }

  if (!sessions.isHydrated && sessions.isLoading) {
    return (
      <main
        data-testid="session-persistence-startup-loading"
        role="status"
        className="flex min-h-svh items-center justify-center bg-background text-foreground"
      >
        <div className="flex flex-col items-center gap-14">
          <OpenScienceLogoLoader />
          <span className="text-sm text-muted-foreground">{t('Loading saved conversations…')}</span>
        </div>
      </main>
    )
  }

  if (!sessions.isHydrated && sessions.loadError) {
    return (
      <main
        data-testid="session-persistence-startup-error"
        className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground"
      >
        <SessionPersistenceAlert
          title={t('Saved conversations could not be loaded')}
          message={sessions.loadError}
          inline
          onRetry={sessions.retryLoad}
        />
      </main>
    )
  }

  const activePresentation = presentation.active
  const isBasePresentationActive = activePresentation === 'base' || activePresentation === 'preview'
  const writeErrorAlert = sessions.writeError ? (
    <SessionPersistenceAlert
      title={t('Conversation storage needs attention')}
      message={sessions.writeError}
      onRetry={sessions.retryWrites}
    />
  ) : null

  return (
    <>
      <div
        className="contents"
        inert={!isBasePresentationActive}
        aria-hidden={isBasePresentationActive ? undefined : true}
      >
        <EnvStatusBanner
          ui={startup.environment.ui}
          onRetry={() => void startup.environment.retry()}
        />
        {sessions.catalogRecovery.kind !== 'ready' ? (
          <SessionCatalogRecoveryAlert
            recovery={sessions.catalogRecovery}
            onRetry={sessions.retryLoad}
          />
        ) : sessions.loadError ? (
          <SessionPersistenceAlert
            title={t('Saved conversations could not be loaded')}
            message={sessions.loadError}
            onRetry={sessions.retryLoad}
          />
        ) : writeErrorAlert ? (
          writeErrorAlert
        ) : sessions.loadWarning ? (
          <SessionPersistenceAlert
            title={t('Saved conversation data was damaged')}
            message={sessions.loadWarning}
            variant="warning"
            onDismiss={sessions.dismissLoadWarning}
          />
        ) : null}
        {sessions.catalogRecovery.kind !== 'ready' ? writeErrorAlert : null}
        <WorkspaceAgentRuntimeProvider>
          <WorkspaceMessageQueueProvider>
            <WorkspaceMessageQueueRuntimeBridge />
            {events.navigation.view === 'home' ? (
              <HomePage
                canDeleteProjects={sessions.canDeleteSessionsAndProjects}
                hasCompleteSessionCatalog={sessions.hasCompleteSessionCatalog}
                catalogRecovery={sessions.catalogRecovery}
                onOpenGlobalSearch={events.globalSearch.open}
              />
            ) : (
              <WorkspacePage
                isSessionPersistenceHydrated={sessions.isHydrated}
                isSessionPersistenceReady={sessions.isReady}
                canDeleteConversations={sessions.canDeleteSessionsAndProjects}
                isPreviewPresentationActive={isBasePresentationActive}
              />
            )}
          </WorkspaceMessageQueueProvider>
        </WorkspaceAgentRuntimeProvider>
        <LifecycleToast
          notice={events.lifecycle.notice}
          onDismiss={events.lifecycle.dismissNotice}
          onView={events.lifecycle.viewNotice}
        />
        <ConnectorAuthToast />
        <NotificationLiveToast />
        <PermissionUndoSnackbar allowsArchiveShortcut={events.allowsArchiveUndoShortcut} />
      </div>
      <WebEventRecoveryDialog
        active={activePresentation === 'webEventRecovery'}
        phase={events.webEventConnectionPhase}
      />
      <SettingsPage
        ref={settingsPageRef}
        open={activePresentation === 'settings'}
        onClose={events.settings.close}
        onOpenSession={events.settings.openSession}
        canDeleteProjects={sessions.canDeleteSessionsAndProjects}
        hasCompleteSessionCatalog={sessions.hasCompleteSessionCatalog}
        catalogRecovery={sessions.catalogRecovery}
        onRetryCatalogRecovery={sessions.retryLoad}
      />
      <ConnectorApprovalDialog
        active={activePresentation === 'connectorApproval'}
        blockedSessionIds={events.blockedApprovalSessionIds}
      />
      <SkillImportApprovalDialog
        active={activePresentation === 'skillImportApproval'}
        blockedSessionIds={events.blockedApprovalSessionIds}
      />
      <ComputeApprovalDialog
        active={activePresentation === 'computeApproval'}
        blockedSessionIds={events.blockedApprovalSessionIds}
      />
      <UpdateDialog active={activePresentation === 'update'} />
      <CloseConfirmModal
        active={activePresentation === 'closeConfirmation'}
        onOpenChange={events.closeConfirmation.setOpen}
      />
      {activePresentation === 'globalSearch' ? (
        <GlobalSearchDialog
          open
          onOpenChange={events.globalSearch.setOpen}
          isSessionPersistenceReady={sessions.isReady}
        />
      ) : null}
      <DataRootMissingDialog
        open={activePresentation === 'dataRootRecovery'}
        dataRoot={startup.storageRecovery.missingDataRoot ?? ''}
        onResolved={startup.storageRecovery.resolveMissingDataRoot}
      />
      {startup.storageRecovery.legacyMove ? (
        <LegacyDataMoveDialog
          active={activePresentation === 'legacyDataMove'}
          currentDataRoot={startup.storageRecovery.legacyMove.currentDataRoot}
          defaultParent={startup.storageRecovery.legacyMove.defaultParent}
          onDismiss={startup.storageRecovery.dismissLegacyMove}
        />
      ) : null}
    </>
  )
}

export { ApplicationPresentationHost }
