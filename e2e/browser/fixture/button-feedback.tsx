import '@/assets/main.css'
import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { isLocale } from '../../../src/shared/locale'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { ErrorNotice } from '@/components/error-notice'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Button } from '@/components/ui/button'
import { RestoreDefaultPermissionsButton } from '@/pages/settings/RestoreDefaultPermissionsButton'
import { WorkspaceToolCodeBlock } from '@/pages/workspace/WorkspaceToolCodeBlock'
import { ManagedFileDownloadButton } from '@/pages/workspace/ManagedFileDownloadButton'
import { HomePage } from '@/pages/home/HomePage'
import { useProjectStore } from '@/stores/project-store'
import { NetworkProxyForm } from '@/pages/settings/NetworkProxyForm'
import { useSettingsStore } from '@/stores/settings-store'
import { useUpdateStore } from '@/stores/update-store'
import { useTranslation } from 'react-i18next'

const params = new URLSearchParams(location.search)
if (params.has('home')) {
  window.api = {
    projectFiles: { onChanged: () => () => {} },
    github: { getStars: async () => 1000 }
  } as unknown as typeof window.api
  useProjectStore.setState({ isLoaded: true })
}
const requestedLocale = params.get('locale')
const locale = isLocale(requestedLocale) ? requestedLocale : 'en'
await prepareI18nLocale(locale)
initI18n(locale)
document.documentElement.classList.toggle('dark', params.has('dark'))
useUpdateStore.setState({ status: { state: 'available', current: '0.29.0', latest: '0.30.0' } })
let finishSave: (() => void) | undefined
useSettingsStore.setState({
  networkProxy: { mode: 'direct' },
  setNetworkProxy: () =>
    new Promise<void>((resolve) => {
      finishSave = resolve
    })
})
// Test-only native boundary. Clipboard completion/failure never touches the user's clipboard.
let rejectCopy = false
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async () => {
      if (rejectCopy) throw new Error('Clipboard denied')
    }
  }
})

export function Fixture(): React.JSX.Element {
  const { t } = useTranslation()
  const [restoring, setRestoring] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmed, setConfirmed] = useState(0)
  const updateOpen = useUpdateStore((state) => state.isDialogOpen)
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-7 p-6 text-foreground">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Open Science</h1>
          <p className="text-sm text-muted-foreground">Button feedback · production components</p>
        </div>
        <div data-testid="update">
          <UpdateCapsule />
        </div>
      </header>
      <output data-testid="update-open" className="sr-only">
        {String(updateOpen)}
      </output>
      <section className="grid gap-3" aria-label="Action states">
        <h2 className="font-medium">{t('Restore defaults')}</h2>
        <div className="flex flex-wrap gap-3">
          {(['idle', 'loading', 'success', 'error'] as const).map((state) => (
            <RestoreDefaultPermissionsButton key={state} state={state} onRestore={() => {}} />
          ))}
        </div>
      </section>
      <section className="flex flex-wrap items-center gap-4" aria-label="Download states">
        <Button disabled aria-label="Spinner fallback">
          <span className="button-feedback">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {t('Installing…')}
          </span>
        </Button>
        {(['idle', 'saving', 'saved', 'error'] as const).map((status) => (
          <ManagedFileDownloadButton
            key={status}
            source="local"
            path="/fixture/report.txt"
            suggestedName="report.txt"
            appearance="primary"
            download={{ status, sizeLimitError: false, execute: async () => {} }}
          />
        ))}
      </section>
      <section aria-label="Code copy">
        <WorkspaceToolCodeBlock code={'mean = sum(values) / len(values)'} copyable />
      </section>
      <ErrorNotice
        title={t('Try again')}
        description={t('Could not copy code. Try again.')}
        primaryButton={{ label: t('Retry'), loading: restoring, onClick: () => setRestoring(true) }}
      />
      <section className="rounded-lg border border-border" aria-label="Proxy form">
        <NetworkProxyForm onDone={() => {}} />
      </section>
      <div
        className="flex flex-wrap gap-2 border-t border-border pt-4"
        aria-label="Fixture controls"
      >
        <Button
          onClick={() => {
            finishSave?.()
          }}
        >
          Finish save
        </Button>
        <Button
          onClick={() => {
            rejectCopy = true
          }}
        >
          Reject next copy
        </Button>
        <Button
          onClick={() => {
            rejectCopy = false
          }}
        >
          Allow copy
        </Button>
        <Button onClick={() => setDialog(true)}>Open confirmation</Button>
        <Button
          onClick={() =>
            useUpdateStore.setState({
              status: { state: 'downloading', current: '0.29.0', latest: '0.30.0', progress: 42 }
            })
          }
        >
          Download progress
        </Button>
      </div>
      <output data-testid="confirm-count">{confirmed}</output>
      <ConfirmActionDialog
        open={dialog}
        title="Confirm action"
        description="Keep focus while the real dialog button changes phase."
        cancelLabel="Cancel"
        confirmLabel="Confirm"
        loadingLabel="Working…"
        loading={confirming}
        onCancel={() => setDialog(false)}
        onConfirm={() => {
          setConfirming(true)
          setConfirmed((n) => n + 1)
        }}
      />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  params.has('home') ? (
    <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={() => {}} />
  ) : (
    <Fixture />
  )
)
