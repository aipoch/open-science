import { ErrorNotice } from '@/components/error-notice'
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Check, LoaderCircle, Plus, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PreferenceWriteResult } from '@/stores/settings-preferences-slice'

type SettingsSectionProps = Omit<ComponentProps<'section'>, 'title'> & {
  title: ReactNode
  titleId?: string
  headingAs?: 'h2' | 'h3'
  // Optional decorative glyph rendered just before the title (e.g. a language logo).
  icon?: ReactNode
  description?: ReactNode
  action?: ReactNode
  separated?: boolean
  headerClassName?: string
  actionClassName?: string
  contentClassName?: string
}

// Keeps first-level settings groups aligned without turning every group into a card.
const SettingsSection = ({
  title,
  titleId,
  headingAs: Heading = 'h3',
  icon,
  description,
  action,
  separated = false,
  headerClassName,
  actionClassName,
  contentClassName,
  className,
  children,
  ...props
}: SettingsSectionProps): React.JSX.Element => (
  <section
    data-slot="settings-section"
    className={cn(separated && 'border-t border-border pt-5', className)}
    {...props}
  >
    <div
      className={cn('flex flex-wrap items-start justify-between gap-3 sm:gap-4', headerClassName)}
    >
      <div className="min-w-0 flex-1">
        <Heading
          id={titleId}
          className="flex min-w-0 items-center gap-2 break-words text-[17px] leading-6 font-medium text-foreground"
        >
          {icon ? (
            <span
              className="inline-flex size-5 shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              {icon}
            </span>
          ) : null}
          {title}
        </Heading>
        {description ? (
          <p className="mt-0.5 max-w-2xl break-words text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className={cn('shrink-0', actionClassName)}>{action}</div> : null}
    </div>
    <div className={cn('mt-3 min-w-0', contentClassName)}>{children}</div>
  </section>
)

// Shared provider-list affordance; keeps the add action next to the resources it creates.
const SettingsListAddAction = ({
  children,
  className,
  ...props
}: ComponentProps<'button'>): React.JSX.Element => (
  <button
    type="button"
    className={cn(
      'mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
      className
    )}
    {...props}
  >
    <Plus className="size-4" aria-hidden="true" />
    {children}
  </button>
)

const SettingsFormFooter = ({
  children,
  className,
  ...props
}: ComponentProps<'div'>): React.JSX.Element => (
  <div className={cn('shrink-0 border-t border-border bg-card', className)} {...props}>
    <div className="mx-auto max-w-[880px] space-y-3 px-5 py-4">{children}</div>
  </div>
)

type SettingsRowProps = ComponentProps<'div'> & {
  label?: ReactNode
  description?: ReactNode
  controlClassName?: string
  layout?: 'standard' | 'model-effort'
}

// Aligns descriptive copy and controls to a stable two-column settings grid.
const SettingsRow = ({
  label,
  description,
  controlClassName,
  layout = 'standard',
  className,
  children,
  ...props
}: SettingsRowProps): React.JSX.Element => (
  <div
    data-slot="settings-row"
    className={cn(
      layout === 'standard'
        ? 'grid min-h-14 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,20rem)] sm:gap-6'
        : 'grid grid-cols-1 gap-3 py-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
      className
    )}
    {...props}
  >
    {layout === 'standard' ? (
      <>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {description ? (
            <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</div>
          ) : null}
        </div>
        <div className={cn('flex min-w-0 justify-end', controlClassName)}>{children}</div>
      </>
    ) : (
      children
    )}
  </div>
)

type SettingsFieldProps = ComponentProps<'label'> & { label: ReactNode }

const SettingsField = ({
  label,
  className,
  children,
  ...props
}: SettingsFieldProps): React.JSX.Element => (
  <label
    data-slot="settings-field"
    className={cn('grid min-w-0 gap-1.5 text-sm font-medium', className)}
    {...props}
  >
    {label}
    {children}
  </label>
)

type SettingsToggleProps = Omit<ComponentProps<typeof Switch>, 'checked' | 'onCheckedChange'> & {
  enabled: boolean
  onToggle: () => void
}

// The Switch's own ::after hit-area expansion is absorbed by the row and panel padding, so the
// toggle's visible edge stays flush with the other controls in the row's control column.
const SettingsToggle = ({
  enabled,
  onToggle,
  className,
  ...props
}: SettingsToggleProps): React.JSX.Element => (
  <Switch checked={enabled} onCheckedChange={onToggle} className={className} {...props} />
)

const SAVED_VISIBLE_MS = 1700
const SAVED_FADE_MS = 300

type SettingsPreferenceToggleProps = Omit<
  ComponentProps<typeof Switch>,
  'checked' | 'onCheckedChange' | 'onToggle'
> & {
  enabled: boolean
  // Resolves with how the write settled; the promise never rejects (preference setters roll back
  // optimistically and report through the result instead).
  onToggle: (nextEnabled: boolean) => Promise<PreferenceWriteResult>
}

// Preference toggle with per-row save feedback: dimmed and non-interactive while the write is in
// flight, a transient Saved check on success, and an inline revert notice with Retry on failure.
// The value itself still flips optimistically via the store.
const SettingsPreferenceToggle = ({
  enabled,
  onToggle,
  disabled,
  className,
  ...props
}: SettingsPreferenceToggleProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'fading' | 'failed'>('idle')
  const requestRef = useRef(0)

  useEffect(() => {
    if (phase !== 'saved' && phase !== 'fading') return
    const timer = setTimeout(
      () => setPhase(phase === 'saved' ? 'fading' : 'idle'),
      phase === 'saved' ? SAVED_VISIBLE_MS : SAVED_FADE_MS
    )
    return () => clearTimeout(timer)
  }, [phase])

  const runToggle = (): void => {
    // After a revert the store holds the previous value again, so !enabled re-attempts the same
    // intended value — this is also what Retry does.
    const next = !enabled
    const request = ++requestRef.current
    setPhase('saving')
    void onToggle(next).then((result) => {
      if (request !== requestRef.current) return
      setPhase(result === 'saved' ? 'saved' : result === 'reverted' ? 'failed' : 'idle')
    })
  }

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {phase === 'saved' || phase === 'fading' ? (
          <span
            role="status"
            className={cn(
              'inline-flex items-center gap-1 text-xs font-medium text-status-success-foreground transition-opacity duration-300 motion-reduce:transition-none dark:text-status-success-dark-foreground',
              phase === 'fading' && 'opacity-0'
            )}
          >
            <Check className="size-3.5" aria-hidden="true" />
            {t('Saved')}
          </span>
        ) : null}
        <Switch
          checked={enabled}
          disabled={disabled || phase === 'saving'}
          aria-busy={phase === 'saving' || undefined}
          onCheckedChange={runToggle}
          className={className}
          {...props}
        />
      </div>
      {phase === 'failed' ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-end gap-x-2 text-xs text-status-failure-foreground dark:text-status-failure-dark-foreground"
        >
          <span>{t("Couldn't save this setting. It was reverted.")}</span>
          <button
            type="button"
            className="cursor-pointer rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={runToggle}
          >
            {t('Retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

type SettingsLoadNoticeProps = {
  state: 'loading' | 'error'
  loadingLabel: string
  errorMessage: string
  onRetry: () => void
  className?: string
}

// Keeps request loading and failure visually distinct from a successful empty Settings surface.
const SettingsLoadNotice = ({
  state,
  loadingLabel,
  errorMessage,
  onRetry,
  className
}: SettingsLoadNoticeProps): React.JSX.Element => {
  const { t } = useTranslation()

  if (state === 'loading') {
    return (
      <div
        role="status"
        className={cn(
          'flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground',
          className
        )}
      >
        <LoaderCircle
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>{loadingLabel}</span>
      </div>
    )
  }

  return (
    <ErrorNotice
      role="alert"
      className={className}
      description={errorMessage}
      primaryButton={{ label: t('Retry'), onClick: onRetry }}
    />
  )
}

type SettingsIconActionProps = Omit<
  ComponentProps<typeof Button>,
  'aria-label' | 'children' | 'size' | 'variant'
> & {
  label: string
  icon: LucideIcon
  danger?: boolean
  tooltip?: string
}

// Keeps compact settings actions consistent and gives every icon-only control a visible name.
const SettingsIconAction = ({
  label,
  icon: Icon,
  danger = false,
  tooltip,
  className,
  ...props
}: SettingsIconActionProps): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={cn(
          'shrink-0 text-muted-foreground',
          danger && 'hover:bg-destructive/10 hover:text-destructive',
          className
        )}
        {...props}
      >
        <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{tooltip ?? label}</TooltipContent>
  </Tooltip>
)

export {
  SettingsField,
  SettingsFormFooter,
  SettingsListAddAction,
  SettingsIconAction,
  SettingsLoadNotice,
  SettingsPreferenceToggle,
  SettingsRow,
  SettingsSection,
  SettingsToggle
}
