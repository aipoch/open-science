/* Hallmark · component: rule summary · genre: modern-minimal · theme: existing shadcn
 * Pre-emit critique: Philosophy 4 · Hierarchy 5 · Execution 4 · Specificity 5 · Restraint 5 · Variety 4
 */
import { useState } from 'react'
import { Check, Minus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseSmartRule } from './smart-rule-fields'

export function SmartRuleSummary({
  rule,
  compact = false
}: {
  rule: string
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const fields = parseSmartRule(rule)
  const [expanded, setExpanded] = useState(false)
  const shorten = (text: string): string =>
    compact && !expanded && text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text
  const hasLongText = fields && Object.values(fields).some((text) => text.length > 80)
  if (!fields) return <p className="whitespace-pre-wrap break-words text-sm leading-6">{rule}</p>
  return (
    <div className="min-w-0 space-y-4">
      {fields.description && (
        <p className="whitespace-pre-wrap break-words text-sm leading-6">
          {shorten(fields.description)}
        </p>
      )}
      <dl
        className={
          compact
            ? 'grid min-w-0 grid-cols-1 gap-3'
            : 'grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6'
        }
      >
        <div className="min-w-0 border-t border-border pt-3">
          <dt className="flex items-center gap-2 text-xs font-medium">
            <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {t('Inclusion criteria')}
          </dt>
          <dd className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
            {shorten(fields.inclusion)}
          </dd>
        </div>
        {fields.exclusion && (
          <div className="min-w-0 border-t border-border pt-3">
            <dt className="flex items-center gap-2 text-xs font-medium">
              <Minus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {t('Exclusion criteria')}
            </dt>
            <dd className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
              {shorten(fields.exclusion)}
            </dd>
          </div>
        )}
      </dl>
      {compact && hasLongText && (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('Show less') : t('Show more')}
        </button>
      )}
    </div>
  )
}
