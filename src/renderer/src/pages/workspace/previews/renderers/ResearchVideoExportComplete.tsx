import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { WorkflowDialogFrame } from '@/components/ui/workflow-dialog-frame'
import { dialogBodyClassName, dialogFooterClassName } from '@/components/ui/dialog-chrome'

export function ResearchVideoExportComplete({
  filePath,
  resolution,
  onClose,
  onRestoreFocus
}: {
  filePath: string
  resolution: string
  onClose: () => void
  onRestoreFocus: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const open = async (action: 'play' | 'reveal'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      if (action === 'reveal') await window.api.localFs.reveal(filePath)
      else {
        const message = await window.api.localFs.openPath(filePath)
        if (message) throw new Error(message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <WorkflowDialogFrame
      title={t('Video ready')}
      description={t('Your {{resolution}} video has been saved.', { resolution })}
      className="w-[min(560px,calc(100vw-2rem))]"
      busy={busy}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        onRestoreFocus()
      }}
      footer={
        <div className={dialogFooterClassName}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('Done')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void open('reveal')}>
            <FolderOpen aria-hidden="true" />
            {t('Show in folder')}
          </Button>
          <Button disabled={busy} onClick={() => void open('play')}>
            <Play aria-hidden="true" />
            {t('Play video')}
          </Button>
        </div>
      }
    >
      <div className={dialogBodyClassName}>
        <p className="break-all text-sm text-muted-foreground">{filePath}</p>
        {error && <ErrorNotice inline tone="amber" description={error} />}
      </div>
    </WorkflowDialogFrame>
  )
}
