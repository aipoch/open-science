import { animate } from 'motion'
import { PanelLeft, PanelRight } from 'lucide-react'
import { FocusScope } from '@radix-ui/react-focus-scope'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useMediaQuery } from '@/hooks/useMediaQuery'

import { MobilePreviewSheet } from './MobilePreviewSheet'
import { PreviewPanel } from './PreviewPanel'
import type { RestoredPlanResponder } from './session-plan/SessionPlanSurfaces'
import type { PreviewInteractionPort } from './previews/preview-types'

const PANEL_COLLAPSED_SIZE = 0
const PANEL_COLLAPSED_SIZE_CSS = `${PANEL_COLLAPSED_SIZE}%`
const PANEL_COLLAPSED_THRESHOLD = 0.1

const SIDEBAR_PANEL_DEFAULT_SIZE = 16
const SIDEBAR_PANEL_DEFAULT_SIZE_CSS = `${SIDEBAR_PANEL_DEFAULT_SIZE}%`
const SIDEBAR_PANEL_MIN_OPEN_SIZE = 16
const SIDEBAR_TOGGLE_RIGHT_INSET = 38

const PREVIEW_PANEL_DEFAULT_SIZE = 40
const PREVIEW_PANEL_DEFAULT_SIZE_CSS = `${PREVIEW_PANEL_DEFAULT_SIZE}%`
const PREVIEW_PANEL_MIN_OPEN_SIZE = 30
// Match the visible divider and its hit area to the resize library's hover/drag region.
const WORKSPACE_RESIZE_HANDLE_CLASS_NAME =
  'z-20 after:w-5 before:top-0 before:h-full before:translate-y-0 before:bg-text-200 hover:before:opacity-100 focus-visible:before:opacity-100 data-[separator=hover]:before:opacity-100 data-[separator=active]:before:opacity-100 transition-opacity duration-200 ease-out'
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'

const panelAnimation = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number]
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

type ResizablePanelState = 'open' | 'collapsed'
type PanelAnimationDirection = 'opening' | 'closing'

type AnimatedResizablePanelOptions = {
  panelState: ResizablePanelState
  defaultOpenSize: number
  minOpenSize: number
  requestVersion?: number
  onPanelStateChange: (state: ResizablePanelState) => boolean | void
  onPixelWidthChange?: (width: number) => void
  collapseFocusTargetRef: React.RefObject<HTMLButtonElement | null>
}

type AnimatedResizablePanel = {
  panelRef: React.RefObject<PanelImperativeHandle | null>
  separatorRef: React.RefObject<HTMLDivElement | null>
  minSize: string
  onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
}

// Owns the imperative animation lifecycle shared by the two workspace side panels.
const useAnimatedResizablePanel = ({
  panelState,
  defaultOpenSize,
  minOpenSize,
  requestVersion = 0,
  onPanelStateChange,
  onPixelWidthChange,
  collapseFocusTargetRef
}: AnimatedResizablePanelOptions): AnimatedResizablePanel => {
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  const separatorRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<{ stop: () => void } | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const animationDirectionRef = useRef<PanelAnimationDirection | null>(null)
  const lastOpenSizeRef = useRef(defaultOpenSize)
  const hasSyncedInitialSizeRef = useRef(false)
  const [isMinSizeRelaxed, setIsMinSizeRelaxed] = useState(false)

  const animatePanelSize = useCallback(
    (
      targetSize: number,
      direction: PanelAnimationDirection,
      options?: { animate?: boolean }
    ): void => {
      const panel = panelRef.current
      if (!panel) return

      animationRef.current?.stop()
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }

      const resizePanel = (size: number): boolean => {
        const currentPanel = panelRef.current

        // Ignore motion callbacks that outlive the panel handle they were created for.
        if (currentPanel !== panel) return false

        currentPanel.resize(`${Number(size.toFixed(3))}%`)
        return true
      }

      const startFromSize = (currentSize: number): void => {
        if (
          options?.animate === false ||
          Math.abs(currentSize - targetSize) <= PANEL_COLLAPSED_THRESHOLD ||
          prefersReducedMotion()
        ) {
          resizePanel(targetSize)
          if (direction === 'opening') lastOpenSizeRef.current = targetSize
          animationDirectionRef.current = null
          animationRef.current = null
          setIsMinSizeRelaxed(false)
          return
        }

        animationDirectionRef.current = direction
        setIsMinSizeRelaxed(true)
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null
          const nextPanel = panelRef.current
          if (!nextPanel) return

          const nextCurrentSize = nextPanel.getSize().asPercentage
          animationRef.current = animate(nextCurrentSize, targetSize, {
            ...panelAnimation,
            onUpdate: resizePanel,
            onComplete: () => {
              const didResize = resizePanel(targetSize)
              if (didResize && direction === 'opening') lastOpenSizeRef.current = targetSize
              animationDirectionRef.current = null
              animationRef.current = null
              setIsMinSizeRelaxed(false)
            }
          })
        })
      }

      try {
        startFromSize(panel.getSize().asPercentage)
      } catch {
        // react-resizable-panels can expose the handle before its layout is registered.
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null
          const nextPanel = panelRef.current
          if (nextPanel !== panel) return

          try {
            startFromSize(nextPanel.getSize().asPercentage)
          } catch {
            // A detached panel will be synchronized by the next state/layout pass.
          }
        })
      }
    },
    []
  )

  const onResize = useCallback(
    (panelSize: PanelSize, previousPanelSize: PanelSize | undefined): void => {
      onPixelWidthChange?.(panelSize.inPixels)

      const isNearCollapsedSize = panelSize.asPercentage <= PANEL_COLLAPSED_THRESHOLD
      const animationDirection = animationDirectionRef.current
      const isOpeningAnimationResize =
        animationDirection === 'opening' &&
        (previousPanelSize === undefined ||
          panelSize.asPercentage >= previousPanelSize.asPercentage)
      const isClosingAnimationResize =
        animationDirection === 'closing' &&
        (previousPanelSize === undefined ||
          panelSize.asPercentage <= previousPanelSize.asPercentage)

      if (isNearCollapsedSize && isOpeningAnimationResize) return
      if (!isNearCollapsedSize && isClosingAnimationResize) return

      if (!isNearCollapsedSize && animationDirection === null) {
        lastOpenSizeRef.current = panelSize.asPercentage
      }

      if (isNearCollapsedSize && document.activeElement === separatorRef.current) {
        collapseFocusTargetRef.current?.focus()
      }

      const accepted = onPanelStateChange(isNearCollapsedSize ? 'collapsed' : 'open')
      if (isNearCollapsedSize && accepted === false) {
        animatePanelSize(Math.max(lastOpenSizeRef.current, minOpenSize), 'opening')
      }
    },
    [animatePanelSize, collapseFocusTargetRef, minOpenSize, onPanelStateChange, onPixelWidthChange]
  )

  // Synchronize restored state on first layout without introducing an entrance animation.
  useLayoutEffect(() => {
    const shouldAnimate = hasSyncedInitialSizeRef.current
    hasSyncedInitialSizeRef.current = true

    if (panelState === 'collapsed') {
      animatePanelSize(PANEL_COLLAPSED_SIZE, 'closing', { animate: shouldAnimate })
      return
    }

    animatePanelSize(Math.max(lastOpenSizeRef.current, minOpenSize), 'opening', {
      animate: shouldAnimate
    })
  }, [animatePanelSize, minOpenSize, panelState, requestVersion])

  useEffect(
    () => () => {
      animationRef.current?.stop()
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
    },
    []
  )

  return {
    panelRef,
    separatorRef,
    minSize: isMinSizeRelaxed ? PANEL_COLLAPSED_SIZE_CSS : `${minOpenSize}%`,
    onResize
  }
}

type WorkspacePanelLayout = {
  isMobile: boolean
  mobileSidebar: {
    isOpen: boolean
    open: () => void
    close: () => void
  }
  sidebar: AnimatedResizablePanel & {
    state: ResizablePanelState
    defaultSize: string
    toggle: () => void
    // Shared between the sidebar header toggle (expanded) and the floating fallback (collapsed);
    // exactly one of them is mounted at a time, so React hands the ref over automatically.
    toggleRef: React.RefObject<HTMLButtonElement | null>
    toggleButton: React.ReactNode
  }
  preview: AnimatedResizablePanel & {
    state: ResizablePanelState
    defaultSize: string
    toggle: () => void
    collapse: () => void
    toggleButton: React.ReactNode
  }
}

type PreviewPanelLayoutPort = {
  state: ResizablePanelState
  openRequestVersion: number
  toggle: () => void
  syncState: (state: ResizablePanelState) => boolean
}

// Presents one layout contract to WorkspacePage across desktop and mobile surfaces.
const useWorkspacePanelLayout = (
  previewPort: PreviewPanelLayoutPort,
  mobileSidebarDialogRef: React.RefObject<HTMLDivElement | null>
): WorkspacePanelLayout => {
  const { t } = useTranslation()
  const [sidebarState, setSidebarState] = useState<ResizablePanelState>('open')
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null)
  const previewToggleRef = useRef<HTMLButtonElement | null>(null)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const mobileSidebarReturnFocusRef = useRef<HTMLElement | null>(null)
  const mobileSidebarWasOpenRef = useRef(false)
  // Latest sidebar width in pixels and a render-phase-independent mirror of the collapse state,
  // so the floating fallback can be positioned no matter which toggle instance holds the ref.
  const sidebarPixelWidthRef = useRef<number | null>(null)
  const sidebarStateRef = useRef(sidebarState)

  const rememberMobileSidebarReturnFocus = useCallback((): void => {
    const activeElement = document.activeElement
    mobileSidebarReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null
  }, [])
  const openMobileSidebar = useCallback((): void => {
    rememberMobileSidebarReturnFocus()
    setIsMobileSidebarOpen(true)
  }, [rememberMobileSidebarReturnFocus])
  const closeMobileSidebar = useCallback((): void => setIsMobileSidebarOpen(false), [])
  const toggleMobileSidebar = useCallback((): void => {
    if (!isMobileSidebarOpen) rememberMobileSidebarReturnFocus()
    setIsMobileSidebarOpen(!isMobileSidebarOpen)
  }, [isMobileSidebarOpen, rememberMobileSidebarReturnFocus])
  const toggleSidebar = useCallback(
    (): void => setSidebarState((state) => (state === 'collapsed' ? 'open' : 'collapsed')),
    []
  )
  const syncSidebarTogglePosition = useCallback((panelWidth: number): void => {
    sidebarPixelWidthRef.current = panelWidth
    // While expanded the toggle sits inline in the sidebar header; only the collapsed floating
    // fallback needs explicit positioning.
    if (sidebarStateRef.current !== 'collapsed') return
    const toggle = sidebarToggleRef.current
    if (toggle) toggle.style.left = `${Math.max(0, panelWidth - SIDEBAR_TOGGLE_RIGHT_INSET)}px`
  }, [])

  const sidebar = useAnimatedResizablePanel({
    panelState: sidebarState,
    defaultOpenSize: SIDEBAR_PANEL_DEFAULT_SIZE,
    minOpenSize: SIDEBAR_PANEL_MIN_OPEN_SIZE,
    onPanelStateChange: setSidebarState,
    onPixelWidthChange: syncSidebarTogglePosition,
    collapseFocusTargetRef: sidebarToggleRef
  })

  const [initialPreviewDefaultSize] = useState(() =>
    previewPort.state === 'collapsed' ? PANEL_COLLAPSED_SIZE_CSS : PREVIEW_PANEL_DEFAULT_SIZE_CSS
  )
  const preview = useAnimatedResizablePanel({
    panelState: previewPort.state,
    defaultOpenSize: PREVIEW_PANEL_DEFAULT_SIZE,
    minOpenSize: PREVIEW_PANEL_MIN_OPEN_SIZE,
    requestVersion: previewPort.openRequestVersion,
    onPanelStateChange: previewPort.syncState,
    collapseFocusTargetRef: previewToggleRef
  })

  useEffect(() => {
    sidebarStateRef.current = sidebarState
  }, [sidebarState])

  useEffect(() => {
    const dialog = mobileSidebarDialogRef.current
    if (isMobile && isMobileSidebarOpen) {
      mobileSidebarWasOpenRef.current = true
      dialog
        ?.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        ?.focus()
      return
    }

    if (!mobileSidebarWasOpenRef.current) return
    mobileSidebarWasOpenRef.current = false

    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      document.contains(activeElement) &&
      !dialog?.contains(activeElement)
    ) {
      return
    }

    const returnFocus = mobileSidebarReturnFocusRef.current
    mobileSidebarReturnFocusRef.current = null
    if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus()
  }, [isMobile, isMobileSidebarOpen, mobileSidebarDialogRef])

  // Drag-to-collapse emits its final zero-width resize while the header toggle still holds the
  // ref, so the freshly mounted floating fallback reapplies the tracked width on collapse.
  useLayoutEffect(() => {
    if (sidebarState !== 'collapsed') return
    const panelWidth = sidebarPixelWidthRef.current
    if (panelWidth === null) return
    const toggle = sidebarToggleRef.current
    if (toggle) toggle.style.left = `${Math.max(0, panelWidth - SIDEBAR_TOGGLE_RIGHT_INSET)}px`
  }, [sidebarState])

  // Each toggle handoff (header instance ↔ floating fallback) unmounts the previously focused
  // button, dropping focus to <body>. Restore it on the surviving instance unless focus
  // legitimately lives elsewhere (e.g. the composer when the shortcut collapses the panel).
  const previousSidebarStateRef = useRef(sidebarState)
  useEffect(() => {
    const previousSidebarState = previousSidebarStateRef.current
    previousSidebarStateRef.current = sidebarState
    if (previousSidebarState === sidebarState) return

    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      document.contains(activeElement)
    ) {
      return
    }
    sidebarToggleRef.current?.focus()
  }, [sidebarState])

  useEffect(() => {
    if (!isMobile || !isMobileSidebarOpen) return

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMobileSidebar()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeMobileSidebar, isMobile, isMobileSidebarOpen])

  useEffect(() => {
    const toggleSidebarFromShortcut = (event: KeyboardEvent): void => {
      const isMac = window.api?.platform === 'darwin'
      const hasBlockingDialog = Array.from(
        document.querySelectorAll<HTMLElement>(OPEN_DIALOG_SELECTOR)
      ).some((dialog) => dialog !== mobileSidebarDialogRef.current)
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'b' ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        hasBlockingDialog
      ) {
        return
      }

      event.preventDefault()
      if (isMobile) toggleMobileSidebar()
      else toggleSidebar()
    }

    window.addEventListener('keydown', toggleSidebarFromShortcut)
    return () => window.removeEventListener('keydown', toggleSidebarFromShortcut)
  }, [isMobile, mobileSidebarDialogRef, toggleMobileSidebar, toggleSidebar])

  return {
    isMobile,
    mobileSidebar: {
      isOpen: isMobileSidebarOpen,
      open: openMobileSidebar,
      close: closeMobileSidebar
    },
    sidebar: {
      ...sidebar,
      state: sidebarState,
      defaultSize: SIDEBAR_PANEL_DEFAULT_SIZE_CSS,
      toggle: toggleSidebar,
      toggleRef: sidebarToggleRef,
      toggleButton: (
        <button
          ref={sidebarToggleRef}
          type="button"
          data-testid="workspace-sidebar-toggle"
          className="absolute top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-action-panel-toggle shadow-none hover:bg-surface-control-hover"
          style={{
            left: `calc(${SIDEBAR_PANEL_DEFAULT_SIZE_CSS} - ${SIDEBAR_TOGGLE_RIGHT_INSET}px)`
          }}
          aria-label={
            sidebarState === 'collapsed' ? t('Expand sidebar panel') : t('Collapse sidebar panel')
          }
          aria-expanded={sidebarState !== 'collapsed'}
          aria-controls="left-panel"
          aria-keyshortcuts={window.api?.platform === 'darwin' ? 'Meta+B' : 'Control+B'}
          title={
            sidebarState === 'collapsed' ? t('Expand sidebar panel') : t('Collapse sidebar panel')
          }
          onClick={toggleSidebar}
        >
          <PanelLeft className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
        </button>
      )
    },
    preview: {
      ...preview,
      state: previewPort.state,
      defaultSize: initialPreviewDefaultSize,
      toggle: previewPort.toggle,
      collapse: () => previewPort.syncState('collapsed'),
      toggleButton: (
        <button
          ref={previewToggleRef}
          type="button"
          data-testid="workspace-preview-toggle"
          className={`absolute right-2 top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg ${
            previewPort.state === 'collapsed'
              ? 'bg-transparent shadow-none text-action-panel-toggle hover:bg-surface-control-hover'
              : 'bg-primary/20 shadow-card backdrop-blur text-action-panel-toggle'
          }`}
          aria-label={
            previewPort.state === 'collapsed'
              ? t('Expand preview panel')
              : t('Collapse preview panel')
          }
          aria-expanded={previewPort.state !== 'collapsed'}
          aria-controls="right-panel"
          title={
            previewPort.state === 'collapsed'
              ? t('Expand preview panel')
              : t('Collapse preview panel')
          }
          onClick={previewPort.toggle}
        >
          <PanelRight className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
        </button>
      )
    }
  }
}

type WorkspacePanelLayoutProps = {
  hasPreviewItems: boolean
  isPreviewPresentationActive?: boolean
  restoredPlanResponder?: RestoredPlanResponder
  previewAnnotations?: PreviewInteractionPort
  onPdfContextError?: (message: string | null) => void
  preview: PreviewPanelLayoutPort
  renderDesktopSidebar: (options: {
    sidebarToggle: {
      state: ResizablePanelState
      onToggle: () => void
    }
    sidebarToggleRef: React.RefObject<HTMLButtonElement | null>
  }) => React.ReactNode
  renderMobileSidebar: (options: { isOpen: boolean; close: () => void }) => React.ReactNode
  renderConversation: (options: {
    isPreviewPanelCollapsed: boolean
    togglePreviewPanel: () => void
    openMobileSidebar: () => void
  }) => React.ReactNode
}

// Adapts the controller to the desktop split view and mobile drawer/sheet without owning page data.
const WorkspacePanelLayout = ({
  hasPreviewItems,
  isPreviewPresentationActive = true,
  restoredPlanResponder,
  previewAnnotations,
  onPdfContextError,
  preview: previewPort,
  renderDesktopSidebar,
  renderMobileSidebar,
  renderConversation
}: WorkspacePanelLayoutProps): React.JSX.Element => {
  const { t } = useTranslation()
  const mobileSidebarDialogRef = useRef<HTMLDivElement | null>(null)
  const { isMobile, mobileSidebar, sidebar, preview } = useWorkspacePanelLayout(
    previewPort,
    mobileSidebarDialogRef
  )

  return (
    <>
      <div className="relative flex h-full">
        {mobileSidebar.isOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-[65] bg-black/45 md:hidden"
            aria-label={t('Close navigation')}
            tabIndex={-1}
            onClick={mobileSidebar.close}
          />
        ) : null}
        {isMobile ? (
          <FocusScope
            asChild
            loop={mobileSidebar.isOpen}
            trapped={mobileSidebar.isOpen}
            onMountAutoFocus={(event) => event.preventDefault()}
            onUnmountAutoFocus={(event) => event.preventDefault()}
          >
            <div
              ref={mobileSidebarDialogRef}
              role={mobileSidebar.isOpen ? 'dialog' : undefined}
              aria-modal={mobileSidebar.isOpen ? true : undefined}
              aria-label={mobileSidebar.isOpen ? t('Workspace navigation') : undefined}
              className="contents"
            >
              {renderMobileSidebar({
                isOpen: mobileSidebar.isOpen,
                close: mobileSidebar.close
              })}
            </div>
          </FocusScope>
        ) : null}
        <ResizablePanelGroup
          orientation="horizontal"
          resizeTargetMinimumSize={{ coarse: 20, fine: 20 }}
          aria-hidden={isMobile && mobileSidebar.isOpen ? true : undefined}
          inert={isMobile && mobileSidebar.isOpen ? true : undefined}
          className={isMobile ? 'min-w-0 flex-1' : '-mr-[10px] min-w-0 flex-1'}
        >
          {!isMobile ? (
            <>
              <ResizablePanel
                id="left-panel"
                panelRef={sidebar.panelRef}
                defaultSize={sidebar.defaultSize}
                minSize={sidebar.minSize}
                collapsible
                collapsedSize="0%"
                onResize={(panelSize, _panelId, previousPanelSize) =>
                  sidebar.onResize(panelSize, previousPanelSize)
                }
              >
                {renderDesktopSidebar({
                  sidebarToggle: { state: sidebar.state, onToggle: sidebar.toggle },
                  sidebarToggleRef: sidebar.toggleRef
                })}
              </ResizablePanel>

              <ResizableHandle
                elementRef={sidebar.separatorRef}
                aria-label={t('Resize left panel')}
                disabled={sidebar.state === 'collapsed'}
                aria-hidden={sidebar.state === 'collapsed'}
                className={`${WORKSPACE_RESIZE_HANDLE_CLASS_NAME} ${
                  sidebar.state === 'collapsed' ? 'pointer-events-none opacity-0' : 'opacity-100'
                }`}
              />
            </>
          ) : null}

          {renderConversation({
            isPreviewPanelCollapsed: preview.state === 'collapsed',
            togglePreviewPanel: preview.toggle,
            openMobileSidebar: mobileSidebar.open
          })}

          {!isMobile ? (
            <>
              <ResizableHandle
                elementRef={preview.separatorRef}
                aria-label={t('Resize right panel')}
                disabled={preview.state === 'collapsed'}
                aria-hidden={preview.state === 'collapsed'}
                className={`${WORKSPACE_RESIZE_HANDLE_CLASS_NAME} bg-border shadow-[1px_0_3px_rgba(30,28,24,0.08)] ${
                  preview.state === 'collapsed' ? 'pointer-events-none opacity-0' : 'opacity-100'
                }`}
              />

              <PreviewPanel
                panelRef={preview.panelRef}
                defaultSize={preview.defaultSize}
                minSize={preview.minSize}
                onResize={preview.onResize}
                restoredPlanResponder={restoredPlanResponder}
                {...previewAnnotations}
                onPdfContextError={onPdfContextError}
              />
            </>
          ) : null}
        </ResizablePanelGroup>
        {!isMobile && hasPreviewItems ? preview.toggleButton : null}
        {!isMobile && sidebar.state === 'collapsed' ? sidebar.toggleButton : null}
      </div>

      {isMobile ? (
        <MobilePreviewSheet
          open={isPreviewPresentationActive && preview.state === 'open'}
          onClose={preview.collapse}
          restoredPlanResponder={restoredPlanResponder}
          {...previewAnnotations}
          onPdfContextError={onPdfContextError}
        />
      ) : null}
    </>
  )
}

export { WorkspacePanelLayout }
