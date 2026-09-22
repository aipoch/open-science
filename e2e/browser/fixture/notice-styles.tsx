import { AppVersionSection } from '@/pages/settings/AppVersionSection'
import { useUpdateStore } from '@/stores/update-store'
import { useThemeStore } from '@/stores/theme-store'
import { NetworkProxyForm } from '@/pages/settings/NetworkProxyForm'
import { useSettingsStore } from '@/stores/settings-store'
import { EnvStatusBanner } from '@/pages/workspace/EnvStatusBanner'
import { EnvProvisionOverlay } from '@/pages/workspace/EnvProvisionOverlay'
import { NotebookNetworkProtectionBanner } from '@/pages/settings/NotebookNetworkProtectionBanner'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { DataRootWarning } from '@/components/DataRootWarning'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Notice } from '@/components/notice'
import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { Button } from '@/components/ui/button'
import { ActionToast, ActionToastStack, BottomNoticeStack } from '@/components/ActionToast'
import { ErrorNotice } from '@/components/error-notice'
import { LinkSafetyModal } from '@/components/streamdown/LinkSafetyModal'
import { StorageMigrationModal } from '@/pages/settings/StorageMigrationModal'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'

const query = new URLSearchParams(location.search)
const locale = query.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
useThemeStore.getState().setPreference(query.has('dark') ? 'dark' : 'light')
window.api = {
  platform: 'darwin',
  storage: {
    detectActive: async () => [],
    discardMigratedCopy: async () => ({ ok: true }),
    commitAndRelaunch: async () => ({ ok: true }),
    onProgress: () => () => {},
    migrate: async () => ({ ok: false, error: 'Fixture storage failure' })
  }
} as unknown as typeof window.api
useArchiveUndoStore.setState({
  notices: [
    {
      key: 'project:fixture:1',
      kind: 'project',
      projectId: 'fixture',
      archivedAt: 1,
      revision: 0,
      expiresAt: Date.now() + 3600000,
      messageKey: 'Archived project “{{name}}”.',
      messageParams: {
        name: query.has('longArchive') ? 'Protein analysis '.repeat(20) : 'Protein analysis'
      }
    }
  ]
})

export function Fixture(): React.JSX.Element {
  const { t } = useTranslation()
  const [modal, setModal] = useState('')
  const [actions, setActions] = useState(0)
  const [notice, setNotice] = useState(true)
  if (query.has('about')) {
    return (
      <main className="mx-auto max-w-5xl space-y-6 p-6 text-foreground" data-testid="about-preview">
        <h1 className="text-xl font-semibold">{t('General')}</h1>
        <AppVersionSection />
      </main>
    )
  }
  if (query.has('layout')) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-6 text-foreground">
        <div className="flex flex-col border" data-testid="margin-host">
          <InlineNotice className="m-2" role="alert" level="error" data-testid="margin-inline">
            {'net::ERR_NAME_NOT_RESOLVED_'.repeat(8)}
          </InlineNotice>
        </div>
        <div className="w-40" data-testid="narrow-host">
          <ErrorNotice description="net::ERR_NAME_NOT_RESOLVED" data-testid="narrow-card" />
        </div>
        <Notice
          inline
          role="alert"
          description="Could not save the language."
          data-testid="inline-dismiss"
          dismissButton={{ label: 'Dismiss', onClick: () => setActions(actions + 1) }}
        />
        <Notice
          inline
          role="alert"
          description="Could not check the log file."
          errorCode={'diagnostic/'.repeat(40)}
          diagnosticsLabel="Details"
          data-testid="inline-retry"
          primaryButton={{ label: 'Retry', onClick: () => setActions(actions + 1) }}
        />
        <Notice
          inline
          role="note"
          content={<p>Review the affected conversations before checking the saved files again.</p>}
          data-testid="inline-content"
          primaryButton={{
            label: 'Recheck saved conversations',
            onClick: () => setActions(actions + 1)
          }}
        />
        <Notice
          title="Saved"
          data-testid="title-only"
          primaryButton={{ label: 'Undo', onClick: () => setActions(actions + 1) }}
        />
        <output data-testid="actions">{actions}</output>
      </main>
    )
  }
  if (query.has('floatingArchive')) {
    return (
      <main className="min-h-svh bg-background">
        <ActionToastStack>
          <PermissionUndoSnackbar allowsArchiveShortcut={() => false} />
        </ActionToastStack>
      </main>
    )
  }
  if (query.has('settingsInline')) {
    return (
      <main
        className="mx-auto max-w-3xl space-y-5 p-5 text-foreground"
        data-testid="settings-inline-preview"
      >
        <h1 className="text-xl font-semibold">{t('Network')}</h1>
        <NotebookNetworkProtectionBanner
          status={{ kind: 'setupRequired', platform: 'win32', reasons: ['windowsHostMissing'] }}
          onOpen={() => {}}
        />
        <NetworkProxyForm onDone={() => {}} />
      </main>
    )
  }
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-foreground" data-testid="notice-styles">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Information surfaces</h1>
        <p className="text-sm text-muted-foreground">
          Production components · isolated fixture data
        </p>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Examples">
        <Button variant="outline" onClick={() => setModal('link')}>
          External link
        </Button>
        <Button variant="outline" onClick={() => setModal('verified')}>
          Verified copy
        </Button>
        <Button variant="outline" onClick={() => setModal('copying')}>
          Incomplete copy
        </Button>
        <Button variant="outline" onClick={() => setModal('error')}>
          Migration error
        </Button>
        <Button variant="outline" onClick={() => setModal('environment')}>
          Notebook environment error
        </Button>
        <Button variant="outline" onClick={() => setModal('combined')}>
          Environment and storage errors
        </Button>
        <Button variant="outline" onClick={() => setModal('progress')}>
          Notebook update progress
        </Button>
        <Button variant="outline" onClick={() => setModal('pane')}>
          Notebook pane error
        </Button>
        <Button variant="outline" onClick={() => setModal('storage')}>
          Bottom storage error
        </Button>
        <Button variant="outline" onClick={() => setModal('short-stack')}>
          Short message stack
        </Button>
        <Button variant="outline" onClick={() => setModal('')}>
          Clear example
        </Button>
      </nav>
      <Notice
        level="info"
        role="note"
        title={t('Notebook environment ready')}
        description={t('Network protection on')}
        data-testid="info-notice-example"
      />
      <ErrorNotice
        role="alert"
        title={t('Runtime recovery blocked')}
        description={t(
          'Use Recheck to retry safe recovery. Only confirmed stopped operations can be reconciled; permissions and repair requirements remain in force.'
        )}
        primaryButton={{ label: t('Recheck'), onClick: () => setActions(actions + 1) }}
      />
      <ErrorNotice
        role="alert"
        tone="red"
        title={t('Provenance integrity error')}
        description={t('No Specialist changes will be saved until the data is repaired.')}
        errorCode="E_READ: research/session.json"
        diagnosticsLabel={t('Details')}
        primaryButton={{ label: t('Retry'), onClick: () => setActions(actions + 1) }}
      />
      {notice ? (
        <ActionToast
          level="warning"
          className="static w-full max-h-none"
          title={t('{{name}} needs sign-in', { name: 'Research Connector' })}
          detail={t(
            'Authorization expired or was revoked. Sign in again to keep this Connector available.'
          )}
          actionLabel={t('Open Connectors')}
          dismissLabel={t('Close')}
          onAction={() => setActions(actions + 1)}
          onDismiss={() => setNotice(false)}
        />
      ) : null}
      <section className="space-y-3" data-testid="inline-notice-examples">
        <DataRootWarning />
        <InlineNotice>
          {t('This point still depends on earlier Notebook state.')}
          <p>{t('Captured file metadata is missing.')}</p>
        </InlineNotice>
        <NotebookNetworkProtectionBanner
          status={{ kind: 'setupRequired', platform: 'win32', reasons: [] }}
          onOpen={() => setActions(actions + 1)}
        />
      </section>
      <ActionToast
        className="static ml-auto max-h-none"
        title={t('This session was deleted or is unavailable.')}
        dismissLabel={t('Close')}
        onDismiss={() => setActions(actions + 1)}
        testId="short-action-notice"
      />
      {modal === 'short-stack' ? (
        <ActionToastStack>
          <ActionToast
            title={t('This session was deleted or is unavailable.')}
            dismissLabel={t('Close')}
            onDismiss={() => setModal('')}
            testId="stacked-short-message"
          />
          <ActionToast
            title={t('This session was deleted or is unavailable.').repeat(8)}
            dismissLabel={t('Close')}
            onDismiss={() => setModal('')}
            testId="stacked-long-message"
          />
        </ActionToastStack>
      ) : null}
      <PermissionUndoSnackbar allowsArchiveShortcut={() => false} />
      <output data-testid="actions" className="sr-only">
        {actions}
      </output>
      {modal === 'pane' ? (
        <div className="relative h-80" data-testid="pane-error-example">
          <EnvProvisionOverlay
            ui={{ kind: 'error', message: 'Unable to prepare the Notebook environment.' }}
            onRetry={() => setActions(actions + 1)}
          />
        </div>
      ) : null}
      <BottomNoticeStack>
        <div className="contents">
          {['environment', 'combined'].includes(modal) ? (
            <EnvStatusBanner
              ui={{
                kind: 'error',
                message:
                  'Unable to download the Notebook runtime. ' + 'python-runtime-package '.repeat(20)
              }}
              onRetry={() => setActions(actions + 1)}
            />
          ) : null}
          {modal === 'progress' ? (
            <EnvStatusBanner
              ui={{
                kind: 'preparing',
                scope: 'upgrade',
                phase: 'upgrade',
                event: { code: 'updating-default-packages' },
                progress: 0.6
              }}
            />
          ) : null}
        </div>
        {['storage', 'combined'].includes(modal) ? (
          <SessionPersistenceAlert
            title={t('Quit was canceled')}
            message={t('Some changes have not been saved.')}
            onRetry={() => setActions(actions + 1)}
            onDismiss={() => setModal(modal === 'combined' ? 'environment' : '')}
          />
        ) : null}
      </BottomNoticeStack>
      <LinkSafetyModal
        url={`https://example.org/research/${'protein-analysis-'.repeat(8)}`}
        isOpen={modal === 'link'}
        onClose={() => setModal('')}
        onConfirm={() => setActions(actions + 1)}
      />
      {['verified', 'copying', 'error'].includes(modal) ? (
        <StorageMigrationModal
          key={modal}
          targetPath="/fixture/OpenScience"
          recoveryStatus={
            modal === 'verified' ? 'verified' : modal === 'copying' ? 'copying' : undefined
          }
          onClose={() => setModal('')}
        />
      ) : null}
    </main>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  if (query.has('about')) {
    useUpdateStore.setState({
      status: {
        state: 'error',
        current: '0.30.1',
        error: query.has('long')
          ? 'net::ERR_NAME_NOT_RESOLVED_'.repeat(20)
          : 'net::ERR_NAME_NOT_RESOLVED'
      },
      check: async () => {
        useUpdateStore.setState({ status: { state: 'up-to-date', current: '0.30.1' } })
      }
    })
  }
  if (query.has('settingsInline')) {
    useSettingsStore.setState({
      networkProxy: { mode: 'manual', server: 'http://127.0.0.1:1086' },
      setNetworkProxy: async () => {
        throw new Error(
          locale === 'zh-Hans' ? '无法保存代理配置。' : 'Could not save the proxy configuration.'
        )
      }
    })
  }
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
