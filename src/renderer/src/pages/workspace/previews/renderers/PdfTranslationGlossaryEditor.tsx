import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PdfTranslationGlossary } from '../../../../../../shared/pdf-translation'
import { glossaryError } from './pdf-translation-glossary'

export function PdfTranslationGlossaryEditor({
  value,
  onChange,
  disabled
}: {
  value: PdfTranslationGlossary
  onChange: (value: PdfTranslationGlossary) => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const errorId = useId()
  const error = glossaryError(value, t)
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 w-full space-y-2"
      aria-label={t('Translation glossary')}
    >
      {value.length ? (
        <div className="max-h-48 space-y-2 overflow-y-auto">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.75rem] gap-2 text-xs text-muted-foreground">
            <span>{t('Source term')}</span>
            <span>{t('Preferred translation')}</span>
          </div>
          {value.map((entry, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.75rem] items-center gap-2"
            >
              <Input
                aria-label={t('Source term {{number}}', { number: index + 1 })}
                aria-describedby={error ? errorId : undefined}
                value={entry.source}
                maxLength={1000}
                className="min-w-0"
                onChange={(event) =>
                  onChange(
                    value.map((item, i) =>
                      i === index ? { ...item, source: event.target.value } : item
                    )
                  )
                }
              />
              <Input
                aria-label={t('Preferred translation {{number}}', { number: index + 1 })}
                aria-describedby={error ? errorId : undefined}
                value={entry.target}
                maxLength={1000}
                className="min-w-0"
                onChange={(event) =>
                  onChange(
                    value.map((item, i) =>
                      i === index ? { ...item, target: event.target.value } : item
                    )
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('Remove glossary term {{number}}', { number: index + 1 })}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || value.length >= 1000}
        onClick={() => onChange([...value, { source: '', target: '' }])}
      >
        <Plus aria-hidden="true" className="size-3.5" />
        {t('Add term')}
      </Button>
      {error ? (
        <p id={errorId} role="status" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}
