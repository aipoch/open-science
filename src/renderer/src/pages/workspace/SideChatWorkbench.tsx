import { MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { SideChatPanel } from './SideChatPanel'
import { useSideChatController } from './use-side-chat-controller'

export function SideChatWorkbenchContent({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const parent = useSessionStore((state) =>
    state.sessions.find((session) => session.id === item.sessionId)
  )
  const chat = useSideChatController(
    item.projectId ? { projectId: item.projectId, sessionId: item.sessionId } : undefined,
    item.sideChatId
  )
  if (!chat.view) return null
  return (
    <SideChatPanel
      view={chat.view}
      headerAction={
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('View main session')}
                disabled={!parent || !item.projectId}
                className="grid size-7 place-items-center rounded-md bg-black text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                onClick={() => {
                  if (item.projectId)
                    useNavigationStore
                      .getState()
                      .openSession(item.projectId, item.sessionId, 'user')
                }}
              >
                <MessageSquare className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-72 space-y-1 p-3">
              <div className="text-[11px] opacity-70">{t('View main session')}</div>
              {parent?.title ? (
                <div className="line-clamp-2 font-medium">{parent.title}</div>
              ) : null}
              {parent?.description?.trim() ? (
                <div className="line-clamp-2 opacity-80">{parent.description}</div>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      }
      onSend={chat.send}
      onDraftChange={chat.setDraft}
      onAnnotationsChange={chat.setAnnotations}
      onCancel={chat.cancel}
      onClose={() => usePreviewWorkbenchStore.getState().removeItem(item.id)}
    />
  )
}
