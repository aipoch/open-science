import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, LoaderCircle } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ScrollArea } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ScrollBar } from '@/components/ui/scroll-area'
import { ErrorNotice } from '@/components/error-notice'
import type { UseCase } from '../../../../shared/use-cases'
import type { UseCaseIntroductionLoader } from './use-case-introduction-loader'
import { UseCaseCover } from './UseCaseCover'

// Resolve published relative resources without allowing executable URLs or raw HTML.
const introductionUrl = (url: string, key: string, item: UseCase): string => {
  try {
    const resolved = new URL(url, item.introductionUrl ?? item.imageUrl)
    if (!['https:', 'http:'].includes(resolved.protocol)) return ''
    if (key === 'src' && resolved.origin !== new URL(item.imageUrl).origin) return ''
    return resolved.href
  } catch {
    return ''
  }
}

// Stable component types preserve table scroll and link focus during progress updates.
const introductionComponents: Components = {
  // Isolate wide tables and expose their overflow on hover or keyboard focus.
  table: ({ children }) => (
    <ScrollArea.Root
      type="hover"
      scrollHideDelay={160}
      className="scrollbar-auto-hide relative my-4 max-w-full"
    >
      <ScrollArea.Viewport
        data-slot="scroll-area-viewport"
        tabIndex={0}
        className="w-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="pb-2.5">
          <table className="[&_td]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere]">
            {children}
          </table>
        </div>
      </ScrollArea.Viewport>
      <ScrollBar orientation="horizontal" forceMount className="h-2.5 flex-col" />
    </ScrollArea.Root>
  ),
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

const UseCaseIntroduction = ({
  item,
  introductions
}: {
  item: UseCase
  introductions: UseCaseIntroductionLoader
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ content: string | null; failed: boolean } | undefined>(
    () => {
      const content = introductions.peek(item)
      return content === undefined ? undefined : { content, failed: false }
    }
  )
  useEffect(() => {
    let active = true
    const showContent = (content: string | null): void => {
      if (active)
        setResult((previous) =>
          previous?.content === content && !previous.failed ? previous : { content, failed: false }
        )
    }
    const unsubscribe = introductions.subscribe(item, showContent)
    void introductions.load(item).then(showContent, () => {
      if (active) setResult({ content: null, failed: true })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [item, introductions, attempt])
  if (!result)
    return (
      <div role="status" className="space-y-4 py-6 text-sm text-text-200">
        <div className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t('Loading introduction…')}
        </div>
        <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
          <div className="h-5 w-1/3 rounded bg-bg-200" />
          <div className="h-3 w-full rounded bg-bg-200" />
          <div className="h-3 w-4/5 rounded bg-bg-200" />
        </div>
      </div>
    )
  if (result.failed)
    return (
      <ErrorNotice
        inline
        tone="amber"
        description={t('Could not load this introduction. Try again.')}
        primaryButton={{
          label: t('Try again'),
          onClick: () => {
            setResult(undefined)
            setAttempt((value) => value + 1)
          }
        }}
      />
    )
  if (!result.content?.trim())
    return (
      <p className="py-6 text-sm text-text-200">
        {t('No introduction is available for this example yet.')}
      </p>
    )
  return (
    <div className="agent-markdown prose prose-sm max-w-none break-words dark:prose-invert [&_img]:h-auto [&_img]:max-w-full [&_pre]:overflow-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url, key) => introductionUrl(url, key, item)}
        components={introductionComponents}
      >
        {result.content}
      </ReactMarkdown>
    </div>
  )
}

export type UseCaseDetailsContentProps = {
  item: UseCase
  introductions: UseCaseIntroductionLoader
  onOpenMarketplace?: () => void
  renderImport: (item: UseCase) => ReactNode
  renderDownloadStatus: (item: UseCase) => ReactNode
}

export const UseCaseDetailsContent = ({
  item,
  introductions,
  onOpenMarketplace,
  renderImport,
  renderDownloadStatus
}: UseCaseDetailsContentProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden" key={item.slug}>
      <div data-case-detail-header className="max-h-[50%] shrink-0 overflow-y-auto px-4 py-2">
        {item.category && <p className="mb-1 text-xs text-text-200">{item.category}</p>}
        <h2 className="mb-2 break-words text-xl font-semibold leading-tight tracking-tight text-text-000">
          {item.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {renderImport(item)}
          {onOpenMarketplace && (
            <Button
              variant="ghost"
              size="lg"
              onClick={onOpenMarketplace}
              className="gap-2 text-muted-foreground"
            >
              {t('Go to Use Case Marketplace')}
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        {renderDownloadStatus(item)}
      </div>
      <div data-case-detail-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        <div className="relative mx-auto mb-8 aspect-[16/9] w-full max-w-[640px] overflow-hidden rounded-xl border border-border">
          <UseCaseCover key={item.imageUrl} src={item.imageUrl} />
        </div>
        <UseCaseIntroduction
          key={item.introductionUrl ?? item.slug}
          item={item}
          introductions={introductions}
        />
      </div>
    </div>
  )
}
