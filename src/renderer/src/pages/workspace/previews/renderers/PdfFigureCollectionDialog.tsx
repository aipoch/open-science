import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { WorkflowDialogFrame } from '@/components/ui/workflow-dialog-frame'
import type { AcpMessageImage } from '../../../../../../shared/acp-image-contract'
import { PDF_FIGURE_LIMITS } from '../../../../../../shared/pdf-annotations'
import { TagSelection } from '../../../settings/ResourceTagControls'

export type PdfFigureCollectionDraft = {
  figureNumber: string
  caption: string
  tagIds: string[]
  note: string
  image: AcpMessageImage
}

export function PdfFigureCollectionDialog({
  capture,
  onSave,
  onClose,
  onRestoreFocus
}: {
  capture: () => AcpMessageImage | undefined
  onSave: (draft: PdfFigureCollectionDraft) => Promise<unknown>
  onClose: () => void
  onRestoreFocus?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const captureImage = (): AcpMessageImage | undefined => {
    try {
      return capture()
    } catch {
      return undefined
    }
  }
  const [image, setImage] = useState(captureImage)
  const [figureNumber, setFigureNumber] = useState('')
  const [caption, setCaption] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const savingRef = useRef(false)

  const save = async (): Promise<void> => {
    if (!image || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setFailed(false)
    try {
      await onSave({
        image,
        figureNumber: figureNumber.trim(),
        caption: caption.trim(),
        tagIds,
        note: note.trim()
      })
      onClose()
    } catch {
      setFailed(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <WorkflowDialogFrame
      title={t('Save to figure collection')}
      busy={saving}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        if (!onRestoreFocus) return
        event.preventDefault()
        onRestoreFocus()
      }}
      className="w-[min(560px,calc(100vw-2rem))]"
      footer={
        <div className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={saving || !image} onClick={() => void save()}>
            {saving ? t('Saving…') : t('Save')}
          </Button>
        </div>
      }
    >
      <div data-pdf-figure-collection-editor className="min-h-0 space-y-4 overflow-y-auto p-5">
        {image ? (
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={t('Selected PDF area')}
            className="max-h-64 w-full rounded-md border border-border object-contain"
          />
        ) : (
          <ErrorNotice
            inline
            role="alert"
            title={t('The selected area could not be captured.')}
            primaryButton={{ label: t('Retry'), onClick: () => setImage(captureImage()) }}
          />
        )}
        <div className="space-y-1.5">
          <label htmlFor={`${id}-number`} className="text-sm font-medium">
            {t('Figure number')}
          </label>
          <Input
            id={`${id}-number`}
            value={figureNumber}
            maxLength={PDF_FIGURE_LIMITS.figureNumber}
            disabled={saving}
            onChange={(event) => setFigureNumber(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-caption`} className="text-sm font-medium">
            {t('Caption')}
          </label>
          <Textarea
            id={`${id}-caption`}
            value={caption}
            maxLength={PDF_FIGURE_LIMITS.caption}
            disabled={saving}
            onChange={(event) => setCaption(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-sm font-medium">{t('Tags')}</div>
          <TagSelection value={tagIds} onChange={setTagIds} disabled={saving} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-note`} className="text-sm font-medium">
            {t('Note (optional)')}
          </label>
          <Textarea
            id={`${id}-note`}
            value={note}
            maxLength={20_000}
            disabled={saving}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {failed ? (
          <ErrorNotice inline role="alert" title={t('Figure could not be saved. Try again.')} />
        ) : null}
      </div>
    </WorkflowDialogFrame>
  )
}
