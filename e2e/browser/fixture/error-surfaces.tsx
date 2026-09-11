import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n } from '@/i18n'
import { ErrorNotice } from '@/components/error-notice'
import { ActionToast, ActionToastStack } from '@/components/ActionToast'
import { SessionPersistenceAlert } from '@/components/SessionPersistenceAlert'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { PermissionUndoSnackbar } from '@/components/PermissionUndoSnackbar'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { Button } from '@/components/ui/button'
import { EnvironmentSetupCard } from '@/pages/onboarding/EnvironmentSetupCard'
import { SettingsLoadNotice } from '@/pages/settings/SettingsLayout'

const query = new URLSearchParams(location.search)
initI18n(query.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en')
document.documentElement.classList.toggle('dark', query.has('dark'))
if (query.has('undo')) {
  window.api = { platform: 'darwin' } as typeof window.api
  useArchiveUndoStore.setState({
    notices: [
      {
        key: 'project:fixture:1',
        kind: 'project',
        projectId: 'fixture',
        archivedAt: 1,
        revision: 0,
        expiresAt: Date.now() + 60000,
        messageKey: 'Archived project “{{name}}”.',
        messageParams: { name: 'Long-project-name-'.repeat(12) }
      }
    ]
  })
}

export function Fixture(): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [showToasts, setShowToasts] = useState(query.has('toasts'))
  return (
    <main className="mx-auto max-w-3xl space-y-7 p-6 text-foreground" data-testid="error-gallery">
      <h1 className="text-xl font-semibold">
        Error surfaces — production components / fixture data
      </h1>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">1 · Control-local inline</h2>
        <label className="block text-sm">
          Provider URL
          <input
            className="mt-2 block w-full rounded border border-input p-2"
            aria-invalid="true"
            aria-describedby="field-error"
            defaultValue="invalid-url"
          />
        </label>
        <p id="field-error" role="alert" className="text-xs text-destructive">
          {t('Could not test the provider connection.')}
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">2 · Multiline local recovery</h2>
        <SettingsLoadNotice
          state="error"
          loadingLabel=""
          errorMessage={t('Open Science could not load Specialists. Retry to continue.')}
          onRetry={() => setRetry(retry + 1)}
        />
        <output data-testid="retry-count">{retry}</output>
        <EnvironmentSetupCard
          environment={undefined}
          error={t('Reload Open Science to try loading this panel again.')}
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">3 · Diagnostics stay outside the announcement</h2>
        <ErrorNotice
          role="alert"
          title={t('Provenance integrity error')}
          description={t('No Specialist changes will be saved until the data is repaired.')}
          tone="red"
          errorCode={'E_READ: ' + 'long-diagnostic-'.repeat(20)}
          diagnosticsLabel="Technical details"
          primaryButton={{ label: t('Retry'), onClick: () => setRetry(retry + 1) }}
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">4 · Persistent recovery notice</h2>
        {!dismissed ? (
          <SessionPersistenceAlert
            inline
            title={t('Saved conversations could not be loaded')}
            message={'StorageUnavailable: ' + 'long-storage-path/'.repeat(10)}
            onRetry={() => setRetry(retry + 1)}
            onDismiss={() => setDismissed(true)}
          />
        ) : (
          <p>Dismissed</p>
        )}
      </section>
      <section className="flex flex-wrap gap-3">
        <Button onClick={() => setConfirm(true)}>Open dangerous action</Button>
        <Button variant="outline" onClick={() => setShowToasts(!showToasts)}>
          Toggle global notices
        </Button>
      </section>
      <output data-testid="confirm-count">{attempts}</output>
      <ConfirmActionDialog
        open={confirm}
        title={t('Delete Session?')}
        description={t(
          'This will permanently delete "{{title}}". Artifacts created in this session will remain in the project. Messages and execution evidence attached to those Artifacts will remain available in Provenance. Files in its working folder are not deleted. This action cannot be undone.',
          { title: 'Research-'.repeat(65) }
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Delete permanently')}
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => setAttempts(attempts + 1)}
      />
      {showToasts ? (
        <ActionToastStack>
          <ActionToast
            title={t('Old data location needs cleanup')}
            detail={t(
              'Your data is using the new location, but some files remain in the old one. Open Science will try again the next time it starts.'
            )}
            actionLabel={t('Open Storage')}
            dismissLabel={t('Close')}
            onAction={() => setRetry(retry + 1)}
            onDismiss={() => setShowToasts(false)}
          />
          <ActionToast
            title={t('{{name}} needs sign-in', { name: 'Research-connector-with-a-long-name' })}
            detail={t(
              'Authorization expired or was revoked. Sign in again to keep this Connector available.'
            )}
            actionLabel={t('Open Connectors')}
            dismissLabel={t('Close')}
            onAction={() => setRetry(retry + 1)}
            onDismiss={() => setShowToasts(false)}
          />
          {query.has('undo') ? (
            <>
              <SessionPersistenceAlert
                title={t('Saved conversations could not be loaded')}
                message={'Long-storage-path/'.repeat(12)}
                onRetry={() => setRetry(retry + 1)}
              />
              <PermissionUndoSnackbar allowsArchiveShortcut={() => false} />
            </>
          ) : null}
        </ActionToastStack>
      ) : null}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
