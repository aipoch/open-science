import { LocalNarrationControl } from '@/components/local-narration-control'
import { LocalOcrControl } from '@/components/local-ocr-control'
import type { ModelView } from '../../lib/settings-navigation'
import { ClassificationPanel } from './ClassificationPanel'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import * as AlertDialog from '@/components/ui/alert-dialog'
import { Tabs } from 'radix-ui'
import { Brain, Cpu, Download, Table2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import {
  localModelDownloadProgress,
  type LocalModelSnapshot
} from '../../../../shared/local-models'
import { SettingsSection } from './SettingsLayout'

const size = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

const LocalModelsPanel = (): React.JSX.Element => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot>()
  const [requestFailed, setRequestFailed] = useState(false)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let installing = false
      try {
        const next = await window.api.localModels.getSnapshot()
        installing = next.availability === 'installing'
        if (live) {
          setSnapshot(next)
          setRequestFailed(false)
        }
      } catch {
        if (live) setRequestFailed(true)
      }
      if (live) timer = setTimeout(() => void poll(), installing ? 750 : 2500)
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [])
  const run = async (action: 'install' | 'cancel' | 'remove'): Promise<void> => {
    setPending(true)
    setRequestFailed(false)
    try {
      setSnapshot(await window.api.localModels[action]())
    } catch {
      setRequestFailed(true)
    } finally {
      setPending(false)
    }
  }
  const installing = snapshot?.availability === 'installing'
  const error = snapshot?.error
  const errorDescription = requestFailed
    ? t('Could not access local models. Open the local app and try again.')
    : error === 'incompatible'
      ? t('These model files belong to an unsupported version. Update the app to manage them.')
      : error === 'integrity'
        ? t('Model verification failed. Retry to download a complete copy.')
        : error === 'storage'
          ? t('Model files could not be accessed. Check the data folder and available space.')
          : t('Model download failed. Retry to resume when supported by the server.')
  const status = installing
    ? t('Downloading…')
    : snapshot?.installedRevision
      ? snapshot.updateAvailable
        ? t('Update available')
        : t('Installed')
      : error
        ? t('Download failed')
        : t('Not installed')
  const actionControls = snapshot ? (
    <div className="col-start-2 row-start-1 ml-auto flex shrink-0 items-center gap-3">
      <span className="text-xs text-muted-foreground">
        {size(snapshot.installedRevision ? snapshot.installedBytes : snapshot.downloadBytes)}
      </span>
      <div className="flex items-center gap-2">
        {installing ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void run('cancel')}>
            {t('Cancel download')}
          </Button>
        ) : (
          <>
            {snapshot.hasFiles ? (
              <AlertDialog.Root>
                <AlertDialog.Trigger asChild>
                  <Button size="sm" variant="outline" disabled={pending || snapshot.inUse}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    {t('Uninstall')}
                  </Button>
                </AlertDialog.Trigger>
                <AlertDialog.Portal>
                  <AlertDialog.Overlay className={dialogOverlayClassName} />
                  <AlertDialog.Content
                    className={dialogPanelClassName('w-[calc(100%-2rem)] max-w-lg p-0')}
                  >
                    <div className={dialogHeaderClassName}>
                      <div>
                        <AlertDialog.Title className={dialogTitleClassName}>
                          {t('Remove local model files?')}
                        </AlertDialog.Title>
                        <AlertDialog.Description className={dialogDescriptionClassName}>
                          {t(
                            'Source documents and existing parsing results are kept. New parsing tasks may require reinstalling the model.'
                          )}
                        </AlertDialog.Description>
                      </div>
                    </div>
                    <div className={dialogFooterClassName}>
                      <AlertDialog.Cancel asChild>
                        <Button variant="ghost">{t('Cancel')}</Button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action asChild>
                        <Button
                          variant="destructive"
                          disabled={pending || snapshot.inUse}
                          onClick={() => void run('remove')}
                        >
                          {t('Remove')}
                        </Button>
                      </AlertDialog.Action>
                    </div>
                  </AlertDialog.Content>
                </AlertDialog.Portal>
              </AlertDialog.Root>
            ) : null}
            {!snapshot.installedRevision || snapshot.updateAvailable || error ? (
              <Button
                size="sm"
                disabled={pending || error === 'incompatible' || requestFailed}
                onClick={() => void run('install')}
              >
                <Download className="size-4" aria-hidden="true" />
                {error ? t('Retry') : snapshot.updateAvailable ? t('Update') : t('Install')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  ) : null
  return (
    <div className="space-y-4 p-5">
      <SettingsSection title={t('Local capabilities')} contentClassName="space-y-3">
        {requestFailed || error ? (
          <div className="mb-4">
            <ErrorNotice
              title={t('Local models need attention')}
              description={errorDescription}
              tone={error === 'integrity' || error === 'incompatible' ? 'red' : 'amber'}
            />
          </div>
        ) : null}
        {!snapshot ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('Loading…')}
          </p>
        ) : (
          <div data-slot="local-model-card" className="rounded-xl border border-border bg-card p-4">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
              <div className="flex min-w-0 items-start gap-3">
                <Table2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{t('PDF figures and tables')}</h3>
                    <span
                      role="status"
                      className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {status}
                    </span>
                  </div>
                </div>
              </div>
              <div className="col-span-2 row-start-2 mt-4 space-y-2 border-t border-border pt-3">
                <p className="text-[13px] text-muted-foreground">
                  {t('Find candidate figures, captions and copyable tables in Literature PDFs.')}
                </p>
                <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">{t('Model source')}</dt>
                    <dd>
                      <ExternalTextLink href="https://github.com/microsoft/table-transformer">
                        {'microsoft/table-transformer'}
                      </ExternalTextLink>
                    </dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">
                      {snapshot.installedRevision ? t('Installed version') : t('Version')}
                    </dt>
                    <dd className="break-all">
                      {snapshot.installedRevision ?? snapshot.recommendedRevision}
                    </dd>
                  </div>
                  {snapshot.installedRevision && snapshot.updateAvailable ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        <dt className="text-muted-foreground">{t('New version')}</dt>
                        <dd className="break-all">{snapshot.recommendedRevision}</dd>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <dt className="text-muted-foreground">{t('Download size')}</dt>
                        <dd>{size(snapshot.downloadBytes)}</dd>
                      </div>
                    </>
                  ) : null}
                </dl>
                {installing ? (
                  <div className="space-y-2">
                    <DownloadProgressLine progress={localModelDownloadProgress(snapshot)} />
                    {snapshot.installedRevision ? (
                      <p className="text-xs text-muted-foreground">
                        {t('The installed version remains available while the update downloads.')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {snapshot.inUse ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    {t('Model in use. Removal is available when parsing finishes.')}
                  </p>
                ) : null}
              </div>
              {actionControls}
            </div>
          </div>
        )}
        <LocalOcrControl />
        <LocalNarrationControl />
      </SettingsSection>
    </div>
  )
}

export type { ModelView } from '../../lib/settings-navigation'

export const ModelPanel = ({
  local,
  view,
  navigate,
  onChange,
  children
}: {
  local: boolean
  view?: ModelView
  navigate?: (view: ModelView) => void
  onChange(local: boolean): void
  children: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const classification = view?.kind.startsWith('classification') ?? false
  const indicatorId = useId()
  const reduceMotion = useReducedMotion()
  const indicator = (
    <motion.span
      aria-hidden="true"
      layoutId={indicatorId}
      initial={false}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="pointer-events-none absolute inset-x-0 -bottom-0.5 h-0.5 bg-primary"
    />
  )
  const tabClass =
    'relative flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap border-b-2 sm:flex-none sm:justify-start border-transparent px-1 py-3 text-xs text-muted-foreground data-[state=active]:font-semibold data-[state=active]:text-primary focus-visible:outline-ring'
  if (
    view &&
    navigate &&
    (view.kind === 'classification-create' || view.kind === 'classification-edit')
  )
    return <ClassificationPanel view={view} navigate={navigate} />
  return (
    <Tabs.Root
      value={classification ? 'classification' : local ? 'local' : 'agent'}
      onValueChange={(value) =>
        value === 'classification'
          ? navigate?.({ kind: 'classification' })
          : onChange(value === 'local')
      }
    >
      <Tabs.List
        aria-label={t('Models')}
        className="flex gap-3 border-b border-border px-3 sm:gap-6 sm:px-5"
      >
        <Tabs.Trigger value="agent" className={tabClass}>
          <Brain className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
          <span className="truncate">{t('Conversation models')}</span>
          {!local && !classification && indicator}
        </Tabs.Trigger>
        {navigate && (
          <Tabs.Trigger value="classification" className={tabClass}>
            <Table2 className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
            <span className="truncate">{t('Classification models')}</span>
            {classification && indicator}
          </Tabs.Trigger>
        )}
        <Tabs.Trigger value="local" className={tabClass}>
          <Cpu className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
          <span className="truncate">{t('Local capabilities')}</span>
          {local && indicator}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="agent" tabIndex={-1}>
        {children}
      </Tabs.Content>
      <Tabs.Content value="classification" tabIndex={-1}>
        {navigate && <ClassificationPanel view={{ kind: 'classification' }} navigate={navigate} />}
      </Tabs.Content>
      <Tabs.Content value="local" tabIndex={-1}>
        <LocalModelsPanel />
      </Tabs.Content>
    </Tabs.Root>
  )
}
