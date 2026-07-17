import { X } from 'lucide-react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import { ResizablePanel } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import type { PreviewItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

import { PreviewFileContent } from './previews/PreviewFileContent'
import { PreviewToolContent } from './previews/PreviewToolContent'

type PreviewPanelProps = {
  panelRef: React.Ref<PanelImperativeHandle>
  defaultSize: string
  minSize: string
  onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
}

type PreviewTab = { id: string; title: string }

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
  'group flex h-8 max-w-[160px] shrink-0 items-center gap-1 rounded-md px-2 text-[12px] transition-colors'

// Renders one open-preview tab and its close affordance.
const PreviewTab = ({
  tab,
  isActive,
  onActivate,
  onClose
}: {
  tab: PreviewTab
  isActive: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element => (
  <div
    className={cn(
      previewTabClassName,
      isActive ? 'bg-bg-300 text-text-000' : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
    )}
  >
    <button
      type="button"
      className="min-w-0 flex-1 truncate text-left"
      onClick={() => onActivate(tab.id)}
      title={tab.title}
    >
      {tab.title}
    </button>
    <button
      type="button"
      className={cn(
        'shrink-0 rounded-sm p-0.5 hover:bg-bg-000/60',
        isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      )}
      onClick={(event) => {
        event.stopPropagation()
        onClose(tab.id)
      }}
      aria-label={`Close preview of ${tab.title}`}
    >
      <X className="size-3.5" aria-hidden />
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
  tabs: PreviewTab[]
  activeItemId: string | undefined
  onActivate: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element => (
  <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-2">
    {tabs.map((tab) => (
      <PreviewTab
        key={tab.id}
        tab={tab}
        isActive={tab.id === activeItemId}
        onActivate={onActivate}
        onClose={onClose}
      />
    ))}
  </div>
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
        <div className="flex-1 overflow-y-auto bg-bg-10">
          {!activeItem || panelState === 'open' ? (
            <PreviewActiveContent key={activeContentKey} item={activeItem} />
          ) : null}
        </div>
      </aside>
    </ResizablePanel>
  )
}

export { PreviewPanel }
