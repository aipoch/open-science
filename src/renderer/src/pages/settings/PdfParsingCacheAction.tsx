import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertDialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'

export const PdfParsingCacheAction = (): React.JSX.Element => {
  const { t } = useTranslation()
  const [clearStatus, setClearStatus] = useState<string>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(false)
    setClearStatus(undefined)
    try {
      const report = await window.api.pdfStructure.clearCache()
      // Storage owns scan failures; successful cleanup must still be reported as successful.
      await useStorageInfoStore
        .getState()
        .refresh()
        .catch(() => undefined)
      setClearStatus(
        report.retainedEntries
          ? t('Some unrecognized files were retained.')
          : t('PDF parsing results cleared.')
      )
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <AlertDialog.Root>
        <AlertDialog.Trigger asChild>
          <Button size="sm" variant="outline" disabled={busy}>
            {t('Clear all PDF parsing results')}
          </Button>
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content className={dialogPanelClassName('max-w-lg p-0')}>
            <div className={dialogHeaderClassName}>
              <div>
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Clear all PDF parsing results?')}
                </AlertDialog.Title>
                <AlertDialog.Description className={dialogDescriptionClassName}>
                  {t(
                    'This stops active extraction and removes cached results for all PDFs. Source documents and installed models are kept.'
                  )}
                </AlertDialog.Description>
              </div>
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button variant="ghost">{t('Cancel')}</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant="destructive" onClick={() => void clear()}>
                  {t('Clear')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <p role="status" className="text-xs text-muted-foreground">
        {clearStatus}
      </p>
      {error ? <ErrorNotice title={t('PDF extraction is unavailable')} tone="amber" /> : null}
    </div>
  )
}
