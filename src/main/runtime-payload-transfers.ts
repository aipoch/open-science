import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, readdir, rm, rmdir, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  MAX_RUNTIME_PAYLOAD_BYTES,
  RUNTIME_PAYLOAD_CHANNELS,
  RUNTIME_PAYLOAD_UPLOAD_CHANNELS,
  RUNTIME_PAYLOAD_INLINE_BYTES,
  RUNTIME_PAYLOAD_PAGE_BYTES,
  type RuntimePayloadDescriptor,
  type RuntimePayloadOptions
} from '../shared/runtime-payload-transfer'
import type { ApplicationCallerLease } from './application-command-router'
import type { CallerContext } from './caller-context'
import { parseRpcJson, stringifyRpcJson } from './rpc-json'

const logger = createLogger('runtime-payload-transfers')
const MAX_TRANSFERS = 4
const MAX_TEMP_BYTES = 1024 * 1024 * 1024
const IDLE_MS = 60_000
const LIFETIME_MS = 300_000

type Transfer = {
  id: string
  channel: string
  lease: ApplicationCallerLease
  mode: 'invoking' | 'upload' | 'download'
  bytes: number
  offset: number
  file?: FileHandle
  path?: string
  busy: boolean
  closed: boolean
  pending: Promise<unknown>
  releasing?: Promise<void>
  wake?: () => void
  idleTimer: ReturnType<typeof setTimeout>
  lifetimeTimer: ReturnType<typeof setTimeout>
  abort: () => void
}

// One process owner, shared by Desktop and Web. Domain commands still own validation and commits.
export class RuntimePayloadTransfers {
  private readonly entries = new Map<string, Transfer>()
  private readonly documents = new Map<ApplicationCallerLease, Transfer>()
  private root: Promise<string> | undefined
  private reservedBytes = 0

  constructor(private readonly temporaryParent = tmpdir()) {}

  async invoke(
    channel: string,
    args: readonly unknown[],
    caller: CallerContext,
    lease: ApplicationCallerLease,
    options: RuntimePayloadOptions,
    dispatch: (args: readonly unknown[]) => Promise<unknown>
  ): Promise<unknown> {
    this.authorize(caller, lease)
    if (!RUNTIME_PAYLOAD_CHANNELS.has(channel)) {
      if (options.transfer) throw new Error('Payload transfers are unavailable for this command.')
      return dispatch(args)
    }
    if (options.acceptPayload !== 1) {
      if (options.transfer) throw new Error('Payload transfer capability is required.')
      return dispatch(args)
    }
    const request = options.transfer
    if (request && args.length !== 0)
      throw new Error('Transfer requests cannot contain command arguments.')
    if (request && request.kind !== 'upload') {
      const entry = this.entries.get(request.snapshotId)
      if (!entry || entry.lease !== lease || entry.channel !== channel || entry.closed)
        throw new Error('Payload transfer is no longer available.')
      if (request.kind === 'release') {
        await this.release(entry)
        return null
      }
      try {
        return await this.use(entry, async () => {
          this.touch(entry)
          if (request.kind === 'read') {
            if (
              entry.mode !== 'download' ||
              request.offset !== entry.offset ||
              entry.offset >= entry.bytes
            )
              throw new Error('Invalid payload read offset.')
            const bytes = Buffer.alloc(
              Math.min(RUNTIME_PAYLOAD_PAGE_BYTES, entry.bytes - entry.offset)
            )
            await this.readExactly(entry.file!, bytes, entry.offset)
            this.authorize(caller, lease, entry)
            const offset = entry.offset
            entry.offset += bytes.length
            return {
              snapshotId: entry.id,
              offset,
              nextOffset: entry.offset,
              data: bytes.toString('base64')
            }
          }
          if (entry.mode !== 'upload')
            throw new Error('Payload upload has already been dispatched.')
          if (request.kind === 'append') {
            const bytes = Buffer.from(request.data, 'base64')
            if (
              bytes.length === 0 ||
              bytes.length > RUNTIME_PAYLOAD_PAGE_BYTES ||
              bytes.toString('base64') !== request.data ||
              request.offset !== entry.offset ||
              entry.offset + bytes.length > entry.bytes
            )
              throw new Error('Invalid payload upload page.')
            await this.writeExactly(entry.file!, bytes, entry.offset)
            this.authorize(caller, lease, entry)
            entry.offset += bytes.length
            return { nextOffset: entry.offset }
          }
          if (entry.offset !== entry.bytes) throw new Error('Payload upload is incomplete.')
          entry.mode = 'invoking'
          const bytes = Buffer.alloc(entry.bytes)
          await this.readExactly(entry.file!, bytes, 0)
          const uploaded: unknown = parseRpcJson(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          )
          if (!Array.isArray(uploaded)) throw new Error('Invalid uploaded command arguments.')
          this.authorize(caller, lease, entry)
          return this.publish(entry, await dispatch(uploaded), caller)
        })
      } catch (error) {
        await this.release(entry)
        throw error
      } finally {
        // A completed download stays immutable until the client acknowledges the final page.
        if (entry.mode === 'invoking') await this.release(entry)
      }
    }
    if (request?.kind === 'upload' && !RUNTIME_PAYLOAD_UPLOAD_CHANNELS.has(channel))
      throw new Error('Payload uploads are unavailable for this command.')
    let readResult: unknown
    let readBytes: string | undefined
    if (!request && (channel === 'sessions:load-one' || channel === 'notebook:state')) {
      readResult = await dispatch(args)
      this.authorize(caller, lease)
      readBytes = stringifyRpcJson(readResult ?? null)
      if (Buffer.byteLength(readBytes) <= RUNTIME_PAYLOAD_INLINE_BYTES) return readResult
    }
    const entry = this.admit(channel, lease)
    try {
      return await this.use(entry, async () => {
        if (request?.kind === 'upload') {
          this.reserve(entry, request.byteLength)
          await this.activate(entry, caller)
          await this.createFile(entry)
          this.authorize(caller, lease, entry)
          entry.mode = 'upload'
          return this.descriptor(entry)
        }
        if (readBytes !== undefined) this.reserve(entry, Buffer.byteLength(readBytes))
        await this.activate(entry, caller)
        return readBytes === undefined
          ? this.publish(entry, await dispatch(args), caller)
          : this.publish(entry, readResult, caller, readBytes)
      })
    } catch (error) {
      await this.release(entry)
      throw error
    } finally {
      if (entry.mode === 'invoking') await this.release(entry)
    }
  }

  async settleReleased(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].filter((entry) => entry.closed).map((entry) => this.release(entry))
    )
  }

  private authorize(caller: CallerContext, lease: ApplicationCallerLease, entry?: Transfer): void {
    if (!lease.isCurrent() || !caller.isAuthorizationCurrent() || entry?.closed)
      throw new Error('Payload transfer caller is no longer authorized.')
  }

  private admit(channel: string, lease: ApplicationCallerLease): Transfer {
    if (this.entries.size >= MAX_TRANSFERS)
      throw new Error('Payload transfer capacity is temporarily unavailable.')
    const expire = (): void => {
      void this.release(entry).catch(() => logger.warn('temporary payload cleanup failed'))
    }
    const entry: Transfer = {
      id: randomUUID(),
      channel,
      lease,
      mode: 'invoking',
      bytes: 0,
      offset: 0,
      busy: false,
      closed: false,
      pending: Promise.resolve(),
      abort: expire,
      idleTimer: setTimeout(expire, IDLE_MS),
      lifetimeTimer: setTimeout(expire, LIFETIME_MS)
    }
    entry.idleTimer.unref()
    entry.lifetimeTimer.unref()
    this.entries.set(entry.id, entry)
    lease.signal.addEventListener('abort', expire, { once: true })
    return entry
  }

  private async activate(entry: Transfer, caller: CallerContext): Promise<void> {
    while (this.documents.has(entry.lease)) {
      await new Promise<void>((resolve) => {
        entry.wake = resolve
      })
      entry.wake = undefined
      this.authorize(caller, entry.lease, entry)
    }
    this.authorize(caller, entry.lease, entry)
    this.documents.set(entry.lease, entry)
  }

  private async use<T>(entry: Transfer, operation: () => Promise<T>): Promise<T> {
    if (entry.busy) throw new Error('A payload operation is already in progress.')
    entry.busy = true
    const pending = operation()
    entry.pending = pending
    try {
      return await pending
    } finally {
      entry.busy = false
    }
  }

  private touch(entry: Transfer): void {
    entry.idleTimer.refresh()
  }

  private reserve(entry: Transfer, bytes: number): void {
    if (
      bytes > MAX_RUNTIME_PAYLOAD_BYTES ||
      this.reservedBytes - entry.bytes + bytes > MAX_TEMP_BYTES
    )
      throw new Error('Payload transfer exceeds the temporary byte budget.')
    this.reservedBytes += bytes - entry.bytes
    entry.bytes = bytes
  }

  private descriptor(entry: Transfer): RuntimePayloadDescriptor {
    return { $payload: { snapshotId: entry.id, byteLength: entry.bytes } }
  }

  private async publish(
    entry: Transfer,
    result: unknown,
    caller: CallerContext,
    encoded?: string
  ): Promise<unknown> {
    this.authorize(caller, entry.lease, entry)
    const serialized = encoded ?? stringifyRpcJson(result ?? null)
    const bytes = Buffer.byteLength(serialized)
    if (bytes <= RUNTIME_PAYLOAD_INLINE_BYTES) return result
    if (bytes > entry.bytes) this.reserve(entry, bytes)
    if (!entry.file) await this.createFile(entry)
    // The JSON string captures one immutable revision before asynchronous file writes begin.
    await entry.file!.truncate(0)
    this.reserve(entry, bytes)
    for (let position = 0, offset = 0; position < serialized.length;) {
      let end = Math.min(position + RUNTIME_PAYLOAD_PAGE_BYTES / 4, serialized.length)
      const last = serialized.charCodeAt(end - 1)
      if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--
      const chunk = Buffer.from(serialized.slice(position, end))
      this.authorize(caller, entry.lease, entry)
      await this.writeExactly(entry.file!, chunk, offset)
      position = end
      offset += chunk.length
    }
    this.authorize(caller, entry.lease, entry)
    entry.offset = 0
    entry.mode = 'download'
    return this.descriptor(entry)
  }

  private async createFile(entry: Transfer): Promise<void> {
    const root = await (this.root ??= this.createRoot())
    entry.path = join(root, entry.id)
    entry.file = await open(entry.path, 'wx+', 0o600)
  }

  private async createRoot(): Promise<string> {
    const uid = process.getuid?.() ?? 0
    const prefix = `open-science-payload-${uid}-`
    for (const name of await readdir(this.temporaryParent)) {
      if (!name.startsWith(prefix)) continue
      const match = /^(\d+)-[0-9a-f-]{36}-[A-Za-z0-9]{6}$/.exec(name.slice(prefix.length))
      if (!match) continue
      const path = join(this.temporaryParent, name)
      const info = await lstat(path).catch(() => undefined)
      if (!info?.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== uid))
        continue
      try {
        process.kill(Number(match[1]), 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH')
          await rm(path, { recursive: true, force: true })
      }
    }
    // mkdtemp uses 0700, and the unpredictable suffix prevents claiming another process's root.
    return mkdtemp(join(this.temporaryParent, `${prefix}${process.pid}-${randomUUID()}-`))
  }

  private async readExactly(file: FileHandle, bytes: Buffer, offset: number): Promise<void> {
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read)
      if (bytesRead === 0) throw new Error('Payload snapshot ended unexpectedly.')
      read += bytesRead
    }
  }

  private async writeExactly(file: FileHandle, bytes: Buffer, offset: number): Promise<void> {
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await file.write(
        bytes,
        written,
        bytes.length - written,
        offset + written
      )
      if (bytesWritten === 0) throw new Error('Payload snapshot write did not progress.')
      written += bytesWritten
    }
  }

  private release(entry: Transfer): Promise<void> {
    if (entry.releasing) return entry.releasing
    entry.closed = true
    entry.wake?.()
    clearTimeout(entry.idleTimer)
    clearTimeout(entry.lifetimeTimer)
    entry.lease.signal.removeEventListener('abort', entry.abort)
    entry.releasing = (async () => {
      await entry.pending.catch(() => undefined)
      await entry.file?.close()
      if (entry.path) await rm(entry.path, { force: true })
      this.reservedBytes -= entry.bytes
      this.entries.delete(entry.id)
      if (this.documents.get(entry.lease) === entry) this.documents.delete(entry.lease)
      for (const waiting of this.entries.values())
        if (waiting.lease === entry.lease) waiting.wake?.()
      if (this.entries.size === 0 && this.root) {
        const root = this.root
        this.root = undefined
        await root
          .then((path) => rmdir(path))
          .catch(() => logger.warn('temporary payload directory cleanup failed'))
      }
    })().catch((error) => {
      entry.releasing = undefined
      throw error
    })
    return entry.releasing
  }
}

export const runtimePayloadTransfers = new RuntimePayloadTransfers()
