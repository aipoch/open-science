import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScanText } from 'lucide-react'
import type { LocalModelSnapshot } from '../../../shared/local-models'
import { localModelDownloadProgress } from '../../../shared/local-models'
import { Button } from './ui/button'
import { ErrorNotice } from './error-notice'
import { DownloadProgressLine } from './DownloadProgressLine'

const size = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export function LocalOcrControl({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot>()
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [installedHere, setInstalledHere] = useState(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let installing = false
      try {
        const next = await window.api.localModels.getSnapshot('ocr')
        installing = next.availability === 'installing'
        if (live) {
          setSnapshot(next)
          setFailed(false)
        }
      } catch {
        if (live) setFailed(true)
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
    try {
      setSnapshot(await window.api.localModels[action]('ocr'))
      setFailed(false)
      if (action === 'install') setInstalledHere(true)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  const installed = snapshot?.availability === 'ready'
  const installing = snapshot?.availability === 'installing'
  if (compact && ((!snapshot && !failed) || (installed && !installedHere && !snapshot?.error)))
    return null
  return (
    <div
      className={compact ? 'space-y-2' : 'space-y-3 rounded-lg border border-border bg-card p-4'}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <ScanText className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium">{t('Text recognition (OCR)')}</span>
          {!compact && (
            <span className="text-xs text-muted-foreground">
              {t('English and Simplified Chinese')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {snapshot && !compact && (
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
            compact ? (
              <span role="status">{t('OCR installed. Read the PDF again.')}</span>
            ) : (
              <>
                <span role="status">{t('Installed')}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || snapshot.inUse}
                  onClick={() => void run('remove')}
                >
                  {t('Uninstall')}
                </Button>
              </>
            )
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
        <DownloadProgressLine progress={localModelDownloadProgress(snapshot)} />
      )}
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
