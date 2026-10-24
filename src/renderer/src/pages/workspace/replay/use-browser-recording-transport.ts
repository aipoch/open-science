import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ReplayMaterialAction } from './replay-material-action'
import {
  isBrowserRecordingPlaybackState,
  isBrowserRecordingRecordedAt,
  isBrowserRecordingTransportMessage,
  recordingTransportMessage,
  type BrowserRecordingPlaybackState
} from '../../../../../shared/browser-recording-transport'

export type EmbeddedBrowserRecordingPlayback = BrowserRecordingPlaybackState & {
  onSeekRecordedAt: (recordedAt: number) => void
}

const exactHttpOrigin = (value: string | undefined): value is string => {
  if (!value) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value
  } catch {
    return false
  }
}
const closePort = (port: MessagePort | undefined): void => {
  if (!port) return
  port.onmessage = null
  port.close()
}
type RecordedMaterialAction = {
  disabled: boolean
  pending: boolean
  recordedAt?: number
  title?: string
}

/** The caller admits only the exact current recorded viewer, never a live project frame.
 * A fresh channel is offered after each iframe load. Offers are retried because the load event
 * can precede the child's React effect; acknowledgements stop the bounded retry loop. */
export const useBrowserRecordingTransportHost = ({
  iframeRef,
  origin,
  enabled,
  playback
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>
  origin?: string
  enabled: boolean
  playback?: EmbeddedBrowserRecordingPlayback
}): {
  onLoad: () => void
  action?: RecordedMaterialAction
  ask: () => void
} => {
  const [action, setAction] = useState<RecordedMaterialAction>()
  const ask = useRef<() => void>(() => undefined)
  const latest = useRef(playback)
  useLayoutEffect(() => {
    latest.current = playback
  }, [playback])
  const connect = useRef<() => void>(() => undefined)
  const send = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!enabled || !exactHttpOrigin(origin) || typeof MessageChannel === 'undefined') return
    let port: MessagePort | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let acknowledged = false
    let revision = 0
    let attempts = 0
    const disconnect = (): void => {
      setAction(undefined)
      ask.current = () => undefined
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (port) {
        try {
          port.postMessage(recordingTransportMessage({ type: 'close' }))
        } catch {
          // Navigation may already have detached the former child.
        }
        closePort(port)
      }
      port = undefined
      acknowledged = false
    }
    const publish = (): void => {
      const current = latest.current
      if (!acknowledged || !port || !current) return
      const state = {
        recordedAt: current.recordedAt,
        playing: current.playing,
        speed: current.speed,
        ...(current.presentation ? { presentation: current.presentation } : {})
      }
      if (!isBrowserRecordingPlaybackState(state)) return
      port.postMessage(
        recordingTransportMessage({ type: 'state', revision: ++revision, playback: state })
      )
    }
    const offer = (): void => {
      if (disposed) return
      disconnect()
      const target = iframeRef.current?.contentWindow
      if (!target) return
      const channel = new MessageChannel()
      const offeredPort = channel.port1
      port = offeredPort
      offeredPort.onmessage = (event): void => {
        if (disposed || port !== offeredPort || !isBrowserRecordingTransportMessage(event.data))
          return
        if (event.data.type === 'ready') {
          acknowledged = true
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
          publish()
        } else if (acknowledged && event.data.type === 'seek' && event.data.revision <= revision) {
          latest.current?.onSeekRecordedAt(event.data.recordedAt)
        } else if (
          acknowledged &&
          event.data.type === 'action' &&
          event.data.revision <= revision &&
          latest.current?.presentation === 'research'
        ) {
          const { disabled, pending, recordedAt, title } = event.data
          setAction((previous) =>
            previous?.disabled === disabled &&
            previous.pending === pending &&
            previous.recordedAt === recordedAt &&
            previous.title === title
              ? previous
              : {
                  disabled,
                  pending,
                  ...(recordedAt === undefined ? {} : { recordedAt }),
                  ...(title === undefined ? {} : { title })
                }
          )
        }
      }
      offeredPort.start()
      ask.current = () => {
        if (acknowledged && port === offeredPort && latest.current?.presentation === 'research')
          offeredPort.postMessage(recordingTransportMessage({ type: 'ask', revision }))
      }
      try {
        // Never use '*': the host already holds the exact admitted viewer origin.
        target.postMessage(recordingTransportMessage({ type: 'offer' }), origin, [channel.port2])
      } catch {
        closePort(channel.port2)
        disconnect()
      }
      attempts += 1
      // Maximum 30 seconds; iframe onLoad starts a new bounded attempt sequence.
      if (!acknowledged && attempts < 60) timer = setTimeout(offer, 500)
    }
    const begin = (): void => {
      attempts = 0
      offer()
    }
    send.current = publish
    connect.current = begin
    begin()
    return () => {
      disposed = true
      disconnect()
      send.current = () => undefined
      connect.current = () => undefined
    }
  }, [enabled, iframeRef, origin])

  useEffect(() => {
    send.current()
  }, [playback?.recordedAt, playback?.playing, playback?.speed, playback?.presentation])

  return {
    onLoad: useCallback(() => connect.current(), []),
    action,
    ask: useCallback(() => ask.current(), [])
  }
}

/** The caller enables this only for desktop presentation inside an iframe. Embedded controls
 * must remain controlled (paused, with no recordedAt) before this hook receives the first state. */
export const useBrowserRecordingTransportReceiver = ({
  enabled
}: {
  enabled: boolean
}): {
  playback?: BrowserRecordingPlaybackState
  onSeekRecordedAt: (recordedAt: number) => void
  onActionChange: (action: ReplayMaterialAction | undefined) => void
} => {
  const action = useRef<ReplayMaterialAction | undefined>(undefined)
  const researchPresentation = useRef(false)
  const [playback, setPlayback] = useState<BrowserRecordingPlaybackState>()
  const [previousEnabled, setPreviousEnabled] = useState(enabled)
  if (previousEnabled !== enabled) {
    setPreviousEnabled(enabled)
    setPlayback(undefined)
  }
  const current = useRef<{ port: MessagePort; revision: number } | undefined>(undefined)
  const publishAction = useCallback(() => {
    const connection = current.current
    if (!connection || connection.revision < 1 || !researchPresentation.current) return
    connection.port.postMessage(
      recordingTransportMessage({
        type: 'action',
        revision: connection.revision,
        disabled: !action.current || Boolean(action.current.disabled),
        pending: Boolean(action.current?.pending),
        ...(action.current?.recordedAt !== undefined &&
        isBrowserRecordingRecordedAt(action.current.recordedAt)
          ? { recordedAt: action.current.recordedAt }
          : {}),
        ...(action.current?.title !== undefined
          ? { title: action.current.title.slice(0, 512) }
          : {})
      })
    )
  }, [])
  useEffect(() => {
    if (!enabled || window.parent === window) return
    const receive = (event: MessageEvent): void => {
      if (
        event.source !== window.parent ||
        !isBrowserRecordingTransportMessage(event.data) ||
        event.data.type !== 'offer' ||
        event.ports.length !== 1
      )
        return
      closePort(current.current?.port)
      const port = event.ports[0]
      const connection = { port, revision: 0 }
      current.current = connection
      setPlayback(undefined)
      port.onmessage = (message): void => {
        if (current.current !== connection || !isBrowserRecordingTransportMessage(message.data))
          return
        if (message.data.type === 'close') {
          closePort(port)
          current.current = undefined
          setPlayback(undefined)
        } else if (message.data.type === 'state' && message.data.revision > connection.revision) {
          connection.revision = message.data.revision
          researchPresentation.current = message.data.playback.presentation === 'research'
          setPlayback(message.data.playback)
          publishAction()
        } else if (
          message.data.type === 'ask' &&
          message.data.revision === connection.revision &&
          researchPresentation.current
        ) {
          const latest = action.current
          if (latest && !latest.disabled && !latest.pending) latest.onAsk()
        }
      }
      port.start()
      port.postMessage(recordingTransportMessage({ type: 'ready' }))
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      closePort(current.current?.port)
      current.current = undefined
    }
  }, [enabled, publishAction])
  const onSeekRecordedAt = useCallback((recordedAt: number): void => {
    const connection = current.current
    if (!connection || connection.revision < 1 || !isBrowserRecordingRecordedAt(recordedAt)) return
    connection.port.postMessage(
      recordingTransportMessage({ type: 'seek', revision: connection.revision, recordedAt })
    )
  }, [])
  const onActionChange = useCallback(
    (next: ReplayMaterialAction | undefined) => {
      action.current = next
      publishAction()
    },
    [publishAction]
  )
  return { playback: enabled ? playback : undefined, onSeekRecordedAt, onActionChange }
}
