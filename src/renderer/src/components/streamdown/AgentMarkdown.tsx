import { Component, memo, useMemo, type ErrorInfo, type ReactNode } from 'react'
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

type AgentMarkdownErrorBoundaryProps = {
  content: string
  children: ReactNode
}

type AgentMarkdownErrorBoundaryState = {
  content: string
  hasError: boolean
}

type MermaidErrorPanelProps = {
  chart: string
  error: string
  retry: () => void
}

const MermaidErrorPanel = ({ chart, error, retry }: MermaidErrorPanelProps): React.JSX.Element => (
  <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-5 text-amber-950 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-100">
    <p className="font-medium">Mermaid syntax could not be rendered</p>
    <p className="mt-1 text-[12px] text-amber-900/90 dark:text-amber-200/90">{error}</p>
    <p className="mt-2 text-[12px] text-amber-800/80 dark:text-amber-300/80">
      Common causes: an xychart is missing the{' '}
      <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">title</code> keyword, axis
      labels are not quoted, or{' '}
      <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">y-axis</code> or{' '}
      <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">bar/line</code> data rows
      are missing.
    </p>
    <details className="mt-2">
      <summary className="cursor-pointer text-[12px] text-amber-900/90 dark:text-amber-200/90">
        View source
      </summary>
      <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-amber-200/80 bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-[#1a1a1a] dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-100">
        {chart}
      </pre>
    </details>
    <button
      type="button"
      className="mt-2 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[12px] text-amber-950 hover:bg-amber-100/80 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-900/40"
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

// Contains rich-renderer failures to one message and preserves its source as readable plain text.
class AgentMarkdownErrorBoundary extends Component<
  AgentMarkdownErrorBoundaryProps,
  AgentMarkdownErrorBoundaryState
> {
  state: AgentMarkdownErrorBoundaryState = {
    content: this.props.content,
    hasError: false
  }

  static getDerivedStateFromProps(
    props: AgentMarkdownErrorBoundaryProps,
    state: AgentMarkdownErrorBoundaryState
  ): AgentMarkdownErrorBoundaryState | null {
    if (props.content === state.content) return null

    // A changed message gets a fresh rich-render attempt instead of inheriting the previous failure.
    return { content: props.content, hasError: false }
  }

  static getDerivedStateFromError(): Partial<AgentMarkdownErrorBoundaryState> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Failed to render rich Markdown; showing plain text fallback.', error, errorInfo)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <pre
          data-agent-markdown-fallback=""
          className="agent-markdown-root m-0 max-w-full min-w-0 whitespace-pre-wrap break-words font-sans text-inherit"
        >
          {this.props.content}
        </pre>
      )
    }

    return this.props.children
  }
}

// Renders agent markdown with Streamdown tuned for incremental AI output.
const RichAgentMarkdown = memo(
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

RichAgentMarkdown.displayName = 'RichAgentMarkdown'

// Keeps renderer-specific failures from unmounting the surrounding workspace.
const AgentMarkdown = memo(
  ({ content, isAnimating = false }: AgentMarkdownProps): React.JSX.Element => (
    <AgentMarkdownErrorBoundary content={content}>
      <RichAgentMarkdown content={content} isAnimating={isAnimating} />
    </AgentMarkdownErrorBoundary>
  )
)

AgentMarkdown.displayName = 'AgentMarkdown'

export { AgentMarkdown }
