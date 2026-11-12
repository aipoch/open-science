import type { NativeTransientViewImage, TransientViewImage } from './execution-model-contract'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

import { MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE } from '../../shared/acp-image-contract'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import {
  ImageContentError,
  MAX_IMAGE_LONG_EDGE,
  prepareImageContentData,
  type ImageCrop,
  type PreparedImageContentData
} from '../uploads/attachment-media'

const MAX_VERSION_ID_LENGTH = 512
const MAX_WORKSPACE_PATH_LENGTH = 4096
const MAX_IMAGES_PER_INVOCATION = 4

export type HostViewImageBackend = Readonly<{
  frameworkId: string
  backendId?: string
  modelRoute?: string
  model?: string
  supportsImageInput: boolean
  generationToken?: object
}>

export type HostViewImageBackendCaptureOptions = Readonly<{
  /** Refresh durable Attempt authority at admission and publication boundaries. */
  requireWritableAttempt?: boolean
}>

export type HostViewImageCaller = Readonly<{
  projectId?: string
  sessionId: string
  agentFrameId?: string
  attemptId?: string
  role?: 'main' | 'delegate'
}>

export type HostViewImageContext = HostViewImageCaller &
  Readonly<{
    projectId: string
    executionCwd?: string
    controlInvocationId: string
    signal: AbortSignal
  }>

export type HostViewImageResult = Readonly<{
  attached: true
  sourceKind: 'artifactVersion' | 'uploadVersion' | 'workspacePath'
  originalSize: Readonly<{ width: number; height: number }>
  crop?: Readonly<{ left: number; top: number; right: number; bottom: number }>
  outputSize: Readonly<{ width: number; height: number }>
  mimeType: 'image/png' | 'image/jpeg'
}>

export type { TransientViewImage } from './execution-model-contract'

type HostViewImageCatalog = Readonly<{
  readHostArtifactCatalog(request: {
    projectId: string
    versionId?: string
  }): Promise<HostArtifactCatalogItem[]>
}>

type HostViewImageManagedFileReader = Readonly<{
  openVersion(
    request: {
      source: 'artifact' | 'upload'
      projectId: string
      fileId: string
    },
    versionId: string
  ): Promise<{ path: string; close(): Promise<void> }>
}>

type HostViewImageServiceOptions = Readonly<{
  catalog: HostViewImageCatalog
  managedFileVersions: HostViewImageManagedFileReader
  captureBackend(
    caller: HostViewImageCaller,
    options?: HostViewImageBackendCaptureOptions
  ): HostViewImageBackend | undefined | Promise<HostViewImageBackend | undefined>
  /** Optional app-owned Vision relay capability for text-only active models. */
  captureVisionRelay?: () => boolean | Promise<boolean>
  /** Converts one invocation's staged images into text evidence for a text-only active model. */
  prepareVisionEvidence?: (input: {
    images: readonly NativeTransientViewImage[]
    projectId: string
    sessionId: string
    signal: AbortSignal
  }) => Promise<string | undefined>
  prepareImage?: (
    filePath: string,
    options: { crop?: ImageCrop; maxSize?: number },
    signal?: AbortSignal,
    expectedCanonicalPath?: string
  ) => Promise<PreparedImageContentData>
}>

type StagedInvocation = {
  caller: HostViewImageCaller
  projectId: string
  sessionId: string
  backendIdentity?: string
  nextOrdinal: number
  reserved: Set<number>
  images: Map<number, NativeTransientViewImage>
  encodedImageBytes: number
  abortController: AbortController
  completing: boolean
}

type NormalizedSource = { versionId: string } | { path: string }
type NormalizedOptions = { crop?: ImageCrop; maxSize?: number }

export class HostViewImageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`host.viewImage ${message}`, cause === undefined ? undefined : { cause })
    this.name = 'HostViewImageError'
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const unknownKey = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): string | undefined => Object.keys(value).find((key) => !allowed.has(key))

const nonEmptyString = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string') throw new HostViewImageError(`${field} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new HostViewImageError(`${field} must be non-empty and at most ${maxLength} characters.`)
  }
  return normalized
}

const normalizeSource = (value: unknown): NormalizedSource => {
  if (!isPlainRecord(value)) throw new HostViewImageError('source must be a plain object.')
  const unknown = unknownKey(value, new Set(['versionId', 'path']))
  if (unknown) throw new HostViewImageError(`source has unknown key: ${unknown}.`)
  const hasVersion = Object.hasOwn(value, 'versionId')
  const hasPath = Object.hasOwn(value, 'path')
  if (hasVersion === hasPath) {
    throw new HostViewImageError('source must contain exactly one of versionId or path.')
  }
  return hasVersion
    ? { versionId: nonEmptyString(value.versionId, 'source.versionId', MAX_VERSION_ID_LENGTH) }
    : { path: nonEmptyString(value.path, 'source.path', MAX_WORKSPACE_PATH_LENGTH) }
}

const normalizeCrop = (value: unknown): ImageCrop => {
  if (!isPlainRecord(value)) throw new HostViewImageError('options.crop must be a plain object.')
  const unknown = unknownKey(value, new Set(['unit', 'left', 'top', 'right', 'bottom']))
  if (unknown) throw new HostViewImageError(`options.crop has unknown key: ${unknown}.`)
  if (value.unit !== 'pixels' && value.unit !== 'fraction') {
    throw new HostViewImageError("options.crop.unit must be 'pixels' or 'fraction'.")
  }
  const coordinates = ['left', 'top', 'right', 'bottom'] as const
  for (const coordinate of coordinates) {
    const candidate = value[coordinate]
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new HostViewImageError(`options.crop.${coordinate} must be finite.`)
    }
    if (value.unit === 'pixels' && (!Number.isInteger(candidate) || candidate < 0)) {
      throw new HostViewImageError(
        `options.crop.${coordinate} must be a non-negative integer for pixel crops.`
      )
    }
    if (value.unit === 'fraction' && (candidate < 0 || candidate > 1)) {
      throw new HostViewImageError(
        `options.crop.${coordinate} must be between 0 and 1 for fraction crops.`
      )
    }
  }
  const crop = {
    unit: value.unit,
    left: value.left as number,
    top: value.top as number,
    right: value.right as number,
    bottom: value.bottom as number
  } as ImageCrop
  if (crop.left >= crop.right || crop.top >= crop.bottom) {
    throw new HostViewImageError('options.crop must satisfy left < right and top < bottom.')
  }
  return crop
}

const normalizeOptions = (value: unknown): NormalizedOptions => {
  if (value === undefined) return {}
  if (!isPlainRecord(value)) throw new HostViewImageError('options must be a plain object.')
  const unknown = unknownKey(value, new Set(['crop', 'maxSize']))
  if (unknown) throw new HostViewImageError(`options has unknown key: ${unknown}.`)
  const maxSize = value.maxSize
  if (
    maxSize !== undefined &&
    (typeof maxSize !== 'number' ||
      !Number.isInteger(maxSize) ||
      maxSize < 1 ||
      maxSize > MAX_IMAGE_LONG_EDGE)
  ) {
    throw new HostViewImageError(
      `options.maxSize must be an integer between 1 and ${MAX_IMAGE_LONG_EDGE}.`
    )
  }
  return {
    ...(value.crop === undefined ? {} : { crop: normalizeCrop(value.crop) }),
    ...(maxSize === undefined ? {} : { maxSize: maxSize as number })
  }
}

const isContainedPath = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

const resolveWorkspaceSource = async (executionCwd: string, path: string): Promise<string> => {
  const crossPlatformPath = path.replaceAll('\\', '/')
  if (
    path.includes('\0') ||
    isAbsolute(path) ||
    posix.isAbsolute(crossPlatformPath) ||
    win32.isAbsolute(path) ||
    /^[a-z][a-z\d+.-]*:/iu.test(path) ||
    crossPlatformPath.split('/').includes('..')
  ) {
    throw new HostViewImageError(
      'source.path must be relative and stay inside the current execution workspace.'
    )
  }
  try {
    const workspaceRoot = await realpath(executionCwd)
    const lexicalTarget = resolve(workspaceRoot, path)
    if (!isContainedPath(workspaceRoot, lexicalTarget)) {
      throw new HostViewImageError(
        'source.path must be relative and stay inside the current execution workspace.'
      )
    }
    const target = await realpath(lexicalTarget)
    if (!isContainedPath(workspaceRoot, target)) {
      throw new HostViewImageError(
        'source.path escapes the current execution workspace through a symlink.'
      )
    }
    if (!(await stat(target)).isFile()) {
      throw new HostViewImageError('source.path must name a regular file.')
    }
    return target
  } catch (error) {
    if (error instanceof HostViewImageError) throw error
    throw new HostViewImageError('could not resolve source.path as a workspace file.', error)
  }
}

const backendGenerationIds = new WeakMap<object, number>()
let nextBackendGenerationId = 1

const backendGenerationId = (backend: HostViewImageBackend): number | undefined => {
  if (!backend.generationToken) return undefined
  const existing = backendGenerationIds.get(backend.generationToken)
  if (existing !== undefined) return existing
  const generationId = nextBackendGenerationId
  nextBackendGenerationId += 1
  backendGenerationIds.set(backend.generationToken, generationId)
  return generationId
}

const backendIdentity = (backend: HostViewImageBackend): string =>
  JSON.stringify([
    backend.frameworkId,
    backend.backendId,
    backend.modelRoute,
    backend.model,
    backend.supportsImageInput,
    backendGenerationId(backend)
  ])

export const isHostViewImageRouteCertified = (backend: HostViewImageBackend): boolean =>
  (backend.frameworkId === 'claude-code' && backend.modelRoute === 'claude-anthropic') ||
  (backend.frameworkId === 'opencode' &&
    (backend.modelRoute === 'opencode-openai' || backend.modelRoute === 'opencode-anthropic')) ||
  (backend.frameworkId === 'codex' &&
    (backend.modelRoute === 'codex-responses' ||
      backend.modelRoute === 'codex-responses-compatibility' ||
      backend.modelRoute === 'codex-bridge')) ||
  (backend.frameworkId === 'codebuddy' && backend.modelRoute === 'codebuddy-openai') ||
  (backend.frameworkId === 'pi' && backend.modelRoute === 'pi') ||
  (backend.frameworkId === 'open-science-agent' && backend.modelRoute === 'open-science-agent')

export const isHostViewImageBackendCertified = (backend: HostViewImageBackend): boolean =>
  backend.supportsImageInput === true && isHostViewImageRouteCertified(backend)

const frozenResult = (
  sourceKind: HostViewImageResult['sourceKind'],
  image: PreparedImageContentData
): HostViewImageResult =>
  Object.freeze({
    attached: true as const,
    sourceKind,
    originalSize: Object.freeze({ ...image.originalSize }),
    ...(image.crop ? { crop: Object.freeze({ ...image.crop }) } : {}),
    outputSize: Object.freeze({ ...image.outputSize }),
    mimeType: image.mimeType as 'image/png' | 'image/jpeg'
  })

export class HostViewImageService {
  private readonly prepareImage: NonNullable<HostViewImageServiceOptions['prepareImage']>
  private readonly invocations = new Map<string, StagedInvocation>()
  private stopped = false

  constructor(private readonly options: HostViewImageServiceOptions) {
    this.prepareImage = options.prepareImage ?? prepareImageContentData
  }

  async isAvailable(context: HostViewImageCaller): Promise<boolean> {
    if (this.stopped) return false
    const backend = await this.options.captureBackend(context)
    if (!backend) return false
    const available = isHostViewImageBackendCertified(backend) || (await this.canRelay(backend))
    const currentBackend = await this.options.captureBackend(context, {
      requireWritableAttempt: true
    })
    return (
      available &&
      !this.stopped &&
      currentBackend !== undefined &&
      backendIdentity(currentBackend) === backendIdentity(backend)
    )
  }

  private async canRelay(backend: HostViewImageBackend): Promise<boolean> {
    return (
      isHostViewImageRouteCertified(backend) &&
      this.options.prepareVisionEvidence !== undefined &&
      (await this.options.captureVisionRelay?.()) === true
    )
  }

  async stage(
    sourceValue: unknown,
    optionsValue: unknown,
    context: HostViewImageContext
  ): Promise<HostViewImageResult> {
    if (this.stopped) throw new HostViewImageError('service is shut down.')
    context.signal.throwIfAborted()
    const source = normalizeSource(sourceValue)
    const options = normalizeOptions(optionsValue)
    let invocation = this.invocations.get(context.controlInvocationId)
    if (!invocation) {
      invocation = {
        caller: {
          projectId: context.projectId,
          sessionId: context.sessionId,
          agentFrameId: context.agentFrameId,
          attemptId: context.attemptId,
          role: context.role
        },
        projectId: context.projectId,
        sessionId: context.sessionId,
        nextOrdinal: 0,
        reserved: new Set(),
        images: new Map(),
        encodedImageBytes: 0,
        abortController: new AbortController(),
        completing: false
      }
      this.invocations.set(context.controlInvocationId, invocation)
    }
    if (
      invocation.projectId !== context.projectId ||
      invocation.sessionId !== context.sessionId ||
      invocation.caller.agentFrameId !== context.agentFrameId ||
      invocation.caller.attemptId !== context.attemptId ||
      invocation.caller.role !== context.role ||
      invocation.completing
    ) {
      this.discard(context.controlInvocationId)
      throw new HostViewImageError('trusted invocation or model identity changed during staging.')
    }
    if (invocation.reserved.size >= MAX_IMAGES_PER_INVOCATION) {
      throw new HostViewImageError(
        `may attach at most ${MAX_IMAGES_PER_INVOCATION} images per invocation.`
      )
    }
    const ordinal = invocation.nextOrdinal
    invocation.nextOrdinal += 1
    invocation.reserved.add(ordinal)
    // A disconnected RPC cancels only this reservation. Stop and owner teardown cancel the batch.
    const signal = AbortSignal.any([context.signal, invocation.abortController.signal])
    const releaseReservation = (): void => {
      invocation.reserved.delete(ordinal)
      if (
        invocation.reserved.size === 0 &&
        this.invocations.get(context.controlInvocationId) === invocation
      ) {
        this.discard(context.controlInvocationId)
      }
    }
    // Completion can race a disconnected RPC whose image preparation has not settled yet.
    context.signal.addEventListener('abort', releaseReservation, { once: true })

    try {
      const backend = await this.options.captureBackend(invocation.caller, {
        requireWritableAttempt: true
      })
      signal.throwIfAborted()
      if (!backend || !isHostViewImageRouteCertified(backend)) {
        throw new HostViewImageError(
          'is unavailable for the current route; select a visual model on a certified provider path.'
        )
      }
      const identity = backendIdentity(backend)
      if (invocation.backendIdentity !== undefined && invocation.backendIdentity !== identity) {
        this.discard(context.controlInvocationId)
        throw new HostViewImageError('trusted invocation or model identity changed during staging.')
      }
      invocation.backendIdentity = identity
      if (!isHostViewImageBackendCertified(backend) && !(await this.canRelay(backend))) {
        throw new HostViewImageError(
          'requires a Vision model for this text-only model. Configure Vision in Settings > Model and retry.'
        )
      }
      signal.throwIfAborted()
      if (!(await this.isCurrentInvocation(context.controlInvocationId, invocation))) {
        if (this.invocations.get(context.controlInvocationId) === invocation) {
          this.discard(context.controlInvocationId)
        }
        throw new HostViewImageError('trusted invocation or model identity changed during staging.')
      }
      let filePath: string
      let sourceKind: HostViewImageResult['sourceKind']
      let expectedCanonicalPath: string | undefined
      let managedLease:
        Awaited<ReturnType<HostViewImageManagedFileReader['openVersion']>> | undefined
      if ('path' in source) {
        if (!context.executionCwd) {
          throw new HostViewImageError(
            'source.path requires a trusted execution workspace for the current invocation.'
          )
        }
        filePath = await resolveWorkspaceSource(context.executionCwd, source.path)
        expectedCanonicalPath = filePath
        sourceKind = 'workspacePath'
      } else {
        const items = await this.options.catalog.readHostArtifactCatalog({
          projectId: context.projectId,
          versionId: source.versionId
        })
        if (items.length === 0) {
          throw new HostViewImageError(
            `Version was not found in the current Project: ${source.versionId}`
          )
        }
        if (items.length !== 1) {
          throw new HostViewImageError(
            `Version is ambiguous in the current Project: ${source.versionId}`
          )
        }
        const item = items[0]
        if (item.projectId !== context.projectId || item.versionId !== source.versionId) {
          throw new HostViewImageError('Version resolver returned an untrusted Project identity.')
        }
        managedLease = await this.options.managedFileVersions.openVersion(
          {
            source: item.source,
            projectId: context.projectId,
            fileId: item.sourceFileId
          },
          item.versionId
        )
        filePath = managedLease.path
        sourceKind = item.source === 'artifact' ? 'artifactVersion' : 'uploadVersion'
      }

      let image: PreparedImageContentData
      try {
        image = await this.prepareImage(filePath, options, signal, expectedCanonicalPath)
      } finally {
        const lease = managedLease
        managedLease = undefined
        if (lease) await lease.close()
      }
      signal.throwIfAborted()
      const currentBackend = await this.options.captureBackend(context)
      if (
        !currentBackend ||
        (!isHostViewImageBackendCertified(currentBackend) &&
          !(await this.canRelay(currentBackend))) ||
        !(await this.isCurrentInvocation(context.controlInvocationId, invocation))
      ) {
        if (this.invocations.get(context.controlInvocationId) === invocation) {
          this.discard(context.controlInvocationId)
        }
        throw new HostViewImageError('model changed before the image could be attached.')
      }
      signal.throwIfAborted()
      const current = this.invocations.get(context.controlInvocationId)
      if (current !== invocation) {
        throw new HostViewImageError('invocation ended before the image could be attached.')
      }
      const payloadBytes = Buffer.byteLength(image.data, 'base64')
      const encodedImageBytes = invocation.encodedImageBytes + payloadBytes
      if (encodedImageBytes > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE) {
        throw new ImageContentError(
          'IMAGE_TOTAL_BUDGET_EXCEEDED',
          `Encoded image content requires ${encodedImageBytes} bytes, exceeding the ${MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE}-byte ACP per-message image budget.`,
          {
            payloadBytes,
            usedBytes: encodedImageBytes,
            limitBytes: MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
            imageCount: invocation.images.size + 1
          }
        )
      }
      invocation.encodedImageBytes = encodedImageBytes
      invocation.images.set(
        ordinal,
        Object.freeze({
          data: image.data,
          mimeType: image.mimeType as NativeTransientViewImage['mimeType']
        })
      )
      return frozenResult(sourceKind, image)
    } catch (error) {
      releaseReservation()
      if (error instanceof HostViewImageError) throw error
      if (error instanceof ImageContentError) {
        throw new HostViewImageError(error.message, error)
      }
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new HostViewImageError('could not prepare the authorized image source.', error)
    } finally {
      context.signal.removeEventListener('abort', releaseReservation)
    }
  }

  async complete(
    controlInvocationId: string,
    completionSignal?: AbortSignal
  ): Promise<readonly TransientViewImage[]> {
    const invocation = this.invocations.get(controlInvocationId)
    if (!invocation || invocation.completing) return []
    invocation.completing = true
    const signal = invocation.abortController.signal
    const isCurrent = async (options?: HostViewImageBackendCaptureOptions): Promise<boolean> => {
      const current = await this.isCurrentInvocation(controlInvocationId, invocation, options)
      signal.throwIfAborted()
      return current
    }
    const discard = (): void => {
      if (this.invocations.get(controlInvocationId) === invocation)
        this.discard(controlInvocationId)
    }
    try {
      completionSignal?.throwIfAborted()
      completionSignal?.addEventListener('abort', discard, { once: true })
      signal.throwIfAborted()
      if (!(await isCurrent()) || invocation.images.size !== invocation.reserved.size) return []
      const images = Object.freeze(
        [...invocation.images.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, image]) => image)
      )
      if (images.length === 0) return []
      const backend = await this.options.captureBackend(invocation.caller)
      signal.throwIfAborted()
      if (!backend || backendIdentity(backend) !== invocation.backendIdentity) return []
      if (isHostViewImageBackendCertified(backend)) {
        return (await isCurrent({ requireWritableAttempt: true })) ? images : []
      }
      if (!(await this.canRelay(backend)) || !this.options.prepareVisionEvidence) {
        throw new HostViewImageError('Vision evidence relay is unavailable for the current model.')
      }
      signal.throwIfAborted()
      if (!(await isCurrent({ requireWritableAttempt: true }))) return []
      const evidence = await this.options.prepareVisionEvidence({
        images,
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        signal
      })
      signal.throwIfAborted()
      if (!(await isCurrent({ requireWritableAttempt: true }))) return []
      if (typeof evidence !== 'string' || evidence.trim().length === 0) {
        throw new HostViewImageError('Vision evidence relay returned no image evidence.')
      }
      return Object.freeze([Object.freeze({ evidence })])
    } catch (error) {
      completionSignal?.throwIfAborted()
      if (signal.aborted) {
        throw new DOMException('host.viewImage image inspection was aborted.', 'AbortError')
      }
      if (error instanceof HostViewImageError) throw error
      throw new HostViewImageError(
        'could not prepare Vision evidence for the current model.',
        error
      )
    } finally {
      completionSignal?.removeEventListener('abort', discard)
      invocation.abortController.abort()
      if (this.invocations.get(controlInvocationId) === invocation) {
        this.invocations.delete(controlInvocationId)
      }
      this.releaseInvocation(invocation)
    }
  }

  discard(controlInvocationId: string): void {
    const invocation = this.invocations.get(controlInvocationId)
    this.invocations.delete(controlInvocationId)
    if (invocation) {
      invocation.abortController.abort()
      this.releaseInvocation(invocation)
    }
  }

  discardSession(sessionId: string): void {
    for (const [invocationId, invocation] of this.invocations) {
      if (invocation.sessionId === sessionId) this.discard(invocationId)
    }
  }

  shutdown(): void {
    this.stopped = true
    for (const invocationId of this.invocations.keys()) this.discard(invocationId)
  }

  private releaseInvocation(invocation: StagedInvocation): void {
    invocation.images.clear()
  }

  private async isCurrentInvocation(
    controlInvocationId: string,
    invocation: StagedInvocation,
    options?: HostViewImageBackendCaptureOptions
  ): Promise<boolean> {
    const backend = await this.options.captureBackend(invocation.caller, options)
    return (
      !this.stopped &&
      this.invocations.get(controlInvocationId) === invocation &&
      backend !== undefined &&
      backendIdentity(backend) === invocation.backendIdentity
    )
  }
}

export type { HostViewImageCatalog, HostViewImageManagedFileReader, HostViewImageServiceOptions }
