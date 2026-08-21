import {
  COMMON_NAMESPACE,
  createNamespacedResource,
  RENDERER_NAMESPACE
} from '../../../shared/i18n/core'
import { common as frCommon, renderer as frRenderer } from '../../../shared/i18n/locales/fr.json'
import { common as jaCommon, renderer as jaRenderer } from '../../../shared/i18n/locales/ja.json'
import { common as koCommon, renderer as koRenderer } from '../../../shared/i18n/locales/ko.json'
import { common as ruCommon, renderer as ruRenderer } from '../../../shared/i18n/locales/ru.json'
import {
  common as zhHansCommon,
  renderer as zhHansRenderer
} from '../../../shared/i18n/locales/zh-Hans.json'
import {
  common as zhHantCommon,
  renderer as zhHantRenderer
} from '../../../shared/i18n/locales/zh-Hant.json'

export {
  englishSourceFallbackPostProcessor,
  hasValidTagStructure,
  sanitizeCatalog
} from '../../../shared/i18n/core'

export const DEFAULT_NAMESPACE = RENDERER_NAMESPACE

export const resources = {
  fr: createNamespacedResource({
    [COMMON_NAMESPACE]: frCommon,
    [RENDERER_NAMESPACE]: frRenderer
  }),
  ja: createNamespacedResource({
    [COMMON_NAMESPACE]: jaCommon,
    [RENDERER_NAMESPACE]: jaRenderer
  }),
  ko: createNamespacedResource({
    [COMMON_NAMESPACE]: koCommon,
    [RENDERER_NAMESPACE]: koRenderer
  }),
  ru: createNamespacedResource({
    [COMMON_NAMESPACE]: ruCommon,
    [RENDERER_NAMESPACE]: ruRenderer
  }),
  'zh-Hans': createNamespacedResource({
    [COMMON_NAMESPACE]: zhHansCommon,
    [RENDERER_NAMESPACE]: zhHansRenderer
  }),
  'zh-Hant': createNamespacedResource({
    [COMMON_NAMESPACE]: zhHantCommon,
    [RENDERER_NAMESPACE]: zhHantRenderer
  })
} as const
