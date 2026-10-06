import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  BookOpen,
  ChartNoAxesCombined,
  ChartScatter,
  ChevronLeft,
  ChevronRight,
  CodeXml,
  FileSearch,
  Files,
  FlaskConical,
  GitFork,
  Info,
  NotebookPen,
  PackageOpen
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { sessionPackageImportAvailable } from '@/components/session-package-import-menu-model'
import { importSessionPackage } from '@/lib/session-package-import'

import { FlaskLogo } from '@/components/flask-logo'

const SessionPackageEntryRow = ({
  projectId,
  compact = false
}: {
  projectId: string
  compact?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const pickerRef = useRef<HTMLInputElement>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerHoveredRef = useRef(false)
  const contentHoveredRef = useRef(false)
  const triggerFocusedRef = useRef(false)
  const contentFocusedRef = useRef(false)
  // Radix reports Escape and outside-pointer dismissal through onOpenChange(false). Keep that
  // dismissal authoritative until the pointer/focus enters the trigger again; otherwise a hover
  // state that is still true can immediately reopen the controlled popover.
  const dismissedRef = useRef(false)

  const browse = (): void => pickerRef.current?.click()
  const cancelGuideClose = (): void => {
    if (closeTimerRef.current === null) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const openGuide = (): void => {
    cancelGuideClose()
    if (dismissedRef.current) return
    setGuideOpen(true)
  }
  const scheduleGuideClose = (): void => {
    cancelGuideClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      if (
        !triggerHoveredRef.current &&
        !contentHoveredRef.current &&
        !triggerFocusedRef.current &&
        !contentFocusedRef.current
      ) {
        setGuideOpen(false)
      }
    }, 120)
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    },
    []
  )

  return (
    <div
      data-testid="session-package-entry"
      className={
        compact
          ? 'pointer-events-auto mx-auto mt-4 flex w-fit max-w-full items-center gap-1.5 text-text-100'
          : 'pointer-events-auto mt-2.5 flex w-[420px] max-w-full items-center gap-3 rounded-[10px] border-[1.5px] border-dashed border-bg-400 bg-transparent px-4 py-3 text-left transition-colors hover:border-text-300 hover:bg-bg-200/50'
      }
    >
      <input
        ref={pickerRef}
        type="file"
        accept=".science"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importSessionPackage(projectId, file)
        }}
      />
      {!compact && (
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-bg-200 text-text-200 transition-colors">
          <PackageOpen className="size-[15px]" aria-hidden="true" />
        </span>
      )}
      <button
        type="button"
        aria-label={t('Choose a .science file')}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:text-text-000 focus-visible:keyboard-focus"
        onClick={browse}
      >
        {compact && <PackageOpen className="size-3.5 shrink-0" aria-hidden="true" />}
        <span>
          <span
            className={compact ? 'block text-xs' : 'block text-[13px] font-medium text-text-000'}
          >
            {t('Import previous research')}
          </span>
          <span className={compact ? 'sr-only' : 'mt-0.5 block text-xs text-text-100'}>
            {t('Drag a .science research package onto this page, or choose a file')}
          </span>
        </span>
      </button>
      <Popover
        open={guideOpen}
        onOpenChange={(open) => {
          if (open) {
            dismissedRef.current = false
            setGuideOpen(true)
          } else {
            dismissedRef.current = true
            cancelGuideClose()
            setGuideOpen(false)
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('What is a .science research package?')}
            className="flex size-[22px] shrink-0 cursor-help items-center justify-center rounded-full text-text-300 transition-colors hover:bg-bg-300 hover:text-text-100 focus-visible:keyboard-focus"
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={() => {
              dismissedRef.current = false
              triggerHoveredRef.current = true
              openGuide()
            }}
            onMouseLeave={() => {
              triggerHoveredRef.current = false
              dismissedRef.current = false
              scheduleGuideClose()
            }}
            onFocus={() => {
              dismissedRef.current = false
              triggerFocusedRef.current = true
              openGuide()
            }}
            onBlur={() => {
              triggerFocusedRef.current = false
              scheduleGuideClose()
            }}
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          sideOffset={10}
          className="w-[330px] rounded-[10px] border border-border bg-bg-000 p-3 text-text-000"
          onOpenAutoFocus={(event) => {
            // Hover should not steal focus from the page; keyboard focus can move into the guide.
            if (!triggerFocusedRef.current) event.preventDefault()
          }}
          onMouseEnter={() => {
            dismissedRef.current = false
            contentHoveredRef.current = true
            openGuide()
          }}
          onMouseLeave={() => {
            contentHoveredRef.current = false
            dismissedRef.current = false
            scheduleGuideClose()
          }}
          onFocus={() => {
            contentFocusedRef.current = true
            openGuide()
          }}
          onBlur={() => {
            contentFocusedRef.current = false
            scheduleGuideClose()
          }}
        >
          <p className="text-[12.5px] font-semibold text-text-000">
            {t('What is a .science research package?')}
          </p>
          <p className="mt-1.5 text-xs leading-normal text-text-100">
            {t(
              'A .science research package contains the exported research history and any files included at export. Import opens read-only history; fork the imported history to continue researching in your own copy.'
            )}
          </p>
          <div className="mt-2.5 flex items-center gap-2 border-t border-bg-300 pt-2.5">
            <span className="flex items-center gap-1.5">
              <PackageOpen className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <span className="block whitespace-nowrap text-xs font-medium text-text-000">
                  {t('Import')}
                </span>
                <span className="block whitespace-nowrap text-[11.5px] text-text-300">
                  {t('read-only history')}
                </span>
              </span>
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
            <span className="flex items-center gap-1.5">
              <GitFork className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <span className="block whitespace-nowrap text-xs font-medium text-text-000">
                  {t('Fork')}
                </span>
                <span className="block whitespace-nowrap text-[11.5px] text-text-300">
                  {t('continue research')}
                </span>
              </span>
            </span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

const EmptyConversationBanner = ({
  onStartResearch,
  researchTitle,
  sessionImport
}: {
  onStartResearch?: (prompt: string) => void
  researchTitle?: string
  sessionImport?: { projectId: string; canImport: boolean }
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      data-testid="empty-conversation-banner"
      className="pointer-events-none absolute inset-x-0 top-[42%] flex -translate-y-1/2 flex-col items-center gap-4 px-6 text-center"
    >
      <FlaskLogo className="size-28 text-text-300 opacity-40 md:size-32 dark:opacity-80" />
      <div className="flex flex-col gap-2">
        <h2 className="text-balance text-lg font-normal text-text-000 md:text-xl">
          {researchTitle
            ? t('What would you like to understand about this research?')
            : t('What will you research in Open-Science?')}
        </h2>
        <p className="text-xs text-text-100">
          {researchTitle
            ? t('Play the replay on the right, or ask about the archived methods and results.')
            : t('Attach data or papers, then describe what you want to find out.')}
        </p>
      </div>
      {onStartResearch ? (
        <div className="pointer-events-auto flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStartResearch(t('Analyze my data and explain the main findings.'))}
          >
            {t('Analyze data')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStartResearch(t('Compare these papers and summarize their evidence.'))}
          >
            {t('Compare papers')}
          </Button>
        </div>
      ) : null}
      {sessionImport?.canImport && sessionImport.projectId && sessionPackageImportAvailable() ? (
        <SessionPackageEntryRow projectId={sessionImport.projectId} />
      ) : null}
    </div>
  )
}

// Native scrolling preserves trackpad/touch behavior and the user's position while editing.
const NewConversationStart = ({
  onStartResearch
}: {
  onStartResearch?: (prompt: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const railRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const scenarios = [
    {
      label: t('Analyze data'),
      prompt: t('Analyze my data and explain the main findings.'),
      Icon: ChartNoAxesCombined
    },
    {
      label: t('Compare papers'),
      prompt: t('Compare these papers and summarize their evidence.'),
      Icon: Files
    },
    {
      label: t('Find literature'),
      prompt: t('Find research papers on my topic and summarize the relevant evidence.'),
      Icon: FileSearch
    },
    {
      label: t('Create charts'),
      prompt: t('Create clear charts from my data and explain what they show.'),
      Icon: ChartScatter
    },
    {
      label: t('Explain a paper'),
      prompt: t('Explain this paper’s research question, methods, findings, and limitations.'),
      Icon: BookOpen
    },
    {
      label: t('Design an experiment'),
      prompt: t('Help me design an experiment, including controls, measurements, and analysis.'),
      Icon: FlaskConical
    },
    {
      label: t('Write code'),
      prompt: t('Help me write reproducible code for my analysis and explain each step.'),
      Icon: CodeXml
    },
    {
      label: t('Draft a report'),
      prompt: t('Help me draft a research report with methods, results, and limitations.'),
      Icon: NotebookPen
    }
  ]
  const updateEdges = (): void => {
    const rail = railRef.current
    if (rail)
      setEdges({
        start: rail.scrollLeft <= 1,
        end: rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1
      })
  }
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(rail)
    updateEdges()
    return () => observer.disconnect()
  }, [t])
  const scroll = (direction: number): void => {
    const rail = railRef.current
    rail?.scrollBy({
      left: direction * rail.clientWidth * 0.75,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    })
  }
  return (
    <section data-testid="new-conversation-start" className="mb-3 px-1 md:px-3">
      <h2 className="text-2xl font-medium tracking-tight text-text-000">
        {t('What would you like to research?')}
      </h2>
      <p className="mt-2 text-sm text-text-100">
        {t('Attach data or papers, then describe what you want to find out.')}
      </p>
      <div className="relative mt-6 min-w-0">
        <div
          ref={railRef}
          data-testid="research-scenario-rail"
          onScroll={updateEdges}
          className="flex min-w-0 scroll-px-12 gap-2 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {scenarios.map(({ label, prompt, Icon }) => (
            <Button
              key={label}
              type="button"
              variant="outline"
              size="sm"
              disabled={!onStartResearch}
              className="h-9 shrink-0 gap-2 rounded-lg px-3 whitespace-nowrap focus-visible:outline-offset-[-2px]"
              onFocus={(event) =>
                event.currentTarget.scrollIntoView({
                  block: 'nearest',
                  inline: 'nearest',
                  behavior: 'instant'
                })
              }
              onClick={() => onStartResearch?.(prompt)}
            >
              <Icon className="size-4 text-text-300" aria-hidden="true" />
              {label}
            </Button>
          ))}
        </div>
        {/* Overlay controls do not reserve layout space. Keep a keyboard-focused arrow
            visible at its boundary until focus leaves, rather than dropping focus to body. */}
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center justify-start bg-gradient-to-r from-bg-10 via-bg-10/90 to-bg-10/0',
            edges.start && 'invisible has-[:focus-visible]:visible'
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('Previous research ideas')}
            aria-disabled={edges.start}
            tabIndex={edges.start ? -1 : 0}
            onClick={() => {
              if (!edges.start) scroll(-1)
            }}
            className="pointer-events-auto rounded-full bg-bg-200 text-text-100 hover:bg-bg-300 focus-visible:outline-offset-[-2px] aria-disabled:opacity-50"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-bg-10 via-bg-10/90 to-bg-10/0',
            edges.end && 'invisible has-[:focus-visible]:visible'
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('Next research ideas')}
            aria-disabled={edges.end}
            tabIndex={edges.end ? -1 : 0}
            onClick={() => {
              if (!edges.end) scroll(1)
            }}
            className="pointer-events-auto rounded-full bg-bg-200 text-text-100 hover:bg-bg-300 focus-visible:outline-offset-[-2px] aria-disabled:opacity-50"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  )
}

export { EmptyConversationBanner, NewConversationStart, SessionPackageEntryRow }
