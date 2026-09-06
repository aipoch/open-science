import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import type { YearFilterState } from './useLiteratureYearFilter'

const LiteratureYearFilter = ({
  draftFrom,
  draftTo,
  invalid,
  setDraftFrom,
  setDraftTo
}: YearFilterState): React.JSX.Element => {
  const { t } = useTranslation()
  const errorId = useId()

  return (
    <div className="grid grid-cols-2 gap-2">
      <Input
        inputMode="numeric"
        value={draftFrom}
        onChange={(event) => setDraftFrom(event.target.value)}
        placeholder={t('From year')}
        aria-label={t('From year')}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
      />
      <Input
        inputMode="numeric"
        value={draftTo}
        onChange={(event) => setDraftTo(event.target.value)}
        placeholder={t('To year')}
        aria-label={t('To year')}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
      />
      {invalid ? (
        <p id={errorId} role="status" className="col-span-2 text-xs text-destructive">
          {t('Enter a valid year range (0–9999).')}
        </p>
      ) : null}
    </div>
  )
}

export { LiteratureYearFilter }
