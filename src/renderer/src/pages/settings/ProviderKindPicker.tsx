import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { ProviderKindIcon } from './provider-icons'
import { PROVIDER_KIND_GROUPS, PROVIDER_KINDS, type ProviderKind } from './provider-form-value'

type ProviderKindPickerProps = {
  // Called with the chosen provider-kind key ('custom', 'claude-default', `official:<id>`, ...).
  onSelect: (kindKey: string) => void
  // The Codex subscription group is only relevant when Codex is the active agent framework.
  showCodexSubscriptions?: boolean
}

const visibleKinds = (showCodexSubscriptions: boolean): ProviderKind[] =>
  PROVIDER_KINDS.filter((kind) => kind.group !== 'coding' || showCodexSubscriptions)

// First step of Add provider: pick the vendor before the configuration form opens. The list is a
// plain top-aligned scroll box (no scroll-to-selected like a dropdown) with a bottom fade while
// more options are available, so it always reads as scrollable (issue #294).
const ProviderKindPicker = ({
  onSelect,
  showCodexSubscriptions = false
}: ProviderKindPickerProps): React.JSX.Element => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const update = (): void =>
      setCanScrollDown(viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1)

    update()
    viewport.addEventListener('scroll', update)
    // jsdom (and very old WebViews) lack ResizeObserver; the fade then just follows scroll events.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    if (observer) {
      observer.observe(viewport)
      for (const child of Array.from(viewport.children)) observer.observe(child)
    }

    return () => {
      viewport.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [])

  const kinds = visibleKinds(showCodexSubscriptions)

  return (
    <div className="relative" data-slot="provider-kind-picker">
      <div
        ref={viewportRef}
        aria-label="Choose a provider"
        className="max-h-96 overflow-y-auto overscroll-contain rounded-lg border border-border bg-card p-1.5"
      >
        {PROVIDER_KIND_GROUPS.map((group) => {
          const groupKinds = kinds.filter((kind) => kind.group === group.id)
          if (groupKinds.length === 0) return null

          return (
            <div key={group.id}>
              <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                {group.label}
              </p>
              {groupKinds.map((kind) => (
                <button
                  key={kind.key}
                  type="button"
                  data-slot="provider-kind-option"
                  onClick={() => onSelect(kind.key)}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors duration-150 select-none motion-reduce:transition-none hover:bg-muted focus-visible:bg-muted"
                >
                  <ProviderKindIcon kindKey={kind.key} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{kind.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {kind.description}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          )
        })}
      </div>
      {canScrollDown ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-lg bg-gradient-to-t from-card to-transparent"
        />
      ) : null}
    </div>
  )
}

export { ProviderKindPicker }
