import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { PptxOperation, PptxParagraph } from '../../../../../shared/pptx-edit'
import { PptxRichTextEditor } from './PptxRichTextEditor'
import { PptxTextFieldsEditor, type PptxTextField } from './PptxTextFieldsEditor'

type FieldChange = { id: string; value: string }

// Each editor carries the operations its edit becomes, so the surface only has to apply them.
type PptxShapeEditorState =
  | {
      kind: 'text'
      label: string
      value: string
      paragraphs?: PptxParagraph[]
      toOperations: (value: string, paragraphs?: PptxParagraph[]) => PptxOperation[]
    }
  | {
      kind: 'fields'
      title: string
      fields: readonly PptxTextField[]
      columns?: number
      notice?: string
      toOperations: (changed: readonly FieldChange[]) => PptxOperation[]
    }

type PptxShapeEditorProps = {
  editor: PptxShapeEditorState
  onApply: (operations: PptxOperation[]) => void
  onCancel: () => void
}

const TextEditor = ({
  editor,
  onApply,
  onCancel
}: PptxShapeEditorProps & { editor: { kind: 'text' } }): React.JSX.Element => {
  const { t } = useTranslation()
  const [value, setValue] = useState(editor.value)
  return (
    <div className="absolute inset-x-4 bottom-4 z-30 flex flex-col gap-2 rounded-lg border border-border-300 bg-bg-000 p-3 shadow-lg">
      <textarea
        autoFocus
        aria-label={editor.label}
        className="min-h-20 resize-none rounded-md border border-border-300 bg-bg-000 p-2 text-sm text-text-000 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="button" size="sm" onClick={() => onApply(editor.toOperations(value))}>
          {t('Apply')}
        </Button>
      </div>
    </div>
  )
}

const PptxShapeEditor = ({ editor, onApply, onCancel }: PptxShapeEditorProps): React.JSX.Element =>
  editor.kind === 'text' && editor.paragraphs ? (
    <PptxRichTextEditor
      label={editor.label}
      initial={editor.paragraphs}
      onApply={(value, paragraphs) => onApply(editor.toOperations(value, paragraphs))}
      onCancel={onCancel}
    />
  ) : editor.kind === 'text' ? (
    <TextEditor editor={editor} onApply={onApply} onCancel={onCancel} />
  ) : (
    <PptxTextFieldsEditor
      title={editor.title}
      fields={editor.fields}
      columns={editor.columns}
      notice={editor.notice}
      onApply={(changed) => onApply(editor.toOperations(changed))}
      onCancel={onCancel}
    />
  )

export { PptxShapeEditor }
export type { PptxShapeEditorProps, PptxShapeEditorState }
