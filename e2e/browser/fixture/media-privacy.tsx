import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PresentedAgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { SessionMessageMarkdown } from '@/pages/workspace/SessionMessageMarkdown'

initI18n('en')
const params = new URLSearchParams(location.search)
const mermaidCase = params.get('mermaid')
const imageChart =
  '```mermaid\nflowchart TD\n A@{ img: "https://privacy-canary.invalid/image.png", label: "Image", h: 60 }\n```'
const chart =
  params.get('chart') ??
  (mermaidCase === 'ordinary'
    ? '```mermaid\nflowchart TD\n A@{ shape: rect, label: "Start" } --> B["Finish"]\n```'
    : imageChart)
// Exercise the production math renderer directly: the separate Markdown normalizer currently
// collapses $$ replacement-string tokens before Mermaid receives them.
if (mermaidCase === 'runtime') {
  void import('@/components/streamdown/mermaid-runtime').then(async ({ mermaid }) => {
    const { svg } = await mermaid.getMermaid({ theme: 'default' }).render('math-fixture', chart)
    document.getElementById('root')!.innerHTML = svg
  })
} else {
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
}
