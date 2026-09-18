import { type PropsWithChildren } from 'react'
import { useTranslation } from 'react-i18next'
import { useSideChatTransfers } from '../use-side-chat-controller'
import { useAnnotationDrop } from './use-annotation-drop'

export function SideChatAnnotationDrop({
  chatId,
  parentSessionId,
  projectId,
  children
}: PropsWithChildren<{
  chatId: string
  parentSessionId: string
  projectId: string
}>): React.JSX.Element {
  const { t } = useTranslation()
  const targets = useSideChatTransfers()
  const { over, error, props } = useAnnotationDrop({
    targetId: `side-chat:${chatId}`,
    projectId,
    parentSessionId,
    receive: (transfer) => targets.receive(chatId, transfer)
  })
  return (
    <div
      data-testid="side-chat-annotation-drop"
      className={over ? 'rounded-md ring-2 ring-primary bg-primary/5' : undefined}
      {...props}
    >
      {over ? (
        <div className="px-2 py-1 text-xs text-text-200">{t('Add to this Side chat')}</div>
      ) : null}
      {children}
      {error ? (
        <p role="alert" className="px-2 text-xs text-danger-000">
          {t('Could not move this annotation. It may have changed or the target is full.')}
        </p>
      ) : null}
    </div>
  )
}
