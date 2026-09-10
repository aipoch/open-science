import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PresentedAgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { SessionMessageMarkdown } from '@/pages/workspace/SessionMessageMarkdown'

initI18n('en')
const mermaidCase = new URLSearchParams(location.search).get('mermaid')
const imageChart =
  '```mermaid\nflowchart TD\n A@{ img: "https://privacy-canary.invalid/image.png", label: "Image", h: 60 }\n```'
const chart =
  mermaidCase === 'ordinary'
    ? '```mermaid\nflowchart TD\n A@{ shape: rect, label: "Start" } --> B["Finish"]\n```'
    : imageChart
createRoot(document.getElementById('root')!).render(
  mermaidCase ? (
    <PresentedAgentMarkdown content={chart} allowMedia={mermaidCase !== 'disabled'} />
  ) : (
    <SessionMessageMarkdown
      content={'![Figure](https://privacy-canary.invalid/image.png)'}
      artifacts={[]}
      onPreviewArtifact={() => {}}
      onPreviewArtifactModal={() => {}}
    />
  )
)
