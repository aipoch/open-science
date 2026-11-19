import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { sanitizeToolDetailText } from '../../../../shared/tool-detail-sanitizer'

export const WorkspaceWebActivityDetails = ({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <details className="group/web-details space-y-2 border-t border-border-200 pt-1">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded py-1 pr-1 text-text-100 hover:text-text-000 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 group-open/web-details:rotate-90"
          aria-hidden="true"
        />
        {t('Details')}
      </summary>
      {children}
    </details>
  )
}

export const WorkspaceWebActivityFact = ({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element => (
  <div className="min-w-0">
    <dt className="text-text-100">{label}</dt>
    <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {typeof children === 'string' ? sanitizeToolDetailText(children) : children}
    </dd>
  </div>
)
