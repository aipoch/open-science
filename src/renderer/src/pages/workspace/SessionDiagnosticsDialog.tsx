import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, CircleCheck, CircleAlert, FileArchive, LoaderCircle, X } from 'lucide-react'
import { Checkbox } from 'radix-ui'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { FieldHelp } from '@/components/FieldHelp'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatByteSize } from '@/lib/utils'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogBodyClassName,
  dialogFooterClassName,
  dialogCloseButtonClassName
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

type DiagnosticChoice = {
  id: string
  label: string
  description?: string
  items: SessionDiagnosticItem[]
  fileItems?: SessionDiagnosticItem[]
  candidateFiles?: string[]
  notebook?: boolean
}

const sourceStatus = (item: SessionDiagnosticItem, t: TFunction): string =>
  item.available ? t('Ready for export') : t('Unavailable')

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
  const [includeExecutionCode, setIncludeExecutionCode] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [reportCopied, setReportCopied] = useState(false)
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
  const hasSelectedNotebook = items.some(
    (item) => item.kind === 'notebook' && item.available && selected.includes(item.id)
  )

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
            .filter(
              (item) =>
                item.available &&
                (item.kind !== 'log' || item.id === 'log:main.log') &&
                item.kind !== 'sensitive-file'
            )
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
        // Cancellation joins worker cleanup; also await the final report returned by export.
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
    setReportCopied(false)
    try {
      const promise = window.api.sessions.exportDiagnostics({
        projectId,
        sessionId,
        operationId,
        selectedItems: selected,
        ...(includeExecutionCode && hasSelectedNotebook ? { includeExecutionCode: true } : {})
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
  const revealPath = result?.path
  const single = (
    item: SessionDiagnosticItem,
    label: string,
    description?: string,
    candidateFiles?: string[]
  ): DiagnosticChoice => ({ id: item.id, label, description, items: [item], candidateFiles })
  const notebookItems = items.filter((item) => item.kind === 'notebook')
  const notebookFiles = notebookItems.filter((item) => item.id !== 'notebook:frames-limited')
  const sections: { title: string; choices: DiagnosticChoice[] }[] = [
    {
      title: t('Session and execution'),
      choices: [
        ...items
          .filter((item) => item.kind === 'session')
          .map((item) =>
            single(
              item,
              t('Session state'),
              t(
                'Session state, tool activity, delegation and recovery records. Full conversations are excluded.'
              )
            )
          ),
        ...(notebookItems.length
          ? [
              {
                id: 'execution-records',
                label: t('Execution records'),
                description: t(
                  'Execution states, errors and recovery details for this session and its subagents. Full standard output is excluded; saved code is optional.'
                ),
                items: notebookItems,
                fileItems: notebookFiles,
                notebook: true
              }
            ]
          : []),
        ...items
          .filter((item) => item.kind === 'database')
          .map((item) =>
            single(
              item,
              t('Related database records'),
              t('Database records linked to this session, including reviews and artifacts.'),
              ['db/*.json', 'db/ArtifactVersion.json', 'db/ReviewFindingDisposition.json']
            )
          ),
        ...items
          .filter((item) => item.kind === 'invalid-session')
          .map((item) =>
            single(
              item,
              t('Damaged session copy'),
              t(
                'An isolated copy of a damaged session file. Available diagnostic records or file metadata are exported.'
              )
            )
          )
      ]
    },
    {
      title: t('Application environment'),
      choices: items
        .filter((item) => item.kind === 'environment')
        .map((item) =>
          single(
            item,
            t('Versions and configuration'),
            t('Application versions and available stored configuration, captured when you export.')
          )
        )
    },
    {
      title: t('Application logs'),
      choices: items
        .filter((item) => item.kind === 'log')
        .map((item) =>
          single(
            item,
            item.id === 'log:main.log'
              ? t('Current log')
              : item.id === 'log:main.1.log'
                ? t('Historical log 1')
                : t('Historical log 2'),
            item.id === 'log:main.log'
              ? t('Current application events and errors, including activity outside this session.')
              : t(
                  'Historical application events and errors, including activity outside this session. Select manually to investigate earlier issues.'
                )
          )
        )
    },
    {
      title: t('Sensitive content'),
      choices: items
        .filter((item) => item.kind === 'sensitive-evidence' || item.kind === 'sensitive-file')
        .map((item) =>
          single(
            item,
            item.kind === 'sensitive-evidence'
              ? t('Sensitive-content evidence (redacted)')
              : t('Flagged original file'),
            item.kind === 'sensitive-evidence'
              ? t('Redacted scanner evidence for the failed Session package export.')
              : t(
                  'Original file that triggered the Session package check. It may contain credentials or research content; review it before exporting.'
                )
          )
        )
    }
  ]
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
          <div className={`${dialogHeaderClassName} flex-col items-stretch`}>
            <div className="flex w-full items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Dialog.Title className={dialogTitleClassName}>
                  {t('Export diagnostics')}
                </Dialog.Title>
                <FieldHelp
                  content={t(
                    'Individual file failures do not stop the export; details appear in the export result. Include screenshots when reporting an issue to developers.'
                  )}
                  contentClassName="max-w-[320px]"
                />
              </div>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Close')}
                      className={`${dialogCloseButtonClassName} shrink-0`}
                      onClick={() => void close()}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('Close')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'Exports diagnostic records, error details and execution errors. Review for sensitive content before sharing. Saved locally; nothing is uploaded.'
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
            <div className="mt-3 space-y-7">
              {sections
                .filter((section) => section.choices.length > 0)
                .map((section, sectionIndex) => (
                  <section key={section.title} aria-label={section.title}>
                    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-300">
                      {section.title}
                    </h3>
                    <div className="space-y-3">
                      {section.choices.map((choice, choiceIndex) => {
                        const files = choice.fileItems ?? choice.items
                        const available = files.filter((item) => item.available).length
                        const unavailable = files.length - available
                        const selectableIds = choice.items
                          .filter((item) => item.available)
                          .map((item) => item.id)
                        const selectedCount = selectableIds.filter((id) =>
                          selected.includes(id)
                        ).length
                        const knownSizes = files
                          .map((item) => item.sizeBytes)
                          .filter((size): size is number => size !== undefined)
                        const size = formatByteSize(
                          knownSizes.reduce((sum, value) => sum + value, 0)
                        )
                        const displayedSize = knownSizes.length
                          ? knownSizes.length === files.length
                            ? size
                            : t('Known size: {{size}}', { size })
                          : undefined
                        const descriptionId = `diagnostic-description-${sectionIndex}-${choiceIndex}`
                        const countId = `diagnostic-count-${sectionIndex}-${choiceIndex}`
                        const unavailableId = `diagnostic-unavailable-${sectionIndex}-${choiceIndex}`
                        const discoveryLimited = choice.items.some(
                          (item) => item.id === 'notebook:frames-limited'
                        )
                        const missing = files.every(
                          (item) => diagnosticSourceCode(item.reason) === 'ENOENT'
                        )
                        return (
                          <div
                            key={choice.id}
                            className={`overflow-hidden rounded-2xl border transition-colors ${
                              selectedCount > 0
                                ? 'border-primary/10 bg-primary/5'
                                : 'border-border-200/40 bg-bg-100/50'
                            }`}
                          >
                            <Checkbox.Root
                              aria-label={
                                choice.items[0]?.kind === 'invalid-session' ||
                                choice.items[0]?.kind === 'sensitive-file'
                                  ? `${choice.label}: ${choice.items[0].name}`
                                  : choice.label
                              }
                              aria-describedby={[
                                choice.description ? descriptionId : undefined,
                                choice.notebook ? countId : undefined,
                                available === 0 ? unavailableId : undefined
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              checked={
                                selectedCount === selectableIds.length && selectableIds.length > 0
                                  ? true
                                  : selectedCount > 0
                                    ? 'indeterminate'
                                    : false
                              }
                              disabled={busy || selectableIds.length === 0}
                              onCheckedChange={(checked) => {
                                if (choice.notebook && checked !== true)
                                  setIncludeExecutionCode(false)
                                setSelected((current) =>
                                  checked === true
                                    ? [
                                        ...current,
                                        ...selectableIds.filter((id) => !current.includes(id))
                                      ]
                                    : current.filter((id) => !selectableIds.includes(id))
                                )
                              }}
                              className="group flex min-h-14 w-full min-w-0 items-start gap-3 rounded-2xl px-4 py-4 text-left outline-none transition-[background-color,box-shadow] hover:bg-primary/5 focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-55"
                            >
                              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border-300 bg-bg-000 text-text-000 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground group-data-[state=indeterminate]:border-primary group-data-[state=indeterminate]:bg-primary group-data-[state=indeterminate]:text-primary-foreground">
                                <Checkbox.Indicator>
                                  <Check className="size-3" aria-hidden="true" />
                                </Checkbox.Indicator>
                              </span>
                              <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5">
                                <span className="min-w-0 break-words text-sm font-semibold text-text-000">
                                  {choice.label}
                                </span>
                                {displayedSize && (
                                  <span className="shrink-0 rounded-full bg-primary/7 px-2 py-0.5 whitespace-nowrap text-xs font-medium text-text-200">
                                    {displayedSize}
                                  </span>
                                )}
                                {choice.description && (
                                  <span
                                    id={descriptionId}
                                    className="col-span-2 text-xs leading-5 text-text-300"
                                  >
                                    {choice.description}
                                  </span>
                                )}
                                {choice.notebook && (
                                  <span
                                    id={countId}
                                    className="col-span-2 text-xs leading-5 text-text-300"
                                  >
                                    {t('{{available}} available, {{unavailable}} unavailable', {
                                      available,
                                      unavailable
                                    })}
                                  </span>
                                )}
                                {available === 0 && (
                                  <span
                                    id={unavailableId}
                                    className="col-span-2 text-xs leading-5 text-text-300"
                                  >
                                    {choice.notebook
                                      ? t('Execution records are unavailable for this session.')
                                      : missing
                                        ? t('This file was not found.')
                                        : t('This source could not be read.')}
                                  </span>
                                )}
                              </span>
                            </Checkbox.Root>
                            {choice.notebook && (
                              <div className="mx-4 border-t border-primary/10 py-3">
                                <Checkbox.Root
                                  aria-label={t('Include execution code')}
                                  aria-describedby={`${descriptionId}-code`}
                                  checked={includeExecutionCode && hasSelectedNotebook}
                                  disabled={busy || !hasSelectedNotebook}
                                  onCheckedChange={(checked) =>
                                    setIncludeExecutionCode(checked === true)
                                  }
                                  className="group flex items-center gap-2 rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-55"
                                >
                                  <span className="flex size-4 shrink-0 items-center justify-center rounded border border-border-300 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
                                    <Checkbox.Indicator>
                                      <Check className="size-3" aria-hidden="true" />
                                    </Checkbox.Indicator>
                                  </span>
                                  {t('Include execution code')}
                                </Checkbox.Root>
                                <p
                                  id={`${descriptionId}-code`}
                                  className="mt-1 text-xs leading-5 text-text-300"
                                >
                                  {t(
                                    'Includes saved code in selected execution records. It may contain research content, paths or credentials; review before sharing.'
                                  )}
                                </p>
                              </div>
                            )}
                            {discoveryLimited && (
                              <p className="px-3.5 pb-2 text-xs leading-5 text-status-warning-foreground dark:text-status-warning-dark-foreground">
                                {t('Some execution records could not be listed.')}
                              </p>
                            )}
                            <details className="mx-4 border-t border-primary/10 py-3 text-xs text-text-300">
                              <summary className="w-fit cursor-pointer select-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                                {t('Included files')}
                              </summary>
                              <ul className="mt-2 space-y-1.5">
                                {(choice.candidateFiles ? [] : files).map((item) => {
                                  const code = diagnosticSourceCode(item.reason)
                                  return (
                                    <li key={item.id} className="flex flex-wrap gap-x-2 break-all">
                                      <code>
                                        {item.kind === 'sensitive-evidence'
                                          ? 'sensitive-content/evidence.json'
                                          : item.name}
                                      </code>
                                      {formatByteSize(item.sizeBytes) && (
                                        <span>{formatByteSize(item.sizeBytes)}</span>
                                      )}
                                      <span>{sourceStatus(item, t)}</span>
                                      {code && <code>{code}</code>}
                                    </li>
                                  )
                                })}
                                {choice.candidateFiles?.map((path) => (
                                  <li key={path} className="flex flex-wrap gap-x-2 break-all">
                                    <code>{path}</code>
                                    <span>{t('Generated during export')}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
            </div>
            {items.some((item) => item.kind === 'sensitive-file') && (
              <p className="mt-3 text-xs leading-5 text-status-warning-foreground dark:text-status-warning-dark-foreground">
                {t(
                  'Sensitive-content files are unchecked by default. Selecting one includes its original bytes in the local diagnostic archive.'
                )}
              </p>
            )}
            {result && (
              <div className="mt-5 space-y-3 rounded-2xl bg-bg-100/60 p-4">
                <div role="status">
                  <p
                    className={`flex items-start gap-2 text-sm font-medium leading-6 ${
                      result.status === 'exported' || result.status === 'partial'
                        ? 'text-primary'
                        : 'text-text-100'
                    }`}
                  >
                    {result.status === 'exported' || result.status === 'partial' ? (
                      <CircleCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                    ) : (
                      <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                    )}
                    {result.status === 'exported' || result.status === 'partial'
                      ? t('Diagnostic package exported successfully.')
                      : result.status === 'cancelled'
                        ? t('Export cancelled.')
                        : t('Diagnostic export failed.')}
                  </p>
                  {result.status === 'partial' && (
                    <p className="text-xs leading-5 text-text-200">
                      {t('Some selected material could not be included in full.')}
                    </p>
                  )}
                </div>
                {revealPath && (
                  <div className="flex items-start gap-2.5 rounded-xl bg-bg-000/80 px-3 py-2.5">
                    <FileArchive
                      className="mt-0.5 size-4 shrink-0 text-text-300"
                      aria-hidden="true"
                    />
                    <p className="min-w-0 select-text break-all font-mono text-xs leading-5 text-text-200">
                      {revealPath}
                    </p>
                  </div>
                )}
              </div>
            )}
            {error && <ErrorNotice inline role="alert" title={t('Error')} description={error} />}
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
            {result?.report && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(result.report!)
                    if (mounted.current) setReportCopied(true)
                  } catch {
                    if (mounted.current) setError(t('Could not copy report'))
                  }
                }}
              >
                {reportCopied ? t('Copied') : t('Copy report')}
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
