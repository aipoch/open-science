import { parse, type ParseError } from 'papaparse'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'

import { getFileExtension } from '../../preview-support'
import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'

const VISIBLE_ROWS = 100
const VISIBLE_COLUMNS = 24

const parseCsvRows = (
  content: string,
  extension: string,
  byteTruncated: boolean
): {
  rows: string[][]
  errors: ParseError[]
  delimiterUncertain: boolean
  rowTruncated: boolean
} => {
  const rows: string[][] = []
  const errors: ParseError[] = []
  let rowTruncated = false
  parse<string[]>(content, {
    delimiter: extension === 'tsv' ? '\t' : '',
    skipEmptyLines: true,
    step: (result, parser) => {
      // Papa owns record boundaries, including quoted newlines. At the byte boundary a
      // record needs a terminator and closed quotes; EOF alone cannot confirm it is complete.
      if (
        byteTruncated &&
        result.meta.cursor >= content.length &&
        (!content.endsWith(result.meta.linebreak) ||
          result.errors.some((error) => error.code === 'MissingQuotes'))
      )
        return
      if (rows.length === VISIBLE_ROWS + 1) {
        rowTruncated = true
        parser.abort()
        return
      }
      rows.push(result.data)
      errors.push(...result.errors)
    }
  })
  const singleColumn = rows.length > 0 && rows.every((row) => row.length === 1)
  return {
    rows,
    errors: errors.filter((error) => error.code !== 'UndetectableDelimiter'),
    delimiterUncertain:
      !singleColumn && errors.some((error) => error.code === 'UndetectableDelimiter'),
    rowTruncated
  }
}

export const CsvPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent({ ...item, encoding: 'base64' })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.error}
        fallbackMessage={t("CSV couldn't be read for preview")}
      />
    )
  }

  // Keep BOM detection local to CSV; other text previews retain their decoding and paging.
  const bytes = Uint8Array.from(atob(state.preview.content), (character) => character.charCodeAt(0))
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  if (utf16) {
    return (
      <ErrorNotice
        role="status"
        title={t('Preview unavailable')}
        description={t('UTF-16 CSV preview is not supported. Save a copy as UTF-8 to preview it.')}
      />
    )
  }
  // A streaming decode withholds a partial UTF-8 character at the read boundary.
  const content = new TextDecoder().decode(bytes, { stream: state.preview.truncated })
  const { rows, errors, delimiterUncertain, rowTruncated } = parseCsvRows(
    content,
    getFileExtension(item.name),
    state.preview.truncated
  )
  if (state.preview.truncated && rows.length === 0) {
    return (
      <ErrorNotice
        role="status"
        title={t('Preview unavailable')}
        description={t('The preview limit was reached before a complete header could be read.')}
      />
    )
  }
  // CSV does not reliably identify headers. Preserve the first-row convention and disclose it.
  const headers = rows[0] ?? []
  const dataRows = rows.slice(1, VISIBLE_ROWS + 1)
  const columnCount = Math.max(0, ...rows.map((row) => row.length))
  const visibleHeaders = Array.from(
    { length: Math.min(columnCount, VISIBLE_COLUMNS) },
    (_, index) => headers[index] ?? ''
  )
  const hiddenColumnCount = Math.max(columnCount - visibleHeaders.length, 0)
  const totalKnown = !state.preview.truncated && !rowTruncated

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
        {totalKnown ? (
          <span>
            {t('{{rows}} rows · {{columns}} columns', {
              rows: dataRows.length,
              columns: columnCount
            })}
          </span>
        ) : null}
        <span className="shrink-0">
          {t('Showing {{rows}} rows · {{columns}} columns', {
            rows: dataRows.length,
            columns: visibleHeaders.length
          })}
        </span>
        {errors[0] ? (
          <span className="text-danger-000">
            {' '}
            · {t('CSV parsing encountered a problem. The preview may be incomplete.')}
          </span>
        ) : null}
      </div>
      {state.preview.truncated ? (
        <div
          className="shrink-0 border-b border-border-300 px-3 py-2 text-[12px] text-text-300"
          role="status"
        >
          {t('The file exceeds the preview limit. Only complete records are shown.')}
        </div>
      ) : null}
      {delimiterUncertain && errors.length === 0 ? (
        <div
          className="shrink-0 border-b border-border-300 px-3 py-2 text-[12px] text-text-300"
          role="status"
        >
          {t('The delimiter could not be detected reliably. Commas are used in this preview.')}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-bg-200 text-text-000">
            <tr>
              <th className="sticky left-0 z-20 w-12 border-b border-r border-border-300 bg-bg-200 px-3 py-2 text-right font-mono text-text-300">
                #
              </th>
              {visibleHeaders.map((header, index) => (
                <th
                  key={`${header}-${index}`}
                  className="max-w-[180px] border-b border-r border-border-300 bg-bg-200 px-3 py-2 font-medium"
                >
                  <span
                    className="block truncate"
                    title={header || t('Column {{index}}', { index: index + 1 })}
                  >
                    {header || t('Column {{index}}', { index: index + 1 })}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-bg-000 text-text-100">
            {dataRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-bg-10">
                <td className="sticky left-0 z-[1] w-12 border-b border-r border-border-300 bg-inherit px-3 py-1.5 text-right font-mono text-text-300">
                  {rowIndex + 1}
                </td>
                {visibleHeaders.map((_, columnIndex) => (
                  <td
                    key={`${rowIndex}-${columnIndex}`}
                    className="max-w-[180px] border-b border-r border-border-300 px-3 py-1.5 align-top"
                  >
                    <span className="block truncate" title={row[columnIndex] ?? ''}>
                      {row[columnIndex] ?? ''}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {headers.length > 0 ? (
        <div className="shrink-0 border-t border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
          <div>{t('First row is used as column headers')}</div>
          {hiddenColumnCount > 0 ? (
            <div>
              {t('{{count}} more columns hidden in this preview', {
                count: hiddenColumnCount,
                defaultValue_one: '{{count}} more column hidden in this preview'
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
