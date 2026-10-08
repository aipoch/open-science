import { expect, it } from 'vitest'
import {
  isPdfTranslationLanguageSupported,
  PDF_TRANSLATION_LANGUAGES
} from './pdf-translation-languages'
import { PdfTranslationError, pdfTranslationFailure } from './pdf-translation'

it.each([
  ...PDF_TRANSLATION_LANGUAGES,
  '  eNgLiSh  ',
  'zh-Hans',
  'zh-Hant-TW',
  'zh-CN',
  'zh-TW',
  'Chinese (Simplified)',
  'Traditional Chinese',
  '中文',
  '简体中文',
  '繁體中文',
  'ja',
  'ja-JP',
  '日本語',
  'pt-BR',
  'en-US'
])('accepts supported PDF language or explicit alias %s', (language) => {
  expect(isPdfTranslationLanguageSupported(language)).toBe(true)
})

it.each([
  'Arabic',
  'ar',
  'العربية',
  'Hindi',
  'hi',
  'हिन्दी',
  'Korean',
  'ko',
  'ko-KR',
  '한국어',
  '',
  '   ',
  'unknown',
  'zh-unknown',
  'ja-Kore',
  'English and Arabic'
])('rejects unsupported or unknown PDF language %s', (language) => {
  expect(isPdfTranslationLanguageSupported(language)).toBe(false)
})

it('preserves unsupported-language through serialized application errors', () => {
  const error = new PdfTranslationError('unsupported-language', 'Choose a supported language.')
  expect(pdfTranslationFailure(new Error(error.message))).toBe('unsupported-language')
})
