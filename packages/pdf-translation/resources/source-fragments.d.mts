import type { PdfTranslationPdfRequest } from '../src/contracts.js'

type RenderUnit = PdfTranslationPdfRequest['units'][number]
export function createSourceFragmentRecovery(
  data: Uint8Array,
  pages: PdfTranslationPdfRequest['pages']
): {
  recover<Unit extends RenderUnit>(unit: Unit): Promise<Unit | undefined>
  close(): Promise<void>
}
