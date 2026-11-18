import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type PptxSlideNoteEditorProps = {
  onSubmit: (note: string) => void
  onCancel: () => void
}

const PptxSlideNoteEditor = ({
  onSubmit,
  onCancel
}: PptxSlideNoteEditorProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  return (
    <div
      data-testid="pptx-slide-note-editor"
      className="pointer-events-auto absolute inset-x-3 bottom-3 z-30 flex flex-col gap-2 rounded-lg border border-border-300 bg-bg-000 p-3 shadow-lg"
    >
      <Textarea
        autoFocus
        aria-label={t('Annotation note')}
        maxLength={2_000}
        placeholder={t('Add context for the Agent')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="button" size="sm" disabled={!note.trim()} onClick={() => onSubmit(note)}>
          {t('Add annotation')}
        </Button>
      </div>
    </div>
  )
}

export { PptxSlideNoteEditor }
