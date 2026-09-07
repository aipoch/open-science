import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'

const SEARCH_DEBOUNCE_MS = 300

const LiteratureSearchInput = ({
  initialValue,
  onCommit,
  onDraftChange
}: Readonly<{
  initialValue: string
  onCommit: (value: string) => void
  onDraftChange: () => void
}>): React.JSX.Element => {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(initialValue)
  const committedRef = useRef(initialValue)

  useEffect(() => {
    if (draft === committedRef.current) return
    const timeout = window.setTimeout(() => {
      committedRef.current = draft
      onCommit(draft)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [draft, onCommit])

  return (
    <label className="relative block min-w-0 flex-1 sm:w-80 sm:flex-none">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          onDraftChange()
        }}
        placeholder={t('Search references')}
        aria-label={t('Search references')}
        className="pl-9"
      />
    </label>
  )
}

export { LiteratureSearchInput }
