import { z } from 'zod'
import type { ImageSpatialReference } from './image-model-presets'
import type { ImageModelPresetId } from './image-model-settings'

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
  spatial: ImageSpatialReference,
  presetId: ImageModelPresetId
): string {
  const mainInstruction = prompt.trim()
  if (!regions.length) return mainInstruction
  const seedream = presetId === 'seedream/5.5'
  const guide =
    spatial === 'separate-reference'
      ? 'Edit Picture 1, the clean original. Use Picture 2 only to locate the numbered instructions. Keep the guide marks out of the output.'
      : 'Use the numbered marks to locate the editing instructions. Keep the guide marks out of the output.'
  const percent = (value: number): string => `${Number((value * 100).toFixed(2))}%`
  const position = ({ x, y }: z.infer<typeof point>): string =>
    `${percent(x)} from the left edge, ${percent(y)} from the top edge`
  const seedreamCoordinate = (value: number): number => Math.min(999, Math.round(value * 1000))
  const seedreamPoint = ({ x, y }: z.infer<typeof point>): string =>
    `图1<point>${seedreamCoordinate(x)} ${seedreamCoordinate(y)}</point>`
  const instructions = regions.map(({ number, instruction, geometry }) => {
    const line = `${number}. ${instruction.trim()}`
    switch (geometry.kind) {
      case 'point':
        if (seedream) return `Point ${number} at ${seedreamPoint(geometry.point)}.\n${line}`
        return `Target point ${number}: ${position(geometry.point)}.\nInstruction for the teal badge labeled ${number}: ${instruction.trim()}`
      case 'rectangle':
        if (seedream) {
          // Keep tiny rectangles non-empty after rounding to Seedream's 0–999 grid.
          const left = Math.min(998, seedreamCoordinate(geometry.start.x))
          const top = Math.min(998, seedreamCoordinate(geometry.start.y))
          const right = Math.max(left + 1, seedreamCoordinate(geometry.end.x))
          const bottom = Math.max(top + 1, seedreamCoordinate(geometry.end.y))
          return `Rectangle ${number} at 图1<bbox>${left} ${top} ${right} ${bottom}</bbox>.\n${line}`
        }
        return `Rectangle ${number}: upper-left (${position(geometry.start)}), lower-right (${position(geometry.end)}).\n${line}`
      case 'arrow':
        if (seedream)
          return `Arrow ${number} points to ${seedreamPoint(geometry.end)} from (${position(geometry.start)}).\n${line}`
        return `Arrow ${number}: tip (${position(geometry.end)}), tail (${position(geometry.start)}).\n${line}`
      case 'polygon': {
        const xs = geometry.points.map(({ x }) => x)
        const ys = geometry.points.map(({ y }) => y)
        return `Lasso ${number}: spans ${percent(Math.min(...xs))}–${percent(Math.max(...xs))} from the left and ${percent(Math.min(...ys))}–${percent(Math.max(...ys))} from the top. Follow its drawn outline.\n${line}`
      }
    }
  })
  const kinds = new Set(regions.map(({ geometry }) => geometry.kind))
  const targets = [
    !seedream &&
      kinds.has('point') &&
      'For each point, find the numbered teal badge in the guide. Edit only the object at that same location in the original. The badge number identifies the instruction. Leave other similar objects unchanged.',
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
