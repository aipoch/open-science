/*
 * Hallmark · modern-minimal · quiet utility · palette: existing semantic theme
 * Macrostructure: integrated in-flow side panel · pre-emit critique: P5 H5 E4 S5 R5 V4
 */
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ArrowUp, MessageCircleMore, Plus, Square, X } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react'

import { ComposerModelPicker } from './ComposerModelPicker'
import { ResizableBottomPanel } from './ResizableBottomPanel'
import type { SideChatView } from './use-side-chat-controller'

type SideChatPanelProps = Readonly<{
  view: SideChatView
  onSend: (text: string) => Promise<boolean>
  onDraftChange: (value: SetStateAction<string>) => void
  onCancel: () => void
  onClose: () => void
  controls?: ReactNode
}>

const SideChatPanel = ({
  view,
  onSend,
  onDraftChange,
  onCancel,
  onClose,
  controls
}: SideChatPanelProps): React.JSX.Element => {
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const followUpRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const messageScroll = messageScrollRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (messageScroll) messageScroll.scrollTop = messageScroll.scrollHeight
  }, [view.entries, view.running, view.error])
  useEffect(() => {
    if (view.sideSessionId) followUpRef.current?.focus()
  }, [view.sideSessionId])

  const submit = (): void => {
    const text = view.draft.trim()
    if (!text || view.running || !view.sideSessionId) return
    onDraftChange('')
    void onSend(text).then((sent) => {
      if (!sent) onDraftChange((current) => current || text)
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <ResizableBottomPanel
      ariaLabel="Resize Side chat panel"
      testId="side-chat-panel"
      scrollTestId="side-chat-panel-scroll"
      variant="integrated"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          data-testid="side-chat-header"
          className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border-200 bg-bg-000 px-4 pt-1"
        >
          <MessageCircleMore className="size-4 text-text-300" aria-hidden="true" />
          <span className="text-[13px] font-medium text-text-100">Side chat</span>
          <div className="flex-1" />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-md text-text-300 transition-colors duration-150 hover:bg-bg-200 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-bg-300 motion-reduce:transition-none"
                  aria-label="Close Side chat"
                  onClick={onClose}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Close Side chat</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div
          data-testid="side-chat-message-viewport"
          className="relative min-h-0 flex-1 overflow-hidden"
        >
          <ScrollArea
            ref={messageScrollRef}
            data-testid="side-chat-message-scroll"
            className="h-full overscroll-contain text-[14px] leading-6"
          >
            <div className="px-5 py-4">
              {view.entries.map((entry) =>
                entry.kind === 'tool' ? (
                  <div key={entry.id} className="my-2 text-[12px] text-text-300">
                    {entry.title}
                    {entry.status ? ` · ${entry.status}` : ''}
                  </div>
                ) : entry.role === 'user' ? (
                  <div key={entry.id} className="my-3 flex justify-end">
                    <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-bg-200 px-3 py-2 text-text-000">
                      {entry.text}
                    </div>
                  </div>
                ) : (
                  <div key={entry.id} className="my-3 min-w-0 text-text-000">
                    <AgentMarkdown content={entry.text} isAnimating={view.running} />
                  </div>
                )
              )}
              {view.running ? <div className="py-2 text-text-300">Thinking…</div> : null}
              {view.error ? (
                <div role="alert" className="py-2 text-[12px] text-danger-000">
                  {view.error}
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <div
            data-testid="side-chat-message-fade-top"
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-5 bg-gradient-to-b from-bg-000 to-bg-000/0"
          />
          <div
            data-testid="side-chat-message-fade-bottom"
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-7 bg-gradient-to-t from-bg-000 to-bg-000/0"
          />
        </div>
        <div
          data-testid="side-chat-composer"
          className="relative z-20 flex shrink-0 flex-col gap-2 border-t border-border-200 bg-bg-000 px-4 py-3"
        >
          <Textarea
            ref={followUpRef}
            rows={1}
            value={view.draft}
            placeholder="Follow up…"
            aria-label="Side chat follow up"
            className="max-h-28 min-h-8 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-1 text-[15px] leading-6 text-text-000 shadow-none placeholder:text-text-300 focus-visible:border-transparent"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex items-center gap-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-disabled="true"
                    aria-label="Add to Side chat"
                    data-testid="side-chat-plus-button"
                    className="grid size-8 shrink-0 cursor-not-allowed place-items-center rounded-md text-text-300 opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={(event) => event.preventDefault()}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Attachments are unavailable in Side chat</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {controls}
            <div className="flex-1" />
            <ComposerModelPicker />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-colors duration-150 hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary motion-reduce:transition-none motion-reduce:active:translate-y-0"
                    disabled={
                      view.running ? !view.sideSessionId : !view.draft.trim() || !view.sideSessionId
                    }
                    aria-label={
                      view.running ? 'Cancel Side chat response' : 'Send Side chat follow up'
                    }
                    onClick={view.running ? onCancel : submit}
                  >
                    {view.running ? (
                      <Square className="size-3.5" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {view.running ? 'Cancel response' : 'Send follow up'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </ResizableBottomPanel>
  )
}

export { SideChatPanel }
