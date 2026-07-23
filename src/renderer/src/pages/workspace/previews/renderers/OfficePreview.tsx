import { useEffect, useId, useRef, useState } from 'react'
import { FileWarning } from 'lucide-react'

import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'
import type {
  OfficePreviewBounds,
  OfficePreviewErrorCode,
  OfficePreviewRequestedExtension,
  OfficePreviewRuntimeState
} from '../../../../../../shared/office-preview'

import { ManagedFileDownloadButton } from '../../ManagedFileDownloadButton'
import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { usePreviewRuntime } from '../preview-runtime-context'
import type { PreviewFileRendererProps } from '../preview-types'
import { officePreviewHostLeaseCoordinator } from './office-preview-lease'
import { isOfficePreviewHostVisible } from './office-preview-visibility'

type OfficeHostState =
  | { kind: 'loading'; title?: string; description?: string }
  | { kind: 'ready' }
  | { kind: 'too-large' }
  | { kind: 'error'; error?: OfficePreviewErrorCode }

const OFFICE_CHECKING_STATE: OfficeHostState = {
  kind: 'loading',
  title: 'Checking the Office file'
}

const resolveOfficeExtension = (item: PreviewFileItem): OfficePreviewRequestedExtension => {
  if (item.format === 'word') return 'docx'
  if (item.format === 'presentation') return 'pptx'
  const normalizedName = item.name.toLowerCase()
  if (normalizedName.endsWith('.xls')) return 'xls'
  if (normalizedName.endsWith('.xlsx')) return 'xlsx'
  return 'spreadsheet'
}

const isRetryableOfficeError = (error: OfficePreviewErrorCode | undefined): boolean =>
  error === undefined ||
  error === 'FILE_READ_FAILED' ||
  error === 'PREVIEW_TIMEOUT' ||
  error === 'PREVIEW_PROCESS_CRASHED' ||
  error === 'RENDER_FAILED'

let fallbackOfficePreviewRequestSequence = 0

// Separates stable host leasing from one-shot state routing across retries and file switches.
const createOfficePreviewRequestId = (hostId: string): string => {
  const uniquePart = globalThis.crypto?.randomUUID?.()
  fallbackOfficePreviewRequestSequence += 1
  return `${hostId}:${uniquePart ?? `${Date.now()}-${fallbackOfficePreviewRequestSequence}`}`
}

const OfficeDownloadFallback = ({
  item,
  source,
  title,
  message
}: {
  item: PreviewFileItem
  source: PreviewFileSource
  title: string
  message: string
}): React.JSX.Element => (
  <PreviewFallbackCard
    icon={FileWarning}
    name={item.name}
    title={title}
    message={message}
    action={
      <ManagedFileDownloadButton
        source={source}
        path={item.path}
        suggestedName={item.name}
        appearance="primary"
        wrapperClassName="mt-3"
      />
    }
  />
)

const getDownloadOnlyErrorMessage = (
  error: OfficePreviewErrorCode | undefined
): string | undefined => {
  if (error === 'INVALID_PACKAGE') {
    return 'This Office file is damaged or unsupported. Download it to view.'
  }
  if (error === 'RESOURCE_LIMIT_EXCEEDED') {
    return 'This Office file exceeds the safe preview limits. Download it to view.'
  }
  return undefined
}

type OfficePreviewBoundsSnapshot = Omit<OfficePreviewBounds, 'sequence'>

const areHorizontalLayoutsEqual = (
  left: OfficePreviewBoundsSnapshot['horizontalLayout'],
  right: OfficePreviewBoundsSnapshot['horizontalLayout']
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.splitGroupX === right.splitGroupX &&
    left.splitGroupWidth === right.splitGroupWidth &&
    left.panelX === right.panelX &&
    left.panelWidth === right.panelWidth)

const areBoundsSnapshotsEqual = (
  left: OfficePreviewBoundsSnapshot | undefined,
  right: OfficePreviewBoundsSnapshot
): boolean =>
  left !== undefined &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height &&
  left.visible === right.visible &&
  left.viewportWidth === right.viewportWidth &&
  left.viewportHeight === right.viewportHeight &&
  areHorizontalLayoutsEqual(left.horizontalLayout, right.horizontalLayout)

type OfficePreviewLayoutTargets = {
  resizeTargets: Element[]
  splitGroup?: HTMLElement
  panel?: HTMLElement
}

// Sibling panels can move the preview without changing its own size, so observe the whole split group.
const getOfficePreviewLayoutTargets = (host: HTMLElement): OfficePreviewLayoutTargets => {
  const targets = new Set<Element>([host])
  let panel: HTMLElement | undefined
  let splitGroup: HTMLElement | undefined
  let current = host.parentElement

  while (current) {
    if (!panel && current.dataset.slot === 'resizable-panel') panel = current
    if (current.dataset.slot === 'resizable-panel-group') {
      splitGroup = current
      targets.add(current)
      current
        .querySelectorAll(':scope > [data-slot="resizable-panel"]')
        .forEach((panel) => targets.add(panel))
      break
    }
    current = current.parentElement
  }

  return {
    resizeTargets: [...targets],
    splitGroup,
    panel: panel?.parentElement === splitGroup ? panel : undefined
  }
}

const measureOfficePreviewBounds = (
  host: HTMLElement,
  visible: boolean,
  layoutTargets: OfficePreviewLayoutTargets
): OfficePreviewBoundsSnapshot => {
  const rect = host.getBoundingClientRect()
  const splitGroupRect = layoutTargets.splitGroup?.getBoundingClientRect()
  const panelRect = layoutTargets.panel?.getBoundingClientRect()
  const horizontalLayout =
    splitGroupRect && panelRect
      ? {
          splitGroupX: Math.round(splitGroupRect.left),
          splitGroupWidth: Math.max(0, Math.round(splitGroupRect.width)),
          panelX: Math.round(panelRect.left),
          panelWidth: Math.max(0, Math.round(panelRect.width))
        }
      : undefined

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
    visible: visible && isOfficePreviewHostVisible(host, rect),
    viewportWidth: Math.max(1, Math.round(window.innerWidth)),
    viewportHeight: Math.max(1, Math.round(window.innerHeight)),
    ...(horizontalLayout ? { horizontalLayout } : {})
  }
}

// Owns only native-view coordination; Office bytes and vendor libraries stay in the child runtime.
export const OfficePreviewContent = ({
  item,
  source = 'artifact'
}: {
  item: PreviewFileItem
  source?: PreviewFileSource
}): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const hostId = useId()
  const runtime = usePreviewRuntime()
  const attempt = runtime?.attempt ?? 0
  const extension = resolveOfficeExtension(item)
  const [ownsLease, setOwnsLease] = useState(false)
  const [state, setState] = useState<OfficeHostState>(OFFICE_CHECKING_STATE)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)

  useEffect(
    () =>
      officePreviewHostLeaseCoordinator.register((active) => {
        setOwnsLease(active)
        setState(OFFICE_CHECKING_STATE)
        setSessionId(undefined)
      }),
    []
  )

  useEffect(() => {
    if (!ownsLease) return

    const requestId = createOfficePreviewRequestId(hostId)
    let active = true
    let openedSessionId: string | undefined
    let pendingState: OfficePreviewRuntimeState | undefined

    const applyRuntimeState = (nextState: OfficePreviewRuntimeState): void => {
      if (nextState.phase === 'ready') {
        setState({ kind: 'ready' })
      } else if (nextState.phase === 'error') {
        // Main destroys terminal sessions, so release native-view observers at the same boundary.
        setSessionId(undefined)
        setState({ kind: 'error', error: nextState.error })
      } else {
        setState({
          kind: 'loading',
          title: nextState.title,
          description: nextState.description
        })
      }
    }
    const removeStateListener = window.api.officePreview.onState(
      (nextState: OfficePreviewRuntimeState) => {
        if (!active || nextState.requestId !== requestId) return
        if (!openedSessionId) {
          pendingState = nextState
          return
        }
        if (nextState.sessionId === openedSessionId) applyRuntimeState(nextState)
      }
    )

    void window.api.officePreview
      .open({ requestId, source, path: item.path, name: item.name, extension, attempt })
      .then((result) => {
        if (!active) {
          if (result.kind === 'started') void window.api.officePreview.close(result.sessionId)
          return
        }
        if (result.kind === 'cancelled') return
        if (result.kind === 'unavailable') {
          setState(
            result.reason === 'FILE_TOO_LARGE'
              ? { kind: 'too-large' }
              : { kind: 'error', error: result.reason }
          )
          return
        }

        openedSessionId = result.sessionId
        setSessionId(result.sessionId)
        if (pendingState?.sessionId === result.sessionId) applyRuntimeState(pendingState)
        pendingState = undefined
      })
      .catch((error) => {
        if (!active) return
        console.error('Failed to start Office preview', error)
        if (pendingState?.phase === 'error') {
          applyRuntimeState(pendingState)
          pendingState = undefined
        } else {
          setState({ kind: 'error', error: 'FILE_READ_FAILED' })
        }
      })

    return () => {
      active = false
      removeStateListener()
      if (openedSessionId) void window.api.officePreview.close(openedSessionId)
    }
  }, [attempt, extension, hostId, item.name, item.path, ownsLease, source])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !sessionId) return

    let animationFrame: number | undefined
    let isIntersecting = true
    let sequence = 0
    let lastBounds: OfficePreviewBoundsSnapshot | undefined
    const layoutTargets = getOfficePreviewLayoutTargets(host)
    const syncBounds = (): void => {
      animationFrame = undefined
      const nextBounds = measureOfficePreviewBounds(host, isIntersecting, layoutTargets)
      if (areBoundsSnapshotsEqual(lastBounds, nextBounds)) return

      lastBounds = nextBounds
      sequence += 1
      window.api.officePreview.setBounds(sessionId, { ...nextBounds, sequence })
    }
    const scheduleBounds = (): void => {
      if (animationFrame !== undefined) return
      animationFrame = window.requestAnimationFrame(syncBounds)
    }
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleBounds)
    layoutTargets.resizeTargets.forEach((target) => resizeObserver?.observe(target))
    const intersectionObserver =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver((entries) => {
            isIntersecting = entries.some((entry) => entry.target === host && entry.isIntersecting)
            scheduleBounds()
          })
    intersectionObserver?.observe(host)
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(scheduleBounds)
    mutationObserver?.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-state', 'hidden', 'open', 'style'],
      childList: true,
      subtree: true
    })
    window.addEventListener('resize', scheduleBounds)
    window.addEventListener('scroll', scheduleBounds, true)
    document.addEventListener('visibilitychange', scheduleBounds)
    syncBounds()

    return () => {
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', scheduleBounds)
      window.removeEventListener('scroll', scheduleBounds, true)
      document.removeEventListener('visibilitychange', scheduleBounds)
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
    }
  }, [sessionId])

  if (state.kind === 'too-large') {
    return (
      <OfficeDownloadFallback
        item={item}
        source={source}
        title="File too large to preview"
        message="This file is larger than 40 MB. Download it to view."
      />
    )
  }
  if (state.kind === 'error') {
    const downloadOnlyMessage = getDownloadOnlyErrorMessage(state.error)
    if (downloadOnlyMessage) {
      return (
        <OfficeDownloadFallback
          item={item}
          source={source}
          title="Preview unavailable"
          message={downloadOnlyMessage}
        />
      )
    }
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        name={item.name}
        message="This Office file couldn't be rendered for preview"
        retryable={isRetryableOfficeError(state.error)}
      />
    )
  }

  return (
    <div
      ref={hostRef}
      data-office-preview-state={state.kind}
      className="relative size-full overflow-hidden bg-bg-000"
    >
      {state.kind === 'loading' ? (
        <PreviewLoadingContent title={state.title} description={state.description} />
      ) : null}
    </div>
  )
}

export const OfficePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <OfficePreviewContent item={item} source={item.source} />
)
