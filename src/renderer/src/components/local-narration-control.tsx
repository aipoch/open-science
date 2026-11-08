import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioLines, Download, Trash2 } from 'lucide-react'
import type { LocalModelSnapshot } from '../../../shared/local-models'
import { localModelDownloadProgress } from '../../../shared/local-models'
import { Button } from './ui/button'
import { ErrorNotice } from './error-notice'
import { DownloadProgressLine } from './DownloadProgressLine'

const size = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export function LocalNarrationControl(): React.JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot>()
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const mutationRevision = useRef(0)
  const mutationPending = useRef(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let installing = false
      const revision = mutationRevision.current
      try {
        const next = await window.api.localModels.getSnapshot('research-narration')
        installing = next.availability === 'installing'
        if (live && !mutationPending.current && revision === mutationRevision.current) {
          setSnapshot(next)
          setFailed(false)
        }
      } catch {
        if (live && !mutationPending.current && revision === mutationRevision.current)
          setFailed(true)
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
    if (mutationPending.current) return
    mutationPending.current = true
    mutationRevision.current += 1
    setPending(true)
    try {
      setSnapshot(await window.api.localModels[action]('research-narration'))
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      mutationRevision.current += 1
      mutationPending.current = false
      setPending(false)
    }
  }
  const installed = snapshot?.availability === 'ready'
  const installing = snapshot?.availability === 'installing'
  return (
    <div
      data-slot="local-model-card"
      className="space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <AudioLines className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="text-sm font-semibold">{t('Research narration')}</span>
          {snapshot && (
            <span
              role="status"
              className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {installing ? t('Downloading…') : installed ? t('Installed') : t('Not installed')}
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {snapshot && (
            <span>{size(installed ? snapshot.installedBytes : snapshot.downloadBytes)}</span>
          )}
          {installing ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void run('cancel')}
            >
              {t('Cancel download')}
            </Button>
          ) : installed && !snapshot?.error && !snapshot?.updateAvailable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || snapshot.inUse}
              onClick={() => void run('remove')}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t('Uninstall')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={
                pending ||
                !snapshot ||
                failed ||
                snapshot.error === 'incompatible' ||
                snapshot.inUse
              }
              onClick={() => void run('install')}
            >
              <Download className="size-4" aria-hidden="true" />
              {snapshot?.error
                ? t('Retry')
                : snapshot?.updateAvailable
                  ? t('Update')
                  : t('Install')}
            </Button>
          )}
        </div>
      </div>
      {installing && snapshot && (
        <div className="border-t border-border pt-4">
          <DownloadProgressLine progress={localModelDownloadProgress(snapshot)} />
        </div>
      )}
      <p className="border-t border-border pt-4 text-sm text-muted-foreground">
        {t('English narration. Downloads the speech engine and model only when installed.')}
      </p>
      {failed || snapshot?.error ? (
        <ErrorNotice
          inline
          tone="amber"
          description={
            failed
              ? t('Could not access local models. Open the local app and try again.')
              : snapshot?.error === 'integrity'
                ? t('Model verification failed. Retry to download a complete copy.')
                : snapshot?.error === 'incompatible'
                  ? t(
                      'These model files belong to an unsupported version. Update the app to manage them.'
                    )
                  : snapshot?.error === 'storage'
                    ? t(
                        'Model files could not be accessed. Check the data folder and available space.'
                      )
                    : t('Model download failed. Retry to resume when supported by the server.')
          }
        />
      ) : null}
    </div>
  )
}
