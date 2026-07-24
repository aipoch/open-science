import { useEffect, useId, useRef, useState } from 'react'
import { FileWarning } from 'lucide-react'

import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'
import type {
  OfficePreviewErrorCode,
  OfficePreviewHostMessage,
  OfficePreviewRequestedExtension,
  OfficePreviewRuntimeState
} from '../../../../../../shared/office-preview'
import {
  isOfficePreviewRuntimeMessage,
  OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
  OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
  OFFICE_PREVIEW_RUNTIME_ORIGIN
} from '../../../../../../shared/office-preview'

import { ManagedFileDownloadButton } from '../../ManagedFileDownloadButton'
import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { usePreviewRuntime } from '../preview-runtime-context'
import type { PreviewFileRendererProps } from '../preview-types'
import { officePreviewHostLeaseCoordinator } from './office-preview-lease'

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

type OfficePreviewFrame = {
  sessionId: string
  url: string
}

// Owns isolated iframe coordination; Office bytes and vendor libraries stay in the child runtime.
export const OfficePreviewContent = ({
  item,
  source = 'artifact'
}: {
  item: PreviewFileItem
  source?: PreviewFileSource
}): React.JSX.Element => {
  const hostId = useId()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const runtime = usePreviewRuntime()
  const attempt = runtime?.attempt ?? 0
  const extension = resolveOfficeExtension(item)
  const [ownsLease, setOwnsLease] = useState(false)
  const [state, setState] = useState<OfficeHostState>(OFFICE_CHECKING_STATE)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [frame, setFrame] = useState<OfficePreviewFrame | undefined>(undefined)
  const [frameLoadGeneration, setFrameLoadGeneration] = useState(0)

  useEffect(
    () =>
      officePreviewHostLeaseCoordinator.register((active) => {
        setOwnsLease(active)
        setState(OFFICE_CHECKING_STATE)
        setSessionId(undefined)
        setFrame(undefined)
        setFrameLoadGeneration(0)
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
        // Main destroys terminal sessions, so remove the corresponding iframe at the same boundary.
        setSessionId(undefined)
        setFrame(undefined)
        setFrameLoadGeneration(0)
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
        setFrameLoadGeneration(0)
        setSessionId(result.sessionId)
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
  }, [attempt, extension, hostId, item.name, item.path, ownsLease, source])

  useEffect(() => {
    if (!frame || frame.sessionId !== sessionId || frameLoadGeneration === 0) return

    let active = true
    let attached = false
    const handleMessage = (event: MessageEvent): void => {
      if (
        !active ||
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== OFFICE_PREVIEW_RUNTIME_ORIGIN ||
        !isOfficePreviewRuntimeMessage(event.data) ||
        event.data.sessionId !== frame.sessionId
      ) {
        return
      }

      if (event.data.type === 'state' && attached) {
        window.api.officePreview.reportState(frame.sessionId, event.data.state)
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
          setSessionId(undefined)
          setFrameLoadGeneration(0)
          setState({ kind: 'error', error: 'PREVIEW_PROCESS_NOT_ISOLATED' })
          return
        }
        attached = true
        const message: OfficePreviewHostMessage = {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'start',
          sessionId: frame.sessionId,
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
        setSessionId(undefined)
        setFrameLoadGeneration(0)
        setState({ kind: 'error', error: 'RENDER_FAILED' })
      })
    return () => {
      active = false
      window.removeEventListener('message', handleMessage)
    }
  }, [frame, frameLoadGeneration, sessionId])

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
      data-office-preview-state={state.kind}
      className="relative size-full overflow-hidden bg-bg-000"
    >
      {frame && frame.sessionId === sessionId ? (
        <iframe
          ref={frameRef}
          data-office-preview-frame
          title={`Preview of ${item.name}`}
          src={frame.url}
          onLoad={() => {
            if (frame.sessionId !== sessionId) return
            // A same-document frame reload needs a fresh process check and start capability.
            setState({ kind: 'loading', title: 'Starting Office preview' })
            setFrameLoadGeneration((generation) => generation + 1)
          }}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full border-0 bg-transparent"
        />
      ) : null}
      {state.kind === 'loading' ? (
        <div className="absolute inset-0 z-10 bg-bg-000">
          <PreviewLoadingContent title={state.title} description={state.description} />
        </div>
      ) : null}
    </div>
  )
}

export const OfficePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <OfficePreviewContent item={item} source={item.source} />
)
