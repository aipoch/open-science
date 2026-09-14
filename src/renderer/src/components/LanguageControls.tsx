import { useTranslation } from 'react-i18next'

import { ActionToast } from '@/components/ActionToast'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useLocaleStore } from '@/stores/locale-store'
import {
  LANGUAGE_PREFERENCES,
  LOCALE_SELF_NAMES,
  type LanguagePreference
} from '../../../shared/locale'

// Only the 'System' option follows the interface language. Order puts 'System' first, then the
// locales in LOCALES order.
const useOptions = (): { value: LanguagePreference; label: string }[] => {
  const { t } = useTranslation()

  return LANGUAGE_PREFERENCES.map((value) =>
    value === 'system'
      ? {
          value,
          label: t('System', { context: 'language' })
        }
      : { value, label: LOCALE_SELF_NAMES[value] }
  )
}

const LanguageSaveError = ({ className }: { className?: string }): React.JSX.Element | null => {
  const { t } = useTranslation()
  const saveFailed = useLocaleStore((state) => state.saveFailed)
  if (!saveFailed) return null

  return (
    <p role="alert" className={cn('flex items-baseline gap-2 text-xs text-danger-000', className)}>
      <span>
        {t('Could not save the language.')}
        <span className="sr-only">
          {' '}
          {t('The saved language has been restored. Select a language to try again.')}
        </span>
      </span>
      <button
        type="button"
        className="shrink-0 underline underline-offset-2 focus-visible:outline-auto"
        onClick={() => useLocaleStore.setState({ saveFailed: false })}
      >
        {t('Dismiss')}
      </button>
    </p>
  )
}

// Language picker for Settings > Appearance. A Select rather than a segmented control: ten options
// with localized labels overflow the row width the theme control fits into.
export const LanguageSelect = (): React.JSX.Element => {
  const { t } = useTranslation()
  const preference = useLocaleStore((state) => state.preference)
  const setPreference = useLocaleStore((state) => state.setPreference)
  const options = useOptions()
  const active = options.find((option) => option.value === preference) ?? options[0]

  return (
    <div className="min-w-0">
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
      <LanguageSaveError className="mt-2" />
    </div>
  )
}

// The shared failure survives the Settings picker, including a rejection delivered after close.
export const LanguageSaveToast = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const saveFailed = useLocaleStore((state) => state.saveFailed)
  if (!saveFailed) return null

  return (
    <ActionToast
      title={`${t('Could not save the language.')} ${t('The saved language has been restored. Select a language to try again.')}`}
      dismissLabel={t('Dismiss')}
      onDismiss={() => useLocaleStore.setState({ saveFailed: false })}
      testId="language-save-error-toast"
    />
  )
}
