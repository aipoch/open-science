import type { TFunction } from 'i18next'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { ThemePreference } from '@/lib/theme'
import { useThemeStore } from '@/stores/theme-store'

// Single source of truth for the three choices, shared by the settings segmented control and the
// home-header menu so their labels, icons, and order never drift. Labels are catalog keys resolved at
// render time — the list is module-level and cannot call a hook.
const THEME_OPTIONS = [
  {
    value: 'system',
    labelKey: 'System',
    descriptionKey: 'Match your device',
    Icon: Monitor
  },
  { value: 'light', labelKey: 'Light', descriptionKey: 'Always light', Icon: Sun },
  { value: 'dark', labelKey: 'Dark', descriptionKey: 'Always dark', Icon: Moon }
] as const satisfies readonly {
  value: ThemePreference
  labelKey: string
  descriptionKey: string
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

type ThemePreferenceMenuProps = {
  className?: string
}

// Compact icon button for the home header, sized to match the neighboring GitHub / settings actions.
// The trigger shows the icon for the *current preference* (Monitor / Sun / Moon); the popover lists
// all three choices with a check beside the active one.
export const ThemePreferenceMenu = ({ className }: ThemePreferenceMenuProps): React.JSX.Element => {
  const { t } = useTranslation()
  const preference = useThemeStore((state) => state.preference)
  const setPreference = useThemeStore((state) => state.setPreference)
  const active = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0]
  const ActiveIcon = active.Icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('Theme: {{theme}}', { theme: themeOptionLabel(active.labelKey, t) })}
          title={t('Theme: {{theme}}', { theme: themeOptionLabel(active.labelKey, t) })}
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000',
            className
          )}
        >
          <ActiveIcon className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t('Theme')}</DropdownMenuLabel>
        {THEME_OPTIONS.map(({ value, labelKey, descriptionKey, Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setPreference(value)} className="gap-2">
            <Icon className="size-4 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
            <span className="flex-1">
              <span className="block leading-tight">{themeOptionLabel(labelKey, t)}</span>
              <span className="block whitespace-nowrap text-xs leading-tight text-muted-foreground">
                {t(descriptionKey)}
              </span>
            </span>
            {preference === value ? (
              <Check className="size-4 text-foreground" strokeWidth={2.5} aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
