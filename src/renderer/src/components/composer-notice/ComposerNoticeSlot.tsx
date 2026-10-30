import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PauseCircle,
  CircleAlert,
  Info,
  TriangleAlert,
  ChevronDown,
  Check,
  LoaderCircle
} from 'lucide-react'
import { Notice, NoticeDiagnostics } from '@/components/notice'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  formatNoticeDiagnostics,
  noticePresentation,
  type ComposerNotice,
  type NoticeActionHandlers,
  type NoticeActionId
} from '@/lib/composer-notice/catalog'

const TruncatedText = ({
  text,
  lines = 1,
  className
}: {
  text: string
  lines?: 1 | 2
  className?: string
}): React.JSX.Element => {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void =>
      setTruncated(
        element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight
      )
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, lines])
  const content = (
    <span
      ref={ref}
      className={cn(
        'block min-w-0',
        lines === 1 ? 'truncate' : 'line-clamp-2 break-words',
        className
      )}
    >
      {text}
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      {truncated ? (
        <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">{text}</TooltipContent>
      ) : null}
    </Tooltip>
  )
}

export const ComposerNoticeSlot = ({
  notices,
  handlers,
  onDismiss
}: {
  notices: readonly ComposerNotice[]
  handlers: NoticeActionHandlers
  onDismiss?: (notice: ComposerNotice) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<{ id: string; leaderId: string }>()
  const [pending, setPending] = useState<ReadonlyMap<string, NoticeActionId>>(new Map())
  const [inFlight] = useState(() => new Map<string, NoticeActionId>())
  const [copiedId, setCopiedId] = useState<string>()
  useEffect(() => {
    if (!copiedId) return
    const timeout = setTimeout(() => setCopiedId(undefined), 2500)
    return () => clearTimeout(timeout)
  }, [copiedId])
  const [actionFailure, setActionFailure] = useState<{ id: string; message: string }>()
  const current =
    (selected?.leaderId === notices[0]?.id
      ? notices.find(({ id }) => id === selected?.id)
      : undefined) ?? notices[0]
  if (!current) return null
  const presentation = noticePresentation(current.failure)
  const title = t(presentation.titleKey)
  const description = t(presentation.descriptionKey)
  const diagnosticText = formatNoticeDiagnostics(current, title, description)
  const diagnosticFields = Object.entries(current.failure.diagnostics).filter(
    ([key, value]) => key !== 'raw' && value !== undefined
  )
  const labels: Record<NoticeActionId, string> = {
    'export-diagnostics': t('Export diagnostics…'),
    'open-agent-settings': t('Agent settings'),
    'choose-specialist': t('Choose another specialist'),
    'use-main-agent': t('Use None (Main Agent)'),
    retry: t('Retry'),
    resume: t('Resume'),
    'open-provider-settings': t('Model settings'),
    'open-environment': t('Open Settings'),
    compact: t('Compact context'),
    'remove-attachments': t('Remove attachments'),
    'new-session': t('New conversation'),
    'copy-error': t('Copy error'),
    report: t('Report error')
  }
  const run = async (action: NoticeActionId, notice: ComposerNotice): Promise<void> => {
    if (inFlight.has(notice.id)) return
    inFlight.set(notice.id, action)
    setPending(new Map(inFlight))
    setActionFailure(undefined)
    setCopiedId(undefined)
    try {
      if (action === 'copy-error') {
        const copy = noticePresentation(notice.failure)
        await navigator.clipboard.writeText(
          formatNoticeDiagnostics(notice, t(copy.titleKey), t(copy.descriptionKey))
        )
        setCopiedId(notice.id)
      } else await handlers[action]?.run(notice)
    } catch (error) {
      setActionFailure({
        id: notice.id,
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      inFlight.delete(notice.id)
      setPending(new Map(inFlight))
    }
  }
  const available = (action: NoticeActionId, notice = current): boolean =>
    action === 'copy-error' ||
    Boolean(handlers[action] && (handlers[action]?.available?.(notice) ?? true))
  const primary = available(presentation.primaryAction)
    ? presentation.primaryAction
    : presentation.primaryAction === 'open-environment' && available('retry')
      ? 'retry'
      : undefined
  const actionButton = (
    action: NoticeActionId,
    notice: ComposerNotice,
    main = false
  ): React.JSX.Element | null =>
    available(action, notice) ? (
      <Button
        key={action}
        type="button"
        size="default"
        variant={main ? 'default' : action === 'copy-error' ? 'ghost' : 'outline'}
        className={cn(
          'focus-visible:transition-none',
          action === 'copy-error' && 'text-muted-foreground'
        )}
        data-notice-action={action}
        aria-label={
          action === 'report'
            ? t('Report this error')
            : action === 'resume'
              ? t('Resume session')
              : action === 'retry' && notice.recovery === 'retry-artifact-publication'
                ? t('Retry Artifact publication')
                : labels[action]
        }
        disabled={
          pending.has(notice.id) || handlers[action]?.busy || handlers[action]?.disabled?.(notice)
        }
        aria-busy={pending.get(notice.id) === action || handlers[action]?.busy || undefined}
        onClick={() => void run(action, notice)}
      >
        {pending.get(notice.id) === action || handlers[action]?.busy ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : action === 'copy-error' && copiedId === notice.id ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : null}
        {action === 'copy-error' && copiedId === notice.id
          ? t('Copied')
          : action === 'resume' && handlers.resume?.busy
            ? t('Resuming…')
            : action === 'retry' && notice.recovery === 'retry-artifact-publication'
              ? t('Retry Artifact publication')
              : labels[action]}
      </Button>
    ) : null
  return (
    <TooltipProvider delayDuration={800}>
      <Notice
        data-testid="composer-notice-slot"
        data-slot={
          current.source === 'session'
            ? 'session-recovery-notice'
            : current.source === 'turn'
              ? 'turn-outcome-notice'
              : undefined
        }
        data-notice-operation={current.operation}
        data-prompt-message-id={current.promptMessageId}
        data-notice-category={current.failure.category}
        level={presentation.level}
        icon={current.failure.category === 'session' ? PauseCircle : undefined}
        iconClassName={current.failure.category === 'session' ? 'text-muted-foreground' : undefined}
        className="mb-2 min-w-0 gap-2 [&_pre]:max-h-40 [&_pre]:overflow-auto"
        content={
          <>
            <div
              role={presentation.level === 'error' ? 'alert' : 'status'}
              aria-atomic="true"
              className="space-y-1"
            >
              <h2 className="min-w-0 text-sm font-semibold leading-5 text-foreground">
                <TruncatedText text={title} />
              </h2>
              <TruncatedText
                text={description}
                lines={2}
                className="text-sm font-normal leading-5 text-muted-foreground"
              />
            </div>
            <NoticeDiagnostics
              key={current.id}
              errorCode={`${diagnosticText}${actionFailure?.id === current.id ? `\n${actionFailure.message}` : ''}`}
              diagnosticsLabel={t('Details')}
              summaryContent={
                diagnosticFields.length > 0 ? (
                  <span className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden tabular-nums border-r border-border pr-3">
                    {diagnosticFields.map(([key, value], index) => (
                      <Fragment key={key}>
                        {index > 0 ? (
                          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
                        ) : null}
                        <TruncatedText
                          text={`${key}: ${value}`}
                          className={key === 'status' ? 'shrink-0' : 'flex-1'}
                        />
                      </Fragment>
                    ))}
                  </span>
                ) : undefined
              }
            />
            {actionFailure?.id === current.id ? (
              <p role="alert" className="text-sm text-destructive">
                {t('The action could not be completed. See details and try again.')}
              </p>
            ) : null}
          </>
        }
        dismissButton={
          onDismiss && current.failure.category !== 'session'
            ? {
                label: t('Dismiss error'),
                onClick: () => {
                  onDismiss(current)
                  setSelected(undefined)
                }
              }
            : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {presentation.feedback === 'link' && handlers.report ? (
            <button
              type="button"
              className="min-h-8 rounded-sm text-left text-xs leading-5 text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:keyboard-focus active:text-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={pending.has(current.id)}
              onClick={() => void run('report', current)}
            >
              {t('Still need help? Report this error')}
            </button>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {actionButton('copy-error', current)}
            {presentation.secondaryActions
              .filter((action) => action !== primary)
              .map((action) => actionButton(action, current))}
            {primary ? actionButton(primary, current, true) : null}
          </div>
        </div>
        {notices.length > 1 ? (
          <div className="min-w-0 pt-1">
            <button
              type="button"
              className="inline-flex min-h-8 items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground hover:text-foreground focus-visible:keyboard-focus active:text-foreground"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? t('Show less')
                : t('{{count}} more notices', {
                    count: notices.length - 1,
                    defaultValue_one: '{{count}} more notice'
                  })}
              <ChevronDown aria-hidden="true" className={cn('size-3', expanded && 'rotate-180')} />
            </button>
            {expanded ? (
              <ul className="mt-1 flex min-w-0 flex-col gap-1">
                {notices
                  .filter(({ id }) => id !== current.id)
                  .map((notice) => {
                    const item = noticePresentation(notice.failure)
                    const Icon =
                      notice.failure.category === 'session'
                        ? PauseCircle
                        : item.level === 'error'
                          ? CircleAlert
                          : item.level === 'warning'
                            ? TriangleAlert
                            : Info
                    return (
                      <li key={notice.id} className="flex min-w-0 items-center gap-2">
                        <Icon
                          aria-hidden="true"
                          className={cn(
                            'size-4 shrink-0',
                            notice.failure.category === 'session'
                              ? 'text-muted-foreground'
                              : item.level === 'error'
                                ? 'text-status-failure-foreground'
                                : item.level === 'warning'
                                  ? 'text-status-warning-foreground'
                                  : 'text-status-info-foreground'
                          )}
                        />
                        <button
                          type="button"
                          className="min-h-8 min-w-0 flex-1 rounded-sm text-left text-sm text-foreground hover:underline focus-visible:keyboard-focus active:text-foreground"
                          data-select-notice={notice.id}
                          onClick={() => {
                            setSelected({ id: notice.id, leaderId: notices[0].id })
                            setExpanded(false)
                          }}
                        >
                          <TruncatedText text={t(item.titleKey)} />
                        </button>
                        {actionButton(item.primaryAction, notice)}
                      </li>
                    )
                  })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Notice>
    </TooltipProvider>
  )
}
