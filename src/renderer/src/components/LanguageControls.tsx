import { Check, Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useLocaleStore } from '@/stores/locale-store'
import { LANGUAGE_PREFERENCES, type Locale, type LanguagePreference } from '../../../shared/locale'

// Language names are written in their own language and never translated, so a reader who has landed in
// the wrong language can still find their way out. Not a t() lookup: these are identical in every
// catalog, and `satisfies` makes a newly supported locale a compile error here instead of a blank label.
const LANGUAGE_NAMES = {
  en: 'English',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский'
} as const satisfies Record<Locale, string>

// Only the 'System' option follows the interface language. Order puts 'System' first, then the
// locales in LOCALES order.
const useOptions = (): { value: LanguagePreference; label: string; description?: string }[] => {
  const { t } = useTranslation()

  return LANGUAGE_PREFERENCES.map((value) =>
    value === 'system'
      ? {
          value,
          label: t('System', { context: 'language' }),
          description: t('Match your device')
        }
      : { value, label: LANGUAGE_NAMES[value] }
  )
}

// Language picker for Settings > Appearance. A Select rather than a segmented control: seven options
// with localized labels overflow the row width the theme control fits into.
export const LanguageSelect = (): React.JSX.Element => {
  const { t } = useTranslation()
  const preference = useLocaleStore((state) => state.preference)
  const setPreference = useLocaleStore((state) => state.setPreference)
  const options = useOptions()
  const active = options.find((option) => option.value === preference) ?? options[0]

  return (
    <Select
      value={preference}
      onValueChange={(value) => setPreference(value as LanguagePreference)}
    >
      <SelectTrigger aria-label={t('Interface language')}>
        <span>{active.label}</span>
      </SelectTrigger>
      <SelectContent>
        {options.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type LanguagePreferenceMenuProps = {
  className?: string
}

// Compact icon button for the home header, sized to match the neighboring theme / GitHub / settings
// actions. The trigger is a single glyph (unlike the theme menu, whose icon encodes the current
// choice) because a language has no natural icon; the active choice is shown by the check in the list.
export const LanguagePreferenceMenu = ({
  className
}: LanguagePreferenceMenuProps): React.JSX.Element => {
  const { t } = useTranslation()
  const preference = useLocaleStore((state) => state.preference)
  const setPreference = useLocaleStore((state) => state.setPreference)
  const options = useOptions()
  const active = options.find((option) => option.value === preference) ?? options[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${t('Language')}: ${active.label}`}
          title={`${t('Language')}: ${active.label}`}
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-lg text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000',
            className
          )}
        >
          <Languages className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t('Language')}</DropdownMenuLabel>
        {options.map(({ value, label, description }) => (
          <DropdownMenuItem key={value} onSelect={() => setPreference(value)} className="gap-2">
            <span className="flex-1">
              <span className="block leading-tight">{label}</span>
              {description ? (
                <span className="block text-xs leading-tight text-muted-foreground">
                  {description}
                </span>
              ) : null}
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
