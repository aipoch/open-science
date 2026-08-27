/*
 * Hallmark · modern-minimal · quiet utility · palette: existing semantic theme
 * Macrostructure: integrated in-flow side panel · pre-emit critique: P5 H5 E4 S5 R5 V4
 */
import { PresentedAgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { useSmoothStreamingContent } from '@/components/streamdown/use-smooth-streaming-content'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ArrowUp, MapPin, MessageCircleMore, Plus, Quote, Square, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  parseSideChatAnnotationText,
  type ParsedSideChatAnnotationText
} from '../../../../shared/annotations'

import { ResizableBottomPanel } from './ResizableBottomPanel'
import type { SideChatEntry, SideChatView } from './use-side-chat-controller'

type SideChatPanelProps = Readonly<{
  view: SideChatView
  onSend: (text: string) => Promise<boolean>
  onDraftChange: (value: SetStateAction<string>) => void
  onCancel: () => void
  onClose: () => void
  controls?: ReactNode
}>

type SideChatMessageEntry = Extract<SideChatEntry, { kind: 'message' }>

type SideChatPresentationState = Readonly<{
  generation: number
  entryIds: Set<string>
}>

type VisibleSideChatEntrySnapshot = Readonly<{
  generation: number | undefined
  entryIds: Set<string>
}>

const VisibleSideChatEntrySnapshotCommit = ({
  generation,
  entryIdsKey,
  onCommit
}: {
  generation: number
  entryIdsKey: string
  onCommit: (generation: number, entryIds: Set<string>) => void
}): null => {
  useLayoutEffect(() => {
    onCommit(generation, new Set(JSON.parse(entryIdsKey)))
  }, [entryIdsKey, generation, onCommit])
  return null
}

const SideChatAssistantMessage = ({
  entry,
  sourceOpen,
  animateOnMount,
  onPresentationChange
}: {
  entry: SideChatMessageEntry
  sourceOpen: boolean
  animateOnMount: boolean
  onPresentationChange: (entryId: string, presenting: boolean) => void
}): React.JSX.Element => {
  const presentation = useSmoothStreamingContent(entry.text, sourceOpen, animateOnMount)

  useLayoutEffect(() => {
    onPresentationChange(entry.id, presentation.isPresenting)
    return () => onPresentationChange(entry.id, false)
  }, [entry.id, onPresentationChange, presentation.isPresenting])

  return (
    <PresentedAgentMarkdown
      content={presentation.content}
      isAnimating={presentation.isPresenting}
      sessionLinks
    />
  )
}

const SideChatUserMessage = ({ text }: { text: string }): React.JSX.Element => {
  const { t } = useTranslation()
  const parsed = parseSideChatAnnotationText(text)
  if (!parsed) {
    return (
      <div data-side-chat-raw-message="true" className="whitespace-pre-wrap break-words">
        {text}
      </div>
    )
  }

  return (
    <>
      {parsed.text ? <div className="whitespace-pre-wrap break-words">{parsed.text}</div> : null}
      <section
        className={parsed.text ? 'mt-2 space-y-2' : 'space-y-2'}
        aria-label={t('Sent annotations')}
      >
        {parsed.items.map((item, index) => (
          <SideChatAnnotationCard
            key={index}
            item={item}
            number={
              item.type === 'image-point'
                ? parsed.items
                    .slice(0, index + 1)
                    .filter((candidate) => candidate.type === 'image-point').length
                : index + 1
            }
          />
        ))}
      </section>
    </>
  )
}

const SideChatAnnotationCard = ({
  item,
  number
}: {
  item: ParsedSideChatAnnotationText['items'][number]
  number: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const imagePoint = item.type === 'image-point'
  const source = imagePoint
    ? item.source.kind === 'artifact-version'
      ? `${item.source.name} · ${item.source.artifactId} · ${item.source.versionId}`
      : `${item.source.name} · ${item.source.versionId}`
    : undefined
  return (
    <article
      data-side-chat-annotation-card="true"
      className="rounded-lg border border-border/70 bg-background/70 p-2"
    >
      <div className="flex items-center gap-1 text-xs font-semibold">
        {imagePoint ? (
          <MapPin className="size-3" aria-hidden="true" />
        ) : (
          <Quote className="size-3" aria-hidden="true" />
        )}
        {imagePoint ? t('Image point {{number}}', { number }) : t('Text quote')}
      </div>
      <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-2 text-xs">
        {imagePoint
          ? t('Point {{number}} at {{x}}, {{y}}', { number, x: item.x, y: item.y })
          : item.content}
      </blockquote>
      {source ? (
        <div className="mt-1 break-all text-[11px] opacity-70">
          {t('Source: {{source}}', { source })}
        </div>
      ) : null}
      {item.instruction ? <div className="mt-1 text-xs">{item.instruction}</div> : null}
    </article>
  )
}

const SideChatPanel = ({
  view,
  onSend,
  onDraftChange,
  onCancel,
  onClose,
  controls
}: SideChatPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const followUpRef = useRef<HTMLTextAreaElement>(null)
  const [presentationState, setPresentationState] = useState<SideChatPresentationState>(() => ({
    generation: view.generation,
    entryIds: new Set()
  }))
  const [visibleEntrySnapshot, setVisibleEntrySnapshot] = useState<VisibleSideChatEntrySnapshot>(
    () => ({ generation: undefined, entryIds: new Set() })
  )
  const generationRemainedVisible = visibleEntrySnapshot.generation === view.generation
  const lastUserEntryIndex = view.entries.findLastIndex(
    (entry) => entry.kind === 'message' && entry.role === 'user'
  )
  const lastUserEntryId = lastUserEntryIndex >= 0 ? view.entries[lastUserEntryIndex]?.id : undefined
  const liveTurnUserId = view.liveTurnUserEntryId ?? (view.running ? lastUserEntryId : undefined)
  const presentingEntryIds =
    presentationState.generation === view.generation
      ? presentationState.entryIds
      : new Set<string>()
  const presentationBarrierIndex = view.entries.findIndex((entry) =>
    presentingEntryIds.has(entry.id)
  )
  const visibleEntryIds = (
    presentationBarrierIndex >= 0
      ? view.entries.slice(0, presentationBarrierIndex + 1)
      : view.entries
  ).map((entry) => entry.id)
  const visibleEntryIdsKey = JSON.stringify(visibleEntryIds)
  const handleVisibleEntrySnapshotCommit = useCallback(
    (generation: number, entryIds: Set<string>): void => {
      setVisibleEntrySnapshot({ generation, entryIds })
    },
    []
  )
  const handlePresentationChange = useCallback(
    (entryId: string, presenting: boolean): void => {
      setPresentationState((currentState) => {
        const currentEntryIds =
          currentState.generation === view.generation ? currentState.entryIds : new Set<string>()
        if (currentEntryIds.has(entryId) === presenting) return currentState

        const nextEntryIds = new Set(currentEntryIds)
        if (presenting) nextEntryIds.add(entryId)
        else nextEntryIds.delete(entryId)
        return { generation: view.generation, entryIds: nextEntryIds }
      })
    },
    [view.generation]
  )

  useEffect(() => {
    const messageScroll = messageScrollRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (messageScroll) messageScroll.scrollTop = messageScroll.scrollHeight
  }, [presentationBarrierIndex, view.entries, view.running, view.error])
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
      ariaLabel={t('Resize Side chat panel')}
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
          <span className="text-[13px] font-medium text-text-100">{t('Side chat')}</span>
          <div className="flex-1" />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-md text-text-300 transition-colors duration-150 hover:bg-bg-200 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-bg-300 motion-reduce:transition-none"
                  aria-label={t('Close Side chat')}
                  onClick={onClose}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('Close Side chat')}</TooltipContent>
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
              <VisibleSideChatEntrySnapshotCommit
                generation={view.generation}
                entryIdsKey={visibleEntryIdsKey}
                onCommit={handleVisibleEntrySnapshotCommit}
              />
              {view.entries.map((entry, entryIndex) => {
                if (presentationBarrierIndex >= 0 && entryIndex > presentationBarrierIndex) {
                  return null
                }
                if (entry.kind === 'tool') {
                  return (
                    <div
                      key={JSON.stringify([view.generation, entry.id])}
                      className="my-2 text-[12px] text-text-300"
                    >
                      {entry.title}
                      {entry.status ? ` · ${entry.status}` : ''}
                    </div>
                  )
                }
                if (entry.role === 'user') {
                  return (
                    <div
                      key={JSON.stringify([view.generation, entry.id])}
                      className="my-3 flex justify-end"
                    >
                      <div className="max-w-[80%] rounded-2xl bg-bg-200 px-3 py-2 text-text-000">
                        <SideChatUserMessage text={entry.text} />
                      </div>
                    </div>
                  )
                }

                const belongsToLiveTurn =
                  lastUserEntryId === liveTurnUserId && entryIndex > lastUserEntryIndex
                const sourceOpen =
                  belongsToLiveTurn && view.running && entryIndex === view.entries.length - 1
                const animateOnMount =
                  sourceOpen &&
                  generationRemainedVisible &&
                  !visibleEntrySnapshot.entryIds.has(entry.id)
                return (
                  <div
                    key={JSON.stringify([view.generation, entry.id])}
                    className="my-3 min-w-0 text-text-000"
                  >
                    <SideChatAssistantMessage
                      entry={entry}
                      sourceOpen={sourceOpen}
                      animateOnMount={animateOnMount}
                      onPresentationChange={handlePresentationChange}
                    />
                  </div>
                )
              })}
              {view.running && presentationBarrierIndex < 0 ? (
                <div className="py-2 text-text-300">{t('Thinking…')}</div>
              ) : null}
              {view.error && presentationBarrierIndex < 0 ? (
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
            placeholder={t('Follow up…')}
            aria-label={t('Side chat follow up')}
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
                    aria-label={t('Add to Side chat')}
                    data-testid="side-chat-plus-button"
                    className="grid size-8 shrink-0 cursor-not-allowed place-items-center rounded-md text-text-300 opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={(event) => event.preventDefault()}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('Attachments are unavailable in Side chat')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {controls}
            <div className="flex-1" />
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
                      view.running ? t('Cancel Side chat response') : t('Send Side chat follow up')
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
                  {view.running ? t('Cancel response') : t('Send follow up')}
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
