import { useEffect } from 'react'

import { useThemeStore } from '@/stores/theme-store'

// The find bar and the native main process cannot observe the renderer's origin-scoped preference.
// Push the resolved appearance whenever either half changes: main forwards it to the find overlay and
// uses it to keep native appearance such as the macOS Dock icon synchronized with General > Theme.
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
