import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
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
      <PresentedAgentMarkdown content={content} isAnimating={streaming} />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
