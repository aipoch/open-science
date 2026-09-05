import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { CloseConfirmModal } from '@/components/CloseConfirmModal'
import { ActionToast } from '@/components/ActionToast'
import { ConnectorAuthToast } from '@/components/ConnectorAuthToast'
import { DataRootMissingDialog } from '@/components/DataRootMissingDialog'
import { ErrorNotice } from '@/components/error-notice'
import { GlobalSearchDialog } from '@/components/global-search/GlobalSearchDialog'
import { LegacyDataMoveDialog } from '@/components/LegacyDataMoveDialog'
import { LifecycleToast } from '@/components/LifecycleToast'
import { NotificationLiveToast } from '@/components/NotificationLiveToast'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import { SessionCatalogRecoveryAlert } from '@/components/SessionCatalogRecoveryAlert'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { StorageCleanupToast } from '@/components/StorageCleanupToast'
import { UpdateDialog } from '@/components/UpdateDialog'
import { WebEventRecoveryDialog } from '@/components/WebEventRecoveryDialog'
import { useApplicationEventBindings } from '@/hooks/useApplicationEventBindings'
import { useApplicationStartup } from '@/hooks/useApplicationStartup'
import { WorkspaceAgentRuntimeProvider } from '@/lib/acp/useWorkspaceAgentRuntime'
import { WorkspaceComputeRecoveryBridge } from '@/lib/compute/WorkspaceComputeRecoveryBridge'
import { HomePage } from '@/pages/home/HomePage'
import { OnboardingWizard } from '@/pages/onboarding/OnboardingWizard'
import { ComputeApprovalDialog } from '@/pages/settings/ComputeApprovalDialog'
import { ConnectorApprovalDialog } from '@/pages/settings/ConnectorApprovalDialog'
import { ConnectorCredentialDialog } from '@/pages/settings/ConnectorCredentialDialog'
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
          <ErrorNotice
            title={t('Settings could not be loaded')}
            description={startup.settings.loadError}
            primaryButton={{
              label: startup.settings.isLoading ? t('Retrying…') : t('Retry'),
              onClick: () => void startup.settings.retry(),
              loading: startup.settings.isLoading
            }}
          />
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

  // Session hydration may be waiting behind the missing-root write gate. Keep recovery reachable
  // before the session-loading branch so reconnect/relocate/accept-empty can release that gate.
  if (startup.storageRecovery.missingDataRoot !== undefined && !startup.sessions.isHydrated) {
    return (
      <DataRootMissingDialog
        open
        dataRoot={startup.storageRecovery.missingDataRoot}
        onResolved={startup.storageRecovery.resolveMissingDataRoot}
      />
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
      title={
        sessions.writeErrorRetryable
          ? t('Conversation storage needs attention')
          : t('Conversation storage limit reached')
      }
      message={sessions.writeError}
      onRetry={sessions.writeErrorRetryable ? sessions.retryWrites : undefined}
      onAction={
        sessions.writeErrorRetryable
          ? undefined
          : () => {
              sessions.startNewConversationAfterSizeLimit()
            }
      }
      actionLabel={sessions.writeErrorRetryable ? undefined : t('New conversation')}
    />
  ) : null
  const quitPersistenceAlert = startup.quitPersistence.notice ? (
    <SessionPersistenceAlert
      title={t('Quit was canceled')}
      message={
        startup.quitPersistence.notice.reason === 'conflict'
          ? t('A conversation changed elsewhere and could not be saved safely.')
          : t('One or more conversations could not be saved.')
      }
      onDismiss={startup.quitPersistence.dismissNotice}
      onRetry={() => {
        sessions.retryWrites()
        if (startup.quitPersistence.notice?.reason === 'conflict') {
          startup.quitPersistence.dismissNotice()
          return
        }
        void startup.quitPersistence.retryPersistence().catch(() => undefined)
      }}
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
            onOpenRecoveryFolder={window.api.sessions.openRecoveryFolder}
          />
        ) : sessions.loadError ? (
          <SessionPersistenceAlert
            title={t('Saved conversations could not be loaded')}
            message={sessions.loadError}
            onRetry={sessions.retryLoad}
          />
        ) : startup.quitPersistence.notice ? null : writeErrorAlert ? (
          writeErrorAlert
        ) : sessions.loadWarning ? (
          <SessionPersistenceAlert
            title={t('Saved conversation data was damaged')}
            message={sessions.loadWarning}
            variant="warning"
            onDismiss={sessions.dismissLoadWarning}
          />
        ) : null}
        {sessions.catalogRecovery.kind !== 'ready' && !startup.quitPersistence.notice
          ? writeErrorAlert
          : null}
        <WorkspaceAgentRuntimeProvider onSessionSizeLimit={sessions.reportSessionSizeLimit}>
          <WorkspaceMessageQueueProvider>
            <WorkspaceComputeRecoveryBridge enabled={sessions.isReady} />
            <WorkspaceMessageQueueRuntimeBridge
              persistenceBlockedSessionIds={sessions.persistenceBlockedSessionIds}
            />
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
                persistenceBlockedSessionIds={sessions.persistenceBlockedSessionIds}
                onSessionSizeLimit={sessions.reportSessionSizeLimit}
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
        <StorageCleanupToast />
        <NotificationLiveToast />
        <PermissionUndoSnackbar allowsArchiveShortcut={events.allowsArchiveUndoShortcut} />
        {events.notification.unavailableToken !== undefined ? (
          <ActionToast
            key={events.notification.unavailableToken}
            title={t('This session was deleted or is unavailable.')}
            dismissLabel={t('Close')}
            onDismiss={events.notification.dismissUnavailable}
            autoDismissMs={6000}
            className="top-44"
            testId="notification-target-unavailable-toast"
          />
        ) : null}
      </div>
      {quitPersistenceAlert}
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
      <ConnectorCredentialDialog active={activePresentation === 'credentialRequest'} />
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
