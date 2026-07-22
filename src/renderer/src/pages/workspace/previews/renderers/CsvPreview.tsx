import { parse } from 'papaparse'

import { getFileExtension } from '../../preview-support'
import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'

const VISIBLE_ROWS = 100
const VISIBLE_COLUMNS = 24

const parseCsvRows = (
  content: string,
  extension: string
): { rows: string[][]; errors: string[] } => {
  const parsed = parse<string[]>(content, {
    delimiter: extension === 'tsv' ? '\t' : '',
    skipEmptyLines: true,
    preview: VISIBLE_ROWS + 1
  })

  return {
    rows: parsed.data.filter((row): row is string[] => Array.isArray(row)),
    errors: parsed.errors.map((error) => error.message)
  }
}

export const CsvPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage="CSV couldn't be read for preview"
      />
    )
  }

  const { rows, errors } = parseCsvRows(state.preview.content, getFileExtension(item.name))
  const headers = rows[0] ?? []
  const dataRows = rows.slice(1, VISIBLE_ROWS + 1)
  const visibleHeaders = headers.slice(0, VISIBLE_COLUMNS)
  const hiddenColumnCount = Math.max(headers.length - visibleHeaders.length, 0)
  const rowCountLabel = `${Math.max(rows.length - 1, 0)}${state.preview.truncated ? '+' : ''} rows · ${
    headers.length
  } columns`

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
        <span>{rowCountLabel}</span>
        <span className="shrink-0">
          Showing {dataRows.length} rows · {visibleHeaders.length} columns
        </span>
        {errors[0] ? <span className="text-danger-000"> · {errors[0]}</span> : null}
      </div>
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
                  <span className="block truncate" title={header || `Column ${index + 1}`}>
                    {header || `Column ${index + 1}`}
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
      {hiddenColumnCount > 0 ? (
        <div className="shrink-0 border-t border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
          {hiddenColumnCount} more columns hidden in this preview
        </div>
      ) : null}
    </div>
  )
}
