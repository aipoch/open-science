/* Hallmark · component: merge review · theme: Open-Science · P5 H5 E4 S5 R5 V4 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  LiteratureItemInput,
  LiteratureItemType,
  LiteratureItemView
} from '../../../../shared/literature'
import {
  literatureMergeRows,
  buildLiteratureMergeItem,
  mergeFieldSource,
  mergeValueKey,
  type LiteratureMergeField,
  type mergeScalarFields
} from './literature-merge'

export function LiteratureMergeReview({
  entries,
  survivorId,
  onSurvivorChange,
  sources,
  onSourceChange,
  fieldLabel,
  creatorLabel,
  itemTypeLabels,
  disabled
}: {
  entries: LiteratureItemView[]
  survivorId: string
  onSurvivorChange: (id: string) => void
  sources: Record<string, string>
  onSourceChange: (field: string, id: string) => void
  fieldLabel: (field: (typeof mergeScalarFields)[number]) => string
  creatorLabel: (item: LiteratureItemInput) => string
  itemTypeLabels: Record<LiteratureItemType, string>
  disabled: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const rows = literatureMergeRows(entries)
  const merged = entries.some(({ id }) => id === survivorId)
    ? buildLiteratureMergeItem(entries, survivorId, sources)
    : undefined
  const differences = rows.filter(({ different }) => different)
  const date = (value: number): string =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(value)
  const typeFieldLabels: Record<string, string> = {
    volume: t('Volume'),
    issue: t('Issue'),
    pages: t('Pages'),
    publisher: t('Publisher'),
    edition: t('Edition'),
    place: t('Place'),
    series: t('Series'),
    isbn: t('ISBN'),
    issn: t('ISSN')
  }
  const label = (field: LiteratureMergeField): string => {
    if (field === 'creators') return t('Authors')
    if (field === 'itemType') return t('Reference type')
    if (field.startsWith('identifier:')) return field.slice(11).toUpperCase()
    if (field.startsWith('type:')) return typeFieldLabels[field.slice(5)] ?? field.slice(5)
    return fieldLabel(field as (typeof mergeScalarFields)[number])
  }
  const display = (
    field: LiteratureMergeField,
    value: unknown,
    entry: LiteratureItemView
  ): string => {
    if (!mergeValueKey(value)) return t('Not provided')
    if (field === 'creators')
      return entry.item.creators
        .map((creator) => {
          const name = creatorLabel({ ...entry.item, creators: [creator] })
          const role =
            creator.creatorType === 'editor'
              ? t('Editor')
              : creator.creatorType === 'translator'
                ? t('Translator')
                : creator.creatorType
          return creator.creatorType === 'author' ? name : `${name} (${role})`
        })
        .join('; ')
    if (field === 'itemType') return itemTypeLabels[entry.item.itemType]
    if (field === 'accessedAt') return date(Number(value))
    if (Array.isArray(value)) return value.join('\n')
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  const summary = t(
    'Attachments: {{attachments}} · Collections: {{collections}} · Projects: {{projects}}',
    {
      attachments: new Set(entries.flatMap((entry) => entry.attachments.map(({ id }) => id))).size,
      collections: new Set(entries.flatMap((entry) => entry.collectionIds)).size,
      projects: new Set(entries.flatMap((entry) => entry.projectIds)).size
    }
  )
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('Keep reference')}</h3>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showAll}
          disabled={disabled}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? t('Show differences only') : t('Show all fields')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table
          className="w-full table-fixed text-sm"
          style={entries.length > 3 ? { minWidth: entries.length * 220 } : undefined}
        >
          <caption className="sr-only">{t('Compare references')}</caption>
          <thead>
            <tr>
              {entries.map((entry, index) => (
                <th
                  key={entry.id}
                  scope="col"
                  className={cn(
                    'border-r border-border p-3 text-left align-top font-normal last:border-r-0',
                    survivorId === entry.id && 'bg-primary/5'
                  )}
                >
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 font-medium">
                    <input
                      type="radio"
                      name="literature-merge-survivor"
                      value={entry.id}
                      checked={survivorId === entry.id}
                      disabled={disabled}
                      onChange={() => onSurvivorChange(entry.id)}
                      aria-label={t('Keep reference {{number}}', { number: index + 1 })}
                      className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
                    />
                    <span className="whitespace-nowrap text-xs">
                      {t('Reference {{number}}', { number: index + 1 })}
                    </span>
                  </label>
                  <p className="mt-2 font-medium [overflow-wrap:anywhere]">{entry.item.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {creatorLabel(entry.item) || t('Not provided')}
                  </p>
                  <dl className="mt-3 space-y-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">{t('DOI')}</dt>
                      <dd className="mt-0.5 [overflow-wrap:anywhere]">
                        {entry.item.identifiers
                          .filter((id) => id.scheme === 'doi')
                          .map((id) => id.value)
                          .join('; ') || t('Not provided')}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('Attachments')}</dt>
                      <dd className="mt-0.5 tabular-nums">{entry.attachments.length}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('Date added')}</dt>
                      <dd className="mt-0.5 [overflow-wrap:anywhere]">{date(entry.createdAt)}</dd>
                    </div>
                  </dl>
                </th>
              ))}
            </tr>
          </thead>
          {(showAll ? rows : differences).map(({ field, values, different, selectable }) => {
            const fieldName = label(field)
            const chosenId = mergeFieldSource(entries, survivorId, sources, field)?.id
            return (
              <tbody key={field}>
                <tr>
                  <th
                    colSpan={entries.length}
                    className="border-t border-border bg-muted/50 px-3 py-2 text-left text-xs font-medium"
                  >
                    {fieldName}
                    {field.startsWith('identifier:') && different ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {t(
                          'All identifiers are kept. Preferred values come from the kept reference when available.'
                        )}{' '}
                        {
                          merged?.identifiers.find(
                            (identifier) =>
                              identifier.scheme === field.slice(11) && identifier.isPrimary
                          )?.value
                        }
                      </span>
                    ) : null}
                  </th>
                </tr>
                <tr>
                  {entries.map((entry, index) => (
                    <td
                      key={entry.id}
                      className="border-r border-border p-3 align-top last:border-r-0"
                    >
                      {selectable && mergeValueKey(values[index]) ? (
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name={`merge-field-${field}`}
                            checked={chosenId === entry.id}
                            disabled={disabled}
                            onChange={() => onSourceChange(field, entry.id)}
                            aria-label={t('Use {{field}} from reference {{number}}', {
                              field: fieldName,
                              number: index + 1
                            })}
                            className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
                          />
                          <span className="whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]">
                            {display(field, values[index], entry)}
                          </span>
                        </label>
                      ) : (
                        <p
                          className={cn(
                            'whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]',
                            !mergeValueKey(values[index]) && 'text-muted-foreground'
                          )}
                        >
                          {display(field, values[index], entry)}
                        </p>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            )
          })}
        </table>
      </div>
      {differences.length === 0 ? (
        <p role="status" className="flex items-center gap-2 text-sm text-primary">
          <Check className="size-4 shrink-0" aria-hidden="true" />
          {t('Metadata is identical.')}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            'Choose values for conflicting fields. Empty fields are filled from the other references.'
          )}
        </p>
      )}
      <div className="space-y-1 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Paperclip className="size-4 shrink-0" aria-hidden="true" />
          {t('After merging')}
        </p>
        <p className="tabular-nums">{summary}</p>
        <p>
          {t(
            'All attachments and their versions, tags, collection links and project links are kept.'
          )}
        </p>
      </div>
    </div>
  )
}
