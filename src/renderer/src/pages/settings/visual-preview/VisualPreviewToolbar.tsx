// Floating toolbar for the settings visual preview. Docked bottom-right above the settings
// dialog (z-index above Radix overlays, pointer-events re-enabled because Radix modal dialogs
// disable them on body). Purely a review tool: all copy comes from VISUAL_PREVIEW_COPY.

import { ChevronDown, ChevronUp, FlaskConical, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { SETTINGS_VISUAL_CHANGES } from './changes'
import { VISUAL_PREVIEW_COPY as COPY } from './copy'

type VisualPreviewToolbarProps = {
  selectedIndex: number
  unreachableId: string | null
  markersVisible: boolean
  onSelect: (index: number) => void
  onMarkersVisibleChange: (visible: boolean) => void
  onExit: () => void
}

export const VisualPreviewToolbar = ({
  selectedIndex,
  unreachableId,
  markersVisible,
  onSelect,
  onMarkersVisibleChange,
  onExit
}: VisualPreviewToolbarProps): React.JSX.Element => {
  const [listOpen, setListOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const total = SETTINGS_VISUAL_CHANGES.length
  const current = SETTINGS_VISUAL_CHANGES[selectedIndex]
  const unreachable = unreachableId
    ? SETTINGS_VISUAL_CHANGES.find((change) => change.id === unreachableId)
    : undefined

  return createPortal(
    <div
      data-slot="settings-visual-preview-toolbar"
      className="pointer-events-auto fixed bottom-4 right-4 z-[120] flex w-72 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2">
        <FlaskConical className="size-3.5 shrink-0 text-red-600" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-red-600">
          {COPY.badge}
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? COPY.expand : COPY.collapse}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={COPY.exit}
          onClick={onExit}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {collapsed ? null : (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={selectedIndex === 0}
              className="rounded-md border border-border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onSelect(selectedIndex - 1)}
            >
              {COPY.previous}
            </button>
            <span className="min-w-0 flex-1 text-center text-xs tabular-nums text-muted-foreground">
              {COPY.position(selectedIndex + 1, total)}
            </span>
            <button
              type="button"
              disabled={selectedIndex === total - 1}
              className="rounded-md border border-border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onSelect(selectedIndex + 1)}
            >
              {COPY.next}
            </button>
          </div>

          {current ? (
            <div className="rounded-lg bg-muted/50 px-2.5 py-2">
              <p className="text-xs font-semibold text-foreground">{current.title}</p>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {current.description}
              </p>
            </div>
          ) : null}

          {unreachable ? (
            <p role="alert" className="text-[11px] leading-4 text-destructive">
              {COPY.unreachable(unreachable.title)}
            </p>
          ) : null}

          <div>
            <button
              type="button"
              aria-expanded={listOpen}
              className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setListOpen((value) => !value)}
            >
              {listOpen ? (
                <ChevronDown className="size-3" aria-hidden="true" />
              ) : (
                <ChevronUp className="size-3" aria-hidden="true" />
              )}
              {COPY.listToggle}
            </button>
            {listOpen ? (
              <ol className="mt-1 flex flex-col gap-0.5">
                {SETTINGS_VISUAL_CHANGES.map((change, index) => (
                  <li key={change.id}>
                    <button
                      type="button"
                      aria-current={index === selectedIndex ? 'true' : undefined}
                      className={cn(
                        'w-full truncate rounded-md px-2 py-1 text-left text-xs',
                        index === selectedIndex
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                      onClick={() => onSelect(index)}
                    >
                      {`${index + 1}. ${change.title}`}
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {COPY.markersToggle}
            <Switch
              checked={markersVisible}
              onCheckedChange={onMarkersVisibleChange}
              aria-label={COPY.markersToggle}
            />
          </label>
        </div>
      )}
    </div>,
    document.body
  )
}
