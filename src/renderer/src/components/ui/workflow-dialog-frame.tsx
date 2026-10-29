import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import * as Dialog from '@/components/ui/dialog'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'

export const WorkflowDialogLayout = ({
  children,
  stage,
  enabled
}: {
  children: React.ReactNode
  stage: string
  enabled: boolean
}): React.JSX.Element => {
  const contentRef = useRef<HTMLDivElement>(null)
  const previousStage = useRef(stage)
  useLayoutEffect(() => {
    const content = contentRef.current
    const panel = content?.parentElement
    if (!content || !panel) return
    if (!enabled) {
      panel.style.removeProperty('height')
      return
    }
    const body = content.querySelector<HTMLElement>('[data-workflow-body]')
    const naturalContent = body?.querySelector<HTMLElement>('[data-workflow-content]')
    if (!body || !naturalContent) return
    const chrome = Array.from(content.children).filter(
      (element) => element !== body
    ) as HTMLElement[]
    const measure = (): void => {
      const style = getComputedStyle(body)
      const height =
        naturalContent.offsetHeight +
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0) +
        chrome.reduce((total, element) => total + element.offsetHeight, 0) +
        2
      const maximum = parseFloat(getComputedStyle(panel).maxHeight) || height
      if (height > 2) panel.style.height = `${Math.min(height, maximum)}px`
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    for (const element of [naturalContent, ...chrome]) observer?.observe(element)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [enabled, stage])
  useLayoutEffect(() => {
    const changed = previousStage.current !== stage
    previousStage.current = stage
    if (!enabled || !changed || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
      return
    const animations = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[data-workflow-content]') ?? []
    ).flatMap((element) =>
      element.animate
        ? [
            element.animate([{ opacity: 0.72 }, { opacity: 1 }], {
              duration: 160,
              fill: 'backwards'
            })
          ]
        : []
    )
    return () => animations.forEach((animation) => animation.cancel())
  }, [stage, enabled])
  return (
    <div
      ref={contentRef}
      className={
        enabled
          ? 'flex h-full max-h-[calc(var(--workflow-dialog-max-height)-2px)] min-h-0 flex-col'
          : 'contents'
      }
    >
      {children}
    </div>
  )
}

export function WorkflowDialogFrame({
  title,
  description,
  busy,
  onClose,
  children,
  footer,
  className,
  stage
}: {
  title: string
  description?: string
  busy: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  className?: string
  stage?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const descriptionId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const content = (
    <>
      <div className={cn(dialogHeaderClassName, 'shrink-0')}>
        <div className="min-w-0">
          <Dialog.Title
            ref={titleRef}
            tabIndex={stage === undefined ? undefined : -1}
            className={dialogTitleClassName}
          >
            {title}
          </Dialog.Title>
          {description ? (
            <Dialog.Description
              id={descriptionId}
              className={cn(dialogDescriptionClassName, '[overflow-wrap:anywhere]')}
            >
              {description}
            </Dialog.Description>
          ) : null}
        </div>
        <Dialog.Close asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={dialogCloseButtonClassName}
            disabled={busy}
            aria-label={t('Close')}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </Dialog.Close>
      </div>
      {children}
      {footer}
    </>
  )
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onOpenAutoFocus={
            stage === undefined
              ? undefined
              : (event) => {
                  event.preventDefault()
                  titleRef.current?.focus()
                }
          }
          aria-describedby={description ? descriptionId : undefined}
          className={cn(
            dialogPanelClassName(
              'flex max-h-[calc(100dvh-2rem)] w-[min(740px,calc(100vw-2rem))] flex-col p-0'
            ),
            stage !== undefined &&
              '[--workflow-dialog-max-height:min(85svh,720px,var(--windows-content-max-height))] top-[calc(var(--windows-content-center-y)-var(--workflow-dialog-max-height)/2)] max-h-[var(--workflow-dialog-max-height)] -translate-y-0 overflow-hidden transition-[height] duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none',
            className
          )}
        >
          {stage === undefined ? (
            content
          ) : (
            <WorkflowDialogLayout stage={stage} enabled>
              {content}
            </WorkflowDialogLayout>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
