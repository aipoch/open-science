/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import {
  Component,
  memo,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode
} from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import {
  Streamdown,
  type AllowedTags,
  type Components,
  type LinkSafetyConfig,
  type PluginConfig,
  type ThemeInput
} from 'streamdown'
import 'katex/dist/katex.min.css'

import { createMarkdownPluginNeedsScanner } from './code-fence'
import { AGENT_ALLOWED_TAGS, AGENT_CONTROLS } from './streamdown-config'
import { LinkSafetyModal } from './LinkSafetyModal'
import { SessionMessageLink } from './SessionMessageLink'
import { createStreamingBlockquote } from './streaming-blockquote'
import { StreamingBlock } from './StreamingBlock'
import { createAgentMarkdownNormalizer } from './normalize-agent-markdown'
import { useCodeHighlighter } from './use-code-highlighter'
import { useSmoothStreamingContent } from './use-smooth-streaming-content'
import { cn } from '@/lib/utils'

type AgentMarkdownExtension = {
  allowedTags: AllowedTags
  components: Components
  literalTagContent?: string[]
}

type AgentMarkdownProps = {
  content: string
  isAnimating?: boolean
  allowMedia?: boolean
  sessionLinks?: boolean
  extension?: AgentMarkdownExtension
  fallback?: ReactNode
  components?: Components
}

type RichAgentMarkdownProps = AgentMarkdownProps & {
  incrementalBlocks?: boolean
}

const sessionLinkComponents = { a: SessionMessageLink } satisfies Components

// Import previews render untrusted Markdown. Removing every element that can initiate a media fetch
// prevents opening a candidate from disclosing viewer activity to an external host. `use` is
// included because an SVG use element may reference a remote document.
const NETWORK_FETCHING_MEDIA_ELEMENTS = [
  'img',
  'video',
  'audio',
  'source',
  'track',
  'iframe',
  'object',
  'embed',
  'use'
] as const

type AgentMarkdownErrorBoundaryProps = {
  content: string
  children: ReactNode
  fallback?: ReactNode
}

type AgentMarkdownErrorBoundaryState = {
  failedContent: string | null
  hasError: boolean
}

type MermaidErrorPanelProps = {
  chart: string
  error: string
  retry: () => void
}

const MermaidErrorPanel = ({ chart, error, retry }: MermaidErrorPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-5 text-amber-950 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-100">
      <p className="font-medium">{t('Mermaid syntax could not be rendered')}</p>
      <p className="mt-1 text-[12px] text-amber-900/90 dark:text-amber-200/90">{error}</p>
      <p className="mt-2 text-[12px] text-amber-800/80 dark:text-amber-300/80">
        <Trans
          t={t}
          i18nKey="Common causes: an xychart is missing the <kw1>title</kw1> keyword, axis labels are not quoted, or <kw2>y-axis</kw2> or <kw3>bar/line</kw3> data rows are missing."
          components={{
            kw1: <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50" />,
            kw2: <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50" />,
            kw3: <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50" />
          }}
        />
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-[12px] text-amber-900/90 dark:text-amber-200/90">
          {t('View source')}
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
        {t('Retry')}
      </button>
    </div>
  )
}

const math = createMathPlugin({ singleDollarTextMath: true })
const basePlugins = { math, cjk } as const
const shikiThemes: [ThemeInput, ThemeInput] = ['github-light', 'github-light']
const mermaidOptions = {
  config: { theme: 'default' as const },
  errorComponent: MermaidErrorPanel
}

const useMarkdownPlugins = (content: string): PluginConfig => {
  // Append-only streaming rescans just the appended lines instead of the full message.
  const [pluginNeedsScanner] = useState(() => createMarkdownPluginNeedsScanner())
  const needs = useMemo(() => pluginNeedsScanner(content), [pluginNeedsScanner, content])
  const [optionalPlugins, setOptionalPlugins] = useState<PluginConfig>({})
  const code = useCodeHighlighter(needs.code)

  useEffect(() => {
    if (!needs.mermaid || optionalPlugins.mermaid) return

    let active = true
    void import('./mermaid-runtime').then(
      ({ mermaid }) => {
        if (active) setOptionalPlugins((current) => ({ ...current, mermaid }))
      },
      (error: unknown) => console.error('Failed to load Mermaid rendering.', error)
    )
    return () => {
      active = false
    }
  }, [needs.mermaid, optionalPlugins.mermaid])

  return useMemo(
    () => ({ ...basePlugins, ...(code ? { code } : {}), ...optionalPlugins }),
    [code, optionalPlugins]
  )
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
    failedContent: null,
    hasError: false
  }

  static getDerivedStateFromProps(
    props: AgentMarkdownErrorBoundaryProps,
    state: AgentMarkdownErrorBoundaryState
  ): AgentMarkdownErrorBoundaryState | null {
    if (!state.hasError || state.failedContent === null || props.content === state.failedContent) {
      return null
    }

    // A changed message gets a fresh rich-render attempt instead of inheriting the previous failure.
    return { failedContent: null, hasError: false }
  }

  static getDerivedStateFromError(): Partial<AgentMarkdownErrorBoundaryState> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState((_state, props) => ({ failedContent: props.content }))
    console.error('Failed to render rich Markdown; showing plain text fallback.', error, errorInfo)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback
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
  ({
    content,
    isAnimating = false,
    allowMedia = true,
    sessionLinks = false,
    components,
    incrementalBlocks = false,
    extension
  }: RichAgentMarkdownProps): React.JSX.Element => {
    // Append-only streaming re-normalizes just the trailing block instead of the full message.
    const [normalizer] = useState(() => createAgentMarkdownNormalizer())
    const renderedContent = useMemo(() => normalizer(content), [normalizer, content])
    const allowedTags = useMemo(
      () => (extension ? { ...AGENT_ALLOWED_TAGS, ...extension.allowedTags } : AGENT_ALLOWED_TAGS),
      [extension]
    )
    const plugins = useMarkdownPlugins(renderedContent)
    const renderedComponents = useMemo(() => {
      const merged =
        !sessionLinks && !components && !extension
          ? undefined
          : {
              ...(sessionLinks ? sessionLinkComponents : {}),
              ...components,
              ...extension?.components
            }
      // While streaming, hide quotes with no non-empty paragraph render-side instead of the old
      // `blockquote:not(:has(p:not(:empty)))` rule, a style-recalc hotspot on each DOM commit.
      if (!isAnimating) return merged
      return {
        ...merged,
        blockquote: createStreamingBlockquote(merged?.blockquote, merged?.p)
      }
    }, [components, extension, sessionLinks, isAnimating])

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
          components={renderedComponents}
          dir="auto"
          mode={isAnimating || incrementalBlocks ? 'streaming' : 'static'}
          isAnimating={isAnimating}
          animated={false}
          BlockComponent={StreamingBlock}
          parseIncompleteMarkdown={isAnimating}
          normalizeHtmlIndentation={!isAnimating}
          allowedTags={allowedTags}
          literalTagContent={extension?.literalTagContent}
          disallowedElements={allowMedia ? undefined : NETWORK_FETCHING_MEDIA_ELEMENTS}
          shikiTheme={plugins.code ? shikiThemes : undefined}
          mermaid={plugins.mermaid ? mermaidOptions : undefined}
        >
          {renderedContent}
        </Streamdown>
      </div>
    )
  }
)

RichAgentMarkdown.displayName = 'RichAgentMarkdown'

// Renders already-paced content. Message surfaces that own a broader visual lifecycle can use this
// directly so their cursor and terminal chrome settle in the same render.
const PresentedAgentMarkdown = memo(
  ({
    content,
    isAnimating = false,
    allowMedia = true,
    sessionLinks = false,
    components,
    incrementalBlocks = true,
    extension,
    fallback
  }: RichAgentMarkdownProps): React.JSX.Element => (
    <AgentMarkdownErrorBoundary content={content} fallback={fallback}>
      <RichAgentMarkdown
        content={content}
        isAnimating={isAnimating}
        allowMedia={allowMedia}
        sessionLinks={sessionLinks}
        components={components}
        incrementalBlocks={incrementalBlocks}
        extension={extension}
      />
    </AgentMarkdownErrorBoundary>
  )
)

PresentedAgentMarkdown.displayName = 'PresentedAgentMarkdown'

// Keeps renderer-specific failures from unmounting the surrounding workspace.
const AgentMarkdown = memo(
  ({
    content,
    isAnimating = false,
    allowMedia = true,
    sessionLinks = false,
    components,
    extension,
    fallback
  }: AgentMarkdownProps): React.JSX.Element => {
    const presentation = useSmoothStreamingContent(content, isAnimating)

    return (
      <PresentedAgentMarkdown
        content={presentation.content}
        isAnimating={presentation.isPresenting}
        allowMedia={allowMedia}
        sessionLinks={sessionLinks}
        components={components}
        incrementalBlocks={false}
        extension={extension}
        fallback={fallback}
      />
    )
  }
)

AgentMarkdown.displayName = 'AgentMarkdown'

export { AgentMarkdown, PresentedAgentMarkdown }
export type { AgentMarkdownExtension }
