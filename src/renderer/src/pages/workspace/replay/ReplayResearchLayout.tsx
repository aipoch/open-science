import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  getResearchReplayPaneMinimumWidth,
  getResearchReplayMinimumGroupWidth,
  resolveResearchReplayPaneWidths,
  resizeResearchReplayPaneWidths
} from './research-replay-pane-sizes'

export type ResearchReplayLayout = {
  mode: 'tabs' | 'split' | 'columns'
  visiblePaneIds: readonly string[]
  widths?: Record<string, number>
  onWidthsChange?: (widths: Record<string, number>) => void
}

type ResearchReplayPane = { id: string; label: string; content: ReactNode }

/** Keep one panel tree through fullscreen/tab transitions so resource-owning views stay mounted. */
export const ReplayResearchLayout = ({
  layout,
  materialTabs,
  materialTabPanelId,
  panes,
  focusedPaneId,
  onFocusPane
}: {
  layout: ResearchReplayLayout
  materialTabs?: ReactNode
  materialTabPanelId?: string
  panes: readonly ResearchReplayPane[]
  focusedPaneId?: string
  onFocusPane?: (id: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const groupRef = useRef<HTMLDivElement>(null)
  const [groupWidth, setGroupWidth] = useState(0)
  const [draft, setDraft] = useState<{ key: string; widths: Record<string, number> } | null>(null)
  const [resizingKey, setResizingKey] = useState<string | null>(null)
  const drag = useRef<{
    pointerId: number
    target: HTMLElement
    startX: number
    left: string
    right: string
    pixels: Record<string, number>
    latest: Record<string, number> | null
  } | null>(null)
  const visibleIds = panes
    .filter((pane) => layout.visiblePaneIds.includes(pane.id))
    .map(({ id }) => id)
  if (!visibleIds.length && panes.length) visibleIds.push(panes[0].id)
  const multiple = visibleIds.length > 1
  const minimumGroupWidth = multiple ? getResearchReplayMinimumGroupWidth(visibleIds) : 0
  const layoutKey = JSON.stringify([layout.mode, visibleIds, layout.widths])
  // Discard interrupted widths so returning to this layout starts from its saved sizes.
  if (draft && draft.key !== layoutKey) setDraft(null)
  if (resizingKey !== null && resizingKey !== layoutKey) setResizingKey(null)
  const widths = draft?.key === layoutKey ? draft.widths : layout.widths
  const pixels = resolveResearchReplayPaneWidths({
    visiblePaneIds: visibleIds,
    availableWidth: Math.max(groupWidth, minimumGroupWidth) - Math.max(0, visibleIds.length - 1),
    mode: layout.mode,
    widths
  })
  useLayoutEffect(() => {
    const element = groupRef.current
    if (!element) return
    const measure = (): void => setGroupWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    // End a drag if a layout is changed or its owner is unmounted.
    return () => {
      const active = drag.current
      drag.current = null
      if (active?.target.hasPointerCapture?.(active.pointerId))
        active.target.releasePointerCapture(active.pointerId)
    }
  }, [layoutKey])
  const finishResize = (cancel = false): void => {
    const active = drag.current
    drag.current = null
    setResizingKey(null)
    if (cancel) setDraft(null)
    else if (active?.latest) layout.onWidthsChange?.(active.latest)
    if (active?.target.hasPointerCapture?.(active.pointerId))
      active.target.releasePointerCapture(active.pointerId)
  }
  const resizePair = (left: string, right: string, deltaPixels: number): void => {
    const next = resizeResearchReplayPaneWidths({
      paneWidths: pixels,
      leftPaneId: left,
      rightPaneId: right,
      deltaPixels
    })
    setDraft({ key: layoutKey, widths: next })
    layout.onWidthsChange?.(next)
  }

  return (
    <div
      data-replay-layout-mode={layout.mode}
      className="flex h-full min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
    >
      <div
        ref={groupRef}
        data-replay-pane-group=""
        className={cn(
          'flex h-full w-full min-h-0 shrink-0',
          resizingKey === layoutKey && 'select-none [&_iframe]:pointer-events-none'
        )}
        style={{ minWidth: minimumGroupWidth }}
      >
        {panes.map((pane, index) => {
          const visible = visibleIds.includes(pane.id)
          const nextVisible = panes.slice(index + 1).find(({ id }) => visibleIds.includes(id))
          const separatorVisible = visible && Boolean(nextVisible)
          const tabbedMaterial =
            layout.mode === 'split' && pane.id !== 'conversation' && visible && !!materialTabs
          return (
            <Fragment key={pane.id}>
              <div
                data-replay-pane-slot={pane.id}
                aria-hidden={!visible || undefined}
                inert={!visible || undefined}
                className="h-full min-h-0 min-w-0 overflow-hidden"
                style={{
                  display: visible ? 'flex' : 'none',
                  flex: visible ? `${pixels[pane.id] ?? 1} 1 0px` : undefined
                }}
              >
                <section
                  data-replay-pane={pane.id}
                  data-replay-pane-visible={visible}
                  aria-label={pane.label}
                  className={cn(
                    'flex h-full w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                    !visible && 'invisible'
                  )}
                  onPointerDownCapture={() => visible && onFocusPane?.(pane.id)}
                  onFocusCapture={() => visible && onFocusPane?.(pane.id)}
                >
                  <div
                    data-replay-layout-control=""
                    className={cn(
                      'shrink-0 border-b border-border-200 text-xs font-medium text-text-300',
                      tabbedMaterial ? '' : 'flex h-10 items-center px-3',
                      focusedPaneId === pane.id && 'bg-bg-100 text-text-100',
                      !multiple && 'hidden'
                    )}
                  >
                    {tabbedMaterial ? materialTabs : pane.label}
                  </div>
                  <div
                    id={tabbedMaterial ? materialTabPanelId : undefined}
                    role={tabbedMaterial ? 'tabpanel' : undefined}
                    aria-label={tabbedMaterial ? pane.label : undefined}
                    className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  >
                    {pane.content}
                  </div>
                </section>
              </div>
              {separatorVisible && nextVisible ? (
                <div
                  role="separator"
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-valuenow={Math.round(
                    (100 * pixels[pane.id]) / (pixels[pane.id] + pixels[nextVisible.id])
                  )}
                  aria-valuemin={Math.round(
                    (100 * getResearchReplayPaneMinimumWidth(pane.id)) /
                      (pixels[pane.id] + pixels[nextVisible.id])
                  )}
                  aria-valuemax={Math.round(
                    100 *
                      (1 -
                        getResearchReplayPaneMinimumWidth(nextVisible.id) /
                          (pixels[pane.id] + pixels[nextVisible.id]))
                  )}
                  data-replay-layout-control=""
                  data-replay-resize-after={pane.id}
                  aria-label={t('Resize {{left}} and {{right}}', {
                    left: pane.label,
                    right: nextVisible.label
                  })}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    event.preventDefault()
                    event.currentTarget.focus()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    drag.current = {
                      pointerId: event.pointerId,
                      target: event.currentTarget,
                      startX: event.clientX,
                      left: pane.id,
                      right: nextVisible.id,
                      pixels,
                      latest: null
                    }
                    setResizingKey(layoutKey)
                  }}
                  onPointerMove={(event) => {
                    const active = drag.current
                    if (!active || active.pointerId !== event.pointerId) return
                    const next = resizeResearchReplayPaneWidths({
                      paneWidths: active.pixels,
                      leftPaneId: active.left,
                      rightPaneId: active.right,
                      deltaPixels: event.clientX - active.startX
                    })
                    active.latest = next
                    setDraft({ key: layoutKey, widths: next })
                  }}
                  onPointerUp={() => finishResize()}
                  onPointerCancel={() => finishResize(true)}
                  onLostPointerCapture={() => {
                    if (drag.current) finishResize()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && drag.current) {
                      finishResize(true)
                      return
                    }
                    const step =
                      Math.max(groupWidth, minimumGroupWidth) * (event.shiftKey ? 0.01 : 0.05)
                    const delta =
                      event.key === 'ArrowLeft'
                        ? -step
                        : event.key === 'ArrowRight'
                          ? step
                          : event.key === 'Home'
                            ? -Infinity
                            : event.key === 'End'
                              ? Infinity
                              : null
                    if (delta === null) return
                    event.preventDefault()
                    resizePair(pane.id, nextVisible.id, delta)
                  }}
                  className="relative z-20 w-px shrink-0 cursor-col-resize touch-none bg-border-200 outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-5 after:-translate-x-1/2 after:content-[''] hover:bg-accent-main-100 focus-visible:bg-accent-main-100"
                />
              ) : null}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
