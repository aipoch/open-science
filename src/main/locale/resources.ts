import {
  COMMON_NAMESPACE,
  createNamespacedResource,
  NATIVE_NAMESPACE
} from '../../shared/i18n/core'
import { common as deCommon, native as deNative } from '../../shared/i18n/locales/de.json'
import { common as esCommon, native as esNative } from '../../shared/i18n/locales/es.json'
import { common as frCommon, native as frNative } from '../../shared/i18n/locales/fr.json'
import { common as jaCommon, native as jaNative } from '../../shared/i18n/locales/ja.json'
import { common as koCommon, native as koNative } from '../../shared/i18n/locales/ko.json'
import { common as ptBrCommon, native as ptBrNative } from '../../shared/i18n/locales/pt-BR.json'
import { common as ruCommon, native as ruNative } from '../../shared/i18n/locales/ru.json'
import {
  common as zhHansCommon,
  native as zhHansNative
} from '../../shared/i18n/locales/zh-Hans.json'
import {
  common as zhHantCommon,
  native as zhHantNative
} from '../../shared/i18n/locales/zh-Hant.json'

export const nativeResources = {
  de: createNamespacedResource({
    [COMMON_NAMESPACE]: deCommon,
    [NATIVE_NAMESPACE]: deNative
  }),
  es: createNamespacedResource({
    [COMMON_NAMESPACE]: esCommon,
    [NATIVE_NAMESPACE]: esNative
  }),
  fr: createNamespacedResource({
    [COMMON_NAMESPACE]: frCommon,
    [NATIVE_NAMESPACE]: frNative
  }),
  ja: createNamespacedResource({
    [COMMON_NAMESPACE]: jaCommon,
    [NATIVE_NAMESPACE]: jaNative
  }),
  ko: createNamespacedResource({
    [COMMON_NAMESPACE]: koCommon,
    [NATIVE_NAMESPACE]: koNative
  }),
  'pt-BR': createNamespacedResource({
    [COMMON_NAMESPACE]: ptBrCommon,
    [NATIVE_NAMESPACE]: ptBrNative
  }),
  ru: createNamespacedResource({
    [COMMON_NAMESPACE]: ruCommon,
    [NATIVE_NAMESPACE]: ruNative
  }),
  'zh-Hans': createNamespacedResource({
    [COMMON_NAMESPACE]: zhHansCommon,
    [NATIVE_NAMESPACE]: zhHansNative
  }),
  'zh-Hant': createNamespacedResource({
    [COMMON_NAMESPACE]: zhHantCommon,
    [NATIVE_NAMESPACE]: zhHantNative
  })
} as const

export const nativeCatalogs = {
  de: deNative,
  es: esNative,
  fr: frNative,
  ja: jaNative,
  ko: koNative,
  'pt-BR': ptBrNative,
  ru: ruNative,
  'zh-Hans': zhHansNative,
  'zh-Hant': zhHantNative
} as const
