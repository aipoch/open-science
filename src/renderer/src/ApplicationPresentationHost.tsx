import { SideChatProvider } from './pages/workspace/use-side-chat-controller'
import { WorkspaceComposerDraftsProvider } from './pages/workspace/workspace-composer-drafts'
import { lazy, memo, Suspense, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { DeferredPresentationOwner } from '@/components/DeferredPresentationOwner'
import { CloseConfirmModal } from '@/components/CloseConfirmModal'
import { ActionToast, ActionToastStack, BottomNoticeStack } from '@/components/ActionToast'
import { ConnectorAuthToast } from '@/components/ConnectorAuthToast'
import { DataRootMissingDialog } from '@/components/DataRootMissingDialog'
import { ErrorNotice } from '@/components/error-notice'
import { LegacyDataMoveDialog } from '@/components/LegacyDataMoveDialog'
import { LifecycleToast } from '@/components/LifecycleToast'
import { LanguageSaveToast } from '@/components/LanguageControls'
import { NotificationLiveToast } from '@/components/NotificationLiveToast'
import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { useSettingsUndoPortal } from '@/components/use-settings-undo-portal'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import { SessionCatalogRecoveryAlert } from '@/components/SessionCatalogRecoveryAlert'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { StorageCleanupToast } from '@/components/StorageCleanupToast'
import { WebEventRecoveryDialog } from '@/components/WebEventRecoveryDialog'
import { useApplicationEventBindings } from '@/hooks/useApplicationEventBindings'
import { useApplicationStartup } from '@/hooks/useApplicationStartup'
import { WorkspaceAgentRuntimeProvider } from '@/lib/acp/useWorkspaceAgentRuntime'
import { WorkspaceComputeRecoveryBridge } from '@/lib/compute/WorkspaceComputeRecoveryBridge'
import { HomePage } from '@/pages/home/HomePage'
import type { SettingsPageHandle } from '@/pages/settings/SettingsPage'
import { EnvStatusBanner } from '@/pages/workspace/EnvStatusBanner'
import {
  WorkspaceMessageQueueProvider,
  WorkspaceMessageQueueRuntimeBridge
} from '@/pages/workspace/workspace-message-queue-controller'

const WorkspacePage = lazy(() =>
  import('@/pages/workspace/WorkspacePage').then(({ WorkspacePage }) => ({
    default: WorkspacePage
  }))
)
const LiteratureLibraryPage = lazy(() =>
  import('@/pages/literature/LiteratureLibraryPage').then(({ LiteratureLibraryPage }) => ({
    default: LiteratureLibraryPage
  }))
)

const StableLiteratureLibraryPage = memo(LiteratureLibraryPage)

const OnboardingWizard = lazy(() =>
  import('@/pages/onboarding/OnboardingWizard').then(({ OnboardingWizard }) => ({
    default: OnboardingWizard
  }))
)
const SettingsPage = lazy(() =>
  import('@/pages/settings/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage }))
)
const ComputeApprovalDialog = lazy(() =>
  import('@/pages/settings/ComputeApprovalDialog').then(({ ComputeApprovalDialog }) => ({
    default: ComputeApprovalDialog
  }))
)
const ConnectorApprovalDialog = lazy(() =>
  import('@/pages/settings/ConnectorApprovalDialog').then(({ ConnectorApprovalDialog }) => ({
    default: ConnectorApprovalDialog
  }))
)
const ConnectorCredentialDialog = lazy(() =>
  import('@/pages/settings/ConnectorCredentialDialog').then(({ ConnectorCredentialDialog }) => ({
    default: ConnectorCredentialDialog
  }))
)
const SkillImportApprovalDialog = lazy(() =>
  import('@/pages/settings/SkillImportApprovalDialog').then(({ SkillImportApprovalDialog }) => ({
    default: SkillImportApprovalDialog
  }))
)

const GlobalSearchDialog = lazy(() =>
  import('@/components/global-search/GlobalSearchDialog').then(({ GlobalSearchDialog }) => ({
    default: GlobalSearchDialog
  }))
)
const UpdateDialog = lazy(() =>
  import('@/components/UpdateDialog').then(({ UpdateDialog }) => ({ default: UpdateDialog }))
)

const ApplicationPresentationHost = (): React.JSX.Element => {
  const startup = useApplicationStartup()
  return (
    <SideChatProvider
      persistence={{
        ready: startup.sessions.isReady,
        blockedSessionIds: startup.sessions.persistenceBlockedSessionIds
      }}
    >
      <ApplicationPresentationContent startup={startup} />
    </SideChatProvider>
  )
}

const ApplicationPresentationContent = ({
  startup
}: {
  startup: ReturnType<typeof useApplicationStartup>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const settingsPageRef = useRef<SettingsPageHandle>(null)
  const closeActiveSettingsPane = useCallback(() => settingsPageRef.current?.closeActivePane(), [])
  const events = useApplicationEventBindings({
    startupView: startup.settings.startupView,
    sessionPersistence: startup.sessions,
    hasDataRootRecovery: startup.storageRecovery.missingDataRoot !== undefined,
    hasLegacyDataMove: startup.storageRecovery.legacyMove !== undefined,
    closeActiveSettingsPane
  })
  const { sessions } = startup
  const { presentation } = events
  const undoPortal = useSettingsUndoPortal(
    <PermissionUndoSnackbar allowsArchiveShortcut={events.allowsArchiveUndoShortcut} />
  )

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
            fullPage
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
        <Suspense fallback={<OpenScienceLogoLoader />}>
          <OnboardingWizard loadStorageInfo={startup.storageRecovery.loadInfo} />
        </Suspense>
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
          className="max-w-md"
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
      onDismiss={sessions.writeErrorRetryable ? sessions.dismissWriteWarning : undefined}
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
      className="z-[70]!"
      title={t('Quit was canceled')}
      message={
        startup.quitPersistence.notice.reason === 'conflict'
          ? t('A conversation changed elsewhere and could not be saved safely.')
          : t('Some changes have not been saved.')
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
      <WorkspaceAgentRuntimeProvider onSessionSizeLimit={sessions.reportSessionSizeLimit}>
        <WorkspaceComposerDraftsProvider>
          <WorkspaceMessageQueueProvider>
            <div
              className="contents"
              inert={!isBasePresentationActive}
              aria-hidden={isBasePresentationActive ? undefined : true}
            >
              <WorkspaceMessageQueueRuntimeBridge
                persistenceBlockedSessionIds={sessions.persistenceBlockedSessionIds}
              />
              <Suspense fallback={null}>
                {events.navigation.view === 'home' ? (
                  <HomePage
                    canDeleteProjects={sessions.canDeleteSessionsAndProjects}
                    hasCompleteSessionCatalog={sessions.hasCompleteSessionCatalog}
                    catalogRecovery={sessions.catalogRecovery}
                    onOpenGlobalSearch={events.globalSearch.open}
                  />
                ) : events.navigation.view === 'library' ? (
                  <StableLiteratureLibraryPage />
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
              </Suspense>
              <ActionToastStack>
                {sessions.catalogRecovery.kind !== 'ready' ? null : sessions.loadError ? (
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
                <LifecycleToast
                  notice={events.lifecycle.notice}
                  onDismiss={events.lifecycle.dismissNotice}
                  onView={events.lifecycle.viewNotice}
                />
                <ConnectorAuthToast />
                <StorageCleanupToast />
                {events.notification.unavailableToken !== undefined ? (
                  <ActionToast
                    key={events.notification.unavailableToken}
                    title={t('This session was deleted or is unavailable.')}
                    dismissLabel={t('Close')}
                    onDismiss={events.notification.dismissUnavailable}
                    autoDismissMs={6000}
                    testId="notification-target-unavailable-toast"
                  />
                ) : null}
                {isBasePresentationActive ? <LanguageSaveToast /> : null}
                {undoPortal.background}
              </ActionToastStack>
            </div>
            <BottomNoticeStack>
              <div
                className="contents"
                inert={!isBasePresentationActive}
                aria-hidden={isBasePresentationActive ? undefined : true}
              >
                <EnvStatusBanner
                  ui={startup.environment.ui}
                  onRetry={() => void startup.environment.retry()}
                  onOpenRuntimes={events.settings.openRuntimes}
                />
                {sessions.catalogRecovery.kind !== 'ready' ? (
                  <SessionCatalogRecoveryAlert
                    recovery={sessions.catalogRecovery}
                    onRetry={sessions.retryLoad}
                    onOpenRecoveryFolder={window.api.sessions.openRecoveryFolder}
                  />
                ) : null}
                <WorkspaceComputeRecoveryBridge enabled={sessions.isReady} />
                <NotificationLiveToast />
              </div>
            </BottomNoticeStack>
            {quitPersistenceAlert}
          </WorkspaceMessageQueueProvider>
        </WorkspaceComposerDraftsProvider>
      </WorkspaceAgentRuntimeProvider>
      <WebEventRecoveryDialog
        active={activePresentation === 'webEventRecovery'}
        phase={events.webEventConnectionPhase}
      />
      <Suspense fallback={null}>
        <SettingsPage
          ref={settingsPageRef}
          undoHostRef={undoPortal.settingsHostRef}
          open={activePresentation === 'settings'}
          onClose={events.settings.close}
          onOpenSession={events.settings.openSession}
          canDeleteProjects={sessions.canDeleteSessionsAndProjects}
          hasCompleteSessionCatalog={sessions.hasCompleteSessionCatalog}
          catalogRecovery={sessions.catalogRecovery}
          onRetryCatalogRecovery={sessions.retryLoad}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ConnectorApprovalDialog
          active={activePresentation === 'connectorApproval'}
          blockedSessionIds={events.blockedApprovalSessionIds}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ConnectorCredentialDialog active={activePresentation === 'credentialRequest'} />
      </Suspense>
      <Suspense fallback={null}>
        <ComputeApprovalDialog
          active={activePresentation === 'computeApproval'}
          blockedSessionIds={events.blockedApprovalSessionIds}
        />
      </Suspense>
      <DeferredPresentationOwner active={activePresentation === 'skillImportApproval'}>
        {(active) => (
          <SkillImportApprovalDialog
            active={active}
            blockedSessionIds={events.blockedApprovalSessionIds}
          />
        )}
      </DeferredPresentationOwner>
      <DeferredPresentationOwner active={activePresentation === 'update'}>
        {(active) => <UpdateDialog active={active} />}
      </DeferredPresentationOwner>
      <CloseConfirmModal
        active={activePresentation === 'closeConfirmation'}
        onOpenChange={events.closeConfirmation.setOpen}
      />
      {activePresentation === 'globalSearch' ? (
        <Suspense fallback={null}>
          <GlobalSearchDialog
            open
            onOpenChange={events.globalSearch.setOpen}
            isSessionPersistenceReady={sessions.isReady}
          />
        </Suspense>
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
          defaultDataRoot={startup.storageRecovery.legacyMove.defaultDataRoot}
          onDismiss={startup.storageRecovery.dismissLegacyMove}
        />
      ) : null}
    </>
  )
}

export { ApplicationPresentationHost }
