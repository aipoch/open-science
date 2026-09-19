import { ErrorNotice } from '@/components/error-notice'
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
import { createIncrementalMarkdownBlocks } from './incremental-markdown-blocks'
import { retainMarkdownParser } from './markdown-parser'
import { AGENT_ALLOWED_TAGS, AGENT_CONTROLS } from './streamdown-config'
import {
  DeferredImage,
  DeferredVideo,
  DeferredAudio,
  ApprovedSource,
  ApprovedTrack,
  LocalSvgUse
} from './DeferredMedia'
import { LinkSafetyModal } from './LinkSafetyModal'
import { SessionMessageLink } from './SessionMessageLink'
import { createStreamingBlockquote } from './streaming-blockquote'
import { AsyncStreamingBlock } from './AsyncStreamingBlock'
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

const deferredMediaComponents = {
  img: DeferredImage,
  video: DeferredVideo,
  audio: DeferredAudio,
  source: ApprovedSource,
  track: ApprovedTrack,
  use: LocalSvgUse
} satisfies Components

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
  const mediaBlocked = error.includes('MERMAID_IMAGE_BLOCKED')
  return (
    <ErrorNotice
      className="my-2"
      title={
        mediaBlocked
          ? t('Images in Mermaid diagrams are blocked')
          : t('Mermaid syntax could not be rendered')
      }
      description={mediaBlocked ? t('Use a separate Markdown image to load it explicitly.') : error}
      primaryButton={!mediaBlocked ? { label: t('Retry'), onClick: retry } : undefined}
    >
      {!mediaBlocked && (
        <p className="text-xs leading-5 text-muted-foreground">
          <Trans
            t={t}
            i18nKey="Common causes: an xychart is missing the <kw1>title</kw1> keyword, axis labels are not quoted, or <kw2>y-axis</kw2> or <kw3>bar/line</kw3> data rows are missing."
            components={{
              kw1: <code className="rounded bg-muted px-1" />,
              kw2: <code className="rounded bg-muted px-1" />,
              kw3: <code className="rounded bg-muted px-1" />
            }}
          />
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t('View source')}
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
          {chart}
        </pre>
      </details>
    </ErrorNotice>
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
    const [splitBlocks] = useState(() => createIncrementalMarkdownBlocks())
    useEffect(() => (isAnimating ? retainMarkdownParser() : undefined), [isAnimating])
    const renderedContent = useMemo(() => normalizer(content), [normalizer, content])
    const allowedTags = useMemo(
      () => (extension ? { ...AGENT_ALLOWED_TAGS, ...extension.allowedTags } : AGENT_ALLOWED_TAGS),
      [extension]
    )
    const plugins = useMarkdownPlugins(renderedContent)
    const renderedComponents = useMemo(() => {
      const merged = {
        ...(sessionLinks ? sessionLinkComponents : {}),
        ...components,
        ...extension?.components,
        ...deferredMediaComponents
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
          BlockComponent={AsyncStreamingBlock}
          parseMarkdownIntoBlocksFn={splitBlocks}
          parseIncompleteMarkdown={isAnimating}
          normalizeHtmlIndentation={!isAnimating}
          allowedTags={allowedTags}
          literalTagContent={extension?.literalTagContent}
          disallowedElements={
            allowMedia ? ['iframe', 'object', 'embed'] : NETWORK_FETCHING_MEDIA_ELEMENTS
          }
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
