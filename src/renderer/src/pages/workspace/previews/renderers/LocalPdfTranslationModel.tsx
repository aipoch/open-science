import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import { ErrorNotice } from '@/components/error-notice'
import { localModelDownloadProgress } from '../../../../../../shared/local-models'
import type { useLocalPdfTranslationModel } from './use-pdf-translation-agent'
import { PdfTranslationActionHint } from './PdfTranslationActionHint'

const modelName = 'qwen3-0.6b-q8'
const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`

export function LocalPdfTranslationModel({
  model,
  running = false
}: {
  model: ReturnType<typeof useLocalPdfTranslationModel>
  running?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { snapshot, requestFailed, pending, run } = model
  const installing = snapshot?.availability === 'installing'
  const ready = snapshot?.availability === 'ready'
  const busy = running || snapshot?.inUse
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
  const actionReason = pending
    ? t('Please wait…')
    : busy
      ? t('Wait for the current translation to finish or cancel it.')
      : error === 'incompatible'
        ? errorDescription
        : undefined
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-background/70 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{modelName}</span>
        <span role="status" className="text-muted-foreground">
          {installing
            ? t('Downloading…')
            : ready
              ? t('Installed')
              : !snapshot
                ? t('Loading…')
                : t('Not installed')}
        </span>
      </div>
      <p className="text-muted-foreground">
        {t('Runs on this computer after installation. Document text stays local.')}
      </p>
      {snapshot && !ready ? (
        <p className="text-muted-foreground">
          {t('Download size')}: {formatBytes(snapshot.downloadBytes)}
        </p>
      ) : null}
      {requestFailed || error ? (
        <ErrorNotice
          inline
          tone="amber"
          title={t('Local models need attention')}
          description={errorDescription}
        />
      ) : null}
      {installing && snapshot ? (
        <DownloadProgressLine progress={localModelDownloadProgress(snapshot)} />
      ) : null}
      {snapshot ? (
        <div className="flex flex-wrap gap-2">
          {installing ? (
            <PdfTranslationActionHint reason={pending ? t('Please wait…') : undefined}>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void run('cancel')}
              >
                {t('Cancel download')}
              </Button>
            </PdfTranslationActionHint>
          ) : (
            <>
              {!ready || snapshot.updateAvailable ? (
                <PdfTranslationActionHint reason={actionReason}>
                  <Button
                    size="sm"
                    disabled={Boolean(actionReason)}
                    onClick={() => void run('install')}
                  >
                    {error ? t('Retry') : snapshot.updateAvailable ? t('Update') : t('Install')}
                  </Button>
                </PdfTranslationActionHint>
              ) : null}
              {snapshot.hasFiles ? (
                <PdfTranslationActionHint reason={actionReason}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(actionReason)}
                    onClick={() => void run('remove')}
                  >
                    {t('Uninstall')}
                  </Button>
                </PdfTranslationActionHint>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
