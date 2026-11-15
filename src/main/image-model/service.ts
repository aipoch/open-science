import type { ImageResultStore } from './result-store'
import { readImageHttpError, readImageProviderError } from './provider-error'
import { createHash } from 'node:crypto'
import { annotateImageInput } from './spatial-input'
import { buildImageEditPrompt, imagePromptFits } from '../../shared/image-edit-contract'
import type { ImageModelBinding } from '../../shared/image-model-settings'
import { consumeBoundedResponseBody, fetchProviderRequest } from '@aipoch/providers/transport'
import { getImageModelPreset, validateImageModelOptions } from '../../shared/image-model-presets'
import {
  customProviderRequiresKey,
  getCustomProviderBaseUrlError
} from '../../shared/provider-url-policy'
import type { ResolvedImageModel } from '../settings/image-model-owner'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import { encodeImageRequest, readImageResult, readImageUsage } from './adapter'
import {
  ImageModelError,
  MAX_IMAGE_RESPONSE_BYTES,
  type ImageModelRequest,
  type ImageModelResult
} from './contract'
import { readImageRaster } from './raster'

export { ImageModelError } from './contract'
export type { ImageModelRequest, ImageModelResult } from './contract'

const MAX_IMAGE_EXECUTION_SLOTS = 4
const LARGE_EDIT_SOURCE_BYTES = 16 * 1024 * 1024
const LARGE_EDIT_SOURCE_PIXELS = 12_000_000

async function readImageResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const decoder = new TextDecoder()
  let text = ''
  await consumeBoundedResponseBody(
    response,
    MAX_IMAGE_RESPONSE_BYTES,
    'Image response',
    (chunk) => {
      text += decoder.decode(chunk, { stream: true })
    },
    signal
  )
  return JSON.parse(text + decoder.decode())
}

export class ImageModelService {
  private readonly shutdown = new AbortController()
  private readonly inflight = new Map<
    string,
    { fingerprint: string; result: Promise<ImageModelResult> }
  >()
  private reservedSlots = 0
  private readonly waiting = new Map<symbol, { slots: number; start: () => void }>()

  private advanceQueue(): void {
    for (const [key, next] of this.waiting) {
      if (this.reservedSlots + next.slots > MAX_IMAGE_EXECUTION_SLOTS) break
      this.waiting.delete(key)
      next.start()
    }
  }

  private acquire(signal: AbortSignal, slots: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const key = Symbol()
      const abort = (): void => {
        this.waiting.delete(key)
        reject(signal.reason)
        this.advanceQueue()
      }
      const start = (): void => {
        signal.removeEventListener('abort', abort)
        this.reservedSlots += slots
        resolve(() => {
          this.reservedSlots -= slots
          this.advanceQueue()
        })
      }
      if (!this.waiting.size && this.reservedSlots + slots <= MAX_IMAGE_EXECUTION_SLOTS) start()
      else if (this.waiting.size >= 32) {
        reject(new ImageModelError('RATE_LIMITED', 'The image queue is full.'))
      } else {
        this.waiting.set(key, { slots, start })
        signal.addEventListener('abort', abort, { once: true })
      }
    })
  }
  constructor(
    private readonly dependencies: {
      retainWrite?: () => () => void
      results?: ImageResultStore
      resolveTarget(selection?: ImageModelBinding): Promise<ResolvedImageModel | undefined>
      fetch: typeof fetch
      download(url: string, signal: AbortSignal): Promise<Buffer>
      // Composition owns the durable recorder and reports persistence failures without rerunning the model.
      recordUsage(record: SessionAuxiliaryTurnUsageRecord): Promise<void>
      timeoutMs?: number
    }
  ) {}

  close(): void {
    this.shutdown.abort()
  }

  capture(
    selection?: ImageModelBinding
  ): (request: ImageModelRequest) => Promise<ImageModelResult> {
    const target = this.dependencies
      .resolveTarget(selection ? { ...selection } : undefined)
      .then((value) => structuredClone(value))
    // A turn may never invoke its image tool; retain resolution failures for invocation only.
    void target.catch(() => {})
    return (request) => this.executeWithTarget(request, () => target)
  }

  async inspectReceipt(context: ImageModelRequest['context']): Promise<boolean | undefined> {
    return this.dependencies.results?.inspectReceipt(context)
  }

  async execute(request: ImageModelRequest): Promise<ImageModelResult> {
    return this.executeWithTarget(request, () => this.dependencies.resolveTarget())
  }

  private executeWithTarget(
    request: ImageModelRequest,
    resolveTarget: () => Promise<ResolvedImageModel | undefined>
  ): Promise<ImageModelResult> {
    const key = JSON.stringify([
      request.context.projectId,
      request.context.sessionId,
      request.context.invocationId
    ])
    const fingerprint = JSON.stringify([
      request.operation,
      request.prompt,
      request.options,
      request.sourceIdentity ??
        (Buffer.isBuffer(request.source)
          ? createHash('sha256').update(request.source).digest('hex')
          : null),
      request.spatial
    ])
    const current = this.inflight.get(key)
    if (current)
      return current.fingerprint === fingerprint
        ? current.result
        : Promise.reject(
            new ImageModelError(
              'INVALID_REQUEST',
              'Image request identity was reused with different inputs.'
            )
          )
    const releaseWrite = this.dependencies.retainWrite?.()
    const result = this.executeOnce(request, resolveTarget).finally(() => {
      this.inflight.delete(key)
      releaseWrite?.()
    })
    this.inflight.set(key, { fingerprint, result })
    return result
  }

  private async executeOnce(
    request: ImageModelRequest,
    resolveTarget: () => Promise<ResolvedImageModel | undefined>
  ): Promise<ImageModelResult> {
    const signal = AbortSignal.any([
      request.signal,
      this.shutdown.signal,
      AbortSignal.timeout(this.dependencies.timeoutMs ?? 600_000)
    ])
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.operation,
          request.prompt,
          request.options ?? null,
          request.sourceIdentity ??
            (Buffer.isBuffer(request.source)
              ? createHash('sha256').update(request.source).digest('hex')
              : null),
          request.spatial ?? null
        ])
      )
      .digest('hex')
    let submitted = false
    let received = false
    let usageRecorded: Promise<PromiseSettledResult<void>[]> | undefined
    let release: (() => void) | undefined
    try {
      signal.throwIfAborted()
      const sourceBytes = Buffer.isBuffer(request.source)
        ? request.source.byteLength
        : (request.sourceSizeBytes ?? 0)
      const size = request.spatial?.naturalSize
      const pixels = request.sourcePixels ?? (size ? size.width * size.height : undefined)
      const largeEdit =
        request.operation === 'edit' &&
        (sourceBytes >= LARGE_EDIT_SOURCE_BYTES || (pixels ?? Infinity) >= LARGE_EDIT_SOURCE_PIXELS)
      release = await this.acquire(signal, largeEdit ? 2 : 1)
      signal.throwIfAborted()
      const recovered = await this.dependencies.results?.recover(request.context, fingerprint)
      if (recovered) {
        received = true
        await request.onResult?.(recovered)
        return recovered
      }
      const target = await resolveTarget()
      signal.throwIfAborted()
      if (
        !target ||
        getCustomProviderBaseUrlError(target.baseUrl) ||
        (customProviderRequiresKey(target.baseUrl) && !target.apiKey)
      )
        throw new ImageModelError(
          'NOT_CONFIGURED',
          'Configure an available image model before generating images.'
        )
      const preset = getImageModelPreset(target.model.presetId)
      if (!preset || preset.adapter !== target.adapter)
        throw new ImageModelError(
          'NOT_CONFIGURED',
          'The image model preset does not match the configured adapter.'
        )
      const validated = validateImageModelOptions(preset.id, request.operation, request.options)
      if (!validated.ok)
        throw new ImageModelError(
          validated.code,
          `${validated.message}${validated.option ? ` (${validated.option})` : ''}`
        )
      if ((request.operation === 'edit') !== Boolean(request.source))
        throw new ImageModelError(
          'UNSUPPORTED_OPTION',
          'Editing requires one source image; generation does not accept a source.'
        )
      const inputSpec = preset.operations.edit
      const spatial = request.operation === 'edit' ? inputSpec?.spatial : undefined
      if (request.spatial && !spatial)
        throw new ImageModelError(
          'UNSUPPORTED_OPTION',
          'This image operation does not support spatial instructions.'
        )
      const instruction = typeof request.prompt === 'string' ? request.prompt : ''
      const prompt =
        spatial && request.spatial
          ? buildImageEditPrompt(instruction, request.spatial.regions, spatial)
          : instruction.trim()
      if (!prompt || !imagePromptFits(prompt))
        throw new ImageModelError(
          'UNSUPPORTED_OPTION',
          'Image prompts must contain 1–32000 characters.'
        )
      const context = { ...request.context }
      if (
        Object.values(context).length !== 4 ||
        Object.values(context).some((value) => typeof value !== 'string' || !value.trim())
      )
        throw new ImageModelError(
          'UNSUPPORTED_OPTION',
          'Trusted image invocation context is required.'
        )
      // Both MCP and the editor share the Host budget, including decoding and downloads.
      await request.onStarted?.()
      let source
      if (request.source) {
        try {
          source = await readImageRaster(
            typeof request.source === 'function' ? await request.source() : request.source,
            true
          )
        } catch (error) {
          if (error instanceof ImageModelError) throw error
          signal.throwIfAborted()
          throw new ImageModelError(
            'UNSUPPORTED_OPTION',
            'The source must be a supported static raster within the image limits.'
          )
        }
        if (
          preset.id === 'minimax-h3/official' &&
          (Math.min(source.width, source.height) < 128 ||
            Math.max(source.width, source.height) > 8192 ||
            Math.max(source.width, source.height) > 4 * Math.min(source.width, source.height))
        )
          throw new ImageModelError(
            'UNSUPPORTED_OPTION',
            'MiniMax reference images require sides of 128–8192 pixels and at most a 4:1 ratio.'
          )
      }
      let guide
      if (request.spatial && source) {
        if (spatial === 'separate-reference' && request.spatial.regions.length)
          guide = await annotateImageInput(source, request.spatial, true)
        else source = await annotateImageInput(source, request.spatial)
      }
      if (
        source &&
        inputSpec &&
        (source.bytes.length > inputSpec.maxInputBytes ||
          source.width * source.height > inputSpec.maxInputPixels ||
          (inputSpec.minInputEdge !== undefined &&
            Math.min(source.width, source.height) < inputSpec.minInputEdge) ||
          (inputSpec.maxInputEdge !== undefined &&
            Math.max(source.width, source.height) > inputSpec.maxInputEdge) ||
          (inputSpec.maxInputRatio !== undefined &&
            Math.max(source.width, source.height) >
              Math.min(source.width, source.height) * inputSpec.maxInputRatio))
      )
        throw new ImageModelError(
          'UNSUPPORTED_OPTION',
          'The source image exceeds the selected model input limits.'
        )
      const encoded = encodeImageRequest(
        target,
        request.operation,
        prompt,
        validated.options,
        source,
        guide
      )
      // The encoded request owns its payload; do not retain another full raster while waiting.
      source = undefined
      guide = undefined
      signal.throwIfAborted()
      await this.dependencies.results?.begin(context, fingerprint)
      if (signal.aborted) {
        const error =
          signal.reason?.name === 'TimeoutError'
            ? new ImageModelError('TIMED_OUT', 'Image request timed out before submission.')
            : new ImageModelError('CANCELLED', 'Image request cancelled before submission.')
        await this.dependencies.results?.fail(context, fingerprint, error)
        throw error
      }
      submitted = true
      const response = await fetchProviderRequest(this.dependencies.fetch, encoded.url, {
        ...encoded.init,
        signal
      })
      encoded.init.body = undefined
      if (!response.ok) throw await readImageHttpError(response, target.adapter, signal)
      let value = await readImageResponse(response, signal)
      const measured = readImageUsage(value, target.adapter)
      if (measured.usage) {
        // Begin accounting immediately, but let the image reach the Version writer independently.
        usageRecorded = Promise.allSettled([
          this.dependencies.recordUsage({
            projectId: context.projectId,
            sessionId: context.sessionId,
            eventId: `image:${context.invocationId}`,
            source: 'image-generation',
            frameworkId: context.frameworkId,
            providerId: target.providerId ?? target.serviceId,
            model: target.model.wireModelId,
            completedAtMs: Date.now(),
            usage: measured.usage
          })
        ])
      }
      const providerError = readImageProviderError(value, target.adapter)
      if (providerError) throw providerError
      const result = readImageResult(value)
      value = undefined // Release the base64 envelope before raster decoding and publication.
      const bytes =
        'bytes' in result ? result.bytes : await this.dependencies.download(result.url, signal)
      // Once bytes have arrived, finishing validation/publication must survive late cancellation.
      const raster = await readImageRaster(bytes, false)
      const output: ImageModelResult = {
        ...raster,
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        promptLength: Array.from(prompt).length,
        serviceId: target.serviceId,
        presetId: preset.id,
        model: target.model.wireModelId,
        parameters: encoded.parameters,
        ...measured
      }
      received = true
      const published = await request.onResult?.(output)
      if (published) await this.dependencies.results?.published(context, output, published)
      return output
    } catch (error) {
      if (error instanceof ImageModelError && !received) {
        if (submitted && error.code !== 'OUTCOME_UNKNOWN')
          await this.dependencies.results?.fail(request.context, fingerprint, error)
        throw error
      }
      // Never expose upstream bodies, credentials, signed URLs or prompt text in errors.
      throw new ImageModelError(
        submitted || received
          ? 'OUTCOME_UNKNOWN'
          : signal.aborted
            ? signal.reason?.name === 'TimeoutError'
              ? 'TIMED_OUT'
              : 'CANCELLED'
            : 'PROVIDER_ERROR',
        submitted || received
          ? 'The image request may have completed, but its result could not be confirmed. Do not retry automatically.'
          : 'The image request could not be prepared or was cancelled before submission.'
      )
    } finally {
      // Usage has its own durable writer; an image waiting for accounting no longer uses a slot.
      release?.()
      await usageRecorded
    }
  }
}
