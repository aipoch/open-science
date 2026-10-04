import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, GitFork, Info, PackageOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { sessionPackageImportAvailable } from '@/components/session-package-import-menu-model'
import { importSessionPackage } from '@/lib/session-package-import'

import { FlaskLogo } from '@/components/flask-logo'

const SessionPackageEntryRow = ({ projectId }: { projectId: string }): React.JSX.Element => {
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
      className="pointer-events-auto mt-2.5 flex w-[420px] max-w-full items-center gap-3 rounded-[10px] border-[1.5px] border-dashed border-bg-400 bg-transparent px-4 py-3 text-left transition-colors hover:border-text-300 hover:bg-bg-200/50"
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
      <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-bg-200 text-text-200 transition-colors">
        <PackageOpen className="size-[15px]" aria-hidden="true" />
      </span>
      <button
        type="button"
        aria-label={t('Choose a .science file')}
        className="min-w-0 flex-1 cursor-pointer text-left transition-colors hover:text-text-000 focus-visible:keyboard-focus"
        onClick={browse}
      >
        <span className="block text-[13px] font-medium text-text-000">
          {t('Import previous research')}
        </span>
        <span className="mt-0.5 block text-xs text-text-100">
          {t('Drag a .science research package onto this page, or choose a file')}
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
      <div className="flex max-w-xl flex-col gap-2">
        <h2 className="text-balance text-lg font-normal text-text-000 md:text-xl">
          {researchTitle
            ? t('Discussing {{title}}', { title: researchTitle })
            : t('What will you research in Open-Science?')}
        </h2>
        <p className="text-xs text-text-100">
          {researchTitle
            ? t(
                'Ask about the recorded research while watching its replay. Your discussion is saved separately; the original research stays unchanged.'
              )
            : t('Attach data or papers, then describe what you want to find out.')}
        </p>
      </div>
      {onStartResearch ? (
        <div className="pointer-events-auto flex flex-wrap justify-center gap-2">
          {researchTitle ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartResearch(t('Summarize this research and its main findings.'))}
              >
                {t('Summarize research')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartResearch(t('What evidence supports the conclusions?'))}
              >
                {t('Examine the evidence')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartResearch(t('What has not been verified yet?'))}
              >
                {t('Identify limitations')}
              </Button>
            </>
          ) : (
            <>
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
                onClick={() =>
                  onStartResearch(t('Compare these papers and summarize their evidence.'))
                }
              >
                {t('Compare papers')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {!researchTitle &&
      sessionImport?.canImport &&
      sessionImport.projectId &&
      sessionPackageImportAvailable() ? (
        <SessionPackageEntryRow projectId={sessionImport.projectId} />
      ) : null}
    </div>
  )
}

export { EmptyConversationBanner }
