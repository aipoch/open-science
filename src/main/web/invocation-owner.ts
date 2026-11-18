import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createLogger } from '@aipoch/diagnostics/node'
import type { ReceiptQuery } from '../harness-acp/tool-receipts'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  fetchInputSchema,
  searchInputSchema,
  parseWebResult,
  type WebInvocationMetadata,
  type WebResult
} from '../../shared/web-tools'
import { abortable } from './errors'
import {
  WebInvocationStore,
  type WebInvocationBinding,
  type WebInvocationRecord,
  type WebInvocationScope,
  type WebUndispatchedCancellation
} from './invocation-store'
import type { WebFetchContext } from './service'

const log = createLogger('web-invocation')

type Active = {
  binding: WebInvocationBinding
  branchId?: string
  controller: AbortController
  signal: AbortSignal
  cleanup: () => void
}
export type WebInvocationOwnerOptions = {
  store: WebInvocationStore
  scope: (binding: WebInvocationBinding) => Promise<WebInvocationScope>
  execute: (
    binding: WebInvocationScope,
    operation: 'search' | 'fetch',
    input: unknown,
    context: WebFetchContext
  ) => Promise<WebResult>
  publishSnapshot?: (
    record: WebInvocationRecord,
    snapshotId: string,
    authorize: () => Promise<boolean>
  ) => Promise<void>
  publish?: (
    record: WebInvocationRecord,
    status: 'in_progress' | 'failed',
    result?: WebResult,
    disposition?: 'cancelled'
  ) => void | Promise<void>
}

/** Owns Web dispatch identity until its MCP receipt is published. */
export class WebInvocationOwner {
  private readonly generation = randomUUID()
  private readonly active = new Map<string, Active>()
  private readonly metadata = new Map<string, WebInvocationMetadata>()
  private readonly cancelled = new Set<string>()
  constructor(private readonly options: WebInvocationOwnerOptions) {}
  private key(binding: WebInvocationBinding, id: string): string {
    return JSON.stringify([binding.projectId, binding.sessionId, id])
  }
  private remember(record: WebInvocationRecord): void {
    if (record.status === 'cancelled') this.cancelled.add(this.key(record, record.invocationId))
    this.metadata.set(this.key(record, record.invocationId), {
      attempt: record.attempt,
      configGeneration: record.configGeneration,
      branchId: record.branchId,
      ...(record.searchDispatches
        ? { searchDispatches: structuredClone(record.searchDispatches) }
        : {}),
      ...(record.searchAttempts ? { searchAttempts: structuredClone(record.searchAttempts) } : {})
    })
  }
  private publishObservation(record: WebInvocationRecord, signal?: AbortSignal): void {
    const publish = this.options.publish
    if (!publish) return
    // The private journal is execution evidence. Its activity projection is observational.
    void Promise.resolve()
      .then(() => {
        if (record.status === 'cancelled')
          return publish(record, 'failed', record.result, 'cancelled')
        if (!signal?.aborted) return publish(record, 'in_progress')
        return undefined
      })
      .catch(() => log.warn('Web invocation activity publication failed'))
  }
  dispositionFor(binding: WebInvocationBinding, id: string): 'cancelled' | undefined {
    return this.cancelled.has(this.key(binding, id)) ? 'cancelled' : undefined
  }
  private cancellationResult(
    record: Pick<WebInvocationRecord, 'invocationId' | 'operation' | 'input' | 'createdAt'>
  ): WebResult {
    return {
      schema: 'open-science.web.v1',
      invocation_id: record.invocationId,
      operation: record.operation,
      status: 'error',
      request: record.input,
      retrieved_at: new Date(record.createdAt).toISOString(),
      duration_ms: 0,
      sources: [],
      error: { code: 'CANCELLED', retryable: false }
    }
  }
  async reconcileResult(
    binding: WebInvocationBinding,
    query: ReceiptQuery
  ): Promise<CallToolResult | undefined> {
    let record: WebInvocationRecord | WebUndispatchedCancellation
    try {
      record = await this.options.store.read(binding, query.invocationId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        record = await this.options.store.readUndispatchedCancellation(binding, query.invocationId)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw missing
      }
    }
    if (
      ('status' in record && record.status !== 'cancelled') ||
      query.name !== `web_${record.operation}` ||
      !isDeepStrictEqual(query.arguments, record.input)
    )
      return undefined
    return this.cancelledToolResult(record)
  }
  async cancelUndispatched(
    binding: WebInvocationBinding,
    query: ReceiptQuery
  ): Promise<CallToolResult> {
    const operation = query.name === 'web_search' ? 'search' : 'fetch'
    if (query.name !== `web_${operation}`) throw new Error('Unknown Web operation')
    const input =
      operation === 'search'
        ? searchInputSchema.parse(query.arguments)
        : fetchInputSchema.parse(query.arguments)
    const cancellation = await this.recordUndispatched(
      binding,
      query.invocationId,
      operation,
      input
    )
    return this.cancelledToolResult(cancellation)
  }

  private async recordUndispatched(
    binding: WebInvocationBinding,
    invocationId: string,
    operation: 'search' | 'fetch',
    input: WebInvocationRecord['input']
  ): Promise<WebUndispatchedCancellation> {
    const cancellation: WebUndispatchedCancellation = {
      ...binding,
      invocationId,
      operation,
      input,
      configGeneration: this.generation,
      createdAt: Date.now()
    }
    await this.options.store.cancelUndispatched(cancellation)
    const key = this.key(binding, invocationId)
    this.cancelled.add(key)
    this.metadata.set(key, { attempt: 1, configGeneration: cancellation.configGeneration })
    return cancellation
  }

  private cancelledToolResult(
    record: WebInvocationRecord | WebUndispatchedCancellation
  ): CallToolResult {
    const result =
      'result' in record && record.result?.error?.code === 'CANCELLED'
        ? record.result
        : this.cancellationResult(record)
    return { content: [], structuredContent: result, isError: true }
  }
  cancelAll(): void {
    for (const active of this.active.values())
      active.controller.abort(new Error('Web runtime stopped'))
  }
  metadataFor(binding: WebInvocationBinding, id: string): WebInvocationMetadata | undefined {
    const metadata = this.metadata.get(this.key(binding, id))
    return metadata ? { ...metadata } : undefined
  }
  branchChanged(binding: WebInvocationBinding, branchId?: string): void {
    for (const active of this.active.values())
      if (
        active.binding.projectId === binding.projectId &&
        active.binding.sessionId === binding.sessionId &&
        active.branchId !== branchId
      )
        active.controller.abort(new Error('Web Session branch changed'))
  }
  cancelSession(sessionId: string): void {
    for (const active of this.active.values())
      if (active.binding.sessionId === sessionId)
        active.controller.abort(new Error('Web session authority changed'))
  }
  private async assertScope(record: WebInvocationRecord): Promise<void> {
    const current = await this.options.scope(record)
    if (current.branchId !== record.branchId || current.agentFrameId !== record.agentFrameId)
      throw new Error('Web invocation belongs to another active branch')
  }
  async execute(
    binding: WebInvocationBinding,
    operation: 'search' | 'fetch',
    rawInput: unknown,
    context: WebFetchContext = {}
  ): Promise<WebResult> {
    const input =
      operation === 'search' ? searchInputSchema.parse(rawInput) : fetchInputSchema.parse(rawInput)
    const invocationId = context.invocationId ?? randomUUID()
    const key = this.key(binding, invocationId)
    if (this.active.has(key)) throw new Error('Web invocation already dispatched')
    const controller = new AbortController()
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal
    const configGeneration = this.generation
    let created = false
    const cancel = (): void => {
      if (!created) return
      void this.options.store
        .mutate(binding, invocationId, (value) =>
          value.status === 'completed' || value.status === 'cancelled'
            ? value
            : {
                ...value,
                status: 'cancelled',
                result: this.cancellationResult(value),
                updatedAt: Date.now()
              }
        )
        .then((value) => this.remember(value))
        .catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    const cleanup = (): void => {
      signal.removeEventListener('abort', cancel)
    }
    this.active.set(key, { binding, controller, signal, cleanup })
    try {
      signal.throwIfAborted()
      const scope = await abortable(this.options.scope(binding), signal)
      let record: WebInvocationRecord = {
        ...scope,
        invocationId,
        operation,
        input,
        attempt: 1,
        configGeneration,
        status: 'started',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await this.options.store.create(record)
      created = true
      const active = this.active.get(key)
      if (active) active.branchId = record.branchId
      this.remember(record)
      signal.throwIfAborted()
      await this.assertScope(record)
      signal.throwIfAborted()
      const result = await abortable(
        this.options.execute(record, operation, structuredClone(input), {
          signal,
          invocationId,
          onDispatch: async (id, attempt) => {
            if (id !== invocationId) throw new Error('Web attempt identity mismatch')
            const updated = await this.options.store.mutate(binding, id, (value) => {
              if (
                value.status !== 'started' ||
                attempt.index !== (value.searchDispatches?.length ?? 0) + 1
              )
                throw new Error('Web dispatch no longer owns invocation')
              return {
                ...value,
                searchDispatches: [...(value.searchDispatches ?? []), structuredClone(attempt)],
                updatedAt: Date.now()
              }
            })
            this.remember(updated)
            this.publishObservation(updated, signal)
          },
          onAttempt: async (id, attempt) => {
            if (id !== invocationId) throw new Error('Web attempt identity mismatch')
            const updated = await this.options.store.mutate(binding, id, (value) => {
              const dispatched = value.searchDispatches?.find(
                (item) => item.index === attempt.index
              )
              if (!dispatched) throw new Error('Web settlement has no dispatch')
              for (const field of [
                'provider',
                'execution',
                'model_service_id',
                'model',
                'protocol',
                'started_at'
              ] as const)
                if (!isDeepStrictEqual(dispatched[field], attempt[field]))
                  throw new Error('Web settlement dispatch identity changed')
              if (value.searchAttempts?.some((item) => item.index === attempt.index)) return value
              return {
                ...value,
                searchAttempts: [...(value.searchAttempts ?? []), structuredClone(attempt)],
                updatedAt: Date.now()
              }
            })
            this.remember(updated)
            if (updated.status === 'started' || updated.status === 'cancelled')
              this.publishObservation(updated, signal)
          }
        }),
        signal
      )
      if (result.error?.code === 'CANCELLED') {
        record = await this.options.store.mutate(binding, invocationId, (value) => ({
          ...value,
          status: 'cancelled',
          result,
          updatedAt: Date.now()
        }))
        this.remember(record)
        cleanup()
        this.active.delete(key)
        this.publishObservation(record)
        return result
      }
      await this.assertScope(record)
      signal.throwIfAborted()
      record = await this.options.store.mutate(binding, invocationId, (value) => {
        if (value.status !== 'started') throw new Error('Web invocation no longer owns completion')
        return { ...value, status: 'prepared', result, updatedAt: Date.now() }
      })
      signal.throwIfAborted()
      // Remain cancellable through the existing MCP receipt publication and commit hook.
      return result
    } catch (error) {
      const wasCancelled = signal.aborted
      cleanup()
      this.active.delete(key)
      if (wasCancelled && !created) {
        const cancellation = await this.recordUndispatched(binding, invocationId, operation, input)
        if (!context.signal?.aborted) return this.cancellationResult(cancellation)
      }
      if (wasCancelled && created) {
        const cancelled = await this.options.store.mutate(binding, invocationId, (value) => {
          if (value.status === 'completed') return value
          return {
            ...value,
            status: 'cancelled',
            result: this.cancellationResult(value),
            updatedAt: Date.now()
          }
        })
        this.remember(cancelled)
        // A caller's transport cancellation cannot return evidence; the private outcome remains
        // available to normal receipt reconciliation. Policy-only cancellation can settle normally.
        if (cancelled.status === 'cancelled') {
          this.publishObservation(cancelled)
          if (!context.signal?.aborted) return cancelled.result!
        }
      }
      throw error
    }
  }
  receiptSignal(binding: WebInvocationBinding, id: string): AbortSignal | undefined {
    return this.active.get(this.key(binding, id))?.signal
  }
  async receiptCommitted(
    binding: WebInvocationBinding,
    rawResult: unknown
  ): Promise<CallToolResult | void> {
    const result = parseWebResult((rawResult as { structuredContent?: unknown })?.structuredContent)
    if (!result) return
    const key = this.key(binding, result.invocation_id)
    const active = this.active.get(key)
    let record: WebInvocationRecord
    try {
      record = await this.options.store.read(binding, result.invocation_id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const cancellation = await this.options.store.readUndispatchedCancellation(
        binding,
        result.invocation_id
      )
      if (!isDeepStrictEqual(result, this.cancellationResult(cancellation)))
        throw new Error('Web cancellation receipt does not match')
      this.cancelled.add(key)
      this.metadata.set(key, { attempt: 1, configGeneration: cancellation.configGeneration })
      active?.cleanup()
      this.active.delete(key)
      return
    }
    const finish = (settled: WebInvocationRecord): void => {
      this.remember(settled)
      active?.cleanup()
      this.active.delete(key)
    }
    if (record.status === 'cancelled') {
      finish(record)
      return this.cancelledToolResult(record)
    }

    let cancellation: CallToolResult | undefined
    const authorize = async (): Promise<boolean> => {
      const settled =
        record.status === 'completed'
          ? record
          : await this.options.store.mutate(
              binding,
              result.invocation_id,
              (value) => {
                if (value.status === 'completed' || value.status === 'cancelled') return value
                if (value.status !== 'prepared')
                  throw new Error('Web invocation no longer owns its receipt')
                return { ...value, status: 'completed', updatedAt: Date.now() }
              },
              active?.signal
            )
      finish(settled)
      if (settled.status === 'cancelled') cancellation = this.cancelledToolResult(settled)
      return settled.status === 'completed'
    }
    try {
      await this.assertScope(record)
      if (
        !['prepared', 'completed'].includes(record.status) ||
        !isDeepStrictEqual(record.result, result)
      )
        throw new Error('Web invocation receipt does not match execution')
      // Authorize under the snapshot lock before publishing cache or continuation visibility.
      if (result.document && this.options.publishSnapshot)
        await this.options.publishSnapshot(record, result.document.snapshot_id, authorize)
      else await authorize()
      return cancellation
    } catch (error) {
      if (!active?.signal.aborted) throw error
      const settled = await this.options.store.read(binding, result.invocation_id)
      if (settled.status !== 'cancelled') throw error
      finish(settled)
      return this.cancelledToolResult(settled)
    }
  }
}
