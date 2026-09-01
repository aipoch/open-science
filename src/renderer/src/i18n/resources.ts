import {
  COMMON_NAMESPACE,
  createNamespacedResource,
  RENDERER_NAMESPACE
} from '../../../shared/i18n/core'
import { common as deCommon, renderer as deRenderer } from '../../../shared/i18n/locales/de.json'
import { common as esCommon, renderer as esRenderer } from '../../../shared/i18n/locales/es.json'
import { common as frCommon, renderer as frRenderer } from '../../../shared/i18n/locales/fr.json'
import { common as jaCommon, renderer as jaRenderer } from '../../../shared/i18n/locales/ja.json'
import { common as koCommon, renderer as koRenderer } from '../../../shared/i18n/locales/ko.json'
import {
  common as ptBrCommon,
  renderer as ptBrRenderer
} from '../../../shared/i18n/locales/pt-BR.json'
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
  de: createNamespacedResource({
    [COMMON_NAMESPACE]: deCommon,
    [RENDERER_NAMESPACE]: deRenderer
  }),
  es: createNamespacedResource({
    [COMMON_NAMESPACE]: esCommon,
    [RENDERER_NAMESPACE]: esRenderer
  }),
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
  'pt-BR': createNamespacedResource({
    [COMMON_NAMESPACE]: ptBrCommon,
    [RENDERER_NAMESPACE]: ptBrRenderer
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
