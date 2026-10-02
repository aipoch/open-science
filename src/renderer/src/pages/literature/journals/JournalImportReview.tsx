import { Button } from '@/components/ui/button'
import * as Checkbox from '@radix-ui/react-checkbox'
import { Check, Type } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { missingJournalValue, type JournalResult } from '../../../../../shared/journal-attributes'
import { CollectionOptionHelp } from '../collections/CollectionOptionHelp'
import { JournalAttributeValue } from '../JournalAttributes'
import { LiteratureErrorNotice } from '../LiteratureErrorNotice'
import { LiteratureTable, LiteratureTextTooltip } from '../LiteratureTable'
import { journalFieldKindIcons } from './journal-field-icons'
import { type JournalColumn } from './journal-import-file'

export function JournalImportReview({
  review,
  skipProblems,
  busy,
  discard,
  setReview,
  problemsOnly,
  changePage,
  setSkipProblems,
  commitDisabledReason,
  reviewScroll,
  reviewPageLoading,
  embedded,
  columns,
  statuses,
  warnings,
  policy,
  source,
  year
}: {
  review: JournalResult
  skipProblems: boolean
  busy: boolean
  discard: () => void
  setReview: React.Dispatch<
    React.SetStateAction<
      | {
          scan?: { token: string; processed: number; done: boolean } | undefined
          removal?: { journals: number; bindings: number; digest: string } | undefined
          exportPage?:
            | {
                dataset: {
                  id: string
                  source: string
                  year: number
                  revision: number
                  fields: {
                    id: string
                    label: string
                    kind: 'number' | 'text' | 'singleSelect' | 'multiSelect'
                    colors: Record<
                      string,
                      'gray' | 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'
                    >
                    visible: boolean
                    columnKey?: string | undefined
                  }[]
                  count: number
                  importedAt: number
                  name?: string | null | undefined
                }
                snapshot: string
                rows: {
                  name: string
                  aliases: string[]
                  issns: string[]
                  row: number
                  values: Record<string, string>
                  externalIds?: { namespace: string; value: string }[] | undefined
                }[]
                next?: string | undefined
              }
            | undefined
          datasets?:
            | {
                id: string
                source: string
                year: number
                revision: number
                fields: {
                  id: string
                  label: string
                  kind: 'number' | 'text' | 'singleSelect' | 'multiSelect'
                  colors: Record<
                    string,
                    'gray' | 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'
                  >
                  visible: boolean
                  columnKey?: string | undefined
                }[]
                count: number
                importedAt: number
                name?: string | null | undefined
              }[]
            | undefined
          alignment?:
            | {
                token: string
                counts: { matched: number; missing: number; ambiguous: number }
                total: number
                rows: {
                  itemId: string
                  metadataRevision: number
                  bindingRevision: string | null
                  title: string
                  identity: {
                    name: string
                    aliases: string[]
                    issns: string[]
                    externalIds?: { namespace: string; value: string }[] | undefined
                  }
                  status: 'matched' | 'missing' | 'ambiguous'
                  reason:
                    | 'name'
                    | 'issn'
                    | 'manual'
                    | 'external-id'
                    | 'multiple-candidates'
                    | 'identifier-conflict'
                    | 'missing-identity'
                    | 'not-found'
                  candidates: {
                    name: string
                    aliases: string[]
                    issns: string[]
                    id: string
                    externalIds?: { namespace: string; value: string }[] | undefined
                  }[]
                  candidateTotal: number
                }[]
              }
            | undefined
          candidates?:
            | {
                name: string
                aliases: string[]
                issns: string[]
                id: string
                externalIds?: { namespace: string; value: string }[] | undefined
              }[]
            | undefined
          token?: string | undefined
          digest?: string | undefined
          total?: number | undefined
          ready?: number | undefined
          problems?: number | undefined
          rows?:
            | {
                name: string
                aliases: string[]
                issns: string[]
                row: number
                values: Record<string, string>
                status: 'matched' | 'ambiguous' | 'new' | 'invalid' | 'duplicate'
                warnings: (
                  | 'missing-identity'
                  | 'invalid-issn'
                  | 'invalid-value'
                  | 'identity-conflict'
                  | 'identity-limit'
                  | 'duplicate-row'
                )[]
                externalIds?: { namespace: string; value: string }[] | undefined
                previous?: Record<string, string> | undefined
              }[]
            | undefined
          entries?:
            | {
                name: string
                aliases: string[]
                issns: string[]
                row: number
                values: Record<string, string>
                id: string
                externalIds?: { namespace: string; value: string }[] | undefined
              }[]
            | undefined
          matches?:
            | {
                status: 'matched' | 'missing' | 'ambiguous'
                attributes: {
                  key: string
                  label: string
                  kind: 'number' | 'text' | 'singleSelect' | 'multiSelect'
                  value: string
                  source: string
                  year: number
                  colors: Record<
                    string,
                    'gray' | 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'
                  >
                }[]
                identity?:
                  | {
                      name: string
                      aliases: string[]
                      issns: string[]
                      externalIds?: { namespace: string; value: string }[] | undefined
                    }
                  | undefined
              }[]
            | undefined
          choices?: string[] | undefined
          imported?: number | undefined
        }
      | undefined
    >
  >
  problemsOnly: boolean
  changePage: (offset: number, nextProblemsOnly?: boolean) => Promise<void>
  setSkipProblems: React.Dispatch<React.SetStateAction<boolean>>
  commitDisabledReason: string
  reviewScroll: React.RefObject<HTMLDivElement | null>
  reviewPageLoading: boolean
  embedded: boolean
  columns: JournalColumn[]
  statuses: { matched: string; new: string; ambiguous: string; invalid: string; duplicate: string }
  warnings: {
    'invalid-issn': string
    'invalid-value': string
    'missing-identity': string
    'identity-conflict': string
    'identity-limit': string
    'duplicate-row': string
  }
  policy: 'fill' | 'replace'
  source: string
  year: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-sm">
            {t('{{ready}} ready; {{problems}} need attention.', {
              ready: review.ready,
              problems: review.problems
            })}
          </p>
          <CollectionOptionHelp label={t('Review import')}>
            <div className="space-y-2">
              <p>
                {t('Only selected attributes are saved. Empty values never erase existing data.')}
              </p>
              {review.problems && skipProblems ? (
                <p>
                  {t('Rows to skip: {{total}}. Only ready rows will be imported.', {
                    total: review.problems
                  })}
                </p>
              ) : null}
            </div>
          </CollectionOptionHelp>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="shrink-0 self-start"
            disabled={busy}
            onClick={() => {
              discard()
              setReview(undefined)
            }}
          >
            {t('Edit mapping')}
          </Button>
          {review.problems ? (
            <Button
              variant="outline"
              disabled={busy}
              aria-pressed={problemsOnly}
              onClick={() => void changePage(0, !problemsOnly)}
            >
              {problemsOnly ? t('Show all rows') : t('Show problem rows')}
            </Button>
          ) : null}
        </div>
      </div>
      {review.problems ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox.Root
            checked={skipProblems}
            disabled={busy}
            onCheckedChange={(checked) => setSkipProblems(checked === true)}
            aria-label={t('Skip ambiguous, invalid and duplicate rows')}
            className="flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Checkbox.Indicator>
              <Check className="size-3" aria-hidden="true" />
            </Checkbox.Indicator>
          </Checkbox.Root>
          {t('Skip ambiguous, invalid and duplicate rows')}
        </label>
      ) : null}
      {commitDisabledReason ? (
        <LiteratureErrorNotice inline role="status" tone="amber" title={commitDisabledReason} />
      ) : null}
      <div
        ref={reviewScroll}
        aria-busy={reviewPageLoading}
        className={`isolate overflow-auto rounded-xl border border-border-300/80 bg-bg-000 ${embedded ? 'min-h-0 flex-1' : 'max-h-[min(60vh,42rem)]'}`}
      >
        <LiteratureTable
          className="w-full table-fixed text-left text-xs"
          style={{
            minWidth: 540 + columns.filter(({ role }) => role === 'attribute').length * 170
          }}
        >
          <colgroup>
            <col style={{ width: 60 }} />
            <col style={{ width: 300 }} />
            <col style={{ width: 180 }} />
            {columns
              .filter(({ role }) => role === 'attribute')
              .map(({ field }) => (
                <col key={field.id} />
              ))}
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
            <tr>
              <th className="h-11 px-3 font-medium">{t('Row')}</th>
              <th className="h-11 px-3 font-medium">
                <span className="flex items-center gap-1.5">
                  <Type className="size-3.5 shrink-0" aria-hidden="true" />
                  {t('Journal name')}
                </span>
              </th>
              <th className="h-11 px-3 font-medium">{t('Status')}</th>
              {columns
                .filter(({ role }) => role === 'attribute')
                .map(({ field }) => {
                  const Icon = journalFieldKindIcons[field.kind]
                  return (
                    <th key={field.id} className="h-11 px-3 font-medium">
                      <span className="flex items-center gap-1.5">
                        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                        <LiteratureTextTooltip text={field.label}>
                          <span className="truncate">{field.label}</span>
                        </LiteratureTextTooltip>
                      </span>
                    </th>
                  )
                })}
            </tr>
          </thead>
          <tbody>
            {review.rows?.map((row) => (
              <tr
                key={row.row}
                className="border-b border-border-300/80 bg-bg-000 last:border-b-0 hover:bg-bg-100"
              >
                <td className="h-16 px-3 py-3 text-muted-foreground tabular-nums">{row.row}</td>
                <td className="px-3 py-3">
                  <LiteratureTextTooltip text={row.name || row.issns.join(', ')}>
                    <span className="block truncate">{row.name || row.issns.join(', ')}</span>
                  </LiteratureTextTooltip>
                </td>
                <td className="px-3 py-3">
                  {statuses[row.status]}
                  {row.warnings.map((warning) => (
                    <p key={warning} className="mt-1 text-muted-foreground">
                      {warnings[warning]}
                    </p>
                  ))}
                </td>
                {columns
                  .filter(({ role }) => role === 'attribute')
                  .map(({ field }) => {
                    const previous = row.previous?.[field.id] ?? ''
                    const value =
                      missingJournalValue(row.values[field.id] ?? '') ||
                      (policy === 'fill' && !missingJournalValue(previous))
                        ? previous || '—'
                        : row.values[field.id]
                    return (
                      <td key={field.id} className="px-3 py-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {!missingJournalValue(previous) && previous !== value ? (
                            <span
                              className="max-w-full truncate text-muted-foreground"
                              title={previous}
                            >
                              {previous}
                              {' → '}
                            </span>
                          ) : null}
                          <LiteratureTextTooltip text={value}>
                            <span className="min-w-0 max-w-full">
                              <JournalAttributeValue
                                attribute={{
                                  ...field,
                                  key: field.id,
                                  value,
                                  source,
                                  year: Number(year)
                                }}
                                singleLine
                              />
                            </span>
                          </LiteratureTextTooltip>
                        </div>
                      </td>
                    )
                  })}
              </tr>
            ))}
          </tbody>
        </LiteratureTable>
      </div>
    </>
  )
}
