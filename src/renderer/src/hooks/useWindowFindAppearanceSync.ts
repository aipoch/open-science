import { useEffect } from 'react'

import { useThemeStore } from '@/stores/theme-store'

// The find bar is a separate file:// WebContentsView, so it cannot observe the main renderer's
// origin-scoped theme preference. Push the resolved appearance whenever either half changes; main
// caches it per window and forwards it only while the overlay is open.
export const useWindowFindAppearanceSync = (): void => {
  const preference = useThemeStore((state) => state.preference)
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)

  useEffect(() => {
    window.api.window.announceWindowFindAppearance?.({
      theme: resolvedTheme,
      followsSystem: preference === 'system'
    })
  }, [preference, resolvedTheme])
}
