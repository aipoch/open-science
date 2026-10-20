import { z } from 'zod'
import { pdfAnnotationSchema, pdfNativeImportReceiptSchema } from '../../shared/pdf-annotations'
import { tagViewSchema } from '../../shared/tags'

// Optional, inert package data. Import never writes these records to the user's shared notebook.
export const packagePdfNotesSchema = z
  .array(
    z
      .object({
        versionId: z.string().min(1).max(1024),
        annotations: z.array(pdfAnnotationSchema).max(10000),
        tags: z.array(tagViewSchema).max(10000),
        nativeImport: pdfNativeImportReceiptSchema.optional()
      })
      .strict()
  )
  .max(1000)

export type PackagePdfNotes = z.infer<typeof packagePdfNotesSchema>
