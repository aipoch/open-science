import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { LiteratureImportDialogFrame } from './LiteratureImportDialogFrame'
import { LiteratureDuplicatePolicyField } from './LiteratureDuplicatePolicyField'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { stageComposerFile } from '../workspace/composer-upload-transfer'
import {
  LITERATURE_IMPORT_IDENTITY_CONFLICT,
  type LiteratureItemInput,
  type LiteratureDuplicatePolicy
} from '../../../../shared/literature'
import type { UploadTransferProgress, UploadedAttachment } from '../../../../shared/uploads'

type Row = {
  file: File
  draft: LiteratureItemInput
  checked: boolean
  status: 'pending' | 'reading' | 'ready' | 'importing' | 'done' | 'error'
  itemId?: string
  linked?: boolean
  uncertain?: boolean
  error?: string
}
export type PdfImportDestination = { name: string; projectId?: string; collectionId?: string }

export function LiteraturePdfBatchImportDialog({
  files,
  destination,
  createDraft,
  onClose
}: {
  files: File[]
  destination: PdfImportDestination
  createDraft: (file: File) => LiteratureItemInput
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>(() =>
    files.map((file) => ({ file, draft: createDraft(file), checked: true, status: 'pending' }))
  )
  const rowsRef = useRef(rows.map((row) => ({ ...row })))
  const [policy, setPolicy] = useState<LiteratureDuplicatePolicy>('reuse')
  const [reading, setReading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [visible, setVisible] = useState(100)
  const [progress, setProgress] = useState<UploadTransferProgress>()
  const active = useRef(true)
  const running = useRef(false)
  const stopped = useRef(false)
  const upload = useRef<{ controller: AbortController; transferId: string } | undefined>(undefined)
  const publish = (): void => {
    if (active.current) setRows(rowsRef.current.map((row) => ({ ...row })))
  }
  const selectAll = (checked: boolean): void => {
    rowsRef.current.forEach((row) => {
      if (row.status !== 'done' && !row.uncertain) row.checked = checked
    })
    publish()
  }
  const stop = (): void => {
    stopped.current = true
    setStopping(true)
    const transfer = upload.current
    if (transfer) {
      transfer.controller.abort()
      void window.api.uploads
        .abortTransfer({ transferId: transfer.transferId })
        .catch(() => undefined)
    }
  }
  useEffect(() => {
    active.current = true
    let disposed = false
    const read = async (): Promise<void> => {
      const { extractLiteraturePdfDraft, completeLiteraturePdfDraft } =
        await import('./literature-pdf-metadata')
      for (const row of rowsRef.current) {
        if (disposed) return
        row.status = 'reading'
        publish()
        try {
          const local = await extractLiteraturePdfDraft(row.file, row.draft)
          if (disposed) return
          const draft = await completeLiteraturePdfDraft(local)
          if (disposed) return
          row.draft = draft
        } catch {
          // Metadata is optional; the importer validates PDF bytes before attaching them.
        }
        if (disposed) return
        row.status = 'ready'
        publish()
      }
    }
    void read()
      .catch(() => {
        if (!disposed) {
          for (const row of rowsRef.current) row.status = 'ready'
          publish()
        }
      })
      .finally(() => {
        if (!disposed) setReading(false)
      })
    return () => {
      disposed = true
      active.current = false
      stopped.current = true
      const transfer = upload.current
      if (transfer) {
        transfer.controller.abort()
        void window.api.uploads
          .abortTransfer({ transferId: transfer.transferId })
          .catch(() => undefined)
      }
    }
  }, [])

  const run = async (): Promise<void> => {
    if (running.current || reading) return
    running.current = true
    stopped.current = false
    setBusy(true)
    setStopping(false)
    try {
      for (const row of rowsRef.current) {
        if (stopped.current || !active.current) break
        if (!row.checked || row.status === 'done' || row.uncertain) continue
        row.status = 'importing'
        row.error = undefined
        publish()
        let staged: UploadedAttachment | undefined
        let creating = false
        try {
          if (!row.itemId) {
            creating = true
            const receipt = await window.api.literature.transact({
              kind: 'create-item',
              item: row.draft,
              duplicatePolicy: policy
            })
            row.itemId = receipt.id
            creating = false
          }
          if (stopped.current || !active.current) {
            row.status = 'ready'
            continue
          }
          if (!row.linked) {
            if (destination.projectId)
              await window.api.literature.transact({
                kind: 'set-project-item',
                projectId: destination.projectId,
                itemId: row.itemId,
                included: true,
                source: 'library'
              })
            else if (destination.collectionId)
              await window.api.literature.transact({
                kind: 'set-collection-item',
                collectionId: destination.collectionId,
                itemId: row.itemId,
                included: true
              })
            row.linked = true
          }
          if (stopped.current || !active.current) {
            row.status = 'ready'
            continue
          }
          const transfer = { controller: new AbortController(), transferId: crypto.randomUUID() }
          upload.current = transfer
          staged = await stageComposerFile(row.file, window.api.uploads, {
            transferId: transfer.transferId,
            name: row.file.name,
            signal: transfer.controller.signal,
            onProgress: (value) => {
              if (active.current) setProgress(value)
            }
          })
          await window.api.uploads.claimLocalFile?.({ transferId: transfer.transferId })
          if (transfer.controller.signal.aborted || !active.current)
            throw new DOMException('Upload cancelled.', 'AbortError')
          // Once submitted, finish the write before stopping; the upload is no longer cancellable.
          upload.current = undefined
          if (active.current) setProgress(undefined)
          await window.api.literature.importPdf({ itemId: row.itemId, attachment: staged })
          row.status = 'done'
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const conflict = message.includes(LITERATURE_IMPORT_IDENTITY_CONFLICT)
          row.uncertain = creating && !conflict
          row.status = 'error'
          row.error = row.uncertain
            ? t(
                'The result could not be confirmed. Check your library before importing this file again.'
              )
            : conflict
              ? t('Conflicting identifiers')
              : stopped.current
                ? t('PDF upload cancelled. The reference was kept.')
                : row.itemId
                  ? t('The reference was kept. Retry to finish adding its PDF.')
                  : t('PDF could not be added.')
        } finally {
          if (staged)
            await window.api.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
          upload.current = undefined
          if (active.current) setProgress(undefined)
          publish()
        }
      }
    } finally {
      running.current = false
      if (active.current) {
        setBusy(false)
        setStopping(false)
      }
    }
  }
  const completed = rows.filter((row) => row.status === 'done').length
  const remaining = rows.filter(
    (row) => row.checked && row.status !== 'done' && !row.uncertain
  ).length
  const selectable = rows.filter((row) => row.status !== 'done' && !row.uncertain)
  const labels = {
    pending: t('Pending'),
    reading: t('Reading…'),
    ready: t('Ready'),
    importing: t('Importing…'),
    done: t('Completed'),
    error: t('Failed')
  }
  return (
    <LiteratureImportDialogFrame
      title={t('Import PDFs')}
      description={t(
        'Review the files, then import the selected PDFs. Keep this window open until the batch finishes.'
      )}
      busy={busy}
      onClose={onClose}
      footer={
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-300/80 px-5 py-4">
          {busy ? (
            <Button variant="outline" disabled={stopping} onClick={stop}>
              {stopping ? t('Stopping…') : t('Stop')}
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {completed ? t('Done') : t('Cancel')}
            </Button>
          )}
          <Button disabled={reading || busy || remaining === 0} onClick={() => void run()}>
            {rows.some((row) => row.itemId || row.status === 'error')
              ? t('Retry unfinished')
              : t('Import selected')}
          </Button>
        </div>
      }
    >
      <div className="min-h-0 space-y-4 overflow-y-auto p-5">
        <p className="text-sm [overflow-wrap:anywhere]">
          {t('Import to')} · <strong>{destination.name}</strong>
        </p>
        <LiteratureDuplicatePolicyField value={policy} onChange={setPolicy} disabled={busy} />
        <p className="text-xs text-muted-foreground">
          {t(
            'PDFs are attached to matching references. Identical attachments are reused; different PDFs are kept separately.'
          )}
        </p>
        <div role="status" className="space-y-2 text-sm">
          <p>
            {reading
              ? t('Reading…')
              : t('{{completed}} / {{total}} completed', { completed, total: rows.length })}
          </p>
          {stopping ? (
            <p>
              {t('Finishing the current operation before stopping. Completed references are kept.')}
            </p>
          ) : null}
          {progress ? (
            <>
              <p className="break-all">{progress.name}</p>
              <progress
                aria-label={t('Upload progress')}
                className="h-2 w-full accent-primary"
                max={Math.max(1, progress.totalBytes)}
                value={progress.receivedBytes}
              />
              <p className="text-xs text-muted-foreground">
                {t('{{received}} / {{total}} bytes uploaded', {
                  received: progress.receivedBytes.toLocaleString(),
                  total: progress.totalBytes.toLocaleString()
                })}
              </p>
            </>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={busy || selectable.length === 0}
            checked={selectable.length > 0 && selectable.every((row) => row.checked)}
            onChange={(event) => selectAll(event.target.checked)}
          />
          {t('Select all')}
        </label>
        <ul className="divide-y divide-border-300/80 rounded-lg border border-border-300/80">
          {rows.slice(0, visible).map((row, index) => (
            <li key={index} className="space-y-2 px-3 py-3">
              <div className="flex items-start gap-3">
                <input
                  className="mt-1"
                  type="checkbox"
                  aria-label={t('Select {{name}}', { name: row.file.name })}
                  disabled={busy || row.status === 'done' || row.uncertain}
                  checked={row.checked}
                  onChange={(event) => {
                    rowsRef.current[index].checked = event.target.checked
                    publish()
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{row.draft.title}</p>
                  <p className="break-all text-xs text-muted-foreground">{row.file.name}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {!row.checked ? t('Skipped') : labels[row.status]}
                </span>
              </div>
              {row.error ? <LiteratureErrorNotice title={row.error} /> : null}
            </li>
          ))}
        </ul>
        {visible < rows.length ? (
          <Button variant="ghost" onClick={() => setVisible((value) => value + 100)}>
            {t('Show more')}
          </Button>
        ) : null}
      </div>
    </LiteratureImportDialogFrame>
  )
}
