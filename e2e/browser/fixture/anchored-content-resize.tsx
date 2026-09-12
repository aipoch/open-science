import '@/assets/main.css'
import { useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem
} from '@/components/ui/message-scroller'
export function App(): JSX.Element {
  const [short, setShort] = useState(false)
  const [added, setAdded] = useState(false)
  return (
    <>
      <button onClick={() => setAdded(true)}>Append turn</button>
      <button onClick={() => setShort(!short)}>Toggle trailing height</button>
      <div style={{ height: 509, width: 700 }}>
        <MessageScrollerProvider
          autoScroll
          defaultScrollPosition="last-anchor"
          scrollPreviousItemPeek={64}
        >
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="first" scrollAnchor disableContainment>
                  <div style={{ height: 180 }}>First prompt</div>
                </MessageScrollerItem>
                <MessageScrollerItem messageId="reply" disableContainment>
                  <div style={{ height: 180 }}>First reply</div>
                </MessageScrollerItem>
                {added && (
                  <>
                    <MessageScrollerItem messageId="prompt" scrollAnchor disableContainment>
                      <div style={{ height: 60 }}>Current prompt</div>
                    </MessageScrollerItem>
                    <MessageScrollerItem messageId="tool" disableContainment>
                      <div style={{ height: 36 }}>Completed tool</div>
                    </MessageScrollerItem>
                    <MessageScrollerItem messageId="tail" disableContainment>
                      <div style={{ height: short ? 24 : 104 }}>Final reply</div>
                    </MessageScrollerItem>
                  </>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
