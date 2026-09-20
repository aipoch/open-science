import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { LOCALES } from '../src/shared/locale'

// Main never needs renderer translations. Emit immutable application assets, not user-data caches.
export const nativeLocaleAssets = (): Plugin => ({
  name: 'open-science-native-locales',
  buildStart() {
    for (const locale of LOCALES) {
      if (locale === 'en') continue
      const path = resolve('src/shared/i18n/locales', `${locale}.json`)
      this.addWatchFile(path)
      const { common, native } = JSON.parse(readFileSync(path, 'utf8'))
      this.emitFile({
        type: 'asset',
        fileName: `native-locales/${locale}.json`,
        source: JSON.stringify({ common, native })
      })
    }
  }
})
