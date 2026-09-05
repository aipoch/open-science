import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'
import type {
  OfficePreviewErrorCode,
  OfficePreviewHostMessage,
  OfficePreviewPhase,
  OfficePreviewRequestedExtension,
  OfficePreviewRuntimeState,
  OfficePreviewSource
} from '../../../../../../shared/office-preview'
import {
  isOfficePreviewRuntimeMessage,
  OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
  OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
  OFFICE_PREVIEW_RUNTIME_ORIGIN
} from '../../../../../../shared/office-preview'
import {
  usePreviewActions,
  useRegisterPreviewContextMenuFrame
} from '../../preview-actions/preview-action-hooks'

import { LocalFileFallbackAction } from '../../LocalFileHeaderActions'
import { ManagedFileDownloadButton } from '../../ManagedFileDownloadButton'
import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { usePreviewRuntime } from '../preview-runtime-context'
import type { PreviewFileRendererProps } from '../preview-types'
import { officePreviewHostLeaseCoordinator } from './office-preview-lease'

type OfficeHostState =
  | { kind: 'loading'; phase: OfficePreviewPhase | 'checking' }
  | { kind: 'ready' }
  | { kind: 'too-large' }
  | { kind: 'error'; error?: OfficePreviewErrorCode }

const OFFICE_CHECKING_STATE: OfficeHostState = {
  kind: 'loading',
  phase: 'checking'
}

// The isolated runtime reports semantic state only. Keeping every user-visible key in literal t()
// calls makes the catalog guard authoritative and prevents runtime English from becoming a dynamic
// translation key that static analysis cannot see.
const officeLoadingCopy = (
  phase: OfficePreviewPhase | 'checking',
  extension: OfficePreviewRequestedExtension,
  t: ReturnType<typeof useTranslation>['t']
): { title: string; description?: string } => {
  if (phase === 'checking') return { title: t('Checking the Office file') }
  if (phase === 'starting') return { title: t('Starting Office preview') }
  if (phase === 'reading') return { title: t('Reading the Office file') }
  if (phase === 'validating') return { title: t('Validating the Office package') }
  if (phase === 'parsing') {
    if (extension === 'docx') return { title: t('Parsing the Word document') }
    if (extension === 'pptx') return { title: t('Parsing the PowerPoint presentation') }
    return {
      title: t('Parsing the Excel workbook'),
      description: t('Preparing worksheets, styles, and virtualized viewport data.')
    }
  }
  if (phase === 'rendering') {
    return {
      title: t('Rendering the preview'),
      description: t('Building the document view.')
    }
  }
  return { title: t('Starting Office preview') }
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
  source: OfficePreviewSource
  title: string
  message: string
}): React.JSX.Element => {
  const runtime = usePreviewRuntime()

  return (
    <PreviewFallbackCard
      icon={FileWarning}
      name={item.name}
      title={title}
      message={message}
      action={
        <ManagedFileDownloadButton
          source={source}
          path={item.path}
          projectId={item.projectId}
          fileId={item.managedFileId}
          versionId={item.selectedVersionId}
          versionNumber={runtime?.downloadVersionContext?.versionNumber}
          latestVersionId={runtime?.downloadVersionContext?.latestVersionId}
          latestVersionNumber={runtime?.downloadVersionContext?.latestVersionNumber}
          suggestedName={item.name}
          appearance="primary"
          wrapperClassName="mt-3"
        />
      }
    />
  )
}

// Returns the catalog key for errors that leave download as the only remedy, or undefined when the
// error is a plain render failure that keeps the retryable card.
const getDownloadOnlyErrorMessageKey = (
  error: OfficePreviewErrorCode | undefined
):
  | 'This Office file is damaged or unsupported. Download it to view.'
  | 'This Office file exceeds the safe preview limits. Download it to view.'
  | undefined => {
  if (error === 'INVALID_PACKAGE')
    return 'This Office file is damaged or unsupported. Download it to view.'
  if (error === 'RESOURCE_LIMIT_EXCEEDED')
    return 'This Office file exceeds the safe preview limits. Download it to view.'
  return undefined
}

type OfficePreviewFrame = {
  sessionId: string
  url: string
}

// Owns isolated iframe coordination; Office bytes and vendor libraries stay in the child runtime.
// Only artifact/upload sources flow here — local files never reach the LibreOffice pipeline (see
// the OfficePreviewContent wrapper below).
const RemoteOfficePreviewContent = ({
  item,
  source
}: {
  item: PreviewFileItem
  source: OfficePreviewSource
}): React.JSX.Element => {
  const { t } = useTranslation()
  const hostId = useId()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const { openContextMenu } = usePreviewActions()
  // Menu state can replace the host callback, but it must not restart the attached Office runtime.
  const openRuntimeContextMenu = useEffectEvent(openContextMenu)
  const runtime = usePreviewRuntime()
  const attempt = runtime?.attempt ?? 0
  const extension = resolveOfficeExtension(item)
  const [ownsLease, setOwnsLease] = useState(false)
  const [state, setState] = useState<OfficeHostState>(OFFICE_CHECKING_STATE)
  const [frame, setFrame] = useState<OfficePreviewFrame | undefined>(undefined)
  const [frameLoadGeneration, setFrameLoadGeneration] = useState(0)
  const hasSourceIdentity =
    source === 'notebook-input' || Boolean(item.projectId && item.managedFileId)
  useRegisterPreviewContextMenuFrame({
    id: `office-preview:${hostId}`,
    frameUrl: frame?.url ?? '',
    frameRef,
    enabled: ownsLease && frame !== undefined
  })

  useEffect(
    () =>
      officePreviewHostLeaseCoordinator.register((active) => {
        setOwnsLease(active)
        setState(OFFICE_CHECKING_STATE)
        setFrame(undefined)
        setFrameLoadGeneration(0)
      }),
    []
  )

  useEffect(() => {
    if (!ownsLease || !hasSourceIdentity) return
    const sourceIdentity =
      source === 'notebook-input'
        ? { source, path: item.path }
        : {
            source,
            projectId: item.projectId!,
            fileId: item.managedFileId!,
            ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {})
          }

    const requestId = createOfficePreviewRequestId(hostId)
    let active = true
    let openedSessionId: string | undefined
    let pendingState: OfficePreviewRuntimeState | undefined

    const applyRuntimeState = (nextState: OfficePreviewRuntimeState): void => {
      if (nextState.phase === 'ready') {
        setState({ kind: 'ready' })
      } else if (nextState.phase === 'error') {
        // Main destroys terminal sessions, so remove the corresponding iframe at the same boundary.
        setFrame(undefined)
        setFrameLoadGeneration(0)
        setState({ kind: 'error', error: nextState.error })
      } else {
        setState({
          kind: 'loading',
          phase: nextState.phase
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
      .open({
        requestId,
        ...sourceIdentity,
        name: item.name,
        extension,
        attempt
      })
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
        setFrameLoadGeneration(0)
        setFrame({ sessionId: result.sessionId, url: result.runtimeUrl })
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
  }, [
    attempt,
    extension,
    hasSourceIdentity,
    hostId,
    item.managedFileId,
    item.name,
    item.path,
    item.projectId,
    item.selectedVersionId,
    ownsLease,
    source
  ])

  useEffect(() => {
    if (!frame || frameLoadGeneration === 0) return

    let active = true
    let attached = false
    const handleMessage = (event: MessageEvent): void => {
      if (
        !active ||
        !attached ||
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== OFFICE_PREVIEW_RUNTIME_ORIGIN ||
        !isOfficePreviewRuntimeMessage(event.data)
      ) {
        return
      }

      if (event.data.type === 'state' && event.data.state.sessionId === frame.sessionId) {
        window.api.officePreview.reportState(frame.sessionId, event.data.state)
      } else if (
        event.data.type === 'context-menu' &&
        event.data.contextMenu.sessionId === frame.sessionId
      ) {
        const currentFrame = frameRef.current
        if (!currentFrame) return
        const bounds = currentFrame.getBoundingClientRect()
        openRuntimeContextMenu(
          {
            x: bounds.left + event.data.contextMenu.x,
            y: bounds.top + event.data.contextMenu.y
          },
          currentFrame
        )
      }
    }

    // The load boundary cannot be missed and guarantees the runtime listener exists before start.
    window.addEventListener('message', handleMessage)
    void window.api.officePreview
      .attachFrame(frame.sessionId)
      .then((result) => {
        if (!active) return
        if (!result || result.kind !== 'attached') {
          setFrame(undefined)
          setFrameLoadGeneration(0)
          setState({ kind: 'error', error: 'PREVIEW_PROCESS_NOT_ISOLATED' })
          return
        }
        attached = true
        const message: OfficePreviewHostMessage = {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'start',
          start: result.start
        }
        frameRef.current?.contentWindow?.postMessage(message, OFFICE_PREVIEW_RUNTIME_ORIGIN)
      })
      .catch((error) => {
        if (!active) return
        console.error('Failed to attach isolated Office preview frame', error)
        // IPC failures bypass the supervisor's normal unavailable result, so release explicitly.
        void window.api.officePreview.close(frame.sessionId)
        setFrame(undefined)
        setFrameLoadGeneration(0)
        setState({ kind: 'error', error: 'RENDER_FAILED' })
      })
    return () => {
      active = false
      window.removeEventListener('message', handleMessage)
    }
  }, [frame, frameLoadGeneration])

  const visibleState: OfficeHostState =
    ownsLease && !hasSourceIdentity ? { kind: 'error', error: 'FILE_READ_FAILED' } : state

  if (visibleState.kind === 'too-large') {
    return (
      <OfficeDownloadFallback
        item={item}
        source={source}
        title={t('File too large to preview')}
        message={t('This file is larger than 40 MB. Download it to view.')}
      />
    )
  }
  if (visibleState.kind === 'error') {
    const downloadOnlyMessageKey = getDownloadOnlyErrorMessageKey(visibleState.error)
    if (downloadOnlyMessageKey) {
      return (
        <OfficeDownloadFallback
          item={item}
          source={source}
          title={t('Preview unavailable')}
          message={t(downloadOnlyMessageKey)}
        />
      )
    }
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        name={item.name}
        message={t("This Office file couldn't be rendered for preview")}
        retryable={isRetryableOfficeError(visibleState.error)}
      />
    )
  }

  return (
    <div
      data-office-preview-state={visibleState.kind}
      className="relative size-full overflow-hidden bg-bg-000"
    >
      {frame ? (
        <iframe
          ref={frameRef}
          data-office-preview-frame
          title={t('Preview of {{name}}', { name: item.name })}
          src={frame.url}
          onLoad={() => {
            // A same-document frame reload needs a fresh process check and start capability.
            setState({ kind: 'loading', phase: 'starting' })
            setFrameLoadGeneration((generation) => generation + 1)
          }}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full border-0 bg-transparent"
        />
      ) : null}
      {visibleState.kind === 'loading' ? (
        <div className="absolute inset-0 z-10 bg-bg-000">
          <PreviewLoadingContent {...officeLoadingCopy(visibleState.phase, extension, t)} />
        </div>
      ) : null}
    </div>
  )
}

// Source-aware entry: local Office files skip the in-app LibreOffice pipeline (which resolves only
// managed artifact/upload paths) and offer to open in the OS default app instead.
export const OfficePreviewContent = ({
  item,
  source = 'artifact'
}: {
  item: PreviewFileItem
  source?: PreviewFileSource
}): React.JSX.Element => {
  const { t } = useTranslation()

  if (source === 'local') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        name={item.name}
        message={t('Open this Office file in your default app to view it.')}
        action={<LocalFileFallbackAction path={item.path} className="mt-3" />}
      />
    )
  }
  if (!window.api.officePreview) {
    return (
      <OfficeDownloadFallback
        item={item}
        source={source}
        title={t('Preview unavailable')}
        message={t(
          'Office preview is only available in the desktop app. Download this file to view it.'
        )}
      />
    )
  }
  return <RemoteOfficePreviewContent item={item} source={source} />
}

export const OfficePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <OfficePreviewContent item={item} source={item.source} />
)
