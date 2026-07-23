import { cn } from '@/lib/utils'

const dialogOverlayClassName =
  'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:fill-mode-forwards motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none'

const dialogPanelClassName = (...className: Array<string | false | null | undefined>): string =>
  cn(
    'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:fill-mode-forwards motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none',
    ...className
  )

const dialogHeaderClassName = 'flex items-start justify-between gap-3'
const dialogTitleClassName = 'text-sm font-semibold text-foreground'
const dialogDescriptionClassName = 'mt-1 text-sm leading-relaxed text-muted-foreground'
const dialogFooterClassName = 'mt-5 flex justify-end gap-2'
const dialogCloseButtonClassName = 'rounded-lg text-muted-foreground'

export {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
}
