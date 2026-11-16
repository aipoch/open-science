import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, LoaderCircle } from 'lucide-react'
import { Notice, type NoticeProps } from '@/components/notice'
import { Button } from '@/components/ui/button'
import {
  readableNoticeDetails,
  noticePresentation,
  type ComposerNotice,
  type NoticeActionHandlers,
  type NoticeActionId
} from '@/lib/composer-notice/catalog'

type FailureNoticeProps = {
  notices: readonly ComposerNotice[]
  handlers: NoticeActionHandlers
  onDismiss?: (notice: ComposerNotice) => void
  onRecoveryFailure?: (notice: ComposerNotice) => void
  collapsed?: boolean
  onRestore?: (notice: ComposerNotice) => void
}

// Visible cards and dismissed recovery entries share in-flight identity and feedback.
type NoticeInteractions = {
  pending: ReadonlyMap<string, NoticeActionId>
  setPending: Dispatch<SetStateAction<ReadonlyMap<string, NoticeActionId>>>
  inFlight: RefObject<Map<string, NoticeActionId>>
  copiedId: string | undefined
  setCopiedId: Dispatch<SetStateAction<string | undefined>>
  failedReady: ReadonlySet<string>
  setFailedReady: Dispatch<SetStateAction<ReadonlySet<string>>>
  actionFailure: { id: string; message: string } | undefined
  setActionFailure: Dispatch<SetStateAction<{ id: string; message: string } | undefined>>
}
const useNoticeInteractions = (): NoticeInteractions => {
  const [pending, setPending] = useState<ReadonlyMap<string, NoticeActionId>>(new Map())
  const inFlight = useRef(new Map<string, NoticeActionId>())
  const [copiedId, setCopiedId] = useState<string>()
  const [failedReady, setFailedReady] = useState<ReadonlySet<string>>(new Set())
  const [actionFailure, setActionFailure] = useState<{ id: string; message: string }>()
  useEffect(() => {
    if (!copiedId) return
    const timeout = setTimeout(() => setCopiedId(undefined), 2500)
    return () => clearTimeout(timeout)
  }, [copiedId])
  return {
    pending,
    setPending,
    inFlight,
    copiedId,
    setCopiedId,
    failedReady,
    setFailedReady,
    actionFailure,
    setActionFailure
  }
}

const ComposerFailureNoticeSlot = ({
  notices,
  handlers,
  onDismiss,
  collapsed,
  onRestore,
  onRecoveryFailure,
  interactions,
  restoreRequest
}: FailureNoticeProps & {
  interactions: ReturnType<typeof useNoticeInteractions>
  restoreRequest?: { id: string }
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [handledRestore, setHandledRestore] = useState<{ id: string }>()
  const [selected, setSelected] = useState<{ id: string; leaderId: string }>()
  const {
    pending,
    setPending,
    inFlight,
    copiedId,
    setCopiedId,
    failedReady,
    setFailedReady,
    actionFailure,
    setActionFailure
  } = interactions
  const current =
    (selected?.leaderId === notices[0]?.id
      ? notices.find(({ id }) => id === selected.id)
      : undefined) ?? notices[0]
  if (
    restoreRequest &&
    handledRestore !== restoreRequest &&
    !collapsed &&
    notices.some(({ id }) => id === restoreRequest.id)
  ) {
    setHandledRestore(restoreRequest)
    setSelected({ id: restoreRequest.id, leaderId: notices[0].id })
  }
  useLayoutEffect(() => {
    if (!collapsed && restoreRequest?.id === current?.id && detailsRef.current) {
      detailsRef.current.open = true
      summaryRef.current?.focus()
    }
  }, [current?.id, restoreRequest, collapsed])
  if (!current) return null
  const presentation = noticePresentation(current.failure, {
    ...current,
    recoveryState: failedReady.has(current.id) ? 'retry-failed' : current.recoveryState
  })
  const title = t(presentation.titleKey)
  const description = t(presentation.descriptionKey)
  const detailLabels = {
    Model: t('Model'),
    Provider: t('Provider'),
    Status: t('Status'),
    Code: t('Code'),
    Error: t('Error')
  }
  const details = readableNoticeDetails(current, title, description)
  const detailText = details
    .map(({ label, value }) => `${detailLabels[label]}: ${value}`)
    .join('\n')
  const labels: Record<NoticeActionId, string> = {
    'export-diagnostics': t('Export diagnostics…'),
    'open-agent-settings': t('Agent settings'),
    'choose-specialist': t('Choose another specialist'),
    'use-main-agent': t('Use None (Main Agent)'),
    retry: t('Retry'),
    resume: t('Retry'),
    'open-provider-settings': t('Model settings'),
    'open-environment': t('Open Settings'),
    compact: t('Compact context'),
    'remove-attachments': t('Remove attachments'),
    'new-session': t('New conversation'),
    'copy-error': t('Copy error'),
    report: t('Report error')
  }
  const available = (action: NoticeActionId, notice = current): boolean =>
    action === 'copy-error' ||
    Boolean(handlers[action] && (handlers[action]?.available?.(notice) ?? true))
  const run = async (action: NoticeActionId, notice: ComposerNotice): Promise<void> => {
    if (inFlight.current.has(notice.id)) return
    inFlight.current.set(notice.id, action)
    setPending(new Map(inFlight.current))
    setActionFailure(undefined)
    setCopiedId(undefined)
    try {
      if (action === 'copy-error') {
        await navigator.clipboard.writeText(detailText)
        setCopiedId(notice.id)
      } else await handlers[action]?.run(notice)
    } catch (error) {
      if ((action === 'retry' || action === 'resume') && notice.recoveryState === 'ready') {
        setFailedReady((ids) => new Set([...ids, notice.id]))
        onRecoveryFailure?.(notice)
      }
      // Apply the same small readable projection to action failures, never a raw stack/payload.
      const message = readableNoticeDetails(
        {
          ...notice,
          failure: {
            category: 'internal',
            diagnostics: { raw: error instanceof Error ? error.message : String(error) }
          }
        },
        title,
        description
      )
        .map(({ value }) => value)
        .join('\n')
      setActionFailure({ id: notice.id, message })
    } finally {
      inFlight.current.delete(notice.id)
      setPending(new Map(inFlight.current))
    }
  }
  const primary =
    presentation.primaryAction && available(presentation.primaryAction)
      ? presentation.primaryAction
      : undefined
  const actionButton = (
    action: NoticeActionId,
    notice: ComposerNotice,
    main = false
  ): React.JSX.Element | null => {
    if (!available(action, notice)) return null
    const handlerBusy = handlers[action]?.busy
    const busy =
      pending.get(notice.id) === action ||
      (typeof handlerBusy === 'function' ? handlerBusy(notice) : handlerBusy)
    const recovery = action === 'retry' || action === 'resume'
    const label = busy && recovery ? t('Retrying…') : labels[action]
    return (
      <Button
        key={action}
        type="button"
        size="default"
        variant={main ? 'default' : 'ghost'}
        className={`${main ? 'col-start-2 row-start-1 self-start justify-self-end ' : ''}h-auto min-h-8 max-w-full whitespace-normal text-left focus-visible:transition-none`}
        data-notice-action={action}
        aria-label={action === 'report' ? t('Report this error') : label}
        disabled={pending.has(notice.id) || busy || handlers[action]?.disabled?.(notice)}
        aria-busy={busy || undefined}
        onClick={() => void run(action, notice)}
      >
        {busy ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          />
        ) : action === 'copy-error' && copiedId === notice.id ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        {action === 'copy-error' && copiedId === notice.id ? t('Copied') : label}
      </Button>
    )
  }

  if (collapsed)
    return (
      <Notice inline className="mb-2" data-testid="composer-notice-recovery-entry">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{title}</span>
          <Button type="button" variant="ghost" autoFocus onClick={() => onRestore?.(current)}>
            {t('Details')}
          </Button>
          {primary ? actionButton(primary, current) : null}
        </div>
      </Notice>
    )

  return (
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
      role="status"
      title={title}
      description={description}
      className="mb-2 min-w-0 gap-2"
      dismissButton={
        onDismiss
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
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
        <details
          ref={detailsRef}
          key={current.id}
          className="group contents [&::details-content]:col-span-2 [&::details-content]:row-start-2"
        >
          <summary
            ref={summaryRef}
            className="col-start-1 row-start-1 inline-flex min-h-8 min-w-0 cursor-pointer justify-self-start list-none items-center gap-1 rounded-sm text-xs text-muted-foreground underline decoration-dotted underline-offset-4 focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden"
          >
            <ChevronDown aria-hidden="true" className="size-3 shrink-0 group-open:rotate-180" />
            {t('Details')}
          </summary>
          <div className="col-span-2 row-start-2 mt-2 min-w-0 space-y-2">
            <dl
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5 [overflow-wrap:anywhere]"
              data-testid="composer-error-details"
            >
              {details.map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{detailLabels[label]}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            {actionFailure?.id === current.id && actionFailure.message ? (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {actionFailure.message}
              </p>
            ) : null}
            <div className="flex min-w-0 flex-wrap gap-1">
              {actionButton('copy-error', current)}
              {actionButton('export-diagnostics', current)}
              {presentation.feedback !== 'none' ? actionButton('report', current) : null}
              {presentation.secondaryActions
                .filter(
                  (action) =>
                    !['copy-error', 'export-diagnostics', 'report', primary].includes(action)
                )
                .map((action) => actionButton(action, current))}
            </div>
          </div>
        </details>
        {primary ? actionButton(primary, current, true) : null}
      </div>
      {actionFailure?.id === current.id ? (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {t('The action could not be completed. See details and try again.')}
        </p>
      ) : null}
      {notices.length > 1 ? (
        <div className="min-w-0 pt-1">
          <button
            type="button"
            className="min-h-8 rounded-sm text-xs text-muted-foreground focus-visible:keyboard-focus"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? t('Show less')
              : t('{{count}} more notices', {
                  count: notices.length - 1,
                  defaultValue_one: '{{count}} more notice'
                })}
          </button>
          {expanded ? (
            <ul>
              {notices
                .filter(({ id }) => id !== current.id)
                .map((notice) => (
                  <li key={notice.id}>
                    <button
                      type="button"
                      className="min-h-8 max-w-full rounded-sm text-left text-sm [overflow-wrap:anywhere] focus-visible:keyboard-focus"
                      data-select-notice={notice.id}
                      onClick={() => {
                        setSelected({ id: notice.id, leaderId: notices[0].id })
                        setExpanded(false)
                      }}
                    >
                      {t(noticePresentation(notice.failure, notice).titleKey)}
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Notice>
  )
}

export const ComposerNoticeSlot = ({
  draftConflict,
  persistence,
  dismissedNotices = [],
  ...props
}: FailureNoticeProps & {
  dismissedNotices?: readonly ComposerNotice[]
  draftConflict?: Pick<NoticeProps, 'description' | 'dismissButton'>
  persistence?: Pick<NoticeProps, 'role' | 'level' | 'title' | 'description' | 'primaryButton'>
}): React.JSX.Element => {
  const interactions = useNoticeInteractions()
  const [restoreRequest, setRestoreRequest] = useState<{ id: string }>()
  const restore = (notice: ComposerNotice): void => {
    setRestoreRequest({ id: notice.id })
    props.onRestore?.(notice)
  }
  return (
    <>
      {draftConflict ? <Notice {...draftConflict} inline level="info" /> : null}
      {persistence ? <Notice {...persistence} inline className="mb-2" /> : null}
      <ComposerFailureNoticeSlot
        {...props}
        interactions={interactions}
        restoreRequest={restoreRequest}
      />
      {dismissedNotices.map((notice) => (
        <ComposerFailureNoticeSlot
          key={notice.id}
          {...props}
          interactions={interactions}
          onRestore={restore}
          notices={[notice]}
          collapsed
        />
      ))}
    </>
  )
}
