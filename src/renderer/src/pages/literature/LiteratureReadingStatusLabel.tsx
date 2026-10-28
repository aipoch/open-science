import type { LiteratureReadingStatus } from '@aipoch/literature-library/contracts'
import { Circle, CircleCheck, Contrast } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function LiteratureReadingStatusLabel({
  status = 'unread'
}: {
  status?: LiteratureReadingStatus
}): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = status === 'read' ? CircleCheck : status === 'reading' ? Contrast : Circle
  const color =
    status === 'read'
      ? 'text-status-success-foreground dark:text-status-success-dark-foreground'
      : status === 'reading'
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-muted-foreground'
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${color}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {status === 'read'
        ? t('Read', { context: 'readingStatus' })
        : status === 'reading'
          ? t('Reading', { context: 'readingStatus' })
          : t('Unread')}
    </span>
  )
}
