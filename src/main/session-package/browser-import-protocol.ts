const MAX_BYTES = 2 * 1024 ** 3
const HEX_SECRET = /^[a-f0-9]{64}$/
export type BrowserImportRequest = {
  origin: string
  secret: string
  port: number
  name: string
  size: number
}
export function parseBrowserImportUrl(input: unknown): BrowserImportRequest | null {
  if (typeof input !== 'string' || input.length > 4096) return null
  try {
    const url = new URL(input)
    if (
      url.protocol !== 'open-science:' ||
      url.hostname !== 'import' ||
      url.port ||
      url.username ||
      url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.hash
    )
      return null
    const keys = ['version', 'origin', 'secret', 'port', 'name', 'size']
    if (
      url.searchParams.size !== keys.length ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.get('version') !== '1'
    )
      return null
    const origin = url.searchParams.get('origin')!
    const site = new URL(origin)
    if (
      site.origin !== origin ||
      (site.protocol !== 'https:' &&
        !(site.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(site.hostname)))
    )
      return null
    const secret = url.searchParams.get('secret')!
    const name = url.searchParams.get('name')!
    const portString = url.searchParams.get('port')!
    const sizeString = url.searchParams.get('size')!
    const port = Number(portString)
    const size = Number(sizeString)
    if (
      !HEX_SECRET.test(secret) ||
      !/^\d+$/.test(portString) ||
      port < 49152 ||
      port > 65535 ||
      !/^\d+$/.test(sizeString) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_BYTES
    )
      return null
    if (
      name.length > 160 ||
      new TextEncoder().encode(name).byteLength > 255 ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) ||
      !/\.science$/i.test(name) ||
      // eslint-disable-next-line no-control-regex -- Reject control characters in external filenames.
      /[\x00-\x1f\x7f/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      name.startsWith('.') ||
      /[. ]$/.test(name)
    )
      return null
    return { origin, secret, port, name, size }
  } catch {
    return null
  }
}

export class BrowserImportLaunchRelay {
  private readonly pending = new Map<string, string>()
  private handler?: (url: string) => void
  private pendingOpen = false
  private openHandler?: () => void
  receiveArgv(argv: readonly string[]): void {
    for (const value of argv.slice(1)) this.receive(value)
  }
  receiveOpenUrl(event: { preventDefault(): void }, url: string): void {
    if (this.receive(url)) event.preventDefault()
  }
  receive(value: unknown): boolean {
    if (value === 'open-science://open' || value === 'open-science://open/') {
      if (this.openHandler) this.openHandler()
      else this.pendingOpen = true
      return true
    }
    const request = parseBrowserImportUrl(value)
    if (!request) return false
    if (this.handler) this.handler(value as string)
    else if (this.pending.size < 16) this.pending.set(request.secret, value as string)
    return true
  }
  bind(handler: (url: string) => void, onOpen?: () => void): void {
    this.handler = handler
    this.openHandler = onOpen
    if (this.pendingOpen && onOpen) {
      this.pendingOpen = false
      onOpen()
    }
    for (const value of this.pending.values()) handler(value)
    this.pending.clear()
  }
}
