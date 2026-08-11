import type { ComponentProps, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type SettingsSectionProps = ComponentProps<'section'> & {
  title: string
  titleId?: string
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
      <div className="min-w-0">
        <h3
          id={titleId}
          className="flex items-center gap-2 text-base font-semibold text-foreground"
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
        </h3>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className={cn('shrink-0', actionClassName)}>{action}</div> : null}
    </div>
    <div className={cn('mt-3', contentClassName)}>{children}</div>
  </section>
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
        : 'grid grid-cols-1 gap-3 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
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
        <div className={cn('min-w-0 justify-self-stretch', controlClassName)}>{children}</div>
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

// Reserves the Switch hit-area expansion so it cannot overlap adjacent row actions or the scroller.
const SettingsToggle = ({
  enabled,
  onToggle,
  className,
  ...props
}: SettingsToggleProps): React.JSX.Element => (
  <Switch
    checked={enabled}
    onCheckedChange={onToggle}
    className={cn('ml-1 mr-3', className)}
    {...props}
  />
)

type SettingsIconActionProps = Omit<
  ComponentProps<typeof Button>,
  'aria-label' | 'children' | 'size' | 'variant'
> & {
  label: string
  icon: LucideIcon
  danger?: boolean
}

// Keeps compact settings actions consistent and gives every icon-only control a visible name.
const SettingsIconAction = ({
  label,
  icon: Icon,
  danger = false,
  className,
  ...props
}: SettingsIconActionProps): React.JSX.Element => (
  <TooltipProvider delayDuration={200}>
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
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

export { SettingsField, SettingsIconAction, SettingsRow, SettingsSection, SettingsToggle }
