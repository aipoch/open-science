import { z } from 'zod'

const multiline = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value.join('') : value))
const output = z.object({
  output_type: z.string(),
  text: multiline.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  traceback: z.array(z.string()).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional()
})
const notebookDocumentSchema = z.object({
  nbformat: z.literal(4),
  metadata: z
    .object({ language_info: z.object({ name: z.string().optional() }).optional() })
    .optional(),
  cells: z.array(
    z.object({
      cell_type: z.enum(['code', 'markdown', 'raw']),
      source: multiline,
      execution_count: z.number().nullable().optional(),
      outputs: z.array(output).optional()
    })
  )
})

export const parseNotebookDocument = (content: string): z.infer<typeof notebookDocumentSchema> =>
  notebookDocumentSchema.parse(JSON.parse(content))
export const notebookOutputText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((part) => typeof part === 'string')
      ? value.join('')
      : ''
