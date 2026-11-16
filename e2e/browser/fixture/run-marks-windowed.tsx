import '@/assets/main.css'
import { useCallback, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { initI18n } from '@/i18n'
import { WorkspaceRunMarks } from '@/pages/workspace/WorkspaceRunMarks'
import {
  useTranscriptWindow,
  MessageScrollerFollowIntent
} from '@/pages/workspace/use-transcript-window'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton
} from '@/components/ui/message-scroller'
import type { WorkspaceConversationTimelineItem } from '@/pages/workspace/workspace-conversation-timeline'
import type { ToolActivity } from '@/stores/session-store-contract'

initI18n('en')
const params = new URLSearchParams(location.search)
const count = Number(params.get('count') ?? 120)
const items: WorkspaceConversationTimelineItem[] = Array.from({ length: count }, (_, index) => {
  const userMessage: WorkspaceConversationTimelineItem = {
    id: `user-${index}`,
    type: 'message',
    sortIndex: index * 3,
    createdAt: index * 3,
    message: {
      id: `user-${index}`,
      role: 'user',
      content: `Message ${index + 1}`,
      status: 'complete',
      eventIds: [],
      createdAt: index * 3,
      updatedAt: index * 3
    }
  }
  const toolActivity: ToolActivity = {
    id: `tool-${index}`,
    kind: 'tool',
    title: `Inspect history ${index + 1}`,
    status: 'completed',
    eventIds: [],
    sortIndex: index * 3 + 1,
    createdAt: index * 3 + 1,
    updatedAt: index * 3 + 1
  }
  const activityGroup: WorkspaceConversationTimelineItem = {
    id: `activity-group-tool-${index}`,
    type: 'activity-group',
    sortIndex: index * 3 + 1,
    createdAt: index * 3 + 1,
    activities: [toolActivity]
  }
  const agentMessage: WorkspaceConversationTimelineItem = {
    id: `agent-${index}`,
    type: 'message',
    sortIndex: index * 3 + 2,
    createdAt: index * 3 + 2,
    message: {
      id: `agent-${index}`,
      role: 'agent',
      content: `Reply ${index + 1}`,
      status: 'complete',
      eventIds: [],
      createdAt: index * 3 + 2,
      updatedAt: index * 3 + 2
    }
  }
  return [userMessage, activityGroup, agentMessage]
}).flat()
export const App = (): JSX.Element => {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [paused, setPaused] = useState(false)
  const previousTop = useRef(0)
  const ref = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element
    setViewport(element)
  }, [])
  const transcript = useTranscriptWindow('run-navigation', items, -1, viewportRef, paused)
  return (
    <section data-session-id="run-navigation" className="h-screen ps-12 pe-8">
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={64}
      >
        <MessageScrollerFollowIntent active onScrollStateChange={setPaused} />
        <MessageScroller>
          <WorkspaceRunMarks
            items={items}
            viewport={viewport}
            onRevealMessage={transcript.revealMessage}
          />
          <MessageScrollerViewport
            ref={ref}
            aria-label="Conversation"
            onWheel={(event) => {
              if (event.deltaY < 0) transcript.recordUserScroll()
            }}
            onScroll={(event) => {
              if (event.target !== event.currentTarget) return
              const before = previousTop.current
              previousTop.current = event.currentTarget.scrollTop
              transcript.expandAtScrollEdge(before)
            }}
          >
            <MessageScrollerContent
              className={`gap-0 pb-14 ${!transcript.isFollowingEnd ? '[&>[data-message-id]]:[content-visibility:visible]' : ''}`}
            >
              {transcript.entries.map(({ item, itemIndex }) => (
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  disableContainment={params.has('no-containment')}
                  scrollAnchor={transcript.isFollowingEnd}
                >
                  <article style={{ height: 90 + (itemIndex % 7) * 85, padding: 16 }}>
                    <h2>{item.type === 'message' ? item.message.content : item.id}</h2>
                    <p>Variable-height history row {itemIndex + 1}</p>
                  </article>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            aria-label="Scroll to end"
            behavior="instant"
            onClick={() => flushSync(transcript.followEnd)}
          />
        </MessageScroller>
      </MessageScrollerProvider>
    </section>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
