import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  fetchInputSchema,
  searchInputSchema,
  webResultSchema,
  webAttemptSchema
} from '../../shared/web-tools'

export const webInvocationRecordSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    branchId: z.string().min(1),
    promptMessageId: z.string().min(1),
    agentFrameId: z.string().min(1),
    runtimeSegmentId: z.string().min(1),
    invocationId: z.string().min(1).max(512),
    operation: z.enum(['search', 'fetch']),
    input: z.union([searchInputSchema, fetchInputSchema]),
    attempt: z.number().int().min(1),
    // Read existing journals written before manual replay was removed.
    retryOf: z.string().max(512).optional(),
    retryInvocationId: z.string().max(512).optional(),
    configGeneration: z.string().min(1),
    status: z.enum(['reserved', 'started', 'prepared', 'completed', 'cancelled', 'denied']),
    result: webResultSchema.optional(),
    searchDispatches: z
      .array(webAttemptSchema.omit({ status: true, duration_ms: true }))
      .max(2)
      .optional(),
    searchAttempts: z.array(webAttemptSchema).max(2).optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
  })
  .strict()
const bindingSchema = z
  .object({ projectId: z.string().min(1), sessionId: z.string().min(1) })
  .strict()
const undispatchedCancellationSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    invocationId: z.string().min(1).max(512),
    operation: z.enum(['search', 'fetch']),
    input: z.union([searchInputSchema, fetchInputSchema]),
    configGeneration: z.string().min(1),
    createdAt: z.number().finite()
  })
  .strict()
export type WebUndispatchedCancellation = z.infer<typeof undispatchedCancellationSchema>
export type WebInvocationRecord = z.infer<typeof webInvocationRecordSchema>
export type WebInvocationBinding = Pick<WebInvocationRecord, 'projectId' | 'sessionId'>
export type WebInvocationScope = Pick<
  WebInvocationRecord,
  'projectId' | 'sessionId' | 'branchId' | 'promptMessageId' | 'agentFrameId' | 'runtimeSegmentId'
>
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const stores = new Map<string, WebInvocationStore>()
export const getWebInvocationStore = (root: string): WebInvocationStore => {
  const directory = resolve(root)
  let store = stores.get(directory)
  if (!store) {
    store = new WebInvocationStore(directory)
    stores.set(directory, store)
  }
  return store
}

/** Private execution evidence, never reconstructed from sanitized transcript arguments. */
export class WebInvocationStore {
  private readonly writes = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: string) {}
  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return
    const directory = await open(path, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  private location(binding: WebInvocationBinding, invocationId: string): string {
    return join(
      this.directory,
      hash(JSON.stringify([binding.projectId, binding.sessionId])),
      hash(invocationId) + '.json'
    )
  }
  private async assertActive(directory: string): Promise<void> {
    try {
      await stat(join(directory, 'deleted'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    throw new Error('Web invocation Session was permanently deleted')
  }
  private async publishJson(
    path: string,
    value: unknown,
    options: { create?: boolean; requireActive?: boolean; signal?: AbortSignal } = {}
  ): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp'
    const file = await open(temporary, 'wx', 0o600)
    try {
      try {
        await file.writeFile(JSON.stringify(value))
        await file.sync()
      } finally {
        await file.close()
      }
      if (options.requireActive) await this.assertActive(dirname(path))
      options.signal?.throwIfAborted()
      if (options.create) await link(temporary, path)
      else await rename(temporary, path)
      await this.syncDirectory(dirname(path))
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private ensureScope(binding: WebInvocationBinding): Promise<void> {
    const parsed = bindingSchema.parse({
      projectId: binding.projectId,
      sessionId: binding.sessionId
    })
    const directory = dirname(this.location(parsed, 'scope'))
    const path = join(directory, 'scope')
    return this.trackWrite(path, async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        await this.publishJson(path, parsed, { create: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = bindingSchema.parse(JSON.parse(await readFile(path, 'utf8')))
        if (existing.projectId !== parsed.projectId || existing.sessionId !== parsed.sessionId)
          throw new Error('Web invocation scope identity changed')
        return
      }
      await this.syncDirectory(this.directory)
      await this.syncDirectory(dirname(this.directory))
    })
  }
  async ownedSessions(): Promise<WebInvocationBinding[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const bindings: WebInvocationBinding[] = []
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue
      const path = join(this.directory, entry, 'scope')
      await this.writes.get(path)?.catch(() => undefined)
      try {
        if ((await stat(path)).size > 16 * 1024)
          throw new Error('Web invocation scope evidence is too large')
        const binding = bindingSchema.parse(JSON.parse(await readFile(path, 'utf8')))
        if (hash(JSON.stringify([binding.projectId, binding.sessionId])) !== entry)
          throw new Error('Web invocation scope identity does not match')
        bindings.push(binding)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    return bindings
  }
  async deleteSession(binding: WebInvocationBinding): Promise<void> {
    const directory = dirname(this.location(binding, 'scope'))
    await this.ensureScope(binding)
    const marker = await open(join(directory, 'deleted'), 'w', 0o600)
    try {
      await marker.writeFile('true')
      await marker.sync()
    } finally {
      await marker.close()
    }
    await this.syncDirectory(directory)
    await this.syncDirectory(this.directory)
    await this.syncDirectory(dirname(this.directory))
    await Promise.allSettled(
      [...this.writes.entries()]
        .filter(([path]) => dirname(path) === directory)
        .map(([, write]) => write)
    )
    for (const name of await readdir(directory))
      if (name !== 'deleted' && name !== 'scope')
        await rm(join(directory, name), { recursive: true, force: true })
    await this.syncDirectory(directory)
  }
  private trackWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(path) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(work)
    this.writes.set(path, pending)
    void pending
      .finally(() => {
        if (this.writes.get(path) === pending) this.writes.delete(path)
      })
      .catch(() => undefined)
    return pending
  }
  cancelUndispatched(record: WebUndispatchedCancellation): Promise<void> {
    const parsed = undispatchedCancellationSchema.parse(record)
    const path = this.location(parsed, parsed.invocationId) + '.cancelled'
    return this.trackWrite(path, () => this.writeUndispatchedCancellation(path, parsed))
  }
  private async writeUndispatchedCancellation(
    path: string,
    parsed: WebUndispatchedCancellation
  ): Promise<void> {
    await this.ensureScope(parsed)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await this.assertActive(dirname(path))
    try {
      await this.publishJson(path, parsed, { create: true, requireActive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.readUndispatchedCancellationPath(parsed, parsed.invocationId)
      if (JSON.stringify(existing) !== JSON.stringify(parsed))
        throw new Error('Web cancellation identity changed')
      return
    }
    await this.syncDirectory(this.directory)
    await this.syncDirectory(dirname(this.directory))
    await this.assertActive(dirname(path))
  }
  async readUndispatchedCancellation(
    binding: WebInvocationBinding,
    invocationId: string
  ): Promise<WebUndispatchedCancellation> {
    await this.writes
      .get(this.location(binding, invocationId) + '.cancelled')
      ?.catch(() => undefined)
    return this.readUndispatchedCancellationPath(binding, invocationId)
  }
  private async readUndispatchedCancellationPath(
    binding: WebInvocationBinding,
    invocationId: string
  ): Promise<WebUndispatchedCancellation> {
    const path = this.location(binding, invocationId) + '.cancelled'
    await this.assertActive(dirname(path))
    if ((await stat(path)).size > 16 * 1024)
      throw new Error('Web cancellation evidence is too large')
    const record = undispatchedCancellationSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (
      record.projectId !== binding.projectId ||
      record.sessionId !== binding.sessionId ||
      record.invocationId !== invocationId
    )
      throw new Error('Web cancellation identity does not match')
    return record
  }
  async read(binding: WebInvocationBinding, invocationId: string): Promise<WebInvocationRecord> {
    const path = this.location(binding, invocationId)
    await this.writes.get(path)?.catch(() => undefined)
    return this.readPath(path, binding, invocationId)
  }
  private async readPath(
    path: string,
    binding: WebInvocationBinding,
    invocationId: string
  ): Promise<WebInvocationRecord> {
    await this.assertActive(dirname(path))
    if ((await stat(path)).size > 64 * 1024) throw new Error('Web invocation evidence is too large')
    const record = webInvocationRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (
      record.projectId !== binding.projectId ||
      record.sessionId !== binding.sessionId ||
      record.invocationId !== invocationId ||
      this.location(binding, record.invocationId) !== path
    )
      throw new Error('Web invocation identity does not match')
    return record
  }
  create(record: WebInvocationRecord): Promise<void> {
    const parsed = webInvocationRecordSchema.parse(record)
    const path = this.location(parsed, parsed.invocationId)
    return this.trackWrite(path, () => this.createRecord(path, parsed))
  }
  private async createRecord(path: string, parsed: WebInvocationRecord): Promise<void> {
    await this.ensureScope(parsed)
    await mkdir(join(this.directory, hash(JSON.stringify([parsed.projectId, parsed.sessionId]))), {
      recursive: true,
      mode: 0o700
    })
    await this.assertActive(dirname(path))
    try {
      await stat(path + '.cancelled')
      throw new Error('Web invocation was cancelled before dispatch')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.publishJson(path, parsed, { create: true, requireActive: true })
    await this.syncDirectory(this.directory)
    await this.syncDirectory(dirname(this.directory))
  }
  mutate(
    binding: WebInvocationBinding,
    invocationId: string,
    update: (record: WebInvocationRecord) => WebInvocationRecord,
    signal?: AbortSignal
  ): Promise<WebInvocationRecord> {
    const path = this.location(binding, invocationId)
    return this.trackWrite(path, async () => {
      const record = webInvocationRecordSchema.parse(
        update(await this.readPath(path, binding, invocationId))
      )
      if (this.location(record, record.invocationId) !== path)
        throw new Error('Web invocation identity cannot change')
      await this.publishJson(path, record, { requireActive: true, signal })
      return record
    })
  }
}
