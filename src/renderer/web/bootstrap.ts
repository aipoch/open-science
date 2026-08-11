import {
  ApplicationCommandError,
  isApplicationCommandErrorCode
} from '../../shared/application-command-contract'
import {
  WEB_RPC_PROTOCOL_VERSION,
  webRpcBootstrapSchema,
  webRpcEventSchema,
  webRpcResponseSchema
} from '../../shared/web-rpc-contract'
import { installWebRendererContracts } from './api-installer'
import { applyTheme, resolveInitialTheme } from '@/lib/theme'
import openScienceLogoSvg from '../../main/remote-access/openscience-logo.svg?raw'

// Apply the saved theme before the (async) web API install and the app import below, so the page
// doesn't paint in light mode and then flip to dark. The Electron renderer does the same at the top
// of main.tsx; the web build reaches main.tsx only after an async round trip, so it must apply here.
applyTheme(resolveInitialTheme())

const REMOTE_ACCESS_OFF_MESSAGE =
  'Remote access is off on the home computer. Re-enable a remote access mode in Open Science, then try again.'

class RemoteAccessOffError extends Error {}

type Listener = (payload: unknown) => void

const BOOTSTRAP_ATTEMPTS = 8
const BOOTSTRAP_TIMEOUT_MS = 8_000

const clientId = sessionStorage.getItem('open-science-web-client') ?? crypto.randomUUID()
sessionStorage.setItem('open-science-web-client', clientId)

const listeners = new Map<string, Set<Listener>>()

const connectionMessage = (): HTMLElement | null =>
  document.getElementById('open-science-connection-message')

const setConnectionMessage = (message: string): void => {
  const element = connectionMessage()
  if (element) element.textContent = message
}

const connectionLogo = document.getElementById('open-science-connection-logo')
if (connectionLogo) {
  connectionLogo.innerHTML = openScienceLogoSvg.replace(
    '<svg ',
    '<svg aria-hidden="true" focusable="false" '
  )
}

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, delayMs))

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
      setConnectionMessage(`Reconnecting to remote computer… (${attempt}/${BOOTSTRAP_ATTEMPTS})`)
      await wait(Math.min(500 * 2 ** (attempt - 2), 5_000))
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS)
    try {
      const response = await fetch('/api/bootstrap', {
        cache: 'no-store',
        signal: controller.signal
      })
      if (!response.ok) {
        throw responseError(
          response,
          await response.text(),
          `Open Science returned HTTP ${response.status}.`
        )
      }
      return response.json()
    } catch (error) {
      if (error instanceof RemoteAccessOffError) throw error
      lastError = error
    } finally {
      window.clearTimeout(timeout)
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
        : `This computer did not finish responding. ${detail}`
  }
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = 'Try again'
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
  const response = await fetch(`/rpc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-open-science-client': clientId
    },
    body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args }, encodeBinary)
  })
  const body = await response.text()
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

let eventReconnectAttempt = 0

const connectEvents = (): void => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(
    `${protocol}//${location.host}/events?client=${encodeURIComponent(clientId)}`
  )
  socket.addEventListener('open', () => {
    eventReconnectAttempt = 0
    window.dispatchEvent(new Event('open-science:web-events-open'))
  })
  socket.addEventListener('message', (event) => {
    const message = webRpcEventSchema.parse(JSON.parse(String(event.data), reviveBinary))
    for (const listener of listeners.get(message.channel) ?? []) listener(message.payload)
  })
  socket.addEventListener('close', () => {
    const delay = Math.min(1_000 * 2 ** eventReconnectAttempt, 10_000)
    eventReconnectAttempt += 1
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

const installWebApi = async (): Promise<void> => {
  const parsedBootstrap = webRpcBootstrapSchema.safeParse(await fetchBootstrap())
  if (!parsedBootstrap.success) {
    throw new Error(
      `Incompatible Open Science Web RPC protocol. Expected version ${WEB_RPC_PROTOCOL_VERSION}.`
    )
  }
  const bootstrap = parsedBootstrap.data
  const api: Record<string, unknown> = { platform: bootstrap.platform }
  const availableRpcChannels = new Set(bootstrap.rpcChannels)
  const restrictedRpcChannels = new Set(bootstrap.restrictedRpcChannels ?? [])

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
      saveManagedFile: async (request: {
        source: 'artifact' | 'upload'
        path: string
        suggestedName: string
      }) => {
        const resource = (await invoke('preview-resources:acquire', [
          { source: request.source, path: request.path }
        ])) as { id: string; url: string }
        try {
          const response = await fetch(resource.url)
          if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
          downloadBlob(await response.blob(), request.suggestedName)
          return { saved: true }
        } finally {
          await invoke('preview-resources:release', [{ resourceId: resource.id }])
        }
      },
      'window.close': () => {
        window.close()
        return Promise.resolve()
      }
    }
  })

  ;(window as unknown as { api: unknown }).api = api
  connectEvents()
}

try {
  await installWebApi()
  await import('../src/main')
} catch (error) {
  showConnectionFailure(error)
}
