/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import {
  Component,
  Children,
  isValidElement,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ErrorInfo,
  type ReactNode
} from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { ExternalLink, Globe2 } from 'lucide-react'
import { Streamdown, type Components, type LinkSafetyConfig } from 'streamdown'
import 'katex/dist/katex.min.css'

import { AGENT_ALLOWED_TAGS, AGENT_CONTROLS } from './streamdown-config'
import { LinkSafetyModal } from './LinkSafetyModal'
import { StreamingBlock } from './StreamingBlock'
import { createAgentMarkdownNormalizer } from './normalize-agent-markdown'
import { useSmoothStreamingContent } from './use-smooth-streaming-content'
import { cn } from '@/lib/utils'
import { createSourcePreviewItem } from '@/lib/source-preview'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type AgentMarkdownProps = {
  content: string
  isAnimating?: boolean
  allowMedia?: boolean
  sessionLinks?: boolean
  components?: Components
}

type RichAgentMarkdownProps = AgentMarkdownProps & {
  incrementalBlocks?: boolean
}

type SessionMessageLinkProps = ComponentProps<'a'> & {
  node?: unknown
  'data-incomplete'?: boolean
}

type FaviconState = 'loading' | 'success' | 'error'

const SOURCE_PREVIEW_OPEN_DELAY_MS = 350
const SOURCE_PREVIEW_CLOSE_DELAY_MS = 150
const TOUCH_ACTIVATION_RESET_MS = 1000

const getSessionLinkFaviconUrl = (href: string | undefined): string | undefined => {
  if (!href) return undefined

  try {
    const url = new URL(href)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined

    return `https://${url.hostname.toLowerCase()}/favicon.ico`
  } catch {
    return undefined
  }
}

const getSessionLinkText = (children: ReactNode): string | undefined => {
  const label = Children.toArray(children)
    .map((part) => {
      if (typeof part === 'string' || typeof part === 'number') return String(part)
      if (isValidElement<{ children?: ReactNode }>(part)) {
        return getSessionLinkText(part.props.children) ?? ''
      }
      return ''
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
  return label || undefined
}

const SessionLinkFavicon = ({
  src,
  className
}: {
  src: string
  className?: string
}): React.JSX.Element => {
  const [state, setState] = useState<FaviconState>('loading')

  return (
    <span
      data-session-link-favicon=""
      data-state={state}
      aria-hidden="true"
      className={cn(
        'relative me-[0.3em] inline-grid size-[1em] place-items-center align-[-0.125em] text-sd-muted',
        className
      )}
    >
      <Globe2
        data-session-link-favicon-fallback=""
        className={cn(
          'absolute inset-0 m-0! size-full! max-w-none! border-0! bg-transparent! p-0! transition-opacity duration-150',
          state === 'success' ? 'opacity-0' : state === 'loading' ? 'opacity-50' : 'opacity-75'
        )}
      />
      {state !== 'error' ? (
        <img
          src={src}
          alt=""
          width="16"
          height="16"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className={cn(
            'absolute inset-0 m-0! size-full! max-w-none! rounded-none! border-0! bg-transparent! p-0! transition-opacity duration-150',
            state === 'success' ? 'opacity-100' : 'opacity-0'
          )}
          onLoad={() => setState('success')}
          onError={() => setState('error')}
        />
      ) : null}
    </span>
  )
}

const SessionMessageLink = ({
  children,
  className,
  href,
  title,
  'data-incomplete': dataIncomplete
}: SessionMessageLinkProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [isSafetyModalOpen, setIsSafetyModalOpen] = useState(false)
  const [isSourcePreviewOpen, setIsSourcePreviewOpen] = useState(false)
  const sourcePreviewTriggerRef = useRef<HTMLAnchorElement>(null)
  const sourcePreviewContentRef = useRef<HTMLDivElement>(null)
  const sourcePreviewTitleId = useId()
  const sourcePreviewOpenTimerRef = useRef<number | undefined>(undefined)
  const sourcePreviewCloseTimerRef = useRef<number | undefined>(undefined)
  const touchActivationResetTimerRef = useRef<number | undefined>(undefined)
  const isTouchActivationRef = useRef(false)
  const isSourcePreviewFocusWithinRef = useRef(false)
  const isSourcePreviewPointerWithinRef = useRef(false)
  const suppressNextFocusOpenRef = useRef(false)
  const upsertAndActivateItem = usePreviewWorkbenchStore((state) => state.upsertAndActivateItem)
  const faviconUrl = getSessionLinkFaviconUrl(href)
  const sourceItem = href
    ? createSourcePreviewItem({
        href,
        title:
          typeof title === 'string' && title.trim() ? title.trim() : getSessionLinkText(children)
      })
    : undefined

  const clearSourcePreviewTimers = (): void => {
    window.clearTimeout(sourcePreviewOpenTimerRef.current)
    window.clearTimeout(sourcePreviewCloseTimerRef.current)
    sourcePreviewOpenTimerRef.current = undefined
    sourcePreviewCloseTimerRef.current = undefined
  }

  const openSourcePreview = (delay = 0): void => {
    clearSourcePreviewTimers()
    if (delay === 0) {
      setIsSourcePreviewOpen(true)
      return
    }
    sourcePreviewOpenTimerRef.current = window.setTimeout(() => {
      setIsSourcePreviewOpen(true)
      sourcePreviewOpenTimerRef.current = undefined
    }, delay)
  }

  const closeSourcePreview = (): void => {
    clearSourcePreviewTimers()
    sourcePreviewCloseTimerRef.current = window.setTimeout(() => {
      if (!isSourcePreviewFocusWithinRef.current && !isSourcePreviewPointerWithinRef.current) {
        setIsSourcePreviewOpen(false)
      }
      sourcePreviewCloseTimerRef.current = undefined
    }, SOURCE_PREVIEW_CLOSE_DELAY_MS)
  }

  const dismissSourcePreview = (restoreFocus = false): void => {
    clearSourcePreviewTimers()
    isSourcePreviewPointerWithinRef.current = false
    setIsSourcePreviewOpen(false)
    if (!restoreFocus) return

    suppressNextFocusOpenRef.current = true
    window.setTimeout(() => {
      const trigger = sourcePreviewTriggerRef.current
      if (trigger && document.activeElement !== trigger) {
        trigger.focus({ preventScroll: true })
      }
      suppressNextFocusOpenRef.current = false
    }, 0)
  }

  useEffect(
    () => () => {
      clearSourcePreviewTimers()
      window.clearTimeout(touchActivationResetTimerRef.current)
    },
    []
  )

  if (sourceItem) {
    const hostname = new URL(sourceItem.url).hostname

    return (
      <Popover
        open={isSourcePreviewOpen}
        onOpenChange={(open) => {
          clearSourcePreviewTimers()
          setIsSourcePreviewOpen(open)
        }}
      >
        <PopoverTrigger asChild>
          <a
            ref={sourcePreviewTriggerRef}
            href={sourceItem.url}
            data-source-preview-link=""
            data-incomplete={dataIncomplete}
            data-session-message-link=""
            data-streamdown="link"
            className={className}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') {
                isSourcePreviewPointerWithinRef.current = true
                openSourcePreview(SOURCE_PREVIEW_OPEN_DELAY_MS)
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'touch') {
                isSourcePreviewPointerWithinRef.current = false
                closeSourcePreview()
              }
            }}
            onPointerDown={(event) => {
              window.clearTimeout(touchActivationResetTimerRef.current)
              isTouchActivationRef.current = event.pointerType === 'touch'
              if (isTouchActivationRef.current) {
                touchActivationResetTimerRef.current = window.setTimeout(() => {
                  isTouchActivationRef.current = false
                }, TOUCH_ACTIVATION_RESET_MS)
              }
            }}
            onPointerCancel={() => {
              window.clearTimeout(touchActivationResetTimerRef.current)
              isTouchActivationRef.current = false
            }}
            onFocus={() => {
              isSourcePreviewFocusWithinRef.current = true
              if (suppressNextFocusOpenRef.current) {
                suppressNextFocusOpenRef.current = false
                return
              }
              openSourcePreview()
            }}
            onBlur={(event) => {
              if (!sourcePreviewContentRef.current?.contains(event.relatedTarget as Node | null)) {
                isSourcePreviewFocusWithinRef.current = false
                closeSourcePreview()
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Tab' || event.shiftKey || !isSourcePreviewOpen) return
              const firstAction = sourcePreviewContentRef.current?.querySelector<HTMLElement>(
                '[data-source-preview-hover-url]'
              )
              if (!firstAction) return
              event.preventDefault()
              firstAction.focus()
            }}
            onClick={(event) => {
              event.preventDefault()
              window.clearTimeout(touchActivationResetTimerRef.current)
              if (isTouchActivationRef.current) {
                isTouchActivationRef.current = false
                openSourcePreview()
                return
              }
              dismissSourcePreview()
              upsertAndActivateItem(sourceItem)
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              dismissSourcePreview()
              upsertAndActivateItem(sourceItem)
            }}
          >
            {faviconUrl ? <SessionLinkFavicon key={faviconUrl} src={faviconUrl} /> : null}
            {children}
          </a>
        </PopoverTrigger>
        <PopoverContent
          ref={sourcePreviewContentRef}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          data-source-preview-hover-card=""
          aria-labelledby={sourcePreviewTitleId}
          className="w-[min(20rem,calc(100vw-1rem))] border border-border-300 bg-bg-000 p-3 text-text-100 shadow-card"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => dismissSourcePreview(true)}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') {
              isSourcePreviewPointerWithinRef.current = true
              clearSourcePreviewTimers()
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') {
              isSourcePreviewPointerWithinRef.current = false
              closeSourcePreview()
            }
          }}
          onFocusCapture={() => {
            isSourcePreviewFocusWithinRef.current = true
            clearSourcePreviewTimers()
          }}
          onBlurCapture={(event) => {
            const nextTarget = event.relatedTarget as Node | null
            if (
              !event.currentTarget.contains(nextTarget) &&
              !sourcePreviewTriggerRef.current?.contains(nextTarget)
            ) {
              isSourcePreviewFocusWithinRef.current = false
              closeSourcePreview()
            }
          }}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            {faviconUrl ? (
              <SessionLinkFavicon className="mt-0.5 me-0 size-5 shrink-0" src={faviconUrl} />
            ) : null}
            <div className="min-w-0 flex-1">
              <div
                id={sourcePreviewTitleId}
                data-source-preview-hover-title=""
                className="break-words text-sm font-medium leading-5 text-text-000"
              >
                {sourceItem.title}
              </div>
              <div
                data-source-preview-hover-hostname=""
                className="truncate text-xs leading-4 text-text-000"
              >
                {hostname}
              </div>
              <a
                href={sourceItem.url}
                data-source-preview-hover-url=""
                title={sourceItem.url}
                className="mt-1 block break-all text-xs leading-4 text-text-000 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                onClick={(event) => {
                  event.preventDefault()
                  dismissSourcePreview(true)
                  upsertAndActivateItem(sourceItem)
                }}
              >
                {sourceItem.url}
              </a>
            </div>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-source-preview-hover-external=""
                    aria-label={t('Open source in browser')}
                    className="mt-0.5 text-text-100 hover:text-text-000"
                    onClick={(event) => {
                      event.stopPropagation()
                      dismissSourcePreview(true)
                      window.open(sourceItem.url, '_blank', 'noreferrer')
                    }}
                  >
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Open source in browser')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        data-incomplete={dataIncomplete}
        data-session-message-link=""
        data-streamdown="link"
        disabled={!href}
        onClick={() => setIsSafetyModalOpen(true)}
      >
        {faviconUrl ? <SessionLinkFavicon key={faviconUrl} src={faviconUrl} /> : null}
        {children}
      </button>
      {href ? (
        <LinkSafetyModal
          url={href}
          isOpen={isSafetyModalOpen}
          onClose={() => setIsSafetyModalOpen(false)}
          onConfirm={() => window.open(href, '_blank', 'noreferrer')}
        />
      ) : null}
    </>
  )
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
    return { failedContent: null, hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ failedContent: this.props.content })
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
  ({
    content,
    isAnimating = false,
    allowMedia = true,
    sessionLinks = false,
    components,
    incrementalBlocks = false
  }: RichAgentMarkdownProps): React.JSX.Element => {
    // Append-only streaming re-normalizes just the trailing block instead of the full message.
    const [normalizer] = useState(() => createAgentMarkdownNormalizer())
    const renderedContent = useMemo(() => normalizer(content), [normalizer, content])
    const renderedComponents = useMemo(
      () => (sessionLinks ? { ...sessionLinkComponents, ...components } : components),
      [components, sessionLinks]
    )

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
          allowedTags={AGENT_ALLOWED_TAGS}
          disallowedElements={allowMedia ? undefined : NETWORK_FETCHING_MEDIA_ELEMENTS}
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

// Renders already-paced content. Message surfaces that own a broader visual lifecycle can use this
// directly so their cursor and terminal chrome settle in the same render.
const PresentedAgentMarkdown = memo(
  ({
    content,
    isAnimating = false,
    allowMedia = true,
    sessionLinks = false,
    components,
    incrementalBlocks = true
  }: RichAgentMarkdownProps): React.JSX.Element => (
    <AgentMarkdownErrorBoundary content={content}>
      <RichAgentMarkdown
        content={content}
        isAnimating={isAnimating}
        allowMedia={allowMedia}
        sessionLinks={sessionLinks}
        components={components}
        incrementalBlocks={incrementalBlocks}
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
    components
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
      />
    )
  }
)

AgentMarkdown.displayName = 'AgentMarkdown'

export { AgentMarkdown, PresentedAgentMarkdown, SessionMessageLink }
