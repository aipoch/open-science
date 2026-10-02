import { ArrowUpRight, CheckCircle2, CircleSlash, CircleX } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { SubagentCompletionProjection } from './subagent-release-projection'

const WorkspaceSubagentCompletionRow = ({
  completion,
  onOpenSource
}: {
  completion: SubagentCompletionProjection
  onOpenSource: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const name = completion.name ?? t('Subagent')
  const heading =
    completion.status === 'completed'
      ? completion.name
        ? t('Subagent {{name}} completed', { name })
        : t('Subagent completed')
      : completion.status === 'error'
        ? completion.name
          ? t('Subagent {{name}} failed', { name })
          : t('Subagent failed')
        : completion.name
          ? t('Subagent {{name}} cancelled', { name })
          : t('Subagent cancelled')
  const Icon =
    completion.status === 'completed'
      ? CheckCircle2
      : completion.status === 'error'
        ? CircleX
        : CircleSlash
  const tone =
    completion.status === 'completed'
      ? 'text-status-success-foreground dark:text-status-success-dark-foreground'
      : completion.status === 'error'
        ? 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
        : 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
  return (
    <div
      data-testid="subagent-completion"
      data-frame-id={completion.frameId}
      data-attempt-id={completion.attemptId}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border-200 bg-bg-100/60 px-3 py-2"
    >
      <Icon className={`size-4 shrink-0 ${tone}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words text-xs text-text-100">{heading}</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={t('Open Subagent preview for {{name}}', { name })}
        onClick={onOpenSource}
      >
        {t('View agent')}
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

export { WorkspaceSubagentCompletionRow }
