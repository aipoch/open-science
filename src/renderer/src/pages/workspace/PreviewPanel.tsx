import { BookOpen, File, FolderOpen, Globe2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { ActionMenuProvider, ActionMenuTarget } from '@/components/action-menu'
import { ResizablePanel } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type {
  PreviewFileItem,
  PreviewItem,
  PreviewSourceItem,
  PreviewToolItem
} from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { workbenchPreviewGuardScope } from '@/stores/preview-leave-guard'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { PreviewFileSurface, type PreviewFileSurfaceHandle } from './PreviewFileSurface'
import {
  createPreviewTabActionBindings,
  getPreviewTabActionRecipe,
  PREVIEW_TAB_ACTION_CATALOG,
  type PreviewTabActionCommand,
  type PreviewTabActionContext,
  type PreviewTabActionDeps
} from './preview-tab-actions'
import { PreviewFileContent } from './previews/PreviewFileContent'
import { SourceWebPreview } from './previews/SourceWebPreview'
import type { PreviewAnnotationPort, PreviewInteractionPort } from './previews/preview-types'
import { PreviewToolContent } from './previews/PreviewToolContent'
import type { RestoredPlanResponder } from './session-plan/SessionPlanSurfaces'
import { useHorizontalScrollFade } from './use-horizontal-scroll-fade'
import { usePdfContextAction } from './use-pdf-context-action'

type PreviewPanelProps = PreviewInteractionPort & {
  panelRef: React.Ref<PanelImperativeHandle>
  defaultSize: string
  minSize: string
  onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
  restoredPlanResponder?: RestoredPlanResponder
  onPdfContextError?: (message: string | null) => void
}

type PreviewPanelSurfaceProps = PreviewInteractionPort & {
  className?: string
  restoredPlanResponder?: RestoredPlanResponder
  onPdfContextError?: (message: string | null) => void
}

// Renders the active tab's content, or an empty state when nothing is previewed yet.
const PreviewActiveContent = ({
  item,
  restoredPlanResponder,
  ...annotationPort
}: {
  item: PreviewItem | undefined
  restoredPlanResponder?: RestoredPlanResponder
} & PreviewAnnotationPort): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (!item) {
    return (
      <div className="flex size-full items-center justify-center text-[12px] text-text-300">
        {t('No preview content')}
      </div>
    )
  }

  if (item.type === 'tool') {
    return <PreviewToolContent item={item} restoredPlanResponder={restoredPlanResponder} />
  }

  if (item.type === 'source') return <SourceWebPreview item={item} />

  return <PreviewFileContent item={item} {...annotationPort} />
}

const previewTabClassName =
  'group flex h-8 max-w-[160px] shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-[12px] transition-colors'

const getPreviewTabId = (itemId: string): string => `preview-tab-${encodeURIComponent(itemId)}`
const getPreviewPanelId = (itemId: string): string => `preview-panel-${encodeURIComponent(itemId)}`
const PREVIEW_MODAL_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const PREVIEW_TAB_EDGE_INSET = 8

const PreviewTabActionTarget = ({
  item,
  tabCount,
  onPdfContextError,
  onLinkReadingContext,
  onUnlinkReadingContext,
  children
}: {
  item: PreviewItem
  tabCount: number
  onPdfContextError?: (message: string | null) => void
  onLinkReadingContext?: PreviewInteractionPort['onLinkReadingContext']
  onUnlinkReadingContext?: PreviewInteractionPort['onUnlinkReadingContext']
  children: React.ReactElement
}): React.JSX.Element => {
  const composerFocusRequestedRef = useRef(false)
  const activateItem = usePreviewWorkbenchStore((state) => state.activateItem)
  const removeItem = usePreviewWorkbenchStore((state) => state.removeItem)
  const removeOtherItems = usePreviewWorkbenchStore((state) => state.removeOtherItems)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const { action: pdfAction } = usePdfContextAction(
    item.type === 'file' ? item : undefined,
    onPdfContextError,
    { link: onLinkReadingContext, unlink: onUnlinkReadingContext }
  )
  const context: PreviewTabActionContext = {
    tabCount,
    ...(pdfAction && !pdfAction.disabled ? { pdfContext: pdfAction.state } : {})
  }
  const stageLocalPath = window.api.uploads?.stageLocalPath
  const deps: PreviewTabActionDeps = {
    closeTab: removeItem,
    closeOtherTabs: removeOtherItems,
    saveManagedFile: (request) => window.api.saveManagedFile(request),
    copyText: (text) => navigator.clipboard.writeText(text),
    stageLocalPath: stageLocalPath ? (request) => stageLocalPath(request) : undefined,
    togglePdfContext:
      pdfAction && !pdfAction.disabled && item.type === 'file'
        ? () => {
            // Linking also enters reading view; the focus override below preserves that handoff.
            activateItem(item.id)
            pdfAction.run()
          }
        : undefined,
    activeProjectId
  }
  const bindings = createPreviewTabActionBindings(context, deps)
  const pdfContextBinding = bindings['toggle-pdf-context']
  const focusAwareBindings = pdfContextBinding
    ? {
        ...bindings,
        'toggle-pdf-context': {
          ...pdfContextBinding,
          execute: (invocation: PreviewItem) => {
            composerFocusRequestedRef.current = pdfAction?.state !== 'remove'
            return pdfContextBinding.execute(invocation)
          }
        }
      }
    : bindings

  return (
    <ActionMenuTarget<PreviewTabActionCommand, PreviewItem>
      targetId={`preview-tab:${item.id}`}
      identityKey={JSON.stringify([
        item.id,
        item.type,
        item.type === 'file' ? item.path : null,
        item.type === 'file' ? (item.selectedVersionId ?? null) : null
      ])}
      catalog={PREVIEW_TAB_ACTION_CATALOG}
      recipe={getPreviewTabActionRecipe(item, context)}
      bindings={focusAwareBindings}
      invocation={item}
      onRestoreFocus={() => {
        const composerFocusRequested = composerFocusRequestedRef.current
        composerFocusRequestedRef.current = false
        if (!composerFocusRequested) {
          document.getElementById(getPreviewTabId(item.id))?.focus()
        }
      }}
      asChild
    >
      {children}
    </ActionMenuTarget>
  )
}

// Scrolls only when the complete tab falls outside the tab list's padded visible bounds.
const scrollPreviewTabIntoView = (
  tabList: HTMLElement,
  tab: HTMLElement,
  behavior: ScrollBehavior
): void => {
  const tabListRect = tabList.getBoundingClientRect()
  if (tabListRect.width <= PREVIEW_TAB_EDGE_INSET * 2) return

  const tabRect = tab.getBoundingClientRect()
  const visibleLeft = tabListRect.left + PREVIEW_TAB_EDGE_INSET
  const visibleRight = tabListRect.right - PREVIEW_TAB_EDGE_INSET
  let offset = 0

  if (tabRect.left < visibleLeft) offset = tabRect.left - visibleLeft
  else if (tabRect.right > visibleRight) offset = tabRect.right - visibleRight
  if (offset === 0) return

  tabList.scrollTo({ left: tabList.scrollLeft + offset, behavior })
}

// One tab owns activation/keyboard behavior while its sibling close button preserves quick removal.
const PreviewTab = ({
  tab,
  isActive,
  containerRef,
  tabRef,
  tabCount,
  onPdfContextError,
  onLinkReadingContext,
  onUnlinkReadingContext,
  onActivate,
  onClose,
  onKeyDown
}: {
  tab: PreviewItem
  isActive: boolean
  containerRef: (element: HTMLDivElement | null) => void
  tabRef: (element: HTMLButtonElement | null) => void
  tabCount: number
  onPdfContextError?: (message: string | null) => void
  onLinkReadingContext?: PreviewInteractionPort['onLinkReadingContext']
  onUnlinkReadingContext?: PreviewInteractionPort['onUnlinkReadingContext']
  onActivate: (id: string) => void
  onClose: (id: string) => boolean
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const tabTitle = tab.title

  return (
    <div
      ref={containerRef}
      role="presentation"
      className={cn(
        previewTabClassName,
        isActive ? 'bg-bg-300 text-text-000' : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
      )}
    >
      <PreviewTabActionTarget
        item={tab}
        tabCount={tabCount}
        onPdfContextError={onPdfContextError}
        onLinkReadingContext={onLinkReadingContext}
        onUnlinkReadingContext={onUnlinkReadingContext}
      >
        <button
          ref={tabRef}
          type="button"
          role="tab"
          id={getPreviewTabId(tab.id)}
          aria-controls={getPreviewPanelId(tab.id)}
          aria-selected={isActive}
          aria-keyshortcuts="Delete Backspace"
          tabIndex={isActive ? 0 : -1}
          className="flex min-w-0 items-center gap-1 self-stretch text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('[data-preview-close]')) {
              onClose(tab.id)
              return
            }
            onActivate(tab.id)
          }}
          onKeyDown={onKeyDown}
          title={tabTitle}
        >
          {tab.type === 'file' ? (
            <File className="size-3.5 shrink-0" aria-hidden="true" />
          ) : tab.type === 'source' ? (
            <Globe2
              data-source-preview-tab-icon=""
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
          ) : tab.toolKind === 'files' ? (
            <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
          ) : tab.toolKind === 'notebook' ? (
            <BookOpen className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          ) : null}
          {tab.type === 'file' ? (
            <ExtensionPreservingFileName name={tab.name} />
          ) : (
            <span className="min-w-0 truncate">{tabTitle}</span>
          )}
          <span
            data-preview-close={tabTitle}
            aria-hidden="true"
            title={t('Close preview of {{title}}', { title: tabTitle })}
            className={cn(
              'shrink-0 rounded-sm p-0.5 hover:bg-bg-000/60',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <X className="size-3.5" />
          </span>
        </button>
      </PreviewTabActionTarget>
    </div>
  )
}

// Horizontal, scrollable strip of every file the user has asked to preview this session.
const PreviewTabBar = ({
  tabs,
  activeItemId,
  onActivate,
  onClose,
  onPdfContextError,
  onLinkReadingContext,
  onUnlinkReadingContext
}: {
  tabs: PreviewItem[]
  activeItemId: string | undefined
  onActivate: (id: string) => void
  onClose: (id: string) => boolean
  onPdfContextError?: (message: string | null) => void
  onLinkReadingContext?: PreviewInteractionPort['onLinkReadingContext']
  onUnlinkReadingContext?: PreviewInteractionPort['onUnlinkReadingContext']
}): React.JSX.Element => {
  const tabListRef = useHorizontalScrollFade<HTMLDivElement>()
  const tabContainerRefs = useRef<Array<HTMLDivElement | null>>([])
  const { t } = useTranslation()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const scrollActiveTabIntoView = useCallback(
    (behavior: ScrollBehavior): void => {
      const tabList = tabListRef.current
      if (!tabList) return

      const activeIndex = tabs.findIndex((tab) => tab.id === activeItemId)
      const activeTab = activeIndex === -1 ? null : tabContainerRefs.current[activeIndex]
      if (activeTab) scrollPreviewTabIntoView(tabList, activeTab, behavior)
    },
    [activeItemId, tabListRef, tabs]
  )

  // External activation keeps the selected tab visible without moving keyboard focus.
  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    scrollActiveTabIntoView(reduceMotion ? 'auto' : 'smooth')
  }, [scrollActiveTabIntoView])

  // Panel expansion and drag-resizing can clip an unchanged active tab, so recheck on width changes.
  useEffect(() => {
    const tabList = tabListRef.current
    if (!tabList || typeof ResizeObserver === 'undefined') return

    let previousWidth = tabList.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const nextWidth = tabList.getBoundingClientRect().width
      if (nextWidth === previousWidth) return

      previousWidth = nextWidth
      scrollActiveTabIntoView('auto')
    })
    observer.observe(tabList)

    return () => observer.disconnect()
  }, [scrollActiveTabIntoView, tabListRef])

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
      if (onClose(tab.id) && fallbackIndex >= 0) moveToTab(fallbackIndex)
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
      ref={tabListRef}
      role="tablist"
      aria-label={t('Open previews')}
      aria-orientation="horizontal"
      className="scroll-fade-x flex min-w-0 flex-1 basis-0 shrink-0 items-center gap-1 overflow-x-auto pb-2"
    >
      {tabs.map((tab, index) => (
        <PreviewTab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeItemId}
          containerRef={(element) => {
            tabContainerRefs.current[index] = element
          }}
          tabRef={(element) => {
            tabRefs.current[index] = element
          }}
          tabCount={tabs.length}
          onPdfContextError={onPdfContextError}
          onLinkReadingContext={onLinkReadingContext}
          onUnlinkReadingContext={onUnlinkReadingContext}
          onActivate={onActivate}
          onClose={onClose}
          onKeyDown={(event) => handleTabKeyDown(event, index)}
        />
      ))}
    </div>
  )
}

// Shared modal behavior for surfaces that switch between panel and modal layout without
// remounting: Escape closes, Tab traps focus inside, body scroll locks, and closing returns
// focus to the owning tab. Escape is ignored while focus lives outside the surface (e.g. a
// portaled dialog above it) so nested overlays close one layer at a time.
const usePreviewModalSurface = ({
  isOpen,
  onClose,
  surfaceRef,
  itemId
}: {
  isOpen: boolean
  onClose: () => void
  surfaceRef: React.RefObject<HTMLElement | null>
  itemId: string
}): void => {
  useEffect(() => {
    if (!isOpen) return

    const surface = surfaceRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    surface?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (
          surface &&
          document.activeElement !== surface &&
          !surface.contains(document.activeElement)
        ) {
          return
        }
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !surface) return

      const focusable = Array.from(
        surface.querySelectorAll<HTMLElement>(PREVIEW_MODAL_FOCUSABLE_SELECTOR)
      )
      if (focusable.length === 0) {
        event.preventDefault()
        surface.focus()
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = previousOverflow
      document.getElementById(getPreviewTabId(itemId))?.focus()
    }
  }, [isOpen, onClose, surfaceRef, itemId])
}

// The same surface switches between panel and modal layout so stateful renderers never remount.
const PreviewFilePanel = ({
  item,
  contentKey,
  onClose,
  onPdfContextError,
  ...annotationPort
}: {
  item: PreviewFileItem
  contentKey: string
  onClose: (id: string) => boolean
  onPdfContextError?: (message: string | null) => void
} & PreviewInteractionPort): React.JSX.Element => {
  const { t } = useTranslation()
  const [isFullScreenOpen, setIsFullScreenOpen] = useState(false)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const previewSurfaceRef = useRef<PreviewFileSurfaceHandle | null>(null)

  const closeFullScreen = useCallback((checkGuard = true): void => {
    if (checkGuard && previewSurfaceRef.current) {
      previewSurfaceRef.current.requestLeave(() => setIsFullScreenOpen(false))
      return
    }
    setIsFullScreenOpen(false)
  }, [])

  const openFullScreen = (): void => {
    setIsFullScreenOpen(true)
  }

  usePreviewModalSurface({
    isOpen: isFullScreenOpen,
    onClose: () => closeFullScreen(true),
    surfaceRef,
    itemId: item.id
  })

  return (
    <>
      {isFullScreenOpen ? (
        <div
          aria-hidden="true"
          data-state="open"
          className={`${dialogOverlayClassName} z-[60] cursor-default`}
          onClick={() => closeFullScreen(true)}
        />
      ) : null}
      <section
        ref={surfaceRef}
        data-testid="preview-card"
        role={isFullScreenOpen ? 'dialog' : 'tabpanel'}
        aria-modal={isFullScreenOpen || undefined}
        aria-label={isFullScreenOpen ? t('Preview {{title}}', { title: item.title }) : undefined}
        id={isFullScreenOpen ? undefined : getPreviewPanelId(item.id)}
        aria-labelledby={isFullScreenOpen ? undefined : getPreviewTabId(item.id)}
        tabIndex={isFullScreenOpen ? -1 : 0}
        data-state={isFullScreenOpen ? 'open' : undefined}
        className={
          isFullScreenOpen
            ? dialogPanelClassName(
                'z-[61] flex h-[90vh] w-[90vw] max-w-none min-h-0 flex-col overflow-hidden overscroll-contain p-0'
              )
            : cn(
                'flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md bg-bg-000 shadow-card'
              )
        }
      >
        <PreviewFileSurface
          ref={previewSurfaceRef}
          item={item}
          contentKey={contentKey}
          // Full-screen mode floats above the modal panel (z-[61]); tooltips must follow.
          tooltipClassName={isFullScreenOpen ? 'z-[70]' : undefined}
          actionMenuContentClassName={isFullScreenOpen ? 'z-[70]' : undefined}
          onClose={isFullScreenOpen ? () => closeFullScreen(true) : () => onClose(item.id)}
          onOpenFullScreen={isFullScreenOpen ? undefined : openFullScreen}
          // The floating surface covers the conversation panel, so a View in context navigation
          // must collapse it for the switched session to become visible. The inline panel keeps
          // its place in the workbench and needs no exit.
          onViewInContextNavigate={isFullScreenOpen ? closeFullScreen : undefined}
          onPdfContextError={onPdfContextError}
          provenanceEntry={isFullScreenOpen ? 'trailing' : 'menu'}
          leaveGuardScope={workbenchPreviewGuardScope(item.projectId, item.id)}
          workbenchConnected
          {...annotationPort}
        />
      </section>
    </>
  )
}

// Tool tabs (files/notebook/reviewer) reuse the same panel/modal layout switch as file previews.
// The expanded state lives in the workbench store because the expand button is rendered by the
// tool content itself (ProjectFilesView), not by this chrome. Overlay/panel stay below z-[60] so
// workspace-level dialogs such as FilePreviewDialog stack above the modal.
// Rendered for every tool tab, active or not, so component state (e.g. the local file browser's
// current directory) survives switching to another tab and back. Inactive panels only get `hidden`;
// returning a different element from this map position would let React unmount the subtree.
const PreviewToolPanel = ({
  item,
  isActive,
  restoredPlanResponder
}: {
  item: PreviewToolItem
  isActive: boolean
  restoredPlanResponder?: RestoredPlanResponder
}): React.JSX.Element => {
  const isExpanded = usePreviewWorkbenchStore(
    (state) => state.expandedToolItemId === item.id && isActive
  )
  const setToolItemExpanded = usePreviewWorkbenchStore((state) => state.setToolItemExpanded)
  const surfaceRef = useRef<HTMLElement | null>(null)

  const closeExpanded = useCallback((): void => {
    setToolItemExpanded(null)
  }, [setToolItemExpanded])

  usePreviewModalSurface({
    isOpen: isExpanded,
    onClose: closeExpanded,
    surfaceRef,
    itemId: item.id
  })

  return (
    <>
      {isExpanded ? (
        <div
          aria-hidden="true"
          data-state="open"
          className={`${dialogOverlayClassName} z-[55] cursor-default`}
          onClick={closeExpanded}
        />
      ) : null}
      <section
        ref={surfaceRef}
        role={isExpanded ? 'dialog' : 'tabpanel'}
        aria-modal={isExpanded || undefined}
        aria-label={isExpanded ? item.title : undefined}
        id={isExpanded ? undefined : getPreviewPanelId(item.id)}
        aria-labelledby={isExpanded ? undefined : getPreviewTabId(item.id)}
        tabIndex={isExpanded ? -1 : 0}
        hidden={!isActive && !isExpanded}
        data-state={isExpanded ? 'open' : undefined}
        className={
          isExpanded
            ? dialogPanelClassName(
                'z-[56] flex h-[90vh] w-[90vw] max-w-none min-h-0 flex-col overflow-hidden overscroll-contain p-0'
              )
            : 'h-full min-h-0 w-full overflow-y-auto'
        }
      >
        <PreviewActiveContent item={item} restoredPlanResponder={restoredPlanResponder} />
      </section>
    </>
  )
}

const PreviewSourcePanel = ({
  item,
  isActive,
  onClose
}: {
  item: PreviewSourceItem
  isActive: boolean
  onClose: (id: string) => void
}): React.JSX.Element => (
  <section
    role="tabpanel"
    id={getPreviewPanelId(item.id)}
    aria-labelledby={getPreviewTabId(item.id)}
    tabIndex={0}
    hidden={!isActive}
    className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-md bg-bg-000 shadow-card"
  >
    <SourceWebPreview item={item} onClose={() => onClose(item.id)} />
  </section>
)

// Shared workbench surface. Desktop wraps it in a resizable panel; mobile presents the exact same
// tabs and active content inside a bottom sheet.
const PreviewPanelSurface = ({
  className,
  restoredPlanResponder,
  onPdfContextError,
  onLinkReadingContext,
  onUnlinkReadingContext,
  ...annotationPort
}: PreviewPanelSurfaceProps): React.JSX.Element => {
  const items = usePreviewWorkbenchStore((state) => state.items)
  const activeItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const panelState = usePreviewWorkbenchStore((state) => state.panelState)
  const activateItem = usePreviewWorkbenchStore((state) => state.activateItem)
  const removeItem = usePreviewWorkbenchStore((state) => state.removeItem)
  const activeItem = items.find((item) => item.id === activeItemId)
  // Remount replaced file previews and release their renderer-owned resources while collapsed.
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

  return (
    <ActionMenuProvider testId="preview-tab-context-menu">
      <aside
        id="right-panel"
        className={cn(
          'relative flex h-full w-full flex-col overflow-hidden bg-bg-10 py-[0.7px]',
          className
        )}
      >
        {items.length > 0 ? (
          <div
            data-testid="preview-panel-top-bar"
            className="flex min-w-0 w-full shrink-0 items-start pl-2 pr-14"
          >
            <PreviewTabBar
              tabs={items}
              activeItemId={activeItemId}
              onActivate={activateItem}
              onClose={removeItem}
              onPdfContextError={onPdfContextError}
              onLinkReadingContext={onLinkReadingContext}
              onUnlinkReadingContext={onUnlinkReadingContext}
            />
          </div>
        ) : null}
        <div
          className={cn(
            'min-h-0 flex-1',
            (activeItem?.type === 'file' || activeItem?.type === 'source') && 'pl-2 pr-1'
          )}
        >
          {!activeItem ? (
            <PreviewActiveContent
              key={activeContentKey}
              item={activeItem}
              restoredPlanResponder={restoredPlanResponder}
            />
          ) : null}
          {items.map((item) => {
            const isActivePanel = item.id === activeItemId && panelState === 'open'
            // Tool panels render at this map position whether active or not, so React keeps the
            // subtree mounted across tab switches. File panels re-create on activation anyway
            // (contentKey encodes path+mtime), so an inactive one collapses to an empty region.
            if (item.type === 'tool') {
              return (
                <PreviewToolPanel
                  key={item.id}
                  item={item}
                  isActive={isActivePanel}
                  restoredPlanResponder={restoredPlanResponder}
                />
              )
            }

            if (item.type === 'source') {
              // Source frames stay mounted while their tabs exist so browser and failure state survive
              // tab switches. Removing the item still unmounts the whole subtree and releases the page.
              return (
                <PreviewSourcePanel
                  key={item.id}
                  item={item}
                  isActive={isActivePanel}
                  onClose={removeItem}
                />
              )
            }

            return isActivePanel ? (
              <PreviewFilePanel
                key={item.id}
                item={item}
                contentKey={activeContentKey}
                onClose={(itemId) => {
                  const before = usePreviewWorkbenchStore.getState().items.length
                  removeItem(itemId)
                  return usePreviewWorkbenchStore.getState().items.length < before
                }}
                {...annotationPort}
                onLinkReadingContext={onLinkReadingContext}
                onUnlinkReadingContext={onUnlinkReadingContext}
                onPdfContextError={onPdfContextError}
              />
            ) : (
              <section
                key={item.id}
                role="tabpanel"
                id={getPreviewPanelId(item.id)}
                aria-labelledby={getPreviewTabId(item.id)}
                hidden
              />
            )
          })}
        </div>
      </aside>
    </ActionMenuProvider>
  )
}

// Desktop right-side workbench: a tab strip over every previewed file, plus active content.
const PreviewPanel = ({
  panelRef,
  defaultSize,
  minSize,
  onResize,
  restoredPlanResponder,
  onPdfContextError,
  onLinkReadingContext,
  onUnlinkReadingContext,
  ...annotationPort
}: PreviewPanelProps): React.JSX.Element => {
  const handleResize = (
    panelSize: PanelSize,
    _panelId: string | number | undefined,
    previousPanelSize: PanelSize | undefined
  ): void => {
    onResize(panelSize, previousPanelSize)
  }

  return (
    <ResizablePanel
      id="right-panel-resizable"
      // The parent drives expand/collapse in response to store open requests and header toggles.
      panelRef={panelRef}
      defaultSize={defaultSize}
      minSize={minSize}
      collapsible
      collapsedSize="0%"
      onResize={handleResize}
    >
      <PreviewPanelSurface
        restoredPlanResponder={restoredPlanResponder}
        onPdfContextError={onPdfContextError}
        onLinkReadingContext={onLinkReadingContext}
        onUnlinkReadingContext={onUnlinkReadingContext}
        {...annotationPort}
      />
    </ResizablePanel>
  )
}

export { PreviewPanel }
export { PreviewPanelSurface }
