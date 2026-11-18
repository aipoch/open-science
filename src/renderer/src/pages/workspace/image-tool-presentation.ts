import type { TFunction } from 'i18next'
import type { ChatSession } from '@/stores/session-store-contract'
import { imageModelErrorSchema, type ImageErrorDetail } from '../../../../shared/image-model-error'
import { notebookInput } from './notebook-tool-presentation'

export const imageToolOperation = (
  ...names: (string | undefined)[]
): 'generate' | 'edit' | undefined => {
  for (const name of names) {
    const match = name?.match(
      /^(?:open-science-images\/|mcp__open[-_]science[-_]images__|open_science_images_)?(generate_image|edit_image)$/u
    )
    if (match) return match[1] === 'edit_image' ? 'edit' : 'generate'
  }
  return undefined
}

export type ImageToolResult = {
  artifactId: string
  versionId: string
  filename: string
  model?: string
  width?: number
  height?: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// Only recognize version receipts; image bytes and arbitrary URLs never become preview sources.
export const readImageToolResult = (value: unknown, depth = 0): ImageToolResult | undefined => {
  if (depth > 6) return undefined
  if (typeof value === 'string') {
    try {
      // Older persisted text redaction removed a numeric token field's comma along with its value.
      const text = value
        .replace(/(:\s*)\[redacted\]\s*(?=")/gu, '$1null,')
        .replace(/(:\s*)\[redacted\]/gu, '$1null')
      return readImageToolResult(JSON.parse(text), depth + 1)
    } catch {
      return undefined
    }
  }
  const item = record(value)
  if (!item || item.isError === true) return undefined
  if (
    ['artifactId', 'versionId', 'filename'].every(
      (key) => typeof item[key] === 'string' && item[key]
    )
  ) {
    return {
      artifactId: item.artifactId as string,
      versionId: item.versionId as string,
      filename: item.filename as string,
      ...(typeof item.model === 'string' ? { model: item.model } : {}),
      ...(typeof item.width === 'number' && item.width > 0 ? { width: item.width } : {}),
      ...(typeof item.height === 'number' && item.height > 0 ? { height: item.height } : {})
    }
  }
  const children = [
    item.structuredContent,
    item.result,
    item.text,
    ...(Array.isArray(item.content) ? item.content : [item.content])
  ]
  for (const child of children) {
    const found = readImageToolResult(child, depth + 1)
    if (found) return found
  }
  return undefined
}

export const imageToolInput = notebookInput

type ImageToolSource = {
  kind: 'artifact-version' | 'upload-version'
  fileId: string
  versionId: string
}

export const readImageToolSource = (value: unknown): ImageToolSource | undefined => {
  const source = record(imageToolInput(value).source)
  if (
    (source?.sourceKind !== 'artifact-version' && source?.sourceKind !== 'upload-version') ||
    typeof source.sourceFileId !== 'string' ||
    typeof source.inputFileVersionId !== 'string'
  )
    return undefined
  return {
    kind: source.sourceKind,
    fileId: source.sourceFileId,
    versionId: source.inputFileVersionId
  }
}

export type ImageSourceSession = Pick<ChatSession, 'artifacts' | 'activities' | 'messages'>

export function findImageToolSourceName(
  source: ImageToolSource | undefined,
  session: ImageSourceSession | undefined
): string | undefined {
  if (!source || !session) return undefined
  if (source.kind === 'upload-version') {
    for (const message of session.messages) {
      const upload = message.uploads?.find(
        (entry) => entry.id === source.fileId && entry.versionId === source.versionId
      )
      if (upload) return upload.originalName || upload.name
    }
    return undefined
  }
  const artifact = session.artifacts?.find(
    (entry) => entry.artifactId === source.fileId && entry.versionId === source.versionId
  )
  if (artifact) return artifact.name
  // A completed tool can already name its output while the turn's Artifact is still unpublished.
  for (const activity of session.activities ?? []) {
    if (
      activity.status !== 'completed' ||
      !imageToolOperation(activity.providerToolName, activity.title)
    )
      continue
    for (const output of [activity.rawOutput, ...(activity.toolContent ?? [])]) {
      const result = readImageToolResult(output)
      if (result?.artifactId === source.fileId && result.versionId === source.versionId)
        return result.filename
    }
  }
  return undefined
}

// Text blocks survive ACP/framework translation even when structuredContent is omitted.
export const readImageToolError = (value: unknown, depth = 0): ImageErrorDetail | undefined => {
  if (depth > 6) return undefined
  if (typeof value === 'string') {
    try {
      return readImageToolError(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  const item = record(value)
  if (!item) return undefined
  const parsed = imageModelErrorSchema.safeParse(item.imageError)
  if (parsed.success) return parsed.data
  for (const child of [
    item.structuredContent,
    item.result,
    item.text,
    ...(Array.isArray(item.content) ? item.content : [item.content])
  ]) {
    const found = readImageToolError(child, depth + 1)
    if (found) return found
  }
  return undefined
}

export const imageOptionLabels = (t: TFunction): Record<string, string> => ({
  size: t('Output size'),
  aspect_ratio: t('Aspect ratio'),
  area: t('Resolution'),
  output_format: t('Output format'),
  background: t('Image background'),
  output_compression: t('Compression'),
  seed: t('Seed'),
  quality: t('Image quality'),
  complexity: t('Planning complexity'),
  negative_prompt: t('Negative prompt'),
  prompt_extend: t('Prompt enhancement'),
  enable_thinking: t('Image reasoning'),
  watermark: t('Watermark'),
  min_generation_area: t('Generation area')
})
