import { ChevronDown, Maximize2, MessageSquare, Minimize2 } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { ComposerModelPicker } from './ComposerModelPicker'
import { SideChatPanel } from './SideChatPanel'
import { useSideChatController } from './use-side-chat-controller'

export function SideChatWorkbenchContent({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const informationTitleId = useId()
  const expanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
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
      headerTitle={
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              disabled={!parent}
              className="min-w-0 max-w-full justify-start gap-1.5 px-2 text-[13px] font-semibold"
              aria-label={t('Session information: {{title}}', { title: t('Side chat') })}
            >
              <span className="truncate">{t('Side chat')}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={8}
            collisionPadding={12}
            aria-labelledby={informationTitleId}
            className="w-[min(360px,calc(100vw-1.5rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-menu"
          >
            <h2 id={informationTitleId} className="break-words text-sm font-semibold">
              {parent?.title}
            </h2>
            {parent?.description?.trim() ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {parent.description}
              </p>
            ) : null}
          </PopoverContent>
        </Popover>
      }
      headerAction={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('View main session')}
                disabled={!parent || !item.projectId}
                onClick={() => {
                  if (item.projectId) {
                    usePreviewWorkbenchStore.getState().setToolItemExpanded(null)
                    useNavigationStore
                      .getState()
                      .openSession(item.projectId, item.sessionId, 'user')
                  }
                }}
              >
                <MessageSquare className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              {t('View main session')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              asChild
              onFocus={(event) => {
                if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
              }}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={expanded ? t('Exit full screen') : t('Enter full screen')}
                onClick={() =>
                  usePreviewWorkbenchStore.getState().setToolItemExpanded(expanded ? null : item.id)
                }
              >
                {expanded ? (
                  <Minimize2 className="size-4" aria-hidden="true" />
                ) : (
                  <Maximize2 className="size-4" aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              {expanded ? t('Exit full screen') : t('Enter full screen')}
            </TooltipContent>
          </Tooltip>
        </>
      }
      controls={
        <ComposerModelPicker
          configuration={
            chat.view.modelSelection
              ? {
                  ...chat.view.modelSelection,
                  reasoningEffort: chat.view.modelSelection.reasoningEffort ?? 'default'
                }
              : undefined
          }
          unavailable={!chat.view.modelSelection}
          includeAllClaudeSubscriptions
          alwaysShow
          onChange={chat.setModelSelection}
        />
      }
      onSend={chat.send}
      sendDisabledReason={chat.unavailableReason}
      onRetryRestore={chat.retryHydration}
      onDraftChange={chat.setDraft}
      onAnnotationsChange={chat.setAnnotations}
      onCancel={chat.cancel}
      onClose={() => usePreviewWorkbenchStore.getState().removeItem(item.id)}
    />
  )
}
