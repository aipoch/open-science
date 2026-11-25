import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { WebviewTag } from 'electron'
import type { UseCase } from '../../../../shared/use-cases'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'
import { SOURCE_PREVIEW_PARTITION } from '../../../../shared/source-preview'

const playerOrigin = 'https://www.youtube-nocookie.com'

export function VideoPlayIndicator(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 grid place-items-center"
    >
      <span className="grid size-14 place-items-center rounded-full bg-black/65 text-white shadow-lg">
        <Play className="ml-1 size-6 fill-current" />
      </span>
    </span>
  )
}

export function UseCaseVideo({
  video,
  title,
  preview = false
}: {
  video: NonNullable<UseCase['video']>
  title: string
  preview?: boolean
}): React.JSX.Element | null {
  const native =
    Boolean(window.api?.getRuntimeVersions?.().electron) &&
    !document.documentElement.hasAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  const [status, setStatus] = useState<'loading' | 'playing' | 'failed'>('loading')
  const frame = useRef<HTMLIFrameElement>(null)
  const guest = useRef<WebviewTag>(null)
  const params = new URLSearchParams({ autoplay: '1', mute: '1', playsinline: '1', rel: '0' })
  if (preview) {
    params.set('controls', '0')
    params.set('disablekb', '1')
    params.set('fs', '0')
    params.set('loop', '1')
    params.set('playlist', video.id)
  }
  if (!native) {
    params.set('enablejsapi', '1')
    params.set('origin', window.location.origin)
  }
  const src = playerOrigin + '/embed/' + video.id + '?' + params
  const failed = status === 'failed'
  useEffect(() => {
    if (failed) return
    const fail = (): void => setStatus('failed')
    const timeout = window.setTimeout(fail, 15000)
    const playing = (): void => {
      clearTimeout(timeout)
      setStatus('playing')
    }
    const player = guest.current
    if (player) {
      const loadFailed = (event: Electron.DidFailLoadEvent): void => {
        if (event.isMainFrame && event.errorCode !== -3) fail()
      }
      player.addEventListener('media-started-playing', playing)
      player.addEventListener('did-fail-load', loadFailed)
      return () => {
        clearTimeout(timeout)
        player.removeEventListener('media-started-playing', playing)
        player.removeEventListener('did-fail-load', loadFailed)
      }
    }
    // Subscribe inside the cross-origin player while keeping third-party scripts out of the app.
    const target = frame.current?.contentWindow
    const send = (message: object): void =>
      target?.postMessage(JSON.stringify(message), playerOrigin)
    const listen = (): void => send({ event: 'listening', channel: 'widget', id: video.id })
    const handshake = window.setInterval(listen, 250)
    const receive = (event: MessageEvent): void => {
      if (
        event.origin !== playerOrigin ||
        event.source !== target ||
        typeof event.data !== 'string'
      )
        return
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message?.event === 'onReady') {
        clearInterval(handshake)
        for (const name of ['onStateChange', 'onError', 'onAutoplayBlocked']) {
          send({ event: 'command', func: 'addEventListener', args: [name] })
        }
        send({ event: 'command', func: 'playVideo', args: [] })
      }
      if (message?.event === 'onError' || message?.event === 'onAutoplayBlocked') fail()
      if (
        (message?.event === 'onStateChange' && message.info === 1) ||
        (['infoDelivery', 'initialDelivery'].includes(message?.event) &&
          message.info?.playerState === 1)
      ) {
        clearInterval(handshake)
        playing()
      }
    }
    window.addEventListener('message', receive)
    listen()
    return () => {
      clearTimeout(timeout)
      clearInterval(handshake)
      window.removeEventListener('message', receive)
    }
  }, [failed, video.id])

  if (failed) return null
  const hidden = preview || status === 'loading'
  return (
    <>
      {status === 'loading' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <span className="size-14 rounded-full border-2 border-white/30 border-t-white motion-safe:animate-spin" />
        </span>
      )}
      <div
        inert={hidden}
        aria-hidden={hidden}
        className={`absolute inset-0 ${hidden ? 'pointer-events-none' : ''} ${status === 'playing' ? 'opacity-100' : 'opacity-0'}`}
      >
        {native ? (
          // YouTube requires an application referrer when the desktop renderer runs from file:.
          <webview
            ref={guest}
            partition={SOURCE_PREVIEW_PARTITION}
            httpreferrer="https://com.aipoch.open-science/"
            src={src}
            title={video.title || title}
            tabIndex={hidden ? -1 : 0}
            className="flex size-full"
          />
        ) : (
          <iframe
            ref={frame}
            src={src}
            title={video.title || title}
            tabIndex={hidden ? -1 : 0}
            allow="autoplay; encrypted-media"
            allowFullScreen={!preview}
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            className="block size-full border-0"
          />
        )}
      </div>
    </>
  )
}
