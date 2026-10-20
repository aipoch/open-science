import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import type { ElicitationField } from '../../../../shared/elicitation'

export const ChoiceKindChip = ({
  kind
}: {
  kind: ElicitationField['kind'] | undefined
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (kind !== undefined && kind !== 'single-select' && kind !== 'multi-select') return null
  return (
    <Badge
      variant="outline"
      data-testid="choice-kind-chip"
      className="h-[22px] shrink-0 rounded-md border-primary/15 bg-primary/10 px-1.5 py-0 text-[11px] font-semibold leading-5 text-primary"
    >
      {kind === 'multi-select' ? t('Multi select') : t('Single select')}
    </Badge>
  )
}
