// Translated PDFs currently use fonts/layout support for these target languages.
// Keep persisted checkpoint labels unchanged; aliases apply only to new admission.
export const PDF_TRANSLATION_LANGUAGES = [
  'Chinese',
  'Dutch',
  'English',
  'French',
  'German',
  'Italian',
  'Japanese',
  'Portuguese',
  'Russian',
  'Spanish'
] as const

const supported = new Set<string>([
  ...PDF_TRANSLATION_LANGUAGES.map((language) => language.toLowerCase()),
  'zh',
  'zh-cn',
  'zh-sg',
  'zh-tw',
  'zh-hk',
  'zh-mo',
  'zh-hans',
  'zh-hant',
  'zh-hans-cn',
  'zh-hans-sg',
  'zh-hant-tw',
  'zh-hant-hk',
  'zh-hant-mo',
  'simplified chinese',
  'traditional chinese',
  'chinese (simplified)',
  'chinese (traditional)',
  '中文',
  '简体中文',
  '簡體中文',
  '繁体中文',
  '繁體中文',
  'nl',
  'nl-nl',
  'en',
  'en-us',
  'en-gb',
  'fr',
  'fr-fr',
  'fr-ca',
  'de',
  'de-de',
  'it',
  'it-it',
  'ja',
  'ja-jp',
  '日本語',
  'pt',
  'pt-pt',
  'pt-br',
  'ru',
  'ru-ru',
  'es',
  'es-es',
  'es-mx'
])

export function isPdfTranslationLanguageSupported(language: string): boolean {
  return supported.has(language.trim().toLowerCase())
}
