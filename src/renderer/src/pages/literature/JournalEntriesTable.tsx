import { ActionMenuProvider } from '@/components/action-menu'
import { Button } from '@/components/ui/button'
import { ArrowDown, ArrowUp, ArrowUpDown, Type } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  type JournalDataset,
  type JournalField,
  type JournalResult
} from '../../../../shared/journal-attributes'
import { JournalColumnHeader } from './JournalColumnHeader'
import { JournalEntryRow } from './JournalEntryRow'
import { LiteraturePagination } from './LiteraturePagination'
import { LiteratureTable, LiteratureTableScrollArea } from './LiteratureTable'
import { journalFieldKindIcons } from './journal-field-icons'

export function JournalEntriesTable({
  dataset,
  identityColumns,
  sortField,
  descending,
  busy,
  editing,
  entryDraft,
  setSortField,
  setDescending,
  setOffset,
  persistFields,
  entries,
  entriesOffset,
  remoteDatasets,
  setEntryDraft,
  saveEntry,
  entriesFailed,
  offset,
  pageSize,
  entriesLoading,
  setPageSize
}: {
  dataset: JournalDataset | undefined
  identityColumns: { issn: boolean; externalIds: boolean }
  sortField: string | undefined
  descending: boolean
  busy: boolean
  editing: boolean
  entryDraft: { id: string; values: Record<string, string> } | undefined
  setSortField: React.Dispatch<React.SetStateAction<string | undefined>>
  setDescending: React.Dispatch<React.SetStateAction<boolean>>
  setOffset: React.Dispatch<React.SetStateAction<number>>
  persistFields: (fields: JournalField[]) => Promise<string | undefined>
  entries: JournalResult
  entriesOffset: number
  remoteDatasets: JournalDataset[] | undefined
  setEntryDraft: React.Dispatch<
    React.SetStateAction<{ id: string; values: Record<string, string> } | undefined>
  >
  saveEntry: () => Promise<void>
  entriesFailed: boolean
  offset: number
  pageSize: 100 | 25 | 50
  entriesLoading: boolean
  setPageSize: React.Dispatch<React.SetStateAction<100 | 25 | 50>>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return dataset ? (
    <ActionMenuProvider>
      <div className="isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-300/80 bg-bg-000">
        <LiteratureTableScrollArea>
          <LiteratureTable
            className="w-full table-fixed text-left text-xs"
            style={{
              minWidth:
                388 +
                (identityColumns.issn ? 180 : 0) +
                (identityColumns.externalIds ? 160 : 0) +
                dataset.fields
                  .filter((field) => field.visible)
                  .reduce(
                    (width, field) =>
                      width +
                      (field.kind === 'number' ? 170 : field.kind === 'singleSelect' ? 180 : 180),
                    0
                  )
            }}
          >
            <colgroup>
              <col style={{ width: 48 }} />
              <col />
              {identityColumns.issn ? <col style={{ width: 180 }} /> : null}
              {identityColumns.externalIds ? <col style={{ width: 160 }} /> : null}
              {dataset.fields
                .filter((field) => field.visible)
                .map((field) => (
                  <col
                    key={field.id}
                    style={{
                      width:
                        field.kind === 'number' ? 170 : field.kind === 'singleSelect' ? 180 : 180
                    }}
                  />
                ))}
              <col style={{ width: 80 }} />
            </colgroup>
            <thead className="sticky top-0 z-40 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
              <tr>
                <th
                  scope="col"
                  className="w-12 min-w-12 max-w-12 px-2 py-2.5 text-center tabular-nums"
                >
                  #
                </th>
                <th
                  aria-sort={sortField ? 'none' : descending ? 'descending' : 'ascending'}
                  className="px-3 py-2.5"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto max-w-full truncate px-0 font-medium"
                    disabled={busy || editing || Boolean(entryDraft)}
                    onClick={() => {
                      setSortField(undefined)
                      setDescending(sortField ? false : !descending)
                      setOffset(0)
                    }}
                  >
                    <Type className="size-3.5 shrink-0" aria-hidden="true" />
                    {t('Journal name')}
                    {sortField ? (
                      <ArrowUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                    ) : descending ? (
                      <ArrowDown className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    )}
                  </Button>
                </th>
                {identityColumns.issn ? (
                  <th className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <Type className="size-3.5 shrink-0" aria-hidden="true" />
                      {t('ISSN')}
                    </span>
                  </th>
                ) : null}
                {identityColumns.externalIds ? (
                  <th className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <Type className="size-3.5 shrink-0" aria-hidden="true" />
                      {t('External IDs')}
                    </span>
                  </th>
                ) : null}
                {dataset.fields
                  .filter(({ visible }) => visible)
                  .map((field) => (
                    <th
                      key={field.id}
                      aria-sort={
                        sortField === field.id ? (descending ? 'descending' : 'ascending') : 'none'
                      }
                      className="px-3 py-2.5"
                    >
                      <JournalColumnHeader
                        identity={`${dataset.id}:${field.id}`}
                        label={field.label}
                        icon={journalFieldKindIcons[field.kind]}
                        direction={
                          sortField === field.id
                            ? descending
                              ? 'descending'
                              : 'ascending'
                            : undefined
                        }
                        disabled={busy || editing || Boolean(entryDraft)}
                        onSort={(nextDescending) => {
                          setSortField(field.id)
                          setDescending(nextDescending)
                          setOffset(0)
                        }}
                        field={field}
                        onSave={(next) =>
                          persistFields(
                            dataset.fields.map((entry) => (entry.id === field.id ? next : entry))
                          )
                        }
                        onHide={async () => {
                          await persistFields(
                            dataset.fields.map((entry) =>
                              entry.id === field.id ? { ...entry, visible: false } : entry
                            )
                          )
                        }}
                      />
                    </th>
                  ))}
                <th className="sticky right-0 z-30 w-20 min-w-20 max-w-20 border-l border-transparent bg-bg-200 group-data-[overflow-right=true]/journal-scroll:border-border-300/60 px-2 py-2.5 text-right before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-linear-to-l before:from-foreground/5 before:to-transparent before:opacity-0 group-data-[overflow-right=true]/journal-scroll:before:opacity-100" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-300/70">
              {entries.entries?.map((entry, index) => (
                <JournalEntryRow
                  key={entry.id}
                  entry={entry}
                  number={entriesOffset + index + 1}
                  dataset={dataset}
                  showIssn={identityColumns.issn}
                  showExternalIds={identityColumns.externalIds}
                  draft={entryDraft?.id === entry.id ? entryDraft : undefined}
                  disabled={busy || editing || Boolean(entryDraft)}
                  busy={busy}
                  saveDisabled={entryDraft?.id === entry.id && Boolean(remoteDatasets)}
                  onDraft={setEntryDraft}
                  onSave={entryDraft?.id === entry.id ? saveEntry : undefined}
                />
              ))}
            </tbody>
          </LiteratureTable>
        </LiteratureTableScrollArea>
        {!entriesFailed && entries.total !== undefined ? (
          <LiteraturePagination
            total={entries.total ?? 0}
            offset={offset}
            pageSize={pageSize}
            displayedCount={entries.entries?.length ?? 0}
            countLabel={t('{{count}} journals', {
              count: entries.total ?? 0,
              defaultValue_one: '{{count}} journal'
            })}
            pageSizeLabel={t('Journals per page')}
            disabled={busy || editing || Boolean(entryDraft)}
            loading={entriesLoading}
            onOffsetChange={setOffset}
            onPageSizeChange={(size) => {
              setOffset(0)
              setPageSize(size as 25 | 50 | 100)
            }}
          />
        ) : null}
      </div>
    </ActionMenuProvider>
  ) : null
}
