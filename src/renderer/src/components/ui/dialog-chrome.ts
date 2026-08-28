import { cn } from '@/lib/utils'

const dialogOverlayClassName =
  'fixed inset-0 z-50 bg-black/50 data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:fill-mode-forwards motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none'

const dialogPanelClassName = (...className: Array<string | false | null | undefined>): string =>
  cn(
    'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog outline-none data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:fill-mode-forwards motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none',
    ...className
  )

const dialogHeaderClassName =
  'flex items-center justify-between gap-3 border-b border-border-300/90 px-5 py-3.5'
const dialogBodyClassName = 'p-5'
const dialogTitleClassName = 'text-lg font-semibold text-text-000'
const dialogDescriptionClassName = 'mt-1 text-sm leading-relaxed text-muted-foreground'
const dialogFooterClassName =
  'flex justify-end gap-3 border-t border-border-300/90 px-5 py-3.5 [&_button:enabled]:cursor-pointer'
const dialogCloseButtonClassName = 'cursor-pointer rounded-lg text-muted-foreground'
const dialogFormLabelClassName = 'block text-sm font-medium text-foreground mb-1'
const dialogFormHelpClassName = 'text-xs leading-relaxed text-foreground/90 mb-2'
const dialogFormInputClassName =
  'rounded-lg border border-input bg-bg-000 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25'
const dialogFormTextareaClassName = `${dialogFormInputClassName} w-full resize-none px-3 py-2 text-sm outline-none`
const dialogCancelButtonClassName =
  'cursor-pointer border-0 shadow-none hover:bg-bg-200 hover:text-foreground'

export {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogFormHelpClassName,
  dialogFormInputClassName,
  dialogFormLabelClassName,
  dialogFormTextareaClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
}
