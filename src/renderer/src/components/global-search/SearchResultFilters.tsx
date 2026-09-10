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
  scope,
  canScopeToProject,
  sort,
  days,
  subtype,
  onScope,
  onSort,
  onDays,
  onSubtype
}: {
  category: SearchCategory | 'all'
  scope: 'all' | 'current'
  canScopeToProject: boolean
  sort: SearchSort
  days: number
  subtype: string
  onScope: (value: string) => void
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
    <div className="search-subfilters">
      <Select value={scope} onValueChange={onScope}>
        <SelectTrigger
          aria-label={t('Search scope')}
          className="search-scope-select w-auto min-w-0 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('All projects and Library')}</SelectItem>
          {canScopeToProject && <SelectItem value="current">{t('Current project')}</SelectItem>}
        </SelectContent>
      </Select>
      <Select value={sort} onValueChange={(value) => onSort(value as SearchSort)}>
        <SelectTrigger aria-label={t('Result order')} className="w-auto min-w-0 max-w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="relevance">{t('Relevance within categories')}</SelectItem>
          <SelectItem value="recent">{t('Recently updated')}</SelectItem>
        </SelectContent>
      </Select>
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
  )
}
