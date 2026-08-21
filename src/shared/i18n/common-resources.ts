import fr from './locales/fr/common.json'
import ja from './locales/ja/common.json'
import ko from './locales/ko/common.json'
import ru from './locales/ru/common.json'
import zhHans from './locales/zh-Hans/common.json'
import zhHant from './locales/zh-Hant/common.json'

export const commonCatalogs = {
  fr,
  ja,
  ko,
  ru,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant
} as const
