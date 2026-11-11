import { z } from 'zod'

export const videoCuePattern = /^(end|\d+(?:\.end|:[^\s+-]+)?)(?:[+-]\d+(?:\.\d+)?)?$/

// Timing hints are optional presentation metadata; malformed hints use the player's defaults.
export const videoCueSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.length <= 100 && videoCuePattern.test(value)
      ? value
      : undefined,
  z.string().optional()
)
const coordinate = z.number().finite().min(-1000).max(2000)
const size = z.number().finite().positive().max(1000)
const color = z.enum(['ink', 'paper', 'sky', 'gold', 'teal', 'muted', 'none'])
const appearance = {
  fill: color.optional(),
  stroke: color.optional(),
  strokeWidth: z.number().finite().min(0).max(12).optional(),
  at: videoCueSchema.optional(),
  motion: z.enum(['still', 'float', 'fall', 'pulse', 'draw']).optional()
}
const element = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rect'),
      x: coordinate,
      y: coordinate,
      width: size,
      height: size,
      radius: z.number().min(0).max(100).optional(),
      ...appearance
    })
    .strict(),
  z
    .object({
      kind: z.literal('ellipse'),
      x: coordinate,
      y: coordinate,
      rx: size,
      ry: size,
      ...appearance
    })
    .strict(),
  z
    .object({
      kind: z.literal('line'),
      x: coordinate,
      y: coordinate,
      x2: coordinate,
      y2: coordinate.optional(),
      ...appearance
    })
    .strict(),
  z
    .object({
      kind: z.literal('path'),
      d: z
        .string()
        .min(1)
        .max(1600)
        .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\s-]+$/)
        .refine(
          (path) =>
            (path.match(/[+-]?(?:\d*\.)?\d+/g) ?? []).every(
              (value) => Math.abs(Number(value)) <= 2000
            ),
          'Path coordinates exceed the drawing bounds'
        ),
      ...appearance
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      x: coordinate,
      y: coordinate,
      text: z.string().trim().min(1).max(80),
      fontSize: z.number().min(12).max(36).optional(),
      ...appearance
    })
    .strict()
])

/** A model may describe artwork, never executable SVG markup or JavaScript. */
export const videoIllustrationSchema = z
  .object({
    type: z.literal('illustration'),
    description: z.string().trim().min(1).max(240),
    at: videoCueSchema.optional(),
    until: videoCueSchema.optional(),
    elements: z.array(element).min(1).max(80)
  })
  .strict()
