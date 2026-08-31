/* Hallmark · component: composer-message-queue · genre: modern-minimal · tone: quiet/technical
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (existing application tokens)
 */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { ChevronDown, GripVertical, ListOrdered, Loader2, Pencil, Send, Trash2 } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { MESSAGE_QUEUE_ANNOUNCEMENTS } from './workspace-message-queue-announcement'
import type { WorkspaceMessageQueueController } from './workspace-message-queue-controller'
import { localizeImageAnnotationSourceError } from './annotations/image-annotation-source-validation'

type ComposerMessageQueueProps = Omit<
  WorkspaceMessageQueueController,
  'lifecycle' | 'hasPendingWork'
>
type ComposerMessageQueueTriggerProps = Pick<ComposerMessageQueueProps, 'items'> & {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}
type ComposerMessageQueueContentProps = ComposerMessageQueueProps & { expanded: boolean }
type DropTarget = { itemId: string; edge: 'before' | 'after' }
type PointerDrag = {
  pointerId: number
  itemId: string
  startY: number
  height: number
  active: boolean
  target: DropTarget | undefined
}

const queueActionClassName =
  'relative flex h-7 shrink-0 items-center justify-center rounded-md px-1.5 text-[11px] font-medium text-text-300 transition-colors duration-150 ease-out hover:bg-bg-200 hover:text-text-000 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:translate-y-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11'
const queueTriggerClassName =
  'relative flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-text-100 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11'

const queueErrorText = (
  t: TFunction,
  error: { kind: 'branch' | 'send' | 'edit' | 'cancel'; detail?: string }
): string => {
  const detail = localizeImageAnnotationSourceError(error.detail, t) ?? error.detail ?? ''
  if (error.kind === 'branch') {
    return t(
      'This queued message belongs to another message branch. Return to that branch to send it.'
    )
  }
  if (error.kind === 'edit') return t('Clear the composer before editing this queued message.')
  if (error.kind === 'cancel') {
    return t('Could not stop the current run. {{detail}} Try again.', {
      detail
    })
  }
  return t('Could not send this queued message. {{detail}} Try again.', {
    detail
  })
}

const queueAnnouncementText = (t: TFunction, announcement: string): string => {
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.sent) return t('Queued message sent.')
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.added) return t('Message added to queue.')
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.movedUp) return t('Queued message moved up.')
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.movedDown) {
    return t('Queued message moved down.')
  }
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.reordered) {
    return t('Queued messages reordered.')
  }
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.removed) return t('Queued message removed.')
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.restoredForEdit) {
    return t('Queued message moved to the composer for editing.')
  }
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.interrupting) {
    return t('Stopping the current run before sending the queued message.')
  }
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.steering) {
    return t('Sending the queued message into the current run.')
  }
  if (announcement === MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle) {
    return t('Queued message will send after the current run finishes.')
  }
  return ''
}

const ComposerMessageQueueTrigger = ({
  items,
  expanded,
  onExpandedChange
}: ComposerMessageQueueTriggerProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (items.length === 0) return null

  return (
    <button
      type="button"
      className={queueTriggerClassName}
      aria-expanded={expanded}
      aria-controls="composer-message-queue-list"
      onClick={() => onExpandedChange(!expanded)}
      data-testid="composer-queue-trigger"
    >
      <ListOrdered className="size-3.5" strokeWidth={2} aria-hidden="true" />
      {t('Queue ({{count}}) · Not saved', { count: items.length })}
      <ChevronDown
        className={cn(
          'size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none',
          expanded && 'rotate-180'
        )}
        aria-hidden="true"
      />
    </button>
  )
}

const ComposerMessageQueueContent = ({
  items,
  announcement,
  actions,
  expanded
}: ComposerMessageQueueContentProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [draggedId, setDraggedId] = useState<string>()
  const [draggedHeight, setDraggedHeight] = useState(0)
  const [dropTarget, setDropTarget] = useState<DropTarget>()
  const pointerDragRef = useRef<PointerDrag | undefined>(undefined)

  const showDropTarget = (next?: DropTarget): void => {
    const drag = pointerDragRef.current
    if (!drag) return
    const current = drag.target
    if (current?.itemId === next?.itemId && current?.edge === next?.edge) return
    drag.target = next
    setDropTarget(next)
  }

  const finishDrag = (): void => {
    pointerDragRef.current = undefined
    setDraggedId(undefined)
    setDraggedHeight(0)
    setDropTarget(undefined)
  }

  const showDropPosition = (itemId: string, bounds: DOMRect, clientY: number): void => {
    if (pointerDragRef.current?.itemId === itemId) {
      showDropTarget()
      return
    }
    showDropTarget({
      itemId,
      edge: clientY >= bounds.top + bounds.height / 2 ? 'after' : 'before'
    })
  }

  const movePointerDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < 6) return
      drag.active = true
      setDraggedId(drag.itemId)
      setDraggedHeight(drag.height)
    }
    event.preventDefault()
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-queue-item-id]')
    if (!target?.dataset.queueItemId) {
      showDropTarget()
      return
    }
    showDropPosition(target.dataset.queueItemId, target.getBoundingClientRect(), event.clientY)
  }

  const endPointerDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = pointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const target = drag.target
    if (drag.active && target) actions.moveTo(drag.itemId, target.itemId, target.edge)
    finishDrag()
  }

  if (items.length === 0) return null

  return (
    <>
      {expanded ? (
        <section className="border-b border-border-200" aria-label={t('Message queue')}>
          <ol id="composer-message-queue-list" className="max-h-36 overflow-y-auto">
            {items.map((item, index) => {
              const busy = item.phase === 'interrupting' || item.phase === 'sending'
              const preview = item.text.trim() || t('Attachment message')
              const draggedIndex = items.findIndex((candidate) => candidate.id === draggedId)
              const targetIndex = items.findIndex(
                (candidate) => candidate.id === dropTarget?.itemId
              )
              let translatedRows = 0
              if (draggedIndex >= 0 && targetIndex >= 0 && dropTarget) {
                let insertionIndex = targetIndex + (dropTarget.edge === 'after' ? 1 : 0)
                if (draggedIndex < insertionIndex) insertionIndex -= 1
                if (
                  draggedIndex < insertionIndex &&
                  index > draggedIndex &&
                  index <= insertionIndex
                ) {
                  translatedRows = -1
                } else if (
                  draggedIndex > insertionIndex &&
                  index >= insertionIndex &&
                  index < draggedIndex
                ) {
                  translatedRows = 1
                }
              }
              return (
                <li
                  key={item.id}
                  className={cn(
                    'grid min-h-8 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-0.5 border-t border-border-200 first:border-t-0',
                    draggedId &&
                      'transition-transform duration-150 ease-out motion-reduce:transition-none',
                    draggedId === item.id && 'opacity-25'
                  )}
                  style={{ transform: `translateY(${translatedRows * draggedHeight}px)` }}
                  data-queue-item-id={item.id}
                  data-testid="composer-queue-item"
                >
                  <button
                    type="button"
                    disabled={busy}
                    className={cn(
                      queueActionClassName,
                      'w-7 touch-none cursor-grab px-0 select-none active:cursor-grabbing'
                    )}
                    aria-label={t('Reorder queued message {{index}}', { index: index + 1 })}
                    title={t('Drag or use arrow keys to reorder')}
                    onPointerCancel={finishDrag}
                    onPointerDown={(event) => {
                      if (event.isPrimary === false || event.button !== 0) return
                      event.currentTarget.setPointerCapture?.(event.pointerId)
                      pointerDragRef.current = {
                        pointerId: event.pointerId,
                        itemId: item.id,
                        startY: event.clientY,
                        height:
                          event.currentTarget.closest('li')?.getBoundingClientRect().height ?? 0,
                        active: false,
                        target: undefined
                      }
                    }}
                    onPointerMove={movePointerDrag}
                    onPointerUp={endPointerDrag}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      actions.move(item.id, event.key === 'ArrowUp' ? 'up' : 'down')
                    }}
                  >
                    <GripVertical className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  </button>

                  <div className="min-w-0 overflow-hidden px-1">
                    <p className="truncate text-[12px] leading-4 text-text-000" title={preview}>
                      {preview}
                    </p>
                    {item.attachmentCount > 0 ? (
                      <p className="text-[11px] leading-4 text-text-300">
                        {t('Attachments: {{count}}', { count: item.attachmentCount })}
                      </p>
                    ) : null}
                    {item.error ? (
                      <p className="mt-0.5 text-[11px] leading-4 text-red-400" role="alert">
                        {queueErrorText(t, item.error)}
                      </p>
                    ) : item.deferredUntilIdle ? (
                      <p className="mt-0.5 text-[11px] leading-4 text-text-300">
                        {t('Queued message will send after the current run finishes.')}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-end gap-0.5">
                    <button
                      type="button"
                      className={cn(queueActionClassName, 'gap-1 whitespace-nowrap')}
                      disabled={busy}
                      aria-busy={busy || undefined}
                      aria-label={
                        item.phase === 'interrupting'
                          ? t('Stopping…')
                          : item.phase === 'sending'
                            ? t('Sending…')
                            : t('Send now')
                      }
                      onClick={() => void actions.sendNow(item.id)}
                    >
                      {busy ? (
                        <Loader2
                          className="size-3.5 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Send className="size-3.5" strokeWidth={2} aria-hidden="true" />
                      )}
                      <span className="hidden whitespace-nowrap sm:inline">
                        {item.phase === 'interrupting'
                          ? t('Stopping…')
                          : item.phase === 'sending'
                            ? t('Sending…')
                            : t('Send now')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={cn(queueActionClassName, 'w-7 px-0')}
                      disabled={busy}
                      aria-label={t('Edit queued message {{index}}', { index: index + 1 })}
                      title={t('Edit queued message')}
                      onClick={() => actions.edit(item.id)}
                    >
                      <Pencil className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={cn(queueActionClassName, 'w-7 px-0')}
                      disabled={busy}
                      aria-label={t('Remove queued message {{index}}', { index: index + 1 })}
                      title={t('Remove queued message')}
                      onClick={() => actions.remove(item.id)}
                    >
                      <Trash2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      <span className="sr-only" aria-live="polite">
        {queueAnnouncementText(t, announcement)}
      </span>
    </>
  )
}

export { ComposerMessageQueueContent, ComposerMessageQueueTrigger }
