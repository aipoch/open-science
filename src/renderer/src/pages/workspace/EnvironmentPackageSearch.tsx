import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'

// Keep keystrokes local: updating the parent also renders the inventory and Provenance sections.
export const EnvironmentPackageSearch = ({
  initialQuery,
  onSearch
}: {
  initialQuery: string
  onSearch: (query: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [query, setQuery] = useState(initialQuery)
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    if (composing || query === initialQuery) return
    if (!query.trim()) {
      onSearch(query)
      return
    }
    const timer = window.setTimeout(() => onSearch(query), 250)
    return () => window.clearTimeout(timer)
  }, [query, initialQuery, composing, onSearch])

  return (
    <Input
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={(event) => {
        setQuery(event.currentTarget.value)
        setComposing(false)
      }}
      placeholder={t('Search packages')}
      aria-label={t('Search packages')}
      className="h-8 text-xs"
    />
  )
}
