import { memo, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { JournalAttributeValue } from './JournalAttributes'
import { LiteratureTextTooltip } from './LiteratureTable'
import type { JournalDataset, JournalResult } from '../../../../shared/journal-attributes'

type Entry = NonNullable<JournalResult['entries']>[number]
type Draft = Pick<Entry, 'id' | 'values'>

export const JournalEntryRow = memo(function JournalEntryRow({
  entry,
  number,
  dataset,
  showIssn,
  showExternalIds,
  draft,
  disabled,
  busy,
  saveDisabled = false,
  onDraft,
  onSave
}: {
  entry: Entry
  number: number
  dataset: JournalDataset
  showIssn: boolean
  showExternalIds: boolean
  draft?: Draft
  disabled: boolean
  busy: boolean
  saveDisabled?: boolean
  onDraft: Dispatch<SetStateAction<Draft | undefined>>
  onSave?: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <tr
      className={
        draft?.id === entry.id
          ? 'group h-16 bg-[color-mix(in_oklab,var(--primary)_5%,var(--bg-000))] focus-within:bg-[color-mix(in_oklab,var(--primary)_10%,var(--bg-000))]'
          : 'group h-16 bg-bg-000 hover:bg-bg-200 focus-within:bg-bg-200'
      }
    >
      <td
        data-row-number={number}
        className="px-2 py-2 text-center align-middle text-xs tabular-nums text-muted-foreground"
      >
        {number}
      </td>
      <td className="px-3 py-2 align-middle">
        <LiteratureTextTooltip overflowOnly text={entry.name}>
          <span className="block truncate text-sm font-medium text-foreground">
            {entry.name || '—'}
          </span>
        </LiteratureTextTooltip>
      </td>
      {showIssn ? (
        <td className="px-3 py-2 align-middle">
          <LiteratureTextTooltip overflowOnly text={entry.issns.join(', ')}>
            <span className="block truncate">{entry.issns.join(', ') || '—'}</span>
          </LiteratureTextTooltip>
        </td>
      ) : null}
      {showExternalIds ? (
        <td className="px-3 py-2 align-middle">
          {(() => {
            const externalIds = (entry.externalIds ?? [])
              .map(({ namespace, value }) => `${namespace}:${value}`)
              .join(', ')
            return (
              <LiteratureTextTooltip overflowOnly text={externalIds}>
                <span className="block truncate">{externalIds || '—'}</span>
              </LiteratureTextTooltip>
            )
          })()}
        </td>
      ) : null}
      {dataset.fields
        .filter(({ visible }) => visible)
        .map((field) => {
          const value = entry.values[field.id] ?? '—'
          return (
            <td className="px-3 py-2 align-middle" key={field.id}>
              {draft?.id === entry.id ? (
                <Input
                  aria-label={`${field.label}: ${entry.name}`}
                  className="h-8 min-w-0"
                  value={draft.values[field.id] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    onDraft((draft) =>
                      draft && draft.id === entry.id
                        ? {
                            ...draft,
                            values: {
                              ...draft.values,
                              [field.id]: event.target.value
                            }
                          }
                        : draft
                    )
                  }
                />
              ) : (
                <LiteratureTextTooltip overflowOnly text={value}>
                  <span className="block max-w-full overflow-hidden truncate">
                    <JournalAttributeValue
                      attribute={{
                        ...field,
                        key: field.id,
                        value,
                        source: dataset.source,
                        year: dataset.year
                      }}
                    />
                  </span>
                </LiteratureTextTooltip>
              )}
            </td>
          )
        })}
      <td className="sticky right-0 z-20 w-20 min-w-20 max-w-20 border-l border-transparent bg-inherit group-data-[overflow-right=true]/journal-scroll:border-border-300/60 px-2 py-2 align-middle before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-linear-to-l before:from-foreground/5 before:to-transparent before:opacity-0 group-data-[overflow-right=true]/journal-scroll:before:opacity-100">
        {draft?.id === entry.id ? (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('Save journal row')}
              disabled={busy || saveDisabled}
              onClick={() => void onSave?.()}
            >
              <Check className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('Cancel editing journal row')}
              disabled={busy}
              onClick={() => onDraft(undefined)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('Edit journal attributes')}
            disabled={disabled}
            onClick={() => onDraft({ id: entry.id, values: entry.values })}
          >
            <Pencil className="size-4" aria-hidden="true" />
          </Button>
        )}
      </td>
    </tr>
  )
})
