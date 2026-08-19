/* Hallmark · component: Specialist appearance picker · genre: modern-minimal · theme: Open Science Settings
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: uses the project semantic foreground, muted, ring, destructive, and success tokens
 * pre-emit critique: P5 H4 E5 S5 R5 V5
 */
import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { APP_ICON_GROUPS } from '@/components/app-icons/registry'
import { cn } from '@/lib/utils'
import { SpecialistAvatar } from './specialist-avatar'
import { AVATAR_COLORS, SPECIALIST_COLOR_OPTIONS } from './specialist-icons'

type SpecialistAppearancePatch = {
  iconKey?: string
  colorKey?: string
}

type AppearancePickerPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

type SaveState = 'idle' | 'saving' | 'error' | 'success'

type SpecialistAppearancePickerProps = {
  name: string
  iconKey?: string
  colorKey?: string
  disabled?: boolean
  onChange: (patch: SpecialistAppearancePatch) => Promise<void>
  previewState?: AppearancePickerPreviewState
}

const previewStateClassName: Record<AppearancePickerPreviewState, string> = {
  default: '',
  hover: 'bg-muted',
  focus: 'ring-2 ring-ring ring-offset-2 ring-offset-background',
  active: 'translate-y-px bg-muted/80',
  disabled: 'cursor-not-allowed opacity-50',
  loading: 'cursor-wait opacity-80',
  error: 'ring-2 ring-destructive ring-offset-2 ring-offset-background',
  success: 'ring-2 ring-status-success-accent ring-offset-2 ring-offset-background'
}

const SpecialistAppearancePicker = ({
  name,
  iconKey,
  colorKey,
  disabled = false,
  onChange,
  previewState
}: SpecialistAppearancePickerProps): React.JSX.Element => {
  const { t } = useTranslation()
  const colorHeadingId = useId()
  const iconHeadingId = useId()
  const iconScrollRef = useRef<HTMLDivElement>(null)
  const selectedIconRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pendingPatch, setPendingPatch] = useState<SpecialistAppearancePatch>()
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [showSaving, setShowSaving] = useState(false)

  useEffect(() => {
    if (saveState !== 'saving') return
    const timer = window.setTimeout(() => setShowSaving(true), 150)
    return () => window.clearTimeout(timer)
  }, [saveState])

  useEffect(() => {
    if (saveState !== 'success') return
    const timer = window.setTimeout(() => setSaveState('idle'), 1200)
    return () => window.clearTimeout(timer)
  }, [saveState])

  const save = async (patch: SpecialistAppearancePatch): Promise<void> => {
    if (disabled || saveState === 'saving') return
    setShowSaving(false)
    setPendingPatch(patch)
    setSaveState('saving')
    try {
      await onChange(patch)
      setPendingPatch(undefined)
      setShowSaving(false)
      setSaveState('success')
    } catch {
      setShowSaving(false)
      setSaveState('error')
    }
  }

  const visualState =
    previewState ??
    (saveState === 'idle' ? 'default' : saveState === 'saving' ? 'loading' : saveState)
  const interactionDisabled = disabled || saveState === 'saving' || visualState === 'disabled'
  const visibleAppearance =
    saveState === 'saving' ? { iconKey, colorKey, ...pendingPatch } : { iconKey, colorKey }

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      selectedIconRef.current?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const scroller = iconScrollRef.current
    if (!scroller || event.ctrlKey || event.deltaY === 0) return
    const multiplier =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroller.clientHeight
          : 1
    scroller.scrollTop += event.deltaY * multiplier
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={interactionDisabled}
          aria-label={t('Change appearance for {{name}}', { name })}
          aria-busy={saveState === 'saving'}
          aria-invalid={visualState === 'error' || undefined}
          data-appearance-state={visualState}
          className={cn(
            'relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:translate-y-0',
            previewStateClassName[visualState]
          )}
        >
          <SpecialistAvatar
            iconKey={visibleAppearance.iconKey}
            colorKey={visibleAppearance.colorKey}
          />
          {(showSaving || previewState === 'loading') && (
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/75">
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            </span>
          )}
          {visualState === 'success' ? (
            <CheckCircle2
              className="absolute -end-1 -top-1 size-4 rounded-full bg-background text-status-success-accent"
              aria-hidden="true"
            />
          ) : null}
          {visualState === 'error' ? (
            <AlertCircle
              className="absolute -end-1 -top-1 size-4 rounded-full bg-background text-destructive"
              aria-hidden="true"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        onWheel={handleWheel}
        className="w-64 max-w-[var(--radix-popover-content-available-width)] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-menu"
      >
        <p className="text-xs font-semibold text-foreground">{t('Appearance')}</p>

        <div className="mt-2" role="group" aria-labelledby={colorHeadingId}>
          <p id={colorHeadingId} className="text-xs font-medium text-muted-foreground">
            {t('Color')}
          </p>
          <div className="mt-1 grid grid-cols-3 gap-1 pe-2.5 sm:grid-cols-6 [@media(pointer:coarse)]:grid-cols-3">
            {SPECIALIST_COLOR_OPTIONS.map((option) => {
              const selected = visibleAppearance.colorKey === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  disabled={interactionDisabled}
                  aria-label={t(option.label)}
                  aria-pressed={selected}
                  onClick={() => {
                    if (!selected) void save({ colorKey: option.key })
                  }}
                  className="flex h-9 w-full max-w-9 cursor-pointer items-center justify-center justify-self-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:translate-y-0 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:max-w-11"
                >
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-md border border-foreground/10',
                      selected && 'ring-2 ring-primary ring-offset-2 ring-offset-popover'
                    )}
                    style={{ background: AVATAR_COLORS[option.key] }}
                    aria-hidden="true"
                  >
                    {selected ? <Check className="size-3 text-foreground" /> : null}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-2" role="group" aria-labelledby={iconHeadingId}>
          <p id={iconHeadingId} className="text-xs font-medium text-muted-foreground">
            {t('Icon')}
          </p>
          <div
            ref={iconScrollRef}
            data-slot="specialist-icon-picker-scroll"
            tabIndex={0}
            aria-labelledby={iconHeadingId}
            className="mt-1 h-44 overflow-y-auto overscroll-contain rounded-sm outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-scrollbar]:hidden"
          >
            <div className="pe-2.5">
              {APP_ICON_GROUPS.map((group, groupIndex) => (
                <div
                  key={group.key}
                  role="group"
                  aria-label={t(group.label)}
                  className={cn(groupIndex > 0 && 'mt-2')}
                >
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    {t(group.label)}
                  </p>
                  <div className="grid grid-cols-3 gap-1 sm:grid-cols-6 [@media(pointer:coarse)]:grid-cols-3">
                    {group.icons.map((option) => {
                      const selected = visibleAppearance.iconKey === option.key
                      return (
                        <button
                          key={option.key}
                          ref={selected ? selectedIconRef : undefined}
                          type="button"
                          disabled={interactionDisabled}
                          aria-label={t(option.label)}
                          aria-pressed={selected}
                          onClick={() => {
                            if (!selected) void save({ iconKey: option.key })
                          }}
                          className={cn(
                            'flex h-9 w-full max-w-9 cursor-pointer items-center justify-center justify-self-center rounded-md border border-transparent text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:translate-y-0 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:max-w-11',
                            selected && 'border-primary/30 bg-primary/10 text-primary'
                          )}
                        >
                          <option.Icon className="size-4" aria-hidden="true" />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {saveState !== 'idle' ? (
          <div
            className="mt-1 flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {saveState === 'saving' && showSaving ? (
              <>
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                <span>{t('Saving…')}</span>
              </>
            ) : saveState === 'success' ? (
              <>
                <CheckCircle2 className="size-3.5 text-status-success-accent" aria-hidden />
                <span>{t('Saved')}</span>
              </>
            ) : saveState === 'error' ? (
              <>
                <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
                <span className="min-w-0 flex-1 text-destructive">
                  {t('Appearance wasn’t saved. Try again.')}
                </span>
                <button
                  type="button"
                  className="min-h-9 shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-1 font-medium text-foreground underline underline-offset-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px motion-reduce:active:translate-y-0 [@media(pointer:coarse)]:min-h-11"
                  onClick={() => pendingPatch && void save(pendingPatch)}
                >
                  {t('Try again')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export { SpecialistAppearancePicker }
export type {
  AppearancePickerPreviewState,
  SpecialistAppearancePatch,
  SpecialistAppearancePickerProps
}
