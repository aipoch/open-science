import { describe, expect, it } from 'vitest'
import { defaultOcrLanguagesForLocale } from './local-models'

describe('defaultOcrLanguagesForLocale', () => {
  it.each([
    ['en', ['eng']],
    ['zh-Hans', ['eng', 'chi_sim']],
    ['zh-Hant', ['eng', 'chi_tra']],
    ['ja', ['eng', 'jpn']],
    ['ko', ['eng', 'kor']],
    ['fr', ['eng', 'fra']],
    ['ru', ['eng', 'rus']],
    ['de', ['eng', 'deu']],
    ['es', ['eng', 'spa']]
  ] as const)('%s selects English and the interface language', (locale, expected) => {
    expect(defaultOcrLanguagesForLocale(locale)).toEqual(expected)
  })
})
