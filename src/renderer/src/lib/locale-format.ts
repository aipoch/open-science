import { useLocaleStore } from '@/stores/locale-store'

export const formatDisplayNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(useLocaleStore.getState().locale, options).format(value)

export const formatDisplayDateTime = (value: Date | number): string =>
  new Intl.DateTimeFormat(useLocaleStore.getState().locale, {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(value)
