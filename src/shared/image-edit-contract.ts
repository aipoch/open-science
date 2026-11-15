import { z } from 'zod'
import type { ImageSpatialReference } from './image-model-presets'

export const IMAGE_EDIT_TEXT_LIMIT = 16_000
export const IMAGE_EDIT_LASSO_POINT_LIMIT = 256
const IMAGE_PROMPT_LIMIT = 32_000

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const coordinate = z.number().finite().min(0).max(1)
const point = z.object({ x: coordinate, y: coordinate }).strict()
const geometry = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('point'), point }).strict(),
    z.object({ kind: z.literal('rectangle'), start: point, end: point }).strict(),
    z
      .object({
        kind: z.literal('polygon'),
        points: z.array(point).min(3).max(IMAGE_EDIT_LASSO_POINT_LIMIT)
      })
      .strict(),
    z.object({ kind: z.literal('arrow'), start: point, end: point }).strict()
  ])
  .refine((value) => {
    if (value.kind === 'point') return true
    if (value.kind === 'rectangle')
      return value.start.x < value.end.x && value.start.y < value.end.y
    if (value.kind === 'arrow')
      return value.start.x !== value.end.x || value.start.y !== value.end.y
    // A lasso needs a non-collinear area; self-intersections remain visual instructions.
    const first = value.points[0]
    const next = value.points.find((p) => p.x !== first.x || p.y !== first.y)
    return (
      !!next &&
      value.points.some(
        (p) => (next.x - first.x) * (p.y - first.y) !== (next.y - first.y) * (p.x - first.x)
      )
    )
  })

export const imageEditRegionSchema = z
  .object({
    id: identity,
    number: z.number().int().min(1).max(16),
    instruction: z.string().trim().min(1).max(4000),
    geometry
  })
  .strict()

// Geometry is measured against the EXIF-oriented source, independent of viewport zoom.
// This is an editing instruction, not a research Annotation or a provider mask payload.
export const imageEditSnapshotSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        projectId: identity,
        sourceSessionId: identity,
        sourceKind: z.enum(['artifact-version', 'upload-version']),
        sourceFileId: identity,
        sourceVersionId: identity,
        name: z.string().min(1).max(512),
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])
      })
      .strict(),
    model: z
      .object({ serviceId: z.string().uuid(), modelId: z.string().trim().min(1).max(128) })
      .strict(),
    options: z
      .record(
        z.string().min(1).max(64),
        z.union([z.string().max(256), z.number().finite(), z.boolean()])
      )
      .refine(
        (value) =>
          Object.keys(value).length <= 32 &&
          !Object.keys(value).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))
      ),
    naturalSize: z
      .object({
        width: z.number().int().min(1).max(20_000_000),
        height: z.number().int().min(1).max(20_000_000)
      })
      .strict()
      .refine(({ width, height }) => width * height <= 20_000_000),
    regions: z
      .array(imageEditRegionSchema)
      .max(16)
      .refine(
        (regions) =>
          new Set(regions.map(({ id }) => id)).size === regions.length &&
          new Set(regions.map(({ number }) => number)).size === regions.length &&
          regions.reduce((sum, { instruction }) => sum + instruction.length, 0) <=
            IMAGE_EDIT_TEXT_LIMIT
      )
  })
  .strict()

export type ImageEditSnapshot = z.infer<typeof imageEditSnapshotSchema>
export type ImageEditRegion = z.infer<typeof imageEditRegionSchema>

export function imagePromptFits(prompt: string): boolean {
  return (
    prompt.length <= IMAGE_PROMPT_LIMIT ||
    (prompt.length <= IMAGE_PROMPT_LIMIT * 2 && Array.from(prompt).length <= IMAGE_PROMPT_LIMIT)
  )
}

export function buildImageEditPrompt(
  prompt: string,
  regions: readonly ImageEditRegion[],
  spatial: ImageSpatialReference
): string {
  const mainInstruction = prompt.trim()
  if (!regions.length) return mainInstruction
  const guide =
    spatial === 'separate-reference'
      ? 'Edit Picture 1, the clean original. Use Picture 2 only to locate the numbered instructions. Keep the guide marks out of the output.'
      : 'Use the numbered shapes to locate the editing instructions. Keep the guide marks out of the output.'
  const instructions = regions.map(({ number, instruction }) => `${number}. ${instruction.trim()}`)
  const kinds = new Set(regions.map(({ geometry }) => geometry.kind))
  const targets = [
    kinds.has('point') && 'For a point, target the object at the center of the numbered mark.',
    (kinds.has('rectangle') || kinds.has('polygon')) &&
      'For an outlined region, target its interior.',
    kinds.has('arrow') &&
      'For an arrow, target what its tip points to. The arrow and its tail are only guides.'
  ]
    .filter(Boolean)
    .join(' ')
  return [
    mainInstruction,
    guide,
    targets,
    'Apply the changes together. Preserve the rest of the image as closely as possible.',
    instructions.join('\n')
  ]
    .filter(Boolean)
    .join('\n\n')
}
