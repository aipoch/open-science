// Shared visual chrome only. Each notice owner retains placement, actions and lifecycle.
const fieldErrorClassName = 'text-xs leading-5 text-destructive [overflow-wrap:anywhere]'
const noticeSurfaceClassName =
  'rounded-2xl border border-border bg-card p-4 text-sm text-foreground'
const noticeCapsuleClassName = 'flex-nowrap items-center gap-2 rounded-3xl py-2 pl-4 pr-2'
const noticeTitleClassName =
  'text-sm font-semibold leading-5 text-foreground [overflow-wrap:anywhere]'
const noticeDescriptionClassName =
  'text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]'
const noticeActionClassName =
  'inline-flex min-h-8 max-w-full items-center justify-center rounded-md px-2 text-xs font-medium whitespace-normal [overflow-wrap:anywhere] text-primary hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'
const noticeDismissClassName =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'

export {
  fieldErrorClassName,
  noticeSurfaceClassName,
  noticeCapsuleClassName,
  noticeTitleClassName,
  noticeDescriptionClassName,
  noticeActionClassName,
  noticeDismissClassName
}

// Shared semantic presentation; these existing tones do not represent business state.
type NoticeLevel = 'info' | 'warning' | 'error'
type ErrorNoticeTone = 'teal' | 'amber' | 'red'
const noticeIconClassNames: Record<NoticeLevel, string> = {
  info: 'text-status-info-foreground dark:text-status-info-dark-foreground',
  warning: 'text-status-warning-foreground dark:text-status-warning-dark-foreground',
  error: 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
}
const noticeToneClassNames: Record<NoticeLevel, string> = {
  info: 'bg-status-info-surface text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground',
  warning:
    'bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground',
  error:
    'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
}
const inlineNoticeClassName = 'min-w-0 text-sm leading-5 text-foreground [overflow-wrap:anywhere]'
export { inlineNoticeClassName, noticeIconClassNames, noticeToneClassNames }
export type { ErrorNoticeTone, NoticeLevel }
