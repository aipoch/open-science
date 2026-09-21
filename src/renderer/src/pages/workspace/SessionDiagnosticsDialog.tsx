import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, LoaderCircle } from 'lucide-react'
import { Checkbox } from 'radix-ui'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { formatByteSize } from '@/lib/utils'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogBodyClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import type {
  SessionDiagnosticIdentity,
  SessionDiagnosticItem,
  SessionDiagnosticExportResult
} from '../../../../shared/session-diagnostics'

// Translate fixed application guidance; arbitrary backend details stay in the technical report.
function diagnosticError(message: string | undefined, t: TFunction): string | undefined {
  if (!message) return undefined
  switch (message) {
    case 'Choose a location outside application data and log folders.':
      return t('Choose a location outside application data and log folders.')
    case 'The selected file already exists. Choose a new filename.':
      return t('The selected file already exists. Choose a new filename.')
    case 'Diagnostic operation timed out.':
      return t('Diagnostic operation timed out.')
    case 'Temporary diagnostic files could not be fully removed.':
      return t('Temporary diagnostic files could not be fully removed.')
    case 'Choose a new .tar.gz file.':
      return t('Choose a new .tar.gz file.')
    default:
      return t('Diagnostic export failed.')
  }
}

function diagnosticSourceCode(reason: string | undefined): string {
  return (
    reason?.match(
      /\((ENOENT|EACCES|EPERM|EIO|ENOSPC|SQLITE_BUSY|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_ERROR)\)/
    )?.[1] ?? ''
  )
}

export const SessionDiagnosticsDialog = ({
  identity,
  onClose
}: {
  identity: SessionDiagnosticIdentity
  onClose: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [items, setItems] = useState<SessionDiagnosticItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<SessionDiagnosticExportResult>()
  const operation = useRef<string | undefined>(undefined)
  const activeExport = useRef<
    | {
        operationId: string
        promise: Promise<SessionDiagnosticExportResult>
      }
    | undefined
  >(undefined)
  const closing = useRef(false)
  const mounted = useRef(true)
  const { projectId, sessionId } = identity

  useEffect(() => {
    mounted.current = true
    const operationId = crypto.randomUUID()
    operation.current = operationId
    void window.api.sessions
      .inspectDiagnostics({ projectId, sessionId, operationId })
      .then((inspection) => {
        if (!mounted.current || operation.current !== operationId) return
        setItems(inspection.items)
        setSelected(
          inspection.items
            .filter((item) => item.available && (item.kind !== 'log' || item.id === 'log:main.log'))
            .map((item) => item.id)
        )
        setError(diagnosticError(inspection.error, t))
      })
      .catch(() => {
        if (mounted.current && operation.current === operationId)
          setError(t('Could not inspect diagnostic sources.'))
      })
      .finally(() => {
        if (mounted.current && operation.current === operationId) {
          operation.current = undefined
          setBusy(false)
        }
      })
    return () => {
      mounted.current = false
      const active = operation.current
      operation.current = undefined
      if (active)
        void window.api.sessions.cancelDiagnostics({ operationId: active }).catch(() => undefined)
    }
  }, [projectId, sessionId, t])

  const close = async (): Promise<void> => {
    if (closing.current) return
    closing.current = true
    const active = operation.current
    const exporting = activeExport.current
    try {
      if (active) {
        await window.api.sessions.cancelDiagnostics({ operationId: active })
        // Cancellation joins worker cleanup, but the final report may still be being saved.
        const exported = exporting?.operationId === active ? await exporting.promise : undefined
        if (!mounted.current) return
        if (exported?.error) return
        if (operation.current === active) operation.current = undefined
      }
      if (mounted.current) onClose()
    } catch {
      if (mounted.current) setError(t('Could not cancel diagnostic export.'))
    } finally {
      closing.current = false
    }
  }
  const exportSelected = async (): Promise<void> => {
    const operationId = crypto.randomUUID()
    operation.current = operationId
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      const promise = window.api.sessions.exportDiagnostics({
        projectId,
        sessionId,
        operationId,
        selectedItems: selected
      })
      activeExport.current = { operationId, promise }
      const exported = await promise
      if (mounted.current && operation.current === operationId) {
        setResult(exported)
        setError(diagnosticError(exported.error, t))
      }
    } catch {
      if (mounted.current && operation.current === operationId)
        setError(t('Diagnostic export failed.'))
    } finally {
      if (activeExport.current?.operationId === operationId) activeExport.current = undefined
      if (mounted.current && operation.current === operationId) {
        operation.current = undefined
        setBusy(false)
      }
    }
  }
  const revealPath = result?.path ?? result?.reportPath
  const separateReportPath = result?.reportPath !== revealPath ? result?.reportPath : undefined
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[80vh] w-[min(560px,calc(100vw-2rem))] flex-col p-0'
          )}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className={`${dialogHeaderClassName} flex-col items-start`}>
            <Dialog.Title className={dialogTitleClassName}>{t('Export diagnostics')}</Dialog.Title>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'Exports diagnostic metadata with private content fields excluded. Saved locally; nothing is uploaded or sent to an LLM. The archive always includes a manifest and export log; missing sources do not stop the export. Damaged or large files may include only a summary. Include screenshots when reporting an issue to developers.'
              )}
            </Dialog.Description>
          </div>
          <div className={`${dialogBodyClassName} min-h-0 overflow-auto`}>
            {busy && (
              <p role="status" className="flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t('Preparing diagnostics…')}
              </p>
            )}
            <div className="mt-3 space-y-2">
              {items.map((item) => {
                const label = item.kind === 'database' ? t('Session database records') : item.name
                const description =
                  item.kind === 'log'
                    ? item.id === 'log:main.log'
                      ? t(
                          'Current application log metadata, including activity outside this session.'
                        )
                      : t(
                          'Historical application log metadata, including activity outside this session. Select manually to investigate earlier issues.'
                        )
                    : undefined
                const sourceCode = diagnosticSourceCode(item.reason)
                const size = formatByteSize(item.sizeBytes)

                return (
                  <Checkbox.Root
                    key={item.id}
                    checked={selected.includes(item.id)}
                    disabled={busy || !item.available}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked === true
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id)
                      )
                    }
                    className="group flex min-h-14 w-full min-w-0 items-start gap-3 rounded-xl border border-transparent bg-bg-000 px-3.5 py-3 text-left outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-primary/5 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/40 active:translate-y-0 active:shadow-none data-[state=checked]:border-primary/30 data-[state=checked]:bg-primary/5 data-[state=checked]:hover:border-primary/50 data-[state=checked]:hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transform-none motion-reduce:transition-none"
                  >
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border-100 bg-bg-000 text-text-000 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
                      <Checkbox.Indicator>
                        <Check className="size-3" aria-hidden="true" />
                      </Checkbox.Indicator>
                    </span>
                    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1">
                      <span className="min-w-0 break-words text-sm font-medium text-text-000">
                        {label}
                      </span>
                      {size && (
                        <span className="shrink-0 whitespace-nowrap text-xs text-text-300">
                          {size}
                        </span>
                      )}
                      {description && (
                        <span className="col-span-2 text-xs leading-5 text-text-300">
                          {description}
                        </span>
                      )}
                      {!item.available && (
                        <span className="col-span-2 text-xs leading-5 text-text-300">
                          {t('Unavailable')}
                          {sourceCode ? `: ${sourceCode}` : ''}
                        </span>
                      )}
                    </span>
                  </Checkbox.Root>
                )
              })}
            </div>
            {result && (
              <p role="status">
                {result.status === 'exported'
                  ? t('Diagnostics exported.')
                  : result.status === 'partial'
                    ? t('Diagnostics exported with missing information.')
                    : result.status === 'cancelled'
                      ? t('Export cancelled.')
                      : t('Diagnostic export failed.')}
              </p>
            )}
            {error && <ErrorNotice inline role="alert" title={t('Error')} description={error} />}
            {revealPath && <p className="select-text break-all text-xs">{revealPath}</p>}
            {separateReportPath && (
              <p className="select-text break-all text-xs">{separateReportPath}</p>
            )}
            {result?.report && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap select-text text-xs">
                {result.report}
              </pre>
            )}
          </div>
          <div className={dialogFooterClassName}>
            <Button variant="outline" onClick={() => void close()}>
              {busy ? t('Cancel') : t('Close')}
            </Button>
            {revealPath && window.api.compute?.revealInFolder && (
              <Button
                variant="outline"
                onClick={() => {
                  void window.api.compute
                    .revealInFolder(revealPath)
                    .catch(() => setError(t('Could not show the exported file.')))
                }}
              >
                {t('Show in folder')}
              </Button>
            )}
            {separateReportPath && window.api.compute?.revealInFolder && (
              <Button
                variant="outline"
                onClick={() => {
                  void window.api.compute
                    .revealInFolder(separateReportPath)
                    .catch(() => setError(t('Could not show the exported file.')))
                }}
              >
                {t('Show export log')}
              </Button>
            )}
            <Button disabled={busy} onClick={() => void exportSelected()}>
              {t('Export')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
