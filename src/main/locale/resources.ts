import { commonCatalogs } from '../../shared/i18n/common-resources'
import { COMMON_NAMESPACE, NATIVE_NAMESPACE, sanitizeCatalog } from '../../shared/i18n/core'
import fr from '../../shared/i18n/locales/fr/native.json'
import ja from '../../shared/i18n/locales/ja/native.json'
import ko from '../../shared/i18n/locales/ko/native.json'
import ru from '../../shared/i18n/locales/ru/native.json'
import zhHans from '../../shared/i18n/locales/zh-Hans/native.json'
import zhHant from '../../shared/i18n/locales/zh-Hant/native.json'

const resource = (
  common: Readonly<Record<string, unknown>>,
  native: Readonly<Record<string, unknown>>
): { common: Record<string, string>; native: Record<string, string> } => ({
  [COMMON_NAMESPACE]: sanitizeCatalog(common),
  [NATIVE_NAMESPACE]: sanitizeCatalog(native)
})

export const nativeResources = {
  fr: resource(commonCatalogs.fr, fr),
  ja: resource(commonCatalogs.ja, ja),
  ko: resource(commonCatalogs.ko, ko),
  ru: resource(commonCatalogs.ru, ru),
  'zh-Hans': resource(commonCatalogs['zh-Hans'], zhHans),
  'zh-Hant': resource(commonCatalogs['zh-Hant'], zhHant)
} as const

export const nativeCatalogs = { fr, ja, ko, ru, 'zh-Hans': zhHans, 'zh-Hant': zhHant } as const
