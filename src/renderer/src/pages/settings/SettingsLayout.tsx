import type { ComponentProps, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type SettingsSectionProps = ComponentProps<'section'> & {
  title: string
  // Optional decorative glyph rendered just before the title (e.g. a language logo).
  icon?: ReactNode
  description?: ReactNode
  action?: ReactNode
  separated?: boolean
  contentClassName?: string
}

// Keeps first-level settings groups aligned without turning every group into a card.
const SettingsSection = ({
  title,
  icon,
  description,
  action,
  separated = false,
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
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
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
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
    <div className={cn('mt-3', contentClassName)}>{children}</div>
  </section>
)

type SettingsRowProps = ComponentProps<'div'> & {
  label: ReactNode
  description?: ReactNode
  controlClassName?: string
}

// Aligns descriptive copy and controls to a stable two-column settings grid.
const SettingsRow = ({
  label,
  description,
  controlClassName,
  className,
  children,
  ...props
}: SettingsRowProps): React.JSX.Element => (
  <div
    data-slot="settings-row"
    className={cn(
      'grid min-h-14 grid-cols-[minmax(0,1fr)_minmax(12rem,20rem)] items-center gap-6 py-3',
      className
    )}
    {...props}
  >
    <div className="min-w-0">
      <div className="text-sm font-medium text-foreground">{label}</div>
      {description ? (
        <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</div>
      ) : null}
    </div>
    <div className={cn('min-w-0 justify-self-stretch', controlClassName)}>{children}</div>
  </div>
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

export { SettingsIconAction, SettingsRow, SettingsSection, SettingsToggle }
