export function pdfLinkLabelKey(text: string): string | null
export function pdfLinkAddressMatches(text: string): { text: string; index: number }[]
export function translatedPdfLinkLabel(
  source: string,
  translation: string,
  label: string,
  offset: number
): { start: number; text: string } | null

export function pdfLinkLabelMatches(text: string, label: string): RegExpMatchArray[]

export function translatedPdfLinkFragment(
  source: string,
  translation: string,
  label: string,
  offset: number
): { start: number; text: string } | null

export function translatedPdfBracketedReference(
  source: string,
  translation: string,
  label: string,
  offset: number
):
  | {
      start: number
      end: number
      text: string
      sourceBlock: { start: number; end: number; text: string }
      targetBlock: { start: number; end: number; text: string }
    }
  | null
  | undefined
