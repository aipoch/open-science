import { pdfTranslationNumericUnitLiterals } from './numeric-units.js'

// Literal-preserving prompts must agree with the guard, rather than normalize quantity scales.
export const pdfTranslationWrittenNumericLiterals = (source: string): string[] =>
  source
    // The separator in a complete dimensional transition is not a unary minus.
    .replace(/(?<![\p{L}\p{N}_+−.,/-])(\d+D-to)-(?=\d+D(?![\p{L}\p{N}_]))/gu, '$1 ')
    .match(/[+−-]?\p{N}+(?:[.,]\p{N}+)*(?:[eE][+−-]?\d+)?/gu) ?? []

const tokens = (source: string): string[] => [
  ...pdfTranslationNumericUnitLiterals(source),
  ...pdfTranslationWrittenNumericLiterals(source),
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

// Limit placeholders to closed expressions whose boundaries survive PDF text extraction.
const inlineFormula =
  /(?<![\p{L}\p{N}_])(?:\[-?\d+(?:\.\d+)?,[ \t]*-?\d+(?:\.\d+)?\][a-z]|ℓ∞|[1-9]\d{0,2}−[a-z]|[A-Za-z][ \t]+′{1,2}(?:\([a-z]\))?(?![′(]))(?![\p{L}\p{N}_])/gu

export function pdfTranslationProtectInlineFormulas(
  source: string
): { source: string; onlyFormulas: boolean; restore: (text: string) => string } | undefined {
  const formulas = [...source.matchAll(inlineFormula)]
  if (!formulas.length) return
  const stem = '⟦PDFMATH'
  const letters = (index: number): string =>
    String(index).replace(/\d/gu, (digit) => 'ABCDEFGHIJ'[Number(digit)])
  let prefix = stem
  if (source.includes(stem)) {
    const occupied = new Set(source.match(/⟦PDFMATHZ[A-J]+Z/gu))
    let namespace = 0
    do {
      prefix = stem + 'Z' + letters(namespace++) + 'Z'
    } while (occupied.has(prefix))
  }
  const marker = (index: number): string => prefix + letters(index) + '⟧'
  let index = 0
  const masked = source.replace(inlineFormula, () => marker(index++))
  return {
    source: masked,
    onlyFormulas: !/[^\s,.，。]/u.test(source.replace(inlineFormula, '')),
    restore: (text) => {
      let next = 0
      const restored = text.replace(new RegExp(prefix + '[A-J]+⟧', 'gu'), (token) =>
        token === marker(next) && next < formulas.length ? formulas[next++][0] : token
      )
      return next === formulas.length && !restored.includes(prefix) ? restored : ''
    }
  }
}
