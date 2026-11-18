import { AtSign, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ActionToast } from '@/components/ActionToast'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProjectFileMentionTarget } from './project-file-mention'
import { useProjectFileMentionAction } from './use-project-file-mention-action'

export const ProjectFileMentionButton = ({
  target,
  tooltipClassName,
  onMentioned
}: {
  target: ProjectFileMentionTarget
  tooltipClassName?: string
  onMentioned?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const mention = useProjectFileMentionAction(target)
  const label = t('Mention {{name}}', { name: target.name })
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-text-000 hover:text-text-000"
            aria-label={label}
            disabled={!mention.available || mention.pending}
            aria-busy={mention.pending}
            onClick={() => {
              void mention.mention().then((mentioned) => {
                if (mentioned) onMentioned?.()
              })
            }}
          >
            {mention.pending ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <AtSign aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent className={tooltipClassName}>{label}</TooltipContent>
      </Tooltip>
      {mention.error ? (
        <ActionToast
          title={t('Could not resolve file version.')}
          dismissLabel={t('Dismiss')}
          onDismiss={mention.dismissError}
        />
      ) : null}
    </TooltipProvider>
  )
}
