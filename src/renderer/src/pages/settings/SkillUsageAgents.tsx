/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4
 * component: agent avatar stack · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · expanded · empty-hidden
 * contrast: semantic foreground / muted tokens · static gates: pass
 * visual gates: pending user review
 */
import { Bot, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type FocusEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { SpecialistAvatar } from './specialist-avatar'
import type { SpecialistUsage } from './specialist-resource-scope'

const AVATAR_SIZE = 20
const COLLAPSED_STEP = 11
const EXPANDED_STEP = 17
const VISIBLE_AGENT_COUNT = 3

type SkillUsageAgentsProps = {
  mainEnabled: boolean
  usages: readonly SpecialistUsage[]
  onOpenSpecialist?: (usage: SpecialistUsage) => void
  className?: string
  resourceKind?: 'Skill' | 'Connector'
}

const SkillUsageAgents = ({
  mainEnabled,
  usages,
  onOpenSpecialist,
  className,
  resourceKind = 'Skill'
}: SkillUsageAgentsProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [spread, setSpread] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)
  const openedFromPointerRef = useRef(false)
  const closedFromScrollRef = useRef(false)

  const agentCount = usages.length + (mainEnabled ? 1 : 0)
  const visibleSpecialistCount = Math.max(0, VISIBLE_AGENT_COUNT - (mainEnabled ? 1 : 0))
  const visibleUsages = usages.slice(0, visibleSpecialistCount)
  const overflowCount = Math.max(0, usages.length - visibleUsages.length)
  const slotCount = (mainEnabled ? 1 : 0) + visibleUsages.length + (overflowCount > 0 ? 1 : 0)
  const stackWidth = AVATAR_SIZE + Math.max(0, slotCount - 1) * EXPANDED_STEP

  const cancelClose = (): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }

  const scheduleClose = (): void => {
    cancelClose()
    if (pinnedRef.current) return
    closeTimerRef.current = setTimeout(() => {
      const focused = document.activeElement
      if (triggerRef.current?.contains(focused) || contentRef.current?.contains(focused)) return
      setOpen(false)
      setSpread(false)
    }, 120)
  }

  const handleBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    if (triggerRef.current?.contains(next) || contentRef.current?.contains(next)) return
    scheduleClose()
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!open) return

    const closeOnExternalScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && contentRef.current?.contains(target)) return
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
      pinnedRef.current = false
      closedFromScrollRef.current = true
      setOpen(false)
      setSpread(false)
    }

    document.addEventListener('scroll', closeOnExternalScroll, true)
    return () => document.removeEventListener('scroll', closeOnExternalScroll, true)
  }, [open])

  const slotStyle = (index: number): React.CSSProperties => ({
    transform: `translate(${index * (spread ? EXPANDED_STEP : COLLAPSED_STEP)}px, -50%)`,
    zIndex: slotCount - index
  })

  if (agentCount === 0) return null

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) closedFromScrollRef.current = false
        if (!nextOpen) {
          pinnedRef.current = false
          setSpread(false)
        }
      }}
    >
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={
            resourceKind === 'Connector'
              ? t('View Connector availability for {{count}} agents', {
                  count: agentCount,
                  defaultValue_one: 'View Connector availability for {{count}} agent'
                })
              : t('View Skill availability for {{count}} agents', {
                  count: agentCount,
                  defaultValue_one: 'View Skill availability for {{count}} agent'
                })
          }
          data-slot="skill-usage-agents-trigger"
          data-resource-kind={resourceKind.toLowerCase()}
          data-main-enabled={mainEnabled ? 'true' : 'false'}
          className={cn(
            'relative h-6 shrink-0 rounded-md outline-none ring-offset-background transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:bg-muted disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-11',
            className
          )}
          style={{ width: stackWidth }}
          onPointerEnter={() => {
            openedFromPointerRef.current = true
            cancelClose()
            setSpread(true)
            setOpen(true)
          }}
          onPointerLeave={scheduleClose}
          onFocus={() => {
            openedFromPointerRef.current = false
            cancelClose()
            setSpread(true)
            setOpen(true)
          }}
          onBlur={handleBlur}
          onClick={() => {
            openedFromPointerRef.current = false
            pinnedRef.current = true
            cancelClose()
            setSpread(true)
            setOpen(true)
          }}
        >
          {mainEnabled ? (
            <span
              data-slot="skill-usage-main-avatar"
              className="absolute top-1/2 left-0 flex size-5 items-center justify-center rounded-md bg-muted text-foreground ring-1 ring-background transition-transform duration-150 motion-reduce:transition-none"
              style={slotStyle(0)}
              aria-hidden="true"
            >
              <Bot className="size-3" strokeWidth={2} />
            </span>
          ) : null}
          {visibleUsages.map((usage, index) => (
            <span
              key={usage.id}
              data-slot="skill-usage-agent-avatar"
              data-agent-id={usage.id}
              className="absolute top-1/2 left-0 rounded-md ring-1 ring-background transition-transform duration-150 motion-reduce:transition-none"
              style={slotStyle(index + (mainEnabled ? 1 : 0))}
              aria-hidden="true"
            >
              <SpecialistAvatar iconKey={usage.iconKey} colorKey={usage.colorKey} size="sm" />
            </span>
          ))}
          {overflowCount > 0 ? (
            <span
              data-slot="skill-usage-agents-overflow"
              className="absolute top-1/2 left-0 flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-1 ring-background transition-transform duration-150 motion-reduce:transition-none"
              style={slotStyle(slotCount - 1)}
              aria-hidden="true"
            >
              +{overflowCount}
            </span>
          ) : null}
        </button>
      </PopoverAnchor>

      <PopoverContent
        ref={contentRef}
        data-slot="skill-usage-agents-popover"
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-max min-w-40 max-w-[min(15rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
        onPointerEnter={() => {
          cancelClose()
          setSpread(true)
        }}
        onPointerLeave={scheduleClose}
        onFocusCapture={() => {
          cancelClose()
          setSpread(true)
        }}
        onBlurCapture={handleBlur}
        onOpenAutoFocus={(event) => {
          if (openedFromPointerRef.current && !pinnedRef.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (!closedFromScrollRef.current) return
          event.preventDefault()
          closedFromScrollRef.current = false
        }}
      >
        <p
          data-slot="skill-usage-agents-title"
          className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground"
        >
          {t('Used by Agents and Specialists')}
        </p>
        <div className="max-h-[min(45vh,16rem)] overflow-y-auto overscroll-contain">
          {mainEnabled ? (
            <div
              data-slot="skill-usage-main-row"
              className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground [@media(pointer:coarse)]:min-h-11"
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-foreground"
                aria-hidden="true"
              >
                <Bot className="size-3" strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1 truncate">{t('Main Agent')}</span>
            </div>
          ) : null}
          {usages.map((usage) => (
            <button
              key={usage.id}
              type="button"
              data-slot="skill-usage-specialist-row"
              className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
              aria-label={t('Open {{name}} in Specialist Settings', { name: usage.name })}
              onClick={() => {
                pinnedRef.current = false
                setOpen(false)
                onOpenSpecialist?.(usage)
              }}
            >
              <SpecialistAvatar iconKey={usage.iconKey} colorKey={usage.colorKey} size="sm" />
              <span className="min-w-0 flex-1 truncate">{usage.name}</span>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { SkillUsageAgents }
