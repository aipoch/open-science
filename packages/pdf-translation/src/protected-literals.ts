import { pdfTranslationNumericUnitLiterals } from './numeric-units.js'

const tokens = (source: string): string[] => [
  ...pdfTranslationNumericUnitLiterals(source),
  ...[...source.matchAll(/[+−-]?\p{N}+(?:[.,]\p{N}+)*(?:[eE][+−-]?\d+)?/gu)].map(
    (match) => match[0]
  ),
  ...[
    ...source.matchAll(/https?:\/\/[^\s<>]+|www\.[^\s<>]+|\b10\.\d{4,9}\/[^\s<>]+|`[^`\r\n]+`/gu)
  ].map((match) => match[0].replace(/[.,;:，。；：)\]}>）】》]+$/u, ''))
]
const key = (text: string): string => text.normalize('NFC').replace(/\s/gu, '')

/** Only content-first mode requires original unit spelling, URLs, DOIs and inline code. */
export function pdfTranslationMissingProtectedLiterals(
  source: string,
  translation: string
): string[] {
  const available = new Map<string, number>()
  for (const token of tokens(translation))
    available.set(key(token), (available.get(key(token)) ?? 0) + 1)
  return tokens(source).flatMap((token) => {
    const count = available.get(key(token)) ?? 0
    if (!count) return [token]
    available.set(key(token), count - 1)
    return []
  })
}
