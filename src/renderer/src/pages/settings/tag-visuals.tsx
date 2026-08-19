import { useTranslation } from 'react-i18next'

import type { TagView } from '../../../../shared/tags'
import { cn } from '@/lib/utils'
import { TAG_COLORS, TAG_ICONS, tagPresentation } from './tag-presentation'

const TagBadge = ({ tag, className }: { tag: TagView; className?: string }): React.JSX.Element => {
  const { t } = useTranslation()
  const presentation = tagPresentation(tag, t)
  const Icon = TAG_ICONS[presentation.iconKey]
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-40 items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TAG_COLORS[presentation.colorKey],
        className
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate" title={presentation.name}>
        {presentation.name}
      </span>
    </span>
  )
}

export { TagBadge }
