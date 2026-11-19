import { createHash } from 'node:crypto'
import type { ImageAdapterKind, ImageServiceModel } from '../../shared/image-model-settings'
import { extname } from 'node:path'
import { imageAttachmentMimeType } from '../../shared/uploads'
import type { ImageErrorDetail, ImageModelErrorCode } from '../../shared/image-model-error'
import type { ImageTaskExecutionModel } from '../../shared/image-task'
import type { ImageEditSnapshot } from '../../shared/image-edit-contract'
import type { AcpTurnTokenUsage } from '../../shared/acp-usage-contract'
import type { ImageOperation, ImageOptionValue } from '../../shared/image-model-presets'

// Host-only execution snapshot; never include this in a renderer settings response.
export type ResolvedImageModel = {
  serviceId: string
  serviceName?: string
  providerId?: string
  adapter: ImageAdapterKind
  baseUrl: string
  apiKey?: string
  model: ImageServiceModel
}

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 20_000_000
export const MAX_IMAGE_RESPONSE_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024
export class ImageModelError extends Error {
  constructor(
    readonly code: ImageModelErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly diagnostics?: Pick<ImageErrorDetail, 'providerCode' | 'requestId' | 'parameter'>
  ) {
    super(message)
    this.name = 'ImageModelError'
  }
  get detail(): ImageErrorDetail {
    return {
      code: this.code,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...this.diagnostics
    }
  }
}
export class ImageRequestConflictError extends ImageModelError {
  constructor() {
    super('INVALID_REQUEST', 'Image request identity was reused with different inputs.', 409)
  }
}
export type ImageRaster = {
  bytes: Buffer
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
}
export type ImageSpatialInput = Pick<ImageEditSnapshot, 'naturalSize' | 'regions'>
export type ImageModelRequest = {
  operation: ImageOperation
  prompt: string
  options?: unknown
  // Already authorized by the Host caller; no renderer paths or remote input URLs.
  source?: Buffer | (() => Promise<Buffer>)
  onStarted?: (model: ImageTaskExecutionModel) => Promise<void>
  onResult?: (result: ImageModelResult) => Promise<{ artifactId: string; versionId: string }>
  // Optional digest from the host when RPC arguments also determine the published artifact.
  requestFingerprint?: string
  sourceIdentity?: string
  sourceSizeBytes?: number
  sourcePixels?: number
  spatial?: ImageSpatialInput
  signal: AbortSignal
  context: { projectId: string; sessionId: string; invocationId: string; frameworkId: string }
}
export type ImageModelResult = ImageRaster & {
  promptSha256?: string
  promptLength?: number
  serviceId: string
  presetId: string
  model: string
  parameters: Record<string, ImageOptionValue>
  usage?: AcpTurnTokenUsage
  generatedImages?: number
}

export function imageArtifactContent(
  result: ImageModelResult,
  request: {
    filename: string
    operation: ImageOperation
    invocationId: string
    prompt: string
    inputFiles?: import('../../shared/artifact-provenance').AppGeneratedArtifactProducer['inputFiles']
    task?: { id: string; regionCount: number }
  }
): {
  filename: string
  content: Buffer
  mimeType: string
  producer: import('../../shared/artifact-provenance').AppGeneratedArtifactProducer
} {
  const extension = extname(request.filename)
  const suffix = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[result.mime]
  return {
    filename:
      imageAttachmentMimeType(extension) === result.mime
        ? request.filename
        : request.filename.slice(0, request.filename.length - extension.length) + suffix,
    content: result.bytes,
    mimeType: result.mime,
    producer: {
      kind: 'connector',
      connectorId: 'image-model',
      toolId: request.operation === 'edit' ? 'edit_image' : 'generate_image',
      invocationId: request.invocationId,
      implementationVersion: '1',
      ...(request.inputFiles ? { inputFiles: request.inputFiles } : {}),
      normalizedArguments: {
        operation: request.operation,
        prompt: request.prompt,
        promptSha256:
          result.promptSha256 ?? createHash('sha256').update(request.prompt).digest('hex'),
        promptLength: result.promptLength ?? Array.from(request.prompt).length,
        imageServiceId: result.serviceId,
        presetId: result.presetId,
        model: result.model,
        parameters: result.parameters,
        width: result.width,
        height: result.height,
        ...(request.inputFiles?.[0]
          ? { sourceVersionId: request.inputFiles[0].inputFileVersionId }
          : {}),
        ...(request.task
          ? {
              imageTaskId: request.task.id,
              regionCount: request.task.regionCount
            }
          : {}),
        ...(result.generatedImages !== undefined
          ? { generatedImages: result.generatedImages }
          : {}),
        ...(result.usage ? { usage: result.usage } : {})
      }
    }
  }
}
