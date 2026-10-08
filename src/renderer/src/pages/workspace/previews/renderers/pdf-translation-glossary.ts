import {
  pdfTranslationGlossarySchema,
  type PdfTranslationGlossary
} from '../../../../../../shared/pdf-translation'

export function glossaryError(
  entries: PdfTranslationGlossary,
  t: (key: string) => string
): string | undefined {
  const result = pdfTranslationGlossarySchema.safeParse(entries)
  if (result.success) return undefined
  const issues = result.error.issues
  if (issues.some((issue) => issue.code === 'too_big' || issue.message === 'glossary-too-large'))
    return t('The glossary is too long. Shorten terms or remove some entries.')
  if (issues.some((issue) => issue.message === 'duplicate-source'))
    return t('Each source term must appear only once in the glossary.')
  return t('Enter a source term and a translation for every glossary entry.')
}
