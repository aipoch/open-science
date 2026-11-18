import { z } from 'zod'

export const PPTX_EDIT_MAX_OPERATIONS = 200
export const PPTX_EDIT_MAX_TEXT_CHARS = 20_000
export const PPTX_EDIT_MAX_IMAGE_BASE64_CHARS = 28 * 1024 * 1024

const id = z.number().int().min(0).max(2_147_483_647)
const emu = z.number().int().min(-100_000_000).max(100_000_000)
const size = z.number().int().min(0).max(100_000_000)

const run = z.object({
  text: z.string().max(PPTX_EDIT_MAX_TEXT_CHARS),
  bold: z.boolean().optional(),
  fontFamily: z.string().min(1).max(200).optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  hyperlink: z
    .string()
    .max(2048)
    .refine((value) => value === '' || /^(https?:\/\/|mailto:)\S+$/i.test(value))
    .optional(),
  sourceRun: z.number().int().min(0).optional(),
  sizePt: z.number().min(1).max(400).optional(),
  color: z
    .string()
    .regex(/^[0-9A-Fa-f]{6}$/)
    .optional()
})

export const paragraphSchema = z.object({ runs: z.array(run).max(200) })
const paragraphs = z.array(paragraphSchema).max(500)

const frame = { x: emu, y: emu, w: size, h: size }

export const pptxOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setText'),
    slideId: id,
    shapeId: id,
    paragraphs,
    frame: z.object({ ...frame, rotationDeg: z.number().min(-360).max(360).optional() }).optional()
  }),
  z.object({
    op: z.literal('setFrame'),
    slideId: id,
    shapeId: id,
    ...frame,
    rotationDeg: z.number().min(-360).max(360).optional()
  }),
  z.object({ op: z.literal('addTextbox'), slideId: id, ...frame, paragraphs }),
  z.object({ op: z.literal('deleteShape'), slideId: id, shapeId: id }),
  z.object({
    op: z.literal('addSlide'),
    afterSlideId: id.optional(),
    layoutPart: z.string().max(300).optional()
  }),
  z.object({ op: z.literal('deleteSlide'), slideId: id }),
  z.object({ op: z.literal('moveSlide'), slideId: id, toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal('duplicateSlide'), slideId: id }),
  z.object({
    op: z.literal('replaceImage'),
    slideId: id,
    shapeId: id,
    mime: z.enum(['image/png', 'image/jpeg', 'image/gif']),
    dataBase64: z.string().max(PPTX_EDIT_MAX_IMAGE_BASE64_CHARS)
  }),
  z.object({
    op: z.literal('setNotes'),
    slideId: id,
    text: z.string().max(PPTX_EDIT_MAX_TEXT_CHARS)
  }),
  z.object({
    op: z.literal('setTableCellText'),
    slideId: id,
    shapeId: id,
    row: z.number().int().min(0),
    col: z.number().int().min(0),
    paragraphs
  }),
  z.object({
    op: z.literal('setChartText'),
    slideId: id,
    shapeId: id,
    target: z.enum(['title', 'categoryAxisTitle', 'valueAxisTitle', 'seriesName', 'category']),
    index: z.number().int().min(0).optional(),
    text: z.string().max(1_000)
  })
])

export const pptxOperationsSchema = z
  .array(pptxOperationSchema)
  .min(1)
  .max(PPTX_EDIT_MAX_OPERATIONS)

export type PptxOperation = z.infer<typeof pptxOperationSchema>
export type PptxParagraph = z.infer<typeof paragraphSchema>
