import { createHash } from 'node:crypto'
import type { BrowserPackageTransfer, PackageOperationSnapshot } from '../../shared/session-package'

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

// Correlate presentation across Electron and Node without exposing the transport secret to the UI.
export const browserImportTransferId = (request: BrowserImportRequest): string =>
  createHash('sha256').update(request.secret).digest('hex')

type PendingLaunch = {
  url: string
  transfer: BrowserPackageTransfer
  work?: Promise<void>
  cancelled?: boolean
}

export class BrowserImportLaunchRelay {
  private readonly pending = new Map<string, PendingLaunch>()
  private current: PackageOperationSnapshot | null = null
  revision = 0
  private handler?: (url: string, cancelled?: boolean) => void | Promise<void>
  private cancelHandler?: (id: string) => Promise<void>
  private changed?: (snapshot: PackageOperationSnapshot | null) => void
  private pendingOpen = false
  private openHandler?: () => void

  get snapshot(): PackageOperationSnapshot | null {
    const preparing = [...this.pending.values()].map((entry) => entry.transfer)
    if (!preparing.length) return this.current
    const current = this.current
    return {
      ...(current ?? {
        id: preparing[0].id,
        kind: 'import',
        browserReceiptOnly: true,
        state: preparing.every((t) => t.state === 'cancelled')
          ? 'cancelled'
          : preparing.every((t) => t.state === 'failed' || t.state === 'cancelled')
            ? 'failed'
            : 'running',
        progress: { phase: 'preparing' }
      }),
      browserTransfers: [
        ...(current?.browserTransfers ?? []).filter((t) => !this.pending.has(t.id)),
        ...preparing
      ]
    }
  }
  observe(changed: (snapshot: PackageOperationSnapshot | null) => void): void {
    this.changed = changed
    this.publish()
  }
  private publish(): void {
    try {
      this.changed?.(this.snapshot)
    } catch {
      /* Presentation cannot reject a protocol launch. */
    }
  }
  update(snapshot: PackageOperationSnapshot | null): void {
    this.revision++
    this.current = snapshot
    // A receiver event owns the task from here on; a late launch acknowledgement cannot rewind it.
    for (const transfer of snapshot?.browserTransfers ?? [])
      if (!this.pending.get(transfer.id)?.cancelled) this.pending.delete(transfer.id)
    this.publish()
  }
  failPending(): void {
    for (const entry of this.pending.values())
      if (!entry.cancelled) entry.transfer = { ...entry.transfer, state: 'failed' }
    this.publish()
  }
  async cancel(id: string): Promise<void> {
    const entry = this.pending.get(id)
    if (entry) {
      entry.cancelled = true
      entry.transfer = { ...entry.transfer, state: entry.work ? 'cancelling' : 'cancelled' }
      this.publish()
      if (!entry.work) return
      await entry.work
    }
    await this.cancelHandler?.(id)
  }
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
    const id = browserImportTransferId(request)
    const previous = this.pending.get(id)
    if (previous) {
      if (this.handler && previous.transfer.state === 'failed' && !previous.work) {
        previous.transfer = { ...previous.transfer, state: 'preparing' }
        this.publish()
        this.dispatch(previous)
      }
      return true
    }
    // Keep a failure visible until the next launch, but do not let settled failures consume capacity.
    for (const [key, entry] of this.pending)
      if (entry.transfer.state === 'failed' && !entry.work) this.pending.delete(key)
    if (this.pending.size >= 16) return true
    const entry: PendingLaunch = {
      url: value as string,
      transfer: {
        id,
        filename: request.name,
        state: 'preparing',
        completedBytes: 0,
        totalBytes: request.size
      }
    }
    this.pending.set(id, entry)
    this.publish()
    if (this.handler) this.dispatch(entry)
    return true
  }
  private dispatch(entry: PendingLaunch): void {
    const id = entry.transfer.id
    try {
      const work = entry.cancelled ? this.handler!(entry.url, true) : this.handler!(entry.url)
      entry.work = Promise.resolve(work).then(
        () => {
          if (this.pending.get(id) === entry) this.pending.delete(id)
          this.publish()
        },
        () => {
          entry.work = undefined
          entry.transfer = { ...entry.transfer, state: 'failed' }
          this.pending.set(id, entry)
          this.publish()
        }
      )
      // Synchronous consumers preserve the existing relay contract.
      if (!(work instanceof Promise)) this.pending.delete(id)
    } catch {
      entry.transfer = { ...entry.transfer, state: 'failed' }
      this.publish()
    }
  }
  bind(
    handler: (url: string, cancelled?: boolean) => void | Promise<void>,
    onOpen?: () => void,
    cancel?: (id: string) => Promise<void>
  ): void {
    this.handler = handler
    this.openHandler = onOpen
    this.cancelHandler = cancel
    if (this.pendingOpen && onOpen) {
      this.pendingOpen = false
      onOpen()
    }
    for (const entry of this.pending.values()) if (!entry.work) this.dispatch(entry)
  }
}
