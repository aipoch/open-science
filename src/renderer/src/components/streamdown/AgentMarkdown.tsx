import { memo, useMemo } from 'react'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { Streamdown, type LinkSafetyConfig } from 'streamdown'
import 'katex/dist/katex.min.css'

import { AGENT_ALLOWED_TAGS, AGENT_CONTROLS } from './streamdown-config'
import { LinkSafetyModal } from './LinkSafetyModal'
import { normalizeAgentMarkdown } from './normalize-agent-markdown'
import { cn } from '@/lib/utils'

type AgentMarkdownProps = {
  content: string
  isAnimating?: boolean
}

type MermaidErrorPanelProps = {
  chart: string
  error: string
  retry: () => void
}

const MermaidErrorPanel = ({ chart, error, retry }: MermaidErrorPanelProps): React.JSX.Element => (
  <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-5 text-amber-950">
    <p className="font-medium">Mermaid syntax could not be rendered</p>
    <p className="mt-1 text-[12px] text-amber-900/90">{error}</p>
    <p className="mt-2 text-[12px] text-amber-800/80">
      Common causes: an xychart is missing the{' '}
      <code className="rounded bg-amber-100/80 px-1">title</code> keyword, axis labels are not
      quoted, or <code className="rounded bg-amber-100/80 px-1">y-axis</code> or{' '}
      <code className="rounded bg-amber-100/80 px-1">bar/line</code> data rows are missing.
    </p>
    <details className="mt-2">
      <summary className="cursor-pointer text-[12px] text-amber-900/90">View source</summary>
      <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-amber-200/80 bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-[#1a1a1a]">
        {chart}
      </pre>
    </details>
    <button
      type="button"
      className="mt-2 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[12px] text-amber-950 hover:bg-amber-100/80"
      onClick={retry}
    >
      Retry
    </button>
  </div>
)

const math = createMathPlugin({ singleDollarTextMath: true })
const plugins = { code, math, mermaid, cjk } as const
const mermaidOptions = {
  config: { theme: 'default' as const },
  errorComponent: MermaidErrorPanel
}

const agentLinkSafety: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkSafetyModal {...props} />
}

// Renders agent markdown with Streamdown tuned for incremental AI output.
const AgentMarkdown = memo(
  ({ content, isAnimating = false }: AgentMarkdownProps): React.JSX.Element => {
    const renderedContent = useMemo(() => normalizeAgentMarkdown(content), [content])

    return (
      <div
        className={cn(
          'agent-markdown-root max-w-full min-w-0',
          isAnimating && 'agent-markdown-streaming'
        )}
      >
        <Streamdown
          className="agent-markdown prose prose-sm prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2"
          plugins={plugins}
          controls={AGENT_CONTROLS}
          linkSafety={agentLinkSafety}
          dir="auto"
          mode={isAnimating ? 'streaming' : 'static'}
          isAnimating={isAnimating}
          animated={false}
          parseIncompleteMarkdown={isAnimating}
          normalizeHtmlIndentation={!isAnimating}
          allowedTags={AGENT_ALLOWED_TAGS}
          shikiTheme={['github-light', 'github-light']}
          mermaid={mermaidOptions}
        >
          {renderedContent}
        </Streamdown>
      </div>
    )
  }
)

AgentMarkdown.displayName = 'AgentMarkdown'

export { AgentMarkdown }
