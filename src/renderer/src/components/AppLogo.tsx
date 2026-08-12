import type { ComponentPropsWithoutRef } from 'react'

import darkLogoUrl from '@/assets/logo-dark.png'
import lightLogoUrl from '@/assets/logo.png'
import { useThemeStore } from '@/stores/theme-store'

type AppLogoProps = Omit<ComponentPropsWithoutRef<'img'>, 'src'>

// The single renderer-facing Open Science logo. Consumers only describe presentation (size, class,
// accessible name); the effective General > Theme decides the asset here. Reading resolvedTheme is
// important: it covers both an explicit Light/Dark choice and live OS changes while following System.
const AppLogo = ({ alt = '', ...props }: AppLogoProps): React.JSX.Element => {
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)
  const src = resolvedTheme === 'dark' ? darkLogoUrl : lightLogoUrl

  return <img {...props} src={src} alt={alt} />
}

export { AppLogo }
export type { AppLogoProps }
