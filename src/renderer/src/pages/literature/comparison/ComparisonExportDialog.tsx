import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogBodyClassName,
  dialogFooterClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import { useLiteratureHost } from '../renderer-host'
import type {
  ComparisonRequest,
  ComparisonResult,
  ComparisonTable
} from '../../../../../shared/literature-comparison'

export function ComparisonExportDialog({
  table,
  summary,
  command,
  blocked,
  triggerRef,
  onBusyChange,
  onClose
}: {
  table: Pick<ComparisonTable, 'id' | 'name'>
  summary: {
    references: number
    fields: number
    total: number
    extracted: number
    awaitingReview: number
    outdatedRule: number
    waiting: number
    failed: number
    pendingExtraction: number
  }
  command: (request: ComparisonRequest) => Promise<ComparisonResult>
  blocked: boolean
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState(false)
  const [exportSaved, setExportSaved] = useState<{ saved: number; total: number }>()
  const [exportKinds, setExportKinds] = useState<('matrix' | 'evidence')[]>(['matrix'])
  const exportDescriptionId = useId()
  const exportCsv = async (
    kind: 'matrix' | 'evidence',
    finalFile: boolean,
    snapshotToken?: string
  ): Promise<{ data: ArrayBuffer; token?: string }> => {
    const chunks: string[] = []
    let offset: number | undefined
    let exportToken = snapshotToken
    do {
      const result = await command({
        action: 'export',
        tableId: table.id,
        kind,
        ...(finalFile ? { releaseOnComplete: true } : {}),
        ...(offset === undefined ? {} : { offset }),
        ...(exportToken ? { exportToken } : {})
      })
      if (result.csv === undefined) throw new Error('Missing comparison export')
      if (exportToken && result.exportToken !== exportToken)
        throw new Error('Comparison export changed')
      exportToken = result.exportToken
      chunks.push(result.csv)
      if (result.nextOffset !== undefined && (!exportToken || result.nextOffset <= (offset ?? 0)))
        throw new Error('Invalid comparison export page')
      offset = result.nextOffset
    } while (offset !== undefined)
    return { data: new TextEncoder().encode(chunks.join('')).buffer, token: exportToken }
  }
  const exportSelected = async (): Promise<void> => {
    if (busyRef.current || blocked) return
    busyRef.current = true
    setExportSaved(undefined)
    setBusy(true)
    onBusyChange(true)
    setError(false)
    try {
      const files: { kind: 'matrix' | 'evidence'; data: ArrayBuffer }[] = []
      let token: string | undefined
      // Prepare every selected CSV from one snapshot before opening any save dialog.
      for (const kind of exportKinds) {
        const file = await exportCsv(kind, kind === exportKinds.at(-1), token)
        token = file.token
        if (exportKinds.length > 1 && !token) throw new Error('Missing export snapshot')
        files.push({ kind, data: file.data })
      }
      let saved = 0
      setExportSaved({ saved, total: files.length })
      for (const file of files) {
        const result = await api.saveBlobFile({
          suggestedName: `${table.name}-${file.kind}.csv`,
          mimeType: 'text/csv;charset=utf-8',
          data: file.data
        })
        if (!result.saved) return
        saved += 1
        setExportSaved({ saved, total: files.length })
      }
      onClose()
    } catch {
      setError(true)
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName('w-[min(34rem,calc(100vw-2rem))] p-0')}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {t('Export comparison results')}
            </Dialog.Title>
          </div>
          <div className={`${dialogBodyClassName} max-h-[65vh] overflow-y-auto space-y-4`}>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t('{{references}} references, {{fields}} fields. CSV (UTF-8).', {
                references: summary.references,
                fields: summary.fields
              })}
            </Dialog.Description>
            <ul className="grid grid-cols-2 gap-2 text-sm" aria-label={t('Table totals')}>
              <li className="rounded-lg bg-muted p-3">
                {t('Extracted cells: {{extracted}} / {{total}}', {
                  extracted: summary.extracted,
                  total: summary.total
                })}
              </li>
              <li className="rounded-lg bg-muted p-3">
                {t('Needs review')}
                {': '}
                {summary.awaitingReview}
              </li>
              <li className="rounded-lg bg-muted p-3">
                {t('Outdated rule cells: {{outdated}}', { outdated: summary.outdatedRule })}
              </li>
              <li className="rounded-lg bg-muted p-3">
                {t('Waiting for source')}
                {': '}
                {summary.waiting}
              </li>
            </ul>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                {t('Failed')}
                {': '}
                {summary.failed}
              </p>
              <p>{t('Pending extraction: {{pending}}', { pending: summary.pendingExtraction })}</p>
              <p>{t('Review and execution counts may overlap.')}</p>
            </div>
            <div className="space-y-4">
              {(['matrix', 'evidence'] as const).map((kind) => (
                <div key={kind}>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      aria-describedby={`${exportDescriptionId}-${kind}`}
                      checked={exportKinds.includes(kind)}
                      disabled={busy}
                      onChange={(event) =>
                        setExportKinds((current) =>
                          event.target.checked
                            ? [...new Set([...current, kind])]
                            : current.filter((entry) => entry !== kind)
                        )
                      }
                    />
                    {t(kind === 'matrix' ? 'Export matrix CSV' : 'Export evidence CSV')}
                  </label>
                  <p
                    id={`${exportDescriptionId}-${kind}`}
                    className="mt-1 pl-5 text-xs text-muted-foreground"
                  >
                    {kind === 'matrix'
                      ? t(
                          'Current values, machine values and manual edits are kept in separate columns.'
                        )
                      : t(
                          'Per-cell evidence, source and rule versions, page numbers, coverage and review status.'
                        )}
                  </p>
                </div>
              ))}
            </div>
            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              {t(
                'Unfinished cells, outdated results, insufficient evidence and failures remain visible. Manual edits do not automatically verify the source.'
              )}
            </p>
            {exportSaved && (
              <p role="status" className="text-sm">
                {t('Saved {{saved}} of {{total}} CSV files.', exportSaved)}
              </p>
            )}
            {error && (
              <ErrorNotice inline title={t('Could not export comparison results. Try again.')} />
            )}
          </div>
          <div className={dialogFooterClassName}>
            <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
              {t('Cancel')}
            </Button>
            <Button
              disabled={busy || !exportKinds.length || blocked}
              onClick={() => void exportSelected()}
            >
              {t('Export {{count}} CSV files', {
                count: exportKinds.length,
                defaultValue_one: 'Export {{count}} CSV file'
              })}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
