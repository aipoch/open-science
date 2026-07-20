import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './api-map.generated'

type BootstrapInfo = {
  platform: string
  versions: { electron: string; chrome: string; node: string }
}

type Listener = (payload: unknown) => void

const clientId = sessionStorage.getItem('open-science-web-client') ?? crypto.randomUUID()
sessionStorage.setItem('open-science-web-client', clientId)

const listeners = new Map<string, Set<Listener>>()

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
    body: JSON.stringify({ args }, encodeBinary)
  })
  const payload = JSON.parse(await response.text(), reviveBinary) as {
    ok: boolean
    result?: unknown
    error?: string
  }
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `RPC ${channel} failed`)
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

const connectEvents = (): void => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(
    `${protocol}//${location.host}/events?client=${encodeURIComponent(clientId)}`
  )
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data), reviveBinary) as {
      channel: string
      payload: unknown
    }
    for (const listener of listeners.get(message.channel) ?? []) listener(message.payload)
  })
  socket.addEventListener('close', () => window.setTimeout(connectEvents, 1_000))
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

const transformArgs = (path: string, args: unknown[]): unknown[] => {
  if (
    [
      'storage.validateDataRoot',
      'storage.inspectDataRoot',
      'storage.migrate',
      'storage.commitAndRelaunch',
      'storage.discardMigratedCopy'
    ].includes(path)
  ) {
    return [{ parent: args[0] }]
  }
  if (path === 'storage.setDataRootAndRelaunch') {
    return [{ parent: args[0], markOnboarding: args[1] }]
  }
  if ((path === 'acp.connect' || path === 'acp.createSession') && args.length === 0) return [{}]
  return args
}

const assignPath = (root: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.')
  const key = parts.pop()!
  let target = root
  for (const part of parts) {
    target[part] ??= {}
    target = target[part] as Record<string, unknown>
  }
  target[key] = value
}

const installWebApi = async (): Promise<void> => {
  const bootstrapResponse = await fetch('/api/bootstrap')
  if (!bootstrapResponse.ok) throw new Error('Unable to initialize Open Science Web.')
  const bootstrap = (await bootstrapResponse.json()) as BootstrapInfo
  const api: Record<string, unknown> = {
    platform: bootstrap.platform,
    getRuntimeVersions: () => bootstrap.versions
  }

  for (const [path, channel] of Object.entries(WEB_INVOKE_CHANNELS)) {
    assignPath(api, path, (...args: unknown[]) => invoke(channel, transformArgs(path, args)))
  }
  for (const [path, channel] of Object.entries(WEB_EVENT_CHANNELS)) {
    assignPath(api, path, (listener: Listener) => subscribe(channel, listener))
  }

  api.saveBlobFile = (request: { suggestedName: string; mimeType: string; data: ArrayBuffer }) => {
    downloadBlob(new Blob([request.data], { type: request.mimeType }), request.suggestedName)
    return Promise.resolve({ saved: true })
  }
  api.saveManagedFile = async (request: {
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
  }
  assignPath(api, 'window.close', () => {
    window.close()
    return Promise.resolve()
  })

  ;(window as unknown as { api: unknown }).api = api
  connectEvents()
}

await installWebApi()
await import('../src/main')
