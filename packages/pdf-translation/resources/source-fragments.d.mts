import type { PdfTranslationPdfRequest } from '../src/contracts.js'

type RenderUnit = PdfTranslationPdfRequest['units'][number]
export function createSourceFragmentRecovery(
  data: Uint8Array,
  pages: PdfTranslationPdfRequest['pages']
): {
  recover<Unit extends RenderUnit>(unit: Unit): Promise<Unit | undefined>
  originalTextOrigins(
    engine: unknown,
    page: number,
    objects: readonly { obj: number; type: number; text: string }[],
    pageNumber: number,
    resources: unknown
  ): Promise<
    Map<number, { font: number; text: string; matrix: number[]; point: number[] }> | undefined
  >
  close(): Promise<void>
}
