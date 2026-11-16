import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

type PptxTextField = { id: string; label: string; value: string }

type PptxTextFieldsEditorProps = {
  title: string
  fields: readonly PptxTextField[]
  // Table cells lay out as a grid; chart labels stack with their visible label.
  columns?: number
  notice?: string
  onApply: (changed: readonly { id: string; value: string }[]) => void
  onCancel: () => void
}

const PptxTextFieldsEditor = ({
  title,
  fields,
  columns,
  notice,
  onApply,
  onCancel
}: PptxTextFieldsEditorProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})
  const changed = fields.flatMap((field) => {
    const value = values[field.id]
    return value !== undefined && value !== field.value ? [{ id: field.id, value }] : []
  })
  const inputClass =
    'min-w-0 rounded-md border border-border-300 bg-bg-000 px-2 py-1 text-xs text-text-000 outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute inset-x-4 bottom-4 z-30 flex max-h-[60%] flex-col gap-2 rounded-lg border border-border-300 bg-bg-000 p-3 shadow-lg"
    >
      <div className="text-xs font-medium text-text-100">{title}</div>
      {notice ? <p className="text-xs text-text-300">{notice}</p> : null}
      <div
        className={columns ? 'grid gap-1 overflow-auto' : 'flex flex-col gap-2 overflow-auto'}
        style={
          columns ? { gridTemplateColumns: `repeat(${columns}, minmax(6rem, 1fr))` } : undefined
        }
      >
        {fields.map((field) => {
          const input = (
            <input
              key={field.id}
              aria-label={field.label}
              className={inputClass}
              value={values[field.id] ?? field.value}
              onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
            />
          )
          return columns ? (
            input
          ) : (
            <label key={field.id} className="flex flex-col gap-1 text-xs text-text-300">
              {field.label}
              {input}
            </label>
          )
        })}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={changed.length === 0}
          onClick={() => onApply(changed)}
        >
          {t('Apply')}
        </Button>
      </div>
    </div>
  )
}

export { PptxTextFieldsEditor }
export type { PptxTextField, PptxTextFieldsEditorProps }
