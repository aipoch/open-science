import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { isLocale } from '../../../shared/locale'

import { useThemeStore } from '@/stores/theme-store'

// The find bar and the native main process cannot observe the renderer's origin-scoped preference.
// Push the resolved appearance whenever either half changes: main forwards it to the find overlay and
// uses it to keep native appearance such as the macOS Dock icon synchronized with General > Theme.
export const useWindowFindAppearanceSync = (): void => {
  const { t, i18n } = useTranslation()
  const lang = i18n.resolvedLanguage ?? i18n.language
  const preference = useThemeStore((state) => state.preference)
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)

  useEffect(() => {
    window.api.window.announceWindowFindAppearance?.({
      theme: resolvedTheme,
      followsSystem: preference === 'system',
      localization: {
        lang: isLocale(lang) ? lang : 'en',
        placeholder: t('Find'),
        findText: t('Find text'),
        findInWindow: t('Find in window'),
        previous: t('Previous match'),
        next: t('Next match'),
        close: t('Close find')
      }
    })
  }, [lang, preference, resolvedTheme, t])
}
