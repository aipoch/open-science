import { X } from 'lucide-react'
import { useRef } from 'react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import { Button } from '@/components/ui/button'
import { ResizablePanel } from '@/components/ui/resizable'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PreviewFileItem, PreviewItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import { PreviewFileContent } from './previews/PreviewFileContent'
import { PreviewToolContent } from './previews/PreviewToolContent'

type PreviewPanelProps = {
  panelRef: React.Ref<PanelImperativeHandle>
  defaultSize: string
  minSize: string
  onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
}

// Renders the active tab's content, or an empty state when nothing is previewed yet.
const PreviewActiveContent = ({
  item
}: {
  item: PreviewItem | undefined
}): React.JSX.Element | null => {
  if (!item) {
    return (
      <div className="flex size-full items-center justify-center text-[12px] text-text-300">
        No preview content
      </div>
    )
  }

  if (item.type === 'tool') return <PreviewToolContent item={item} />

  return <PreviewFileContent item={item} />
}

const previewTabClassName =
  'group flex h-8 max-w-[160px] shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-[12px] transition-colors'

// Keeps the identifying tail and extension visible while the flexible prefix owns the ellipsis.
const MiddleEllipsisFileName = ({ name }: { name: string }): React.JSX.Element => {
  const extensionIndex = name.lastIndexOf('.')
  const extensionLength = extensionIndex > 0 ? name.length - extensionIndex : 0
  const trailingLength = Math.min(name.length, Math.max(extensionLength + 10, 18))
  const splitIndex = Math.max(1, name.length - trailingLength)

  return (
    <span className="flex min-w-0 max-w-full flex-1 items-center overflow-hidden whitespace-nowrap">
      <span className="min-w-0 truncate">{name.slice(0, splitIndex)}</span>
      <span
        data-testid="preview-title-tail"
        className="min-w-0 max-w-[65%] shrink overflow-hidden text-ellipsis [direction:rtl] [unicode-bidi:plaintext]"
      >
        {name.slice(splitIndex)}
      </span>
    </span>
  )
}

const getPreviewTabId = (itemId: string): string => `preview-tab-${encodeURIComponent(itemId)}`
const getPreviewPanelId = (itemId: string): string => `preview-panel-${encodeURIComponent(itemId)}`

// One tab owns activation/keyboard behavior while its sibling close button preserves quick removal.
const PreviewTab = ({
  tab,
  isActive,
  tabRef,
  onActivate,
  onClose,
  onKeyDown
}: {
  tab: PreviewItem
  isActive: boolean
  tabRef: (element: HTMLButtonElement | null) => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}): React.JSX.Element => (
  <div
    role="presentation"
    className={cn(
      previewTabClassName,
      isActive ? 'bg-bg-300 text-text-000' : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
    )}
  >
    <button
      ref={tabRef}
      type="button"
      role="tab"
      id={getPreviewTabId(tab.id)}
      aria-controls={getPreviewPanelId(tab.id)}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      className="flex min-w-0 flex-1 self-stretch items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      onClick={() => onActivate(tab.id)}
      onKeyDown={onKeyDown}
      title={tab.title}
    >
      {tab.type === 'file' ? (
        <MiddleEllipsisFileName name={tab.name} />
      ) : (
        <span className="min-w-0 truncate">{tab.title}</span>
      )}
    </button>
    <button
      type="button"
      tabIndex={-1}
      className={cn(
        'shrink-0 rounded-sm p-0.5 outline-none hover:bg-bg-000/60 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
        isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      )}
      onClick={() => onClose(tab.id)}
      aria-label={`Close preview of ${tab.title}`}
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  </div>
)

// Horizontal, scrollable strip of every file the user has asked to preview this session.
const PreviewTabBar = ({
  tabs,
  activeItemId,
  onActivate,
  onClose
}: {
  tabs: PreviewItem[]
  activeItemId: string | undefined
  onActivate: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveToTab = (index: number): void => {
    const tab = tabs[index]
    if (!tab) return

    onActivate(tab.id)
    tabRefs.current[index]?.focus()
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const lastIndex = tabs.length - 1
    let nextIndex: number | undefined

    if (event.key === 'Delete' || event.key === 'Backspace') {
      const tab = tabs[index]
      if (!tab) return

      event.preventDefault()
      const fallbackIndex = index < lastIndex ? index + 1 : index - 1
      if (fallbackIndex >= 0) moveToTab(fallbackIndex)
      onClose(tab.id)
      return
    }

    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = lastIndex
    if (nextIndex === undefined) return

    event.preventDefault()
    moveToTab(nextIndex)
  }

  return (
    <div
      role="tablist"
      aria-label="Open previews"
      aria-orientation="horizontal"
      className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-2"
    >
      {tabs.map((tab, index) => (
        <PreviewTab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeItemId}
          tabRef={(element) => {
            tabRefs.current[index] = element
          }}
          onActivate={onActivate}
          onClose={onClose}
          onKeyDown={(event) => handleTabKeyDown(event, index)}
        />
      ))}
    </div>
  )
}

// The compact card header centralizes the active preview's identity and file-level actions.
const PreviewCardHeader = ({
  item,
  onClose
}: {
  item: PreviewFileItem
  onClose: (id: string) => void
}): React.JSX.Element => (
  <header
    data-testid="preview-card-header"
    className="flex h-8 shrink-0 items-center gap-1 border-b border-border-300/50 px-2"
  >
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 text-[12px] font-medium text-text-000">
            <MiddleEllipsisFileName name={item.name} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{item.title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <ManagedFileDownloadButton
      source={item.source ?? 'artifact'}
      path={item.path}
      suggestedName={item.name}
      className="bg-transparent shadow-none"
    />
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-text-100 hover:text-text-000"
            aria-label={`Close preview of ${item.title}`}
            onClick={() => onClose(item.id)}
          >
            <X aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Close preview</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </header>
)

// Right-side workbench: a tab strip over every previewed file, plus content for the active tab.
const PreviewPanel = ({
  panelRef,
  defaultSize,
  minSize,
  onResize
}: PreviewPanelProps): React.JSX.Element => {
  const items = usePreviewWorkbenchStore((state) => state.items)
  const activeItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const panelState = usePreviewWorkbenchStore((state) => state.panelState)
  const activateItem = usePreviewWorkbenchStore((state) => state.activateItem)
  const removeItem = usePreviewWorkbenchStore((state) => state.removeItem)
  const activeItem = items.find((item) => item.id === activeItemId)
  // Remount replaced files and unmount collapsed content so renderer-owned resources are released.
  const activeContentKey =
    activeItem?.type === 'file'
      ? JSON.stringify([
          activeItem.id,
          activeItem.source ?? 'artifact',
          activeItem.path,
          activeItem.mimeType ?? null,
          activeItem.size ?? null,
          activeItem.mtimeMs ?? null
        ])
      : (activeItem?.id ?? 'empty')

  const handleResize = (
    panelSize: PanelSize,
    _panelId: string | number | undefined,
    previousPanelSize: PanelSize | undefined
  ): void => {
    onResize(panelSize, previousPanelSize)
  }

  return (
    <ResizablePanel
      id="right-panel"
      // The parent drives expand/collapse in response to store open requests and header toggles.
      panelRef={panelRef}
      defaultSize={defaultSize}
      minSize={minSize}
      collapsible
      collapsedSize="0%"
      onResize={handleResize}
    >
      <aside className="flex h-full w-full flex-col overflow-hidden bg-bg-10 py-[10px]">
        {items.length > 0 ? (
          <PreviewTabBar
            tabs={items}
            activeItemId={activeItemId}
            onActivate={activateItem}
            onClose={removeItem}
          />
        ) : null}
        <div className={cn('min-h-0 flex-1', activeItem?.type === 'file' && 'pl-2 pr-1')}>
          {!activeItem ? <PreviewActiveContent key={activeContentKey} item={activeItem} /> : null}
          {items.map((item) => {
            const isActivePanel = item.id === activeItemId && panelState === 'open'
            if (!isActivePanel) {
              return (
                <section
                  key={item.id}
                  role="tabpanel"
                  id={getPreviewPanelId(item.id)}
                  aria-labelledby={getPreviewTabId(item.id)}
                  hidden
                />
              )
            }

            return item.type === 'file' ? (
              <section
                key={item.id}
                data-testid="preview-card"
                role="tabpanel"
                id={getPreviewPanelId(item.id)}
                aria-labelledby={getPreviewTabId(item.id)}
                tabIndex={0}
                className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md bg-bg-000 shadow-card"
              >
                <PreviewCardHeader item={item} onClose={removeItem} />
                <div className="min-h-0 flex-1 overflow-y-auto bg-bg-000">
                  <PreviewActiveContent key={activeContentKey} item={item} />
                </div>
              </section>
            ) : (
              <section
                key={item.id}
                role="tabpanel"
                id={getPreviewPanelId(item.id)}
                aria-labelledby={getPreviewTabId(item.id)}
                tabIndex={0}
                className="h-full min-h-0 w-full overflow-y-auto"
              >
                <PreviewActiveContent key={activeContentKey} item={item} />
              </section>
            )
          })}
        </div>
      </aside>
    </ResizablePanel>
  )
}

export { PreviewPanel }
