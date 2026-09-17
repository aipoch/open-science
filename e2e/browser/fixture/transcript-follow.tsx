import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranscriptWindow } from '@/pages/workspace/use-transcript-window'
import type { WorkspaceConversationTimelineItem } from '@/pages/workspace/workspace-conversation-timeline'

export function App(): JSX.Element {
  const [count, setCount] = useState(120)
  const viewportRef = useRef<HTMLDivElement>(null)
  const previousTop = useRef(0)
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
    type: 'message'
  })) as WorkspaceConversationTimelineItem[]
  const transcript = useTranscriptWindow('keyboard-regression', items, -1, viewportRef)
  useLayoutEffect(() => {
    if (transcript.isFollowingEnd && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
      previousTop.current = viewportRef.current.scrollTop
    }
  }, [count, transcript.isFollowingEnd])
  return (
    <>
      <button onClick={() => setCount((value) => value + 1)}>Append</button>
      <output data-testid="following">{String(transcript.isFollowingEnd)}</output>
      <div
        ref={viewportRef}
        tabIndex={0}
        aria-label="Transcript"
        style={{ height: 300, overflowY: 'auto', overflowAnchor: 'none' }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) transcript.recordUserScroll()
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) transcript.recordUserScroll()
        }}
        onScroll={(event) => {
          transcript.expandAtScrollEdge(previousTop.current)
          previousTop.current = event.currentTarget.scrollTop
        }}
      >
        {transcript.entries.map(({ item }) => (
          <div key={item.id} data-message-id={item.id} style={{ height: 100 }}>
            {item.id}
          </div>
        ))}
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
