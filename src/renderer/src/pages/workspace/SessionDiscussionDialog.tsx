import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogBodyClassName,
  dialogFooterClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogFormInputClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { SessionMentionPopup } from './composer/SessionMentionPopup'
import { stageSessionDiscussion } from './workspace-discussion-navigation'
import type { SessionDiscussionCapture } from './replay/replay-context'

export const SessionDiscussionDialog = ({
  context,
  onClose
}: {
  context: SessionDiscussionCapture
  onClose: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  const [activeOption, setActiveOption] = useState<string>()
  const listboxId = useId()
  const select = (sessionId?: string): void => {
    const navigation = useNavigationStore.getState()
    const target = sessionId
      ? useSessionStore.getState().sessions.find((row) => row.id === sessionId)
      : undefined
    const projectId = target?.projectId ?? navigation.activeProjectId
    const accepted = projectId && stageSessionDiscussion(context, { projectId, sessionId }, onClose)
    if (!accepted) setError(t('This conversation is unavailable. Choose another conversation.'))
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>
                {t('Ask in a conversation')}
              </Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t('Add to a draft. Send when ready.')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                className={cn(dialogCloseButtonClassName, 'shrink-0 self-start')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className={cn(dialogBodyClassName, 'flex min-h-0 flex-col gap-3 overflow-hidden')}>
            <p
              className="truncate text-sm text-muted-foreground"
              title={`${context.sourceTitle} · ${context.stepTitle ?? ''}`}
            >
              {context.scope === 'session'
                ? t('Entire research')
                : [
                    context.stepNumber ? t('Step {{step}}', { step: context.stepNumber }) : '',
                    context.stepTitle || context.sourceTitle
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </p>
            <Input
              autoFocus
              className={cn(dialogFormInputClassName, 'shrink-0')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search conversations')}
              aria-label={t('Search conversations')}
              role="combobox"
              aria-controls={listboxId}
              aria-expanded
              aria-autocomplete="list"
              aria-activedescendant={activeOption}
            />
            <SessionMentionPopup
              inline
              writableOnly
              excludedSessionId={context.sourceSessionId}
              query={query}
              listboxId={listboxId}
              onActiveOptionIdChange={setActiveOption}
              onSelect={(row) => select(row.sessionId)}
              onClose={onClose}
            />
            {error ? <ErrorNotice inline tone="amber" description={error} /> : null}
          </div>
          <div className={dialogFooterClassName}>
            <Button variant="ghost" className={dialogCancelButtonClassName} onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button variant="outline" onClick={() => select()}>
              {t('New conversation')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
