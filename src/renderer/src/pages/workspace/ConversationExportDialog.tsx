import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, FileText, FileType2, LoaderCircle, Minus, X } from 'lucide-react'
import { Checkbox, Dialog, RadioGroup } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn } from '@/lib/utils'
import type { ChatSession } from '@/stores/session-store'
import {
  createConversationExportDocument,
  createConversationExportTurns,
  type ConversationExportFormat,
  type ExportConversationRequest,
  type ExportConversationResult
} from '../../../../shared/conversation-export'
import { projectPresentedSessionActionability } from './session-wait-reason'

type ConversationExportDialogProps = {
  session: ChatSession | undefined
  currentSession: ChatSession | undefined
  onClose: () => void
  onExport?: (request: ExportConversationRequest) => Promise<ExportConversationResult>
}

type ExportScope = 'entire' | 'selected'

const normalizePreview = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const attachmentCountFor = (session: ChatSession, messageIds: ReadonlySet<string>): number => {
  const artifactIds = new Set<string>()
  let count = 0

  for (const message of session.messages) {
    if (!messageIds.has(message.id)) continue
    count += (message.uploads?.length ?? 0) + (message.images?.length ?? 0)
    for (const artifactId of message.artifactIds ?? []) artifactIds.add(artifactId)
  }

  return count + artifactIds.size
}

const ConversationExportDialogContent = ({
  session,
  currentSession,
  open,
  onClose,
  onExport
}: ConversationExportDialogProps & { session: ChatSession; open: boolean }): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const [format, setFormat] = useState<ConversationExportFormat>('pdf')
  const [scope, setScope] = useState<ExportScope>('entire')
  const [selectedPromptIds, setSelectedPromptIds] = useState<ReadonlySet<string>>(new Set())
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState<string>()
  const turns = useMemo(() => createConversationExportTurns(session.messages), [session.messages])
  const conversationChanged = useMemo(() => {
    if (!currentSession) return true
    const snapshot = createConversationExportDocument(session, 0)
    const current = createConversationExportDocument(currentSession, 0)
    return JSON.stringify(snapshot) !== JSON.stringify(current)
  }, [currentSession, session])
  const allSelected = turns.length > 0 && selectedPromptIds.size === turns.length
  const partlySelected = selectedPromptIds.size > 0 && !allSelected
  const unavailable = currentSession
    ? projectPresentedSessionActionability(currentSession).activity !== 'inactive'
    : true
  const noSelection = scope === 'selected' && selectedPromptIds.size === 0
  const disabled = unavailable || conversationChanged || noSelection || isExporting

  const toggleTurn = (promptMessageId: string): void => {
    setError(undefined)
    setSelectedPromptIds((current) => {
      const next = new Set(current)
      if (next.has(promptMessageId)) next.delete(promptMessageId)
      else next.add(promptMessageId)
      return next
    })
  }

  const toggleAll = (): void => {
    setError(undefined)
    setSelectedPromptIds(
      allSelected ? new Set() : new Set(turns.map((turn) => turn.promptMessageId))
    )
  }

  const submit = async (): Promise<void> => {
    if (disabled) return
    const exporter = onExport ?? window.api?.sessions?.exportConversation
    if (!exporter) return

    setIsExporting(true)
    setError(undefined)
    try {
      const result = await exporter({
        projectId: session.projectId,
        sessionId: session.id,
        format,
        ...(scope === 'selected'
          ? {
              selectedPromptMessageIds: turns.flatMap((turn) =>
                selectedPromptIds.has(turn.promptMessageId) ? [turn.promptMessageId] : []
              )
            }
          : {})
      })
      if (result.saved) onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsExporting(false)
    }
  }

  const exportLabel = format === 'pdf' ? t('Export PDF') : t('Export Markdown')

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isExporting) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[min(760px,calc(100svh-2rem))] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden p-0 max-sm:h-[calc(100svh-1rem)] max-sm:max-h-none max-sm:w-[calc(100vw-1rem)]'
          )}
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border-300/90 px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-text-000">
                {t('Export conversation')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 truncate text-sm text-muted-foreground">
                {session.title || t('Untitled conversation')}
              </Dialog.Description>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              disabled={isExporting}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </header>

          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5">
            <section aria-labelledby="conversation-export-format" className="grid gap-2.5">
              <h2 id="conversation-export-format" className="text-sm font-medium text-text-000">
                {t('Format')}
              </h2>
              <RadioGroup.Root
                value={format}
                onValueChange={(value) => setFormat(value as ConversationExportFormat)}
                className="grid grid-cols-2 gap-2 max-[420px]:grid-cols-1"
              >
                {(
                  [
                    ['pdf', FileType2, t('PDF'), t('Best for sharing and printing.')],
                    ['markdown', FileText, t('Markdown'), t('Best for editing and reuse.')]
                  ] as const
                ).map(([value, Icon, label, description]) => (
                  <RadioGroup.Item
                    key={value}
                    value={value}
                    aria-label={label}
                    className="group flex min-h-16 items-start gap-3 rounded-xl border border-border-200 bg-bg-000 px-3.5 py-3 text-left outline-none transition-colors hover:border-border-100 hover:bg-bg-100 focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=checked]:border-text-200 data-[state=checked]:bg-bg-100"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-200 text-text-100 group-data-[state=checked]:text-text-000">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-000">{label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {description}
                      </span>
                    </span>
                    <span className="ms-auto mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-100 group-data-[state=checked]:border-text-000">
                      <RadioGroup.Indicator className="size-2 rounded-full bg-text-000" />
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </section>

            <section aria-labelledby="conversation-export-content" className="mt-5 grid gap-2.5">
              <h2 id="conversation-export-content" className="text-sm font-medium text-text-000">
                {t('Content')}
              </h2>
              <RadioGroup.Root
                value={scope}
                onValueChange={(value) => {
                  setScope(value as ExportScope)
                  setError(undefined)
                }}
                className="grid grid-cols-2 gap-2 max-[420px]:grid-cols-1"
              >
                {(
                  [
                    ['entire', t('Entire conversation'), t('Include the entire branch.')],
                    ['selected', t('Selected'), t('Choose only what you need.')]
                  ] as const
                ).map(([value, label, description]) => (
                  <RadioGroup.Item
                    key={value}
                    value={value}
                    className="group flex min-h-14 items-start gap-3 rounded-xl border border-border-200 bg-bg-000 px-3.5 py-3 text-left outline-none transition-colors hover:border-border-100 hover:bg-bg-100 focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=checked]:border-text-200 data-[state=checked]:bg-bg-100"
                  >
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-100 group-data-[state=checked]:border-text-000">
                      <RadioGroup.Indicator className="size-2 rounded-full bg-text-000" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-000">{label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {description}
                      </span>
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </section>

            {scope === 'selected' ? (
              <section aria-labelledby="conversation-export-turns" className="mt-5">
                <div className="mb-2.5 flex items-center justify-between gap-4">
                  <div>
                    <h2
                      id="conversation-export-turns"
                      className="text-sm font-medium text-text-000"
                    >
                      {t('Conversation')}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('{{selected}} of {{total}} selected', {
                        selected: selectedPromptIds.size,
                        total: turns.length
                      })}
                    </p>
                  </div>
                  <Checkbox.Root
                    checked={allSelected ? true : partlySelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAll}
                    className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm font-medium text-text-100 outline-none hover:bg-bg-100 focus-visible:ring-3 focus-visible:ring-ring/40"
                  >
                    <span className="flex size-4 items-center justify-center rounded border border-border-100 bg-bg-000 text-text-000">
                      <Checkbox.Indicator>
                        {partlySelected ? (
                          <Minus className="size-3" aria-hidden="true" />
                        ) : (
                          <Check className="size-3" aria-hidden="true" />
                        )}
                      </Checkbox.Indicator>
                    </span>
                    {t('Select all')}
                  </Checkbox.Root>
                </div>

                <div
                  className="grid min-w-0 gap-2"
                  role="group"
                  aria-label={t('Content to export')}
                >
                  {turns.map((turn) => {
                    const selected = selectedPromptIds.has(turn.promptMessageId)
                    const firstResponse = turn.messages.find((message) => message.role === 'agent')
                    const messageIds = new Set(turn.messages.map((message) => message.id))
                    const attachmentCount = attachmentCountFor(session, messageIds)
                    const prompt = normalizePreview(turn.prompt.content) || t('Prompt without text')
                    const response = firstResponse
                      ? normalizePreview(firstResponse.content) || t('Response without text')
                      : t('No response yet')

                    return (
                      <Checkbox.Root
                        key={turn.promptMessageId}
                        checked={selected}
                        onCheckedChange={() => toggleTurn(turn.promptMessageId)}
                        className="group flex min-h-20 w-full min-w-0 items-start gap-3 rounded-xl border border-border-200 bg-bg-000 px-3.5 py-3 text-left outline-none transition-colors hover:border-border-100 hover:bg-bg-100 focus-visible:ring-3 focus-visible:ring-ring/40 data-[state=checked]:border-text-200 data-[state=checked]:bg-bg-100"
                      >
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border-100 bg-bg-000 text-text-000 group-data-[state=checked]:border-text-000">
                          <Checkbox.Indicator>
                            <Check className="size-3" aria-hidden="true" />
                          </Checkbox.Indicator>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-000">
                            {prompt}
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {response}
                          </span>
                          <span className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] text-text-300">
                            <time>{formatDate(turn.prompt.createdAt)}</time>
                            {attachmentCount > 0 ? (
                              <span>{t('Attachments: {{total}}', { total: attachmentCount })}</span>
                            ) : null}
                          </span>
                        </span>
                      </Checkbox.Root>
                    )
                  })}
                </div>
              </section>
            ) : null}
          </div>

          <footer className="shrink-0 border-t border-border-300/90 bg-card px-5 py-3.5">
            <div className="mb-3 min-h-5 text-xs">
              {conversationChanged ? (
                <p className="text-muted-foreground">
                  {t('The conversation changed. Close and reopen export to review it.')}
                </p>
              ) : error ? (
                <p role="alert" className="text-danger-000">
                  {error}
                </p>
              ) : unavailable ? (
                <p className="text-muted-foreground">
                  {t('Wait for the conversation to finish before exporting it.')}
                </p>
              ) : noSelection ? (
                <p className="text-muted-foreground">{t('Select content to export.')}</p>
              ) : (
                <p className="text-muted-foreground">
                  {scope === 'entire'
                    ? t('The entire conversation will be exported.')
                    : t('Only selected content will be exported.')}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                className={cn(dialogCancelButtonClassName, 'min-h-9')}
                disabled={isExporting}
                onClick={onClose}
              >
                {t('Cancel')}
              </Button>
              <Button
                data-testid="conversation-export-confirm"
                type="button"
                className="min-h-9 min-w-28"
                disabled={disabled}
                onClick={submit}
              >
                {isExporting ? (
                  <>
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {t('Exporting…')}
                  </>
                ) : (
                  <>
                    <Download className="size-4" aria-hidden="true" />
                    {exportLabel}
                  </>
                )}
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const ConversationExportDialog = ({
  session,
  currentSession,
  onClose,
  onExport
}: ConversationExportDialogProps): React.JSX.Element => {
  const retainedSession = useRetainedDialogValue(session)
  if (!retainedSession) return <></>

  return (
    <ConversationExportDialogContent
      key={retainedSession.id}
      session={retainedSession}
      currentSession={currentSession}
      open={Boolean(session)}
      onClose={onClose}
      onExport={onExport}
    />
  )
}

export { ConversationExportDialog }
export type { ConversationExportDialogProps }
