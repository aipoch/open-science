import { commonCatalogs } from '../../../shared/i18n/common-resources'
import { COMMON_NAMESPACE, RENDERER_NAMESPACE, sanitizeCatalog } from '../../../shared/i18n/core'
import fr from '../locales/fr.json'
import ja from '../locales/ja.json'
import ko from '../locales/ko.json'
import ru from '../locales/ru.json'
import zhHans from '../locales/zh-Hans.json'
import zhHant from '../locales/zh-Hant.json'

export {
  englishSourceFallbackPostProcessor,
  hasValidTagStructure,
  sanitizeCatalog
} from '../../../shared/i18n/core'

const resource = (
  common: Readonly<Record<string, unknown>>,
  renderer: Readonly<Record<string, unknown>>
): { common: Record<string, string>; renderer: Record<string, string> } => ({
  [COMMON_NAMESPACE]: sanitizeCatalog(common),
  [RENDERER_NAMESPACE]: sanitizeCatalog(renderer)
})

export const DEFAULT_NAMESPACE = RENDERER_NAMESPACE

export const resources = {
  fr: resource(commonCatalogs.fr, fr),
  ja: resource(commonCatalogs.ja, ja),
  ko: resource(commonCatalogs.ko, ko),
  ru: resource(commonCatalogs.ru, ru),
  'zh-Hans': resource(commonCatalogs['zh-Hans'], zhHans),
  'zh-Hant': resource(commonCatalogs['zh-Hant'], zhHant)
} as const
