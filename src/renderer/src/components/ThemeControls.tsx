import type { TFunction } from 'i18next'
import { Monitor, Moon, Sun } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import type { ThemePreference } from '@/lib/theme'
import { useThemeStore } from '@/stores/theme-store'

// Labels are catalog keys resolved at render time; the module-level list cannot call a hook.
const THEME_OPTIONS = [
  {
    value: 'system',
    labelKey: 'System',
    Icon: Monitor
  },
  { value: 'light', labelKey: 'Light', Icon: Sun },
  { value: 'dark', labelKey: 'Dark', Icon: Moon }
] as const satisfies readonly {
  value: ThemePreference
  labelKey: string
  Icon: typeof Monitor
}[]

const themeOptionLabel = (labelKey: string, t: TFunction): string =>
  labelKey === 'System' ? t('System', { context: 'theme' }) : t(labelKey)

// Three-way segmented control for the Settings > Appearance section. The selected segment carries a
// raised surface; the whole group is a radiogroup so it reads correctly to assistive tech.
export const ThemeSegmentedControl = (): React.JSX.Element => {
  const { t } = useTranslation()
  const preference = useThemeStore((state) => state.preference)
  const setPreference = useThemeStore((state) => state.setPreference)

  return (
    <RadioGroup.Root
      aria-label={t('Theme')}
      value={preference}
      onValueChange={(value) => setPreference(value as ThemePreference)}
      orientation="horizontal"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1"
    >
      {THEME_OPTIONS.map(({ value, labelKey, Icon }) => {
        const selected = preference === value
        return (
          <RadioGroup.Item
            key={value}
            value={value}
            aria-label={themeOptionLabel(labelKey, t)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors duration-150 ease-out motion-reduce:transition-none',
              selected
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
            <span>{themeOptionLabel(labelKey, t)}</span>
          </RadioGroup.Item>
        )
      })}
    </RadioGroup.Root>
  )
}
