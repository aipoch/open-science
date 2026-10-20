import { Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'

const SEARCH_DEBOUNCE_MS = 300

const LiteratureSearchInput = ({
  initialValue,
  resetRevision,
  onCommit,
  onDraftChange
}: Readonly<{
  initialValue: string
  resetRevision: number
  onCommit: (value: string) => void
  onDraftChange: () => void
}>): React.JSX.Element => {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(initialValue)
  const [isComposing, setIsComposing] = useState(false)
  const committedRef = useRef(initialValue)
  const resetRevisionRef = useRef(resetRevision)

  useLayoutEffect(() => {
    if (resetRevisionRef.current === resetRevision) return
    resetRevisionRef.current = resetRevision
    committedRef.current = initialValue
    setDraft(initialValue)
  }, [initialValue, resetRevision])

  const updateDraft = (value: string): void => {
    if (value === draft) return
    setDraft(value)
    onDraftChange()
  }

  useEffect(() => {
    if (isComposing || draft === committedRef.current) return
    const timeout = window.setTimeout(() => {
      committedRef.current = draft
      onCommit(draft)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [draft, isComposing, onCommit, resetRevision])

  return (
    <label className="relative block min-w-0 flex-1 sm:w-80 sm:flex-none">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={draft}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={(event) => {
          updateDraft(event.currentTarget.value)
          setIsComposing(false)
        }}
        onChange={(event) => updateDraft(event.target.value)}
        placeholder={t('Search references')}
        aria-label={t('Search references')}
        className="pl-9"
      />
    </label>
  )
}

export { LiteratureSearchInput }
