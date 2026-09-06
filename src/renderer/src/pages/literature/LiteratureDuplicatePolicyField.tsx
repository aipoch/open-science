import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  literatureDuplicatePolicySchema,
  type LiteratureDuplicatePolicy
} from '../../../../shared/literature'

export function LiteratureDuplicatePolicyField({
  value,
  onChange,
  disabled
}: {
  value: LiteratureDuplicatePolicy
  onChange: (value: LiteratureDuplicatePolicy) => void
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {t('When identifiers match')}
      </label>
      <Select
        value={value}
        onValueChange={(next) => onChange(literatureDuplicatePolicySchema.parse(next))}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-help`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="reuse">{t('Reuse existing reference')}</SelectItem>
          <SelectItem value="separate">{t('Keep as separate reference')}</SelectItem>
          <SelectItem value="fill-missing">{t('Fill empty fields')}</SelectItem>
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">
        {value === 'reuse'
          ? t('Keep existing metadata and add the reference to this destination.')
          : value === 'separate'
            ? t('Create independent references. Review them later in Duplicates.')
            : t('Fill empty fields only. Existing values and conflicting fields are kept.')}
      </p>
    </div>
  )
}
