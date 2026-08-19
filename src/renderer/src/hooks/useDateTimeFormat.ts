import { useCallback } from 'react'

import { formatDateTime, formatRelativeTime, type DateTimeStyleName } from '@/lib/format-datetime'
import { useLocaleStore } from '@/stores/locale-store'

// Formats absolute timestamps in the interface language, re-rendering the caller when the language
// changes. Subscribes to the locale store rather than reading i18next's language directly: the store
// is the value that drives <html lang> and the catalogs, so a component using this stays in step with
// the prose beside it.
export const useDateTimeFormat = (): ((
  value: Date | number | string,
  style?: DateTimeStyleName
) => string) => {
  const locale = useLocaleStore((state) => state.locale)

  return useCallback(
    (value: Date | number | string, style?: DateTimeStyleName) =>
      formatDateTime(value, locale, style),
    [locale]
  )
}

// Same contract as useDateTimeFormat for relative stamps ("3 minutes ago"): the time value follows
// the interface language via Intl while the surrounding prose goes through i18next.
export const useRelativeTimeFormat = (): ((
  value: Date | number | string,
  now?: Date | number | string
) => string) => {
  const locale = useLocaleStore((state) => state.locale)

  return useCallback(
    (value: Date | number | string, now?: Date | number | string) =>
      formatRelativeTime(value, locale, now),
    [locale]
  )
}
