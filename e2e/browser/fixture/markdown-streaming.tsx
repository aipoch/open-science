import '@/assets/main.css'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { SessionMessageMarkdown } from '@/pages/workspace/SessionMessageMarkdown'
import { ArtifactPreview } from '@/pages/workspace/artifact-preview'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton
} from '@/components/ui/message-scroller'
import type { MessageArtifact } from '@/pages/workspace/session-message-artifact-reference'
import { PresentedAgentMarkdown } from '@/components/streamdown/AgentMarkdown'

initI18n('en')
export function App(): React.JSX.Element {
  const [content, setContent] = useState('Short text')
  const [streaming, setStreaming] = useState(true)
  return (
    <main className="mx-auto max-w-3xl p-8">
      <label>
        Markdown input
        <textarea
          aria-label="Markdown input"
          className="block h-24 w-full border"
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </label>
      <button onClick={() => setStreaming(false)}>Finish stream</button>
      <PresentedAgentMarkdown content={content} isAnimating={streaming} sessionLinks />
    </main>
  )
}
const image: MessageArtifact = {
  id: 'stream-image-version',
  artifactId: 'stream-image-file',
  versionId: 'stream-image-version',
  kind: 'managed-file',
  isPublished: true,
  path: '/stream-image.png',
  name: 'stream-image.png',
  mimeType: 'image/png',
  size: 1024,
  resolvedProjectId: 'image-project',
  resolvedSessionId: 'image-session'
}
const artifacts = [image]
const noop = (): void => {}
function ImageStream(): React.JSX.Element {
  const [showImage, setShowImage] = useState(false)
  const [text, setText] = useState('')
  const [finished, setFinished] = useState(false)
  useEffect(() => {
    if (!showImage || finished) return
    const timer = window.setInterval(() => setText((value) => value + 'Streaming text. '), 50)
    return () => window.clearInterval(timer)
  }, [showImage, finished])
  const prefix = 'Introductory paragraph.\n\n'.repeat(60)
  return (
    <>
      <button onClick={() => setShowImage(true)}>Stream image</button>
      <button onClick={() => setText((value) => value + 'More streamed text.\n\n'.repeat(5))}>
        Append text
      </button>
      <button onClick={() => setFinished(true)}>Complete generation</button>
      <div style={{ height: 500, width: 700 }}>
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="image-reply" disableContainment>
                  <SessionMessageMarkdown
                    content={
                      prefix + (showImage ? '![Generated image](stream-image.png)\n\n' : '') + text
                    }
                    isAnimating={!finished}
                    artifacts={artifacts}
                    onPreviewArtifact={noop}
                    onPreviewArtifactModal={noop}
                  />
                  {finished && (
                    <div style={{ width: 100, height: 64 }}>
                      <ArtifactPreview
                        artifact={image}
                        projectId={image.resolvedProjectId}
                        sessionId={image.resolvedSessionId}
                        managedFileId={image.artifactId}
                        selectedVersionId={image.versionId}
                      />
                    </div>
                  )}
                  <div data-testid="reply-tail">{finished ? 'Completed' : 'Generating'}</div>
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </>
  )
}
const imageScenario = new URLSearchParams(location.search).has('image-scroll')
if (imageScenario) {
  window.api = {
    previewResources: {
      acquire: async () => ({
        id: 'stream-resource',
        url: '/delayed-stream-image.png',
        size: 1024,
        mimeType: 'image/png',
        version: 1,
        ...(new URLSearchParams(location.search).has('dimensions')
          ? { width: 1200, height: 1800 }
          : {})
      }),
      release: async () => {}
    }
  } as unknown as Window['api']
}
createRoot(document.getElementById('root')!).render(imageScenario ? <ImageStream /> : <App />)
