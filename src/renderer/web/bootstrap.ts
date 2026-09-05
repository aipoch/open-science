import {
  ApplicationCommandError,
  isApplicationCommandErrorCode
} from '../../shared/application-command-contract'
import {
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  WEB_RPC_CAPABILITY_UPDATE_CLI_V1,
  WEB_RPC_PROTOCOL_VERSION,
  webRpcBootstrapSchema,
  webRpcEventMessageSchema,
  webRpcResponseSchema
} from '../../shared/web-rpc-contract'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../shared/web-caller-location'
import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_CONSUMERS_READY_EVENT,
  WEB_EVENTS_OPEN_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE,
  type WebEventConnectionPhase
} from '../../shared/web-event-connection'
import {
  WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME,
  type SaveManagedFileRequest
} from '../../shared/file-save'
import type { AcquireManagedPreviewRequest } from '../../shared/preview-resources'
import { installWebRendererContracts } from './api-installer'
import { i18next, initI18n } from '@/i18n'
import { applyHtmlLang, resolveInitialLocale } from '@/lib/locale-preference'
import { applyTheme, resolveInitialTheme } from '@/lib/theme'
import openScienceLogoSvg from '../../main/remote-access/openscience-logo.svg?raw'

// Apply the saved theme before the (async) web API install and the app import below, so the page
// doesn't paint in light mode and then flip to dark. The Electron renderer does the same at the top
// of main.tsx; the web build reaches main.tsx only after an async round trip, so it must apply here.
applyTheme(resolveInitialTheme())

// Language, for the same reason. Detection reads the *browser's* language list, which describes the
// person reading the page — the backend host's OS locale may be something else entirely.
const initialLocale = resolveInitialLocale()
initI18n(initialLocale)
const t = i18next.t.bind(i18next)
applyHtmlLang(initialLocale)
document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')

const REMOTE_ACCESS_OFF_MESSAGE = t(
  'Remote access is off on the home computer. Re-enable a remote access mode in Open Science, then try again.'
)

class RemoteAccessOffError extends Error {}

type Listener = (payload: unknown) => void

const BOOTSTRAP_ATTEMPTS = 8
const BOOTSTRAP_TIMEOUT_MS = 8_000
const WEB_RPC_TIMEOUT_MS = 30_000
const WEB_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const WEB_BLOB_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const EVENT_CONNECTION_ATTEMPTS = 8
const EVENT_CONNECTION_IDLE_TIMEOUT_MS = 30_000
const MODEL_OWNED_WEB_RPC_CHANNELS = new Set(['notebook:execute', 'notebook:run-cell'])

const clientId = sessionStorage.getItem('open-science-web-client') ?? crypto.randomUUID()
sessionStorage.setItem('open-science-web-client', clientId)

const listeners = new Map<string, Set<Listener>>()
let eventConnectionController = new AbortController()

const connectionMessage = (): HTMLElement | null =>
  document.getElementById('open-science-connection-message')

const setConnectionMessage = (message: string): void => {
  const element = connectionMessage()
  if (element) element.textContent = message
}

setConnectionMessage(t('Connecting to remote computer…'))

const connectionLogo = document.getElementById('open-science-connection-logo')
if (connectionLogo) {
  connectionLogo.innerHTML = openScienceLogoSvg.replace(
    '<svg ',
    '<svg aria-hidden="true" focusable="false" '
  )
}

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, delayMs))

const withRequestTimeout = async <T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal
): Promise<T> => {
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () =>
      controller.abort(
        new DOMException(`Request timed out after ${timeoutMs} milliseconds.`, 'TimeoutError')
      ),
    timeoutMs
  )
  try {
    return await operation(
      externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal
    )
  } finally {
    window.clearTimeout(timeout)
  }
}

const responseError = (response: Response, body: string, fallback: string): Error => {
  if (response.status === 401) return new RemoteAccessOffError(REMOTE_ACCESS_OFF_MESSAGE)
  try {
    const payload = JSON.parse(body) as {
      error?: string | { message?: string }
      message?: string
    }
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : (payload.error?.message ?? payload.message)
    if (message) return new Error(message)
  } catch {
    // Some reverse proxies return a plain-text error page. Fall through to a readable fallback.
  }
  return new Error(body.trim() || fallback)
}

const fetchBootstrap = async (): Promise<unknown> => {
  let lastError: unknown
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      setConnectionMessage(
        t('Reconnecting to remote computer… ({{attempt}}/{{maxAttempts}})', {
          attempt,
          maxAttempts: BOOTSTRAP_ATTEMPTS
        })
      )
      await wait(Math.min(500 * 2 ** (attempt - 2), 5_000))
    }
    try {
      return await withRequestTimeout(BOOTSTRAP_TIMEOUT_MS, async (signal) => {
        const response = await fetch('/api/bootstrap', {
          cache: 'no-store',
          signal
        })
        if (!response.ok) {
          throw responseError(
            response,
            await response.text(),
            `Open Science returned HTTP ${response.status}.`
          )
        }
        return await response.json()
      })
    } catch (error) {
      if (error instanceof RemoteAccessOffError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to initialize Open Science Remote.')
}

const showConnectionFailure = (error: unknown): void => {
  const state = document.getElementById('open-science-connection-state')
  const detail = error instanceof Error ? error.message : String(error)
  if (!state) return
  state.classList.add('connection-failed')
  state.setAttribute('role', 'alert')
  const message = connectionMessage()
  if (message) {
    message.textContent =
      error instanceof RemoteAccessOffError
        ? detail
        : t('This computer did not finish responding. {{detail}}', { detail })
  }
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = t('Try again')
  retry.style.cssText =
    'margin-top:18px;border:1px solid #737373;border-radius:8px;background:var(--connection-background);color:var(--connection-foreground);padding:9px 14px;font:inherit;cursor:pointer'
  retry.addEventListener('click', () => window.location.reload())
  state.querySelector('.open-science-connection-panel')?.append(retry)
}

const reviveBinary = (_key: string, value: unknown): unknown => {
  if (
    value &&
    typeof value === 'object' &&
    '$binary' in value &&
    typeof (value as { $binary?: unknown }).$binary === 'string'
  ) {
    const raw = atob((value as { $binary: string }).$binary)
    return Uint8Array.from(raw, (character) => character.charCodeAt(0))
  }
  return value
}

const encodeBinary = (_key: string, value: unknown): unknown => {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { $binary: btoa(binary) }
  }
  return value
}

const invoke = async (channel: string, args: unknown[]): Promise<unknown> => {
  const request = async (signal?: AbortSignal): Promise<{ response: Response; body: string }> => {
    const response = await fetch(`/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-open-science-client': clientId
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args }, encodeBinary),
      signal
    })
    return { response, body: await response.text() }
  }
  // Notebook execution has its own optional domain deadline. A transport wall clock must not report
  // failure while the kernel is still legitimately running; connection liveness owns disconnects.
  const connectionSignal = eventConnectionController.signal
  const { response, body } = MODEL_OWNED_WEB_RPC_CHANNELS.has(channel)
    ? await request(connectionSignal)
    : await withRequestTimeout(WEB_RPC_TIMEOUT_MS, request)
  let payload
  try {
    payload = webRpcResponseSchema.parse(JSON.parse(body, reviveBinary))
  } catch {
    if (!response.ok) throw responseError(response, body, `RPC ${channel} failed`)
    throw new Error(
      'Open Science returned an invalid response. Try reconnecting to the remote computer.'
    )
  }
  if (!payload.ok) {
    if (isApplicationCommandErrorCode(payload.error.code)) {
      throw new ApplicationCommandError(payload.error.code, payload.error.message)
    }
    throw responseError(response, body, payload.error.message)
  }
  if (!response.ok) throw responseError(response, body, `RPC ${channel} failed`)
  return rewritePreviewUrls(payload.result)
}

const rewritePreviewUrls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(rewritePreviewUrls)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) result[key] = rewritePreviewUrls(child)
    return result
  }
  if (typeof value === 'string' && value.startsWith('open-science-preview://')) {
    const url = new URL(value)
    return `/preview/${encodeURIComponent(url.hostname)}${url.pathname}`
  }
  return value
}

type EventCursor = {
  streamId: string
  latestSequence: number
}

let eventCursor: EventCursor
let eventReconnectAttempt = 0
let eventRecoveryRequired = false

const publishEventConnectionPhase = (phase: WebEventConnectionPhase): void => {
  window.dispatchEvent(
    new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, {
      detail: { phase }
    })
  )
}

const requireEventReload = (socket: WebSocket): void => {
  if (eventRecoveryRequired) return
  eventRecoveryRequired = true
  publishEventConnectionPhase('reload-required')
  socket.close(1000, 'Event stream resynchronization required')
}

const connectEvents = (): void => {
  if (eventRecoveryRequired) return
  if (eventConnectionController.signal.aborted) {
    eventConnectionController = new AbortController()
  }
  const connectionLease = eventConnectionController
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL(`${protocol}//${location.host}/events`)
  url.searchParams.set('client', clientId)
  url.searchParams.set('eventProtocol', String(WEB_EVENT_STREAM_PROTOCOL_VERSION))
  url.searchParams.set('stream', eventCursor.streamId)
  url.searchParams.set('after', String(eventCursor.latestSequence))
  url.searchParams.set('liveness', '1')
  const socket = new WebSocket(url.toString())
  const expireConnection = (): void => {
    if (eventConnectionController === connectionLease && !connectionLease.signal.aborted) {
      connectionLease.abort(new DOMException('Event stream liveness timed out.', 'TimeoutError'))
    }
    socket.close(4000, 'Event stream liveness timeout')
  }
  let idleTimeout = window.setTimeout(expireConnection, EVENT_CONNECTION_IDLE_TIMEOUT_MS)
  const armIdleTimeout = (): void => {
    window.clearTimeout(idleTimeout)
    idleTimeout = window.setTimeout(expireConnection, EVENT_CONNECTION_IDLE_TIMEOUT_MS)
  }

  socket.addEventListener('open', () => {
    armIdleTimeout()
    publishEventConnectionPhase('replaying')
  })
  socket.addEventListener('message', (event) => {
    armIdleTimeout()
    let decoded: unknown
    try {
      decoded = JSON.parse(String(event.data), reviveBinary)
    } catch {
      requireEventReload(socket)
      return
    }
    const parsed = webRpcEventMessageSchema.safeParse(decoded)
    if (!parsed.success) {
      requireEventReload(socket)
      return
    }
    const message = parsed.data
    if (message.kind === 'resync-required') {
      requireEventReload(socket)
      return
    }
    if (message.streamId !== eventCursor.streamId) {
      requireEventReload(socket)
      return
    }
    if (message.kind === 'event') {
      if (message.sequence !== eventCursor.latestSequence + 1) {
        requireEventReload(socket)
        return
      }
      try {
        for (const listener of listeners.get(message.channel) ?? []) listener(message.payload)
      } catch (error) {
        console.error('Failed to apply a Web event frame.', error)
        requireEventReload(socket)
        return
      }
      eventCursor.latestSequence = message.sequence
      return
    }
    if (message.kind === 'heartbeat') {
      if (message.latestSequence !== eventCursor.latestSequence) requireEventReload(socket)
      return
    }
    if (message.latestSequence !== eventCursor.latestSequence) {
      requireEventReload(socket)
      return
    }
    eventReconnectAttempt = 0
    publishEventConnectionPhase('live')
    window.dispatchEvent(new Event(WEB_EVENTS_OPEN_EVENT))
  })
  socket.addEventListener('close', () => {
    window.clearTimeout(idleTimeout)
    if (eventConnectionController === connectionLease && !connectionLease.signal.aborted) {
      connectionLease.abort(new DOMException('Event stream disconnected.', 'NetworkError'))
    }
    if (eventRecoveryRequired) return
    eventReconnectAttempt += 1
    if (eventReconnectAttempt >= EVENT_CONNECTION_ATTEMPTS) {
      requireEventReload(socket)
      return
    }
    publishEventConnectionPhase('reconnecting')
    const delay = Math.min(1_000 * 2 ** (eventReconnectAttempt - 1), 10_000)
    window.setTimeout(connectEvents, delay)
  })
}

const subscribe = (channel: string, listener: Listener): (() => void) => {
  const channelListeners = listeners.get(channel) ?? new Set<Listener>()
  channelListeners.add(listener)
  listeners.set(channel, channelListeners)
  return () => {
    channelListeners.delete(listener)
    if (channelListeners.size === 0) listeners.delete(channel)
  }
}

const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

type BrowserSaveFileHandle = {
  createWritable: () => Promise<WritableStream<Uint8Array>>
}

type BrowserSaveFilePicker = (options: { suggestedName: string }) => Promise<BrowserSaveFileHandle>

const webManagedFileSizeLimitError = (): Error =>
  Object.assign(new Error('Managed file exceeds the Web Blob download limit.'), {
    name: WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME
  })

const installWebApi = async (): Promise<EventCursor> => {
  const parsedBootstrap = webRpcBootstrapSchema.safeParse(await fetchBootstrap())
  if (!parsedBootstrap.success) {
    throw new Error(
      `Incompatible Open Science Web RPC protocol. Expected version ${WEB_RPC_PROTOCOL_VERSION}.`
    )
  }
  const bootstrap = parsedBootstrap.data
  const callerLocation =
    bootstrap.webCallerLocation ??
    (bootstrap.rpcCapabilities?.includes(WEB_RPC_CAPABILITY_UPDATE_CLI_V1) ? 'local' : 'remote')
  document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, callerLocation)
  const api: Record<string, unknown> = { platform: bootstrap.platform }
  const availableRpcChannels = new Set(bootstrap.rpcChannels)
  const restrictedRpcChannels = new Set(bootstrap.restrictedRpcChannels ?? [])
  document.documentElement.toggleAttribute(
    'data-open-science-notebook-network-unavailable',
    restrictedRpcChannels.has('settings:get-notebook-network-status')
  )

  installWebRendererContracts(api, {
    availableRpcChannels,
    restrictedRpcChannels,
    invoke,
    subscribe,
    nativeAdapters: {
      getRuntimeVersions: () => bootstrap.versions,
      saveBlobFile: (request: { suggestedName: string; mimeType: string; data: ArrayBuffer }) => {
        downloadBlob(new Blob([request.data], { type: request.mimeType }), request.suggestedName)
        return Promise.resolve({ saved: true })
      },
      saveManagedFile: async (request: SaveManagedFileRequest) => {
        const showSaveFilePicker = (
          window as unknown as { showSaveFilePicker?: BrowserSaveFilePicker }
        ).showSaveFilePicker
        let writable: WritableStream<Uint8Array> | undefined
        if (showSaveFilePicker) {
          try {
            const handle = await showSaveFilePicker.call(window, {
              suggestedName: request.suggestedName
            })
            writable = await handle.createWritable()
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return { saved: false }
            throw error
          }
        }

        let resource: { id: string; url: string; size: number } | undefined
        try {
          let previewRequest: AcquireManagedPreviewRequest
          switch (request.source) {
            case 'artifact':
            case 'upload':
              previewRequest = {
                source: request.source,
                projectId: request.projectId,
                fileId: request.fileId,
                ...(request.versionId ? { versionId: request.versionId } : {})
              }
              break
            case 'notebook-input':
            case 'local':
              previewRequest = { source: request.source, path: request.path }
              break
          }
          const acquiredResource = (await invoke('preview-resources:acquire', [
            previewRequest
          ])) as { id: string; url: string; size: number }
          resource = acquiredResource
          if (!writable && acquiredResource.size > WEB_BLOB_DOWNLOAD_MAX_BYTES) {
            throw webManagedFileSizeLimitError()
          }
          await withRequestTimeout(WEB_DOWNLOAD_TIMEOUT_MS, async (signal) => {
            const response = await fetch(acquiredResource.url, { signal })
            if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
            if (writable) {
              if (!response.body) throw new Error('Download failed: response body is unavailable.')
              await response.body.pipeTo(writable, { signal })
              return
            }
            downloadBlob(await response.blob(), request.suggestedName)
          })
          return { saved: true }
        } catch (error) {
          if (writable) await writable.abort(error).catch(() => undefined)
          throw error
        } finally {
          if (resource) {
            await invoke('preview-resources:release', [{ resourceId: resource.id }])
          }
        }
      },
      'window.close': () => {
        window.close()
        return Promise.resolve()
      }
    }
  })

  ;(window as unknown as { api: unknown }).api = api
  return {
    streamId: bootstrap.eventStream.streamId,
    latestSequence: bootstrap.eventStream.latestSequence
  }
}

const eventConsumersReady = new Promise<void>((resolve) => {
  window.addEventListener(WEB_EVENT_CONSUMERS_READY_EVENT, () => resolve(), {
    once: true
  })
})

try {
  eventCursor = await installWebApi()
  await import('../src/main')
  await eventConsumersReady
  publishEventConnectionPhase('connecting')
  connectEvents()
} catch (error) {
  showConnectionFailure(error)
}
