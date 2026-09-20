import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ArtifactReproducibilityCheckLog } from '../../../../shared/artifact-reproducibility'

const formatElapsedClock = (milliseconds: number): string => {
  const totalSeconds = Number.isFinite(milliseconds)
    ? Math.max(0, Math.floor(milliseconds / 1_000))
    : 0
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export const CheckElapsedTime = ({ startedAt }: { startedAt: string }): React.JSX.Element => {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const duration = formatElapsedClock(now - Date.parse(startedAt))
  return (
    <span className="text-[11px] tabular-nums text-text-000/65">
      {t('Elapsed {{duration}}', { duration })}
    </span>
  )
}

export const EnvironmentRestoreHint = ({
  startedAt
}: {
  startedAt: string
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(() => Date.now() - Date.parse(startedAt) >= 30_000)
  useEffect(() => {
    const timer = window.setTimeout(
      () => setVisible(true),
      Math.max(0, 30_000 - (Date.now() - Date.parse(startedAt)))
    )
    return () => window.clearTimeout(timer)
  }, [startedAt])
  return visible ? (
    <p className="mt-1.5 max-w-xl">
      {t('The first environment restore may take a few minutes. Cached packages are reused.')}
    </p>
  ) : null
}

export const ReproducibilityLogViewport = ({
  children,
  logs
}: {
  children: ReactNode
  logs: readonly ArtifactReproducibilityCheckLog[]
}): React.JSX.Element => {
  const { t } = useTranslation()
  const viewport = useRef<HTMLDivElement>(null)
  const followTail = useRef(true)
  const previousLogs = useRef(logs)
  const [hasNewOutput, setHasNewOutput] = useState(false)
  useLayoutEffect(() => {
    const changed =
      logs.length !== previousLogs.current.length ||
      logs.some((entry, index) => entry.text !== previousLogs.current[index]?.text)
    previousLogs.current = logs
    if (followTail.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    } else if (changed) {
      setHasNewOutput(true)
    }
  }, [children, logs])
  return (
    <div className="relative">
      <div
        ref={viewport}
        role="log"
        tabIndex={0}
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const element = event.currentTarget
          const next = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
          followTail.current = next
          if (next) setHasNewOutput(false)
        }}
        className="min-h-16 max-h-52 space-y-3 overflow-auto px-3 py-2.5 font-mono text-[11px] leading-5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </div>
      {hasNewOutput ? (
        <div className="pointer-events-none absolute right-3 bottom-2">
          <TooltipProvider delayDuration={350}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={t('Latest output')}
                  className="pointer-events-auto rounded-full shadow-sm"
                  onClick={() => {
                    followTail.current = true
                    setHasNewOutput(false)
                    if (viewport.current) {
                      viewport.current.scrollTop = viewport.current.scrollHeight
                      viewport.current.focus({ preventScroll: true })
                    }
                  }}
                >
                  <ArrowDownToLine className="size-3" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('Latest output')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : null}
    </div>
  )
}
