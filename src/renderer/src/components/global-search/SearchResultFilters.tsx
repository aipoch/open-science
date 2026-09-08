import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { SearchSort } from '../../../../shared/search-text'
import type { SearchCategory } from './search-result'

export const SearchResultFilters = ({
  category,
  sort,
  days,
  subtype,
  total,
  shown,
  loading,
  onSort,
  onDays,
  onSubtype
}: {
  category: SearchCategory | 'all'
  sort: SearchSort
  days: number
  subtype: string
  total: number
  shown: number
  loading: boolean
  onSort: (value: SearchSort) => void
  onDays: (value: number) => void
  onSubtype: (value: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const options =
    category === 'messages'
      ? [
          ['all', t('All senders')],
          ['user', t('Sent by me')],
          ['agent', t('Sent by agents')]
        ]
      : category === 'uploads' || category === 'generated'
        ? [
            ['all', t('All formats')],
            ['pdf', 'PDF'],
            ['spreadsheet', t('Spreadsheets / CSV')],
            ['notebook', 'Notebook'],
            ['image', t('Images')]
          ]
        : category === 'library'
          ? [
              ['all', t('All entries')],
              ['paper', t('Literature')],
              ['collection', t('Collections')],
              ['pdf', t('With PDF')]
            ]
          : []
  return (
    <>
      <div className="search-list-toolbar">
        <span aria-live="polite">
          {loading ? t('Loading…') : t('{{total}} results · {{shown}} shown', { total, shown })}
        </span>
        <Select value={sort} onValueChange={(value) => onSort(value as SearchSort)}>
          <SelectTrigger
            aria-label={t('Result order')}
            className="w-auto min-w-0 max-w-full text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="relevance">{t('Relevance within categories')}</SelectItem>
            <SelectItem value="recent">{t('Recently updated')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="search-subfilters">
        <Select value={String(days)} onValueChange={(value) => onDays(Number(value))}>
          <SelectTrigger aria-label={t('Time range')} className="w-auto max-w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t('Any time')}</SelectItem>
            <SelectItem value="7">{t('Last 7 days')}</SelectItem>
            <SelectItem value="30">{t('Last 30 days')}</SelectItem>
          </SelectContent>
        </Select>
        {options.length > 0 && (
          <Select value={subtype} onValueChange={onSubtype}>
            <SelectTrigger aria-label={t('Refine category')} className="w-auto max-w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </>
  )
}
