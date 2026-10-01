import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type JournalDataset, type JournalField } from '../../../../shared/journal-attributes'
import { JournalImportColumn } from './JournalImportColumn'
import { LiteratureTable, LiteratureTextTooltip } from './LiteratureTable'
import { suggestJournalHeader, type JournalColumn, type JournalSheet } from './journal-import-file'

export function JournalImportMapping({
  file,
  sheet,
  busy,
  read,
  header,
  remap,
  setSheet,
  previewRows,
  setShowFilePreview,
  showFilePreview,
  skippedColumns,
  showSkippedColumns,
  setShowSkippedColumns,
  previewTotal,
  previewWidth,
  previewStart,
  sourceSuggested,
  source,
  dataset,
  resetInheritedFields,
  setSourceSuggested,
  setSource,
  yearSuggested,
  year,
  setYearSuggested,
  setYear,
  previousDataset,
  policy,
  setPolicy,
  visibleColumns,
  updateColumn,
  roles,
  availableFields,
  kinds
}: {
  file: File | undefined
  sheet: JournalSheet
  busy: boolean
  read: (file: File, selectedSheet?: string) => Promise<void>
  header: number
  remap: (rows: string[][], header: number, width?: number) => void
  setSheet: React.Dispatch<React.SetStateAction<JournalSheet | undefined>>
  previewRows: string[][]
  setShowFilePreview: React.Dispatch<React.SetStateAction<boolean>>
  showFilePreview: boolean
  skippedColumns: JournalColumn[]
  showSkippedColumns: boolean
  setShowSkippedColumns: React.Dispatch<React.SetStateAction<boolean>>
  previewTotal: number
  previewWidth: number
  previewStart: number
  sourceSuggested: boolean
  source: string
  dataset: JournalDataset | undefined
  resetInheritedFields: () => void
  setSourceSuggested: React.Dispatch<React.SetStateAction<boolean>>
  setSource: React.Dispatch<React.SetStateAction<string>>
  yearSuggested: boolean
  year: string
  setYearSuggested: React.Dispatch<React.SetStateAction<boolean>>
  setYear: React.Dispatch<React.SetStateAction<string>>
  previousDataset: JournalDataset | undefined
  policy: 'fill' | 'replace'
  setPolicy: React.Dispatch<React.SetStateAction<'fill' | 'replace'>>
  visibleColumns: JournalColumn[]
  updateColumn: (index: number, patch: Partial<JournalColumn>) => void
  roles: {
    ignore: string
    name: string
    alias: string
    issn: string
    externalId: string
    attribute: string
  }
  availableFields: Array<JournalField & { columnKey?: string }>
  kinds: { text: string; number: string; singleSelect: string; multiSelect: string }
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return (
    <>
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{file?.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('Import settings')}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {sheet.names.length > 1 ? (
              <label className="space-y-1 text-xs">
                {t('Worksheet')}
                <Select
                  value={sheet.selected}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (file) void read(file, value)
                  }}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sheet.names.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            <label className="space-y-1 text-xs">
              {t('Header row')}
              <Input
                type="number"
                min={0}
                max={sheet.rows.length}
                value={header + 1}
                disabled={busy}
                onChange={(event) =>
                  remap(
                    sheet.rows,
                    Math.max(-1, Math.min(sheet.rows.length - 1, Number(event.target.value) - 1))
                  )
                }
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || sheet.rows.length > 256}
              onClick={() => {
                const width = sheet.width ?? sheet.rows[0]?.length ?? 0
                const rows = Array.from({ length: width }, (_, index) =>
                  sheet.rows.map((row) => row[index] ?? '')
                )
                setSheet({ ...sheet, rows, width: sheet.rows.length })
                remap(rows, suggestJournalHeader(rows), sheet.rows.length)
              }}
            >
              {t('Transpose')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !previewRows.length}
              onClick={() => setShowFilePreview((value) => !value)}
            >
              <Eye className="size-4" aria-hidden="true" />
              {t(showFilePreview ? 'Hide preview' : 'Preview')}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t(
            'The first row is treated as column names. Change it if needed; enter 0 when the file has no column names.'
          )}
        </p>
        {skippedColumns.length ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-pressed={!showSkippedColumns}
            onClick={() => setShowSkippedColumns((value) => !value)}
          >
            {showSkippedColumns ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
            {t(showSkippedColumns ? 'Hide skipped columns' : 'Show skipped columns')} (
            {skippedColumns.length})
          </Button>
        ) : null}
      </div>
      {showFilePreview ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/10 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{t('File preview')}</p>
            <p className="text-xs text-muted-foreground">
              {t('Table preview: showing first {{shown}} of {{total}} rows.', {
                shown: previewRows.length,
                total: previewTotal
              })}{' '}
              {t('Hover a cell to see its full value.')}
            </p>
          </div>
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <LiteratureTable className="w-full min-w-max text-left text-xs">
              <thead className="sticky top-0 bg-muted shadow-sm">
                <tr>
                  <th className="whitespace-nowrap p-2">{t('Row')}</th>
                  {Array.from({ length: previewWidth }, (_, index) => (
                    <th key={index} className="max-w-48 truncate p-2">
                      {header >= 0
                        ? sheet?.rows[header]?.[index] ||
                          t('Column {{number}}', { number: index + 1 })
                        : t('Column {{number}}', { number: index + 1 })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, rowIndex) => (
                  <tr key={previewStart + rowIndex} className="border-t border-border">
                    <td className="whitespace-nowrap p-2 text-muted-foreground">
                      {previewStart + rowIndex + 1}
                    </td>
                    {Array.from({ length: previewWidth }, (_, columnIndex) => {
                      const value = row[columnIndex] ?? ''
                      return (
                        <td key={columnIndex} className="max-w-48 p-2">
                          <LiteratureTextTooltip text={value}>
                            <span className="block max-w-48 truncate">{value || '—'}</span>
                          </LiteratureTextTooltip>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </LiteratureTable>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="flex min-h-6 items-center gap-2 font-medium">
            {t('Source')}
            {sourceSuggested ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-[0.7rem] font-normal text-muted-foreground">
                {t('Suggested')}
              </span>
            ) : null}
          </span>
          <span className="block flex-1 text-muted-foreground">
            {t('Name of the source for this dataset.')}
          </span>
          <Input
            aria-label={t('Source')}
            value={source}
            maxLength={100}
            disabled={busy || Boolean(dataset)}
            onChange={(event) => {
              resetInheritedFields()
              setSourceSuggested(false)
              setSource(event.target.value)
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="flex min-h-6 items-center gap-2 font-medium">
            {t('Metric year')}
            {yearSuggested ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-[0.7rem] font-normal text-muted-foreground">
                {t('Suggested')}
              </span>
            ) : null}
          </span>
          <span className="block flex-1 text-muted-foreground">
            {t('Year the values describe; it can differ from the file release year.')}
          </span>
          <Input
            aria-label={t('Metric year')}
            type="number"
            min={1800}
            max={9999}
            value={year}
            disabled={busy || Boolean(dataset)}
            onChange={(event) => {
              resetInheritedFields()
              setYearSuggested(false)
              setYear(event.target.value)
            }}
          />
        </label>
      </div>
      {!dataset && previousDataset ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'Choose an earlier attribute to keep its type, colors and table column selection across years.'
          )}
        </p>
      ) : null}
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          {t(
            'Use identity columns to match journals. Choose Journal attribute for values to show and filter in the literature table.'
          )}
        </p>
        <p>
          {t(
            'Saved name and Value type apply only to journal attributes. Skipped columns are not saved.'
          )}
        </p>
      </div>
      {dataset ? (
        <label className="flex items-center gap-2 text-xs">
          {t('Existing values')}
          <Select
            value={policy}
            disabled={busy}
            onValueChange={(value) => setPolicy(value as 'fill' | 'replace')}
          >
            <SelectTrigger className="w-auto min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fill">{t('Fill missing values')}</SelectItem>
              <SelectItem value="replace">{t('Replace selected values')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      ) : null}
      <div className="overflow-auto rounded-xl border border-border-300/80 bg-bg-000">
        <LiteratureTable className="w-full min-w-[920px] table-fixed text-left text-xs">
          <thead className="border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground [&_th]:h-11 [&_th]:font-medium">
            <tr>
              <th className="w-[18%] p-2">{t('Original column')}</th>
              <th className="w-[22%] p-2">{t('Example value')}</th>
              <th className="w-[18%] p-2">{t('Import as')}</th>
              <th className="w-[25%] p-2">{t('Saved name')}</th>
              <th className="w-[17%] p-2">{t('Value type')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleColumns.map((column) => {
              const label = column.label || t('Column {{number}}', { number: column.index + 1 })
              const example = sheet.rows[header + 1]?.[column.index] ?? ''
              return (
                <JournalImportColumn
                  key={column.index}
                  column={column}
                  label={label}
                  example={example}
                  busy={busy}
                  updateColumn={updateColumn}
                  roles={roles}
                  availableFields={availableFields}
                  kinds={kinds}
                />
              )
            })}
          </tbody>
        </LiteratureTable>
      </div>
    </>
  )
}
