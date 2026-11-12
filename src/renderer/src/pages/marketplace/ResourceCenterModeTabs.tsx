import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
  type ComponentType
} from 'react'
import { Tabs } from 'radix-ui'
import { ChevronDown, Ellipsis, LoaderCircle, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

type ResourceCenterMode = 'installed' | 'marketplace'
type ResourceCenterModeTabsProps = {
  value: ResourceCenterMode
  onChange: (value: ResourceCenterMode) => void
  marketplaceHidden?: boolean
  marketplaceDisabled?: boolean
  installedLabel?: string
  count?: number
}

const ResourceNavigationContext = createContext<ReactNode>(null)
export const ResourceNavigationProvider = ({
  children,
  navigation
}: {
  children: ReactNode
  navigation: ReactNode
}): React.JSX.Element => (
  <ResourceNavigationContext.Provider value={navigation}>
    {children}
  </ResourceNavigationContext.Provider>
)
export const ResourceHeading = ({
  title,
  icon: Icon
}: {
  title: string
  icon?: ComponentType<{ className?: string }>
}): React.JSX.Element => {
  const navigation = useContext(ResourceNavigationContext)
  return (
    <>
      {navigation ?? (
        <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-foreground">
          {Icon ? <Icon className="size-5 shrink-0" aria-hidden="true" /> : null}
          {title}
        </h2>
      )}
    </>
  )
}

export const ResourceCatalogHeader = ({
  title,
  icon,
  actions,
  children,
  toolbar,
  selectionBar,
  className,
  ref
}: {
  title: string
  icon?: ComponentType<{ className?: string }>
  actions?: ReactNode
  children?: ReactNode
  toolbar?: ReactNode
  selectionBar?: ReactNode
  className?: string
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element => (
  <header
    ref={ref}
    className={cn(
      '@container sticky top-0 z-20 -mx-5 -mt-5 mb-4 border-b border-border/60 bg-card px-5 py-3',
      className
    )}
    data-slot="resource-catalog-header"
  >
    <div
      className={cn(
        'grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2',
        children
          ? '@min-[26rem]:grid-cols-[auto_minmax(0,1fr)] @min-[48rem]:grid-cols-[auto_auto_minmax(0,1fr)_auto]'
          : '@min-[48rem]:grid-cols-[auto_minmax(0,1fr)_auto]'
      )}
    >
      <div className="flex min-h-8 min-w-0 items-center">
        <ResourceHeading title={title} icon={icon} />
      </div>
      {children ? (
        <div className="col-span-2 row-start-2 flex min-h-8 min-w-0 items-center @min-[26rem]:col-span-1 @min-[48rem]:col-start-2 @min-[48rem]:row-start-1 @min-[48rem]:ml-2">
          {children}
        </div>
      ) : null}
      {toolbar ? (
        <div
          className={cn(
            'col-span-2 min-w-0 @min-[48rem]:col-span-1 @min-[48rem]:row-start-1',
            children
              ? 'row-start-3 @min-[26rem]:col-span-1 @min-[26rem]:col-start-2 @min-[26rem]:row-start-2 @min-[48rem]:col-start-3'
              : 'row-start-2 @min-[48rem]:col-start-2'
          )}
        >
          {toolbar}
        </div>
      ) : null}
      <div
        className={cn(
          'col-start-2 row-start-1 flex items-center justify-end gap-2 empty:hidden [&_button]:h-8 @max-[20rem]:[&_button]:w-8 @max-[20rem]:[&_button]:min-w-0 @max-[20rem]:[&_button]:gap-0 @max-[20rem]:[&_button]:px-0 @max-[20rem]:[&_button]:text-[0px] @max-[20rem]:[&_button>svg:not(:first-child)]:hidden',
          children ? '@min-[48rem]:col-start-4' : '@min-[48rem]:col-start-3'
        )}
      >
        {actions}
      </div>
    </div>
    {selectionBar}
  </header>
)

/** Keep catalog chrome in place while its lazy module or initial data is loading. */
export const ResourceCatalogPending = ({
  title,
  icon,
  marketplaceHidden = false,
  mode = 'installed',
  children
}: {
  title: string
  icon: ComponentType<{ className?: string }>
  marketplaceHidden?: boolean
  mode?: ResourceCenterMode
  children?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="p-5">
      <ResourceCatalogHeader
        title={title}
        icon={icon}
        actions={
          <div aria-hidden="true" className="h-8 w-32 rounded-md bg-muted @max-[20rem]:w-8" />
        }
        toolbar={
          <div aria-hidden="true" className="flex h-8 min-w-0 items-center justify-end gap-2">
            <div className="h-8 min-w-0 max-w-56 flex-1 rounded-md bg-muted" />
            <div className="size-8 shrink-0 rounded-md bg-muted" />
          </div>
        }
      >
        <div inert aria-hidden="true">
          <ResourceCenterModeTabs
            value={mode}
            marketplaceHidden={marketplaceHidden}
            onChange={() => {}}
          />
        </div>
      </ResourceCatalogHeader>
      {children ?? (
        <div
          role="status"
          className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>{t('Loading…')}</span>
        </div>
      )}
    </div>
  )
}

/** Field identity stays visible when its selected value is only “All”. */
export const ResourceCatalogFilter = ({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element => (
  <div className="flex min-w-0 items-center gap-3" data-slot="resource-catalog-filter">
    <span
      data-slot="resource-filter-label"
      className="shrink-0 break-words text-xs text-muted-foreground"
    >
      {label}
    </span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
)

export const ResourceCatalogToolbar = ({
  search,
  trailing,
  children,
  activeFilterCount = 0,
  onResetFilters,
  resetFiltersDisabled = false,
  className,
  ref,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  search: ReactNode
  trailing?: ReactNode
  children?: ReactNode
  activeFilterCount?: number
  onResetFilters?: () => void
  resetFiltersDisabled?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = (width: number): void => {
      if (width <= 0) return
      const nextCompact = width < 1080
      setCompact(nextCompact)
      if (!nextCompact) setOpen(false)
    }
    // ResizeObserver's first delivery can follow paint. Resolve the initial layout now so
    // mounting a catalog never briefly expands its filters and pushes the content down.
    measure(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const resetFilters = onResetFilters ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={onResetFilters}
      disabled={activeFilterCount === 0 || resetFiltersDisabled}
      className="shrink-0"
    >
      {t('Reset filters')}
    </Button>
  ) : null
  const filters = (
    <div
      className={cn(
        'flex min-w-0 gap-2 [&_[role=combobox]]:max-w-full',
        compact
          ? 'flex-col [&_[role=combobox]]:w-full [&_[data-slot=resource-filter-label]]:w-24'
          : 'items-center'
      )}
    >
      {children}
    </div>
  )
  return (
    <div
      ref={(element) => {
        containerRef.current = element
        if (typeof ref === 'function') return ref(element)
        if (ref) ref.current = element
      }}
      className={cn(
        '@container flex min-w-0 items-center justify-end gap-2 [&_button]:h-8',
        compact ? 'flex-nowrap' : 'flex-wrap',
        className
      )}
      {...props}
    >
      <div className="min-w-0 flex-1 basis-20 @min-[26rem]:max-w-56">{search}</div>
      {children ? (
        compact ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size={activeFilterCount > 0 ? 'sm' : 'icon-sm'}
                aria-label={t('Filters')}
                title={t('Filters')}
                className={cn(
                  'shrink-0',
                  activeFilterCount > 0 && 'border-primary/40 text-primary'
                )}
              >
                <SlidersHorizontal className="size-4" aria-hidden="true" />
                {activeFilterCount > 0 ? (
                  <span className="text-xs tabular-nums">{activeFilterCount}</span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              aria-label={t('Filters')}
              className="w-96 max-w-[calc(100vw-2rem)] space-y-3 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-foreground">{t('Filters')}</h3>
                {resetFilters}
              </div>
              {filters}
            </PopoverContent>
          </Popover>
        ) : (
          <>
            {filters}
            {resetFilters}
          </>
        )
      ) : null}
      {trailing ? (
        <div className="flex shrink-0 items-center justify-end gap-2 [&>[role=status]]:hidden @min-[40rem]:[&>[role=status]]:block">
          {trailing}
        </div>
      ) : null}
    </div>
  )
}

export const ResourceCatalogActions = ({
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  items,
  menuTriggerRef,
  children
}: {
  onRefresh?: () => void
  refreshing?: boolean
  refreshDisabled?: boolean
  items: readonly { label: string; onSelect: () => void; disabled?: boolean }[]
  menuTriggerRef?: React.Ref<HTMLButtonElement>
  children?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <>
      {children}
      {onRefresh ? (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('Refresh')}
          title={t('Refresh')}
          disabled={refreshing || refreshDisabled}
          onClick={onRefresh}
        >
          <RefreshCw
            className={cn('size-4', refreshing && 'animate-spin motion-reduce:animate-none')}
            aria-hidden="true"
          />
        </Button>
      ) : null}
      {items.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              ref={menuTriggerRef}
              aria-label={t('More actions')}
              title={t('More actions')}
            >
              <Ellipsis className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {items.map((item) => (
              <DropdownMenuItem key={item.label} onSelect={item.onSelect} disabled={item.disabled}>
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  )
}

const ResourceCenterModeTabs = ({
  value,
  onChange,
  marketplaceHidden = false,
  marketplaceDisabled = false,
  count,
  installedLabel
}: ResourceCenterModeTabsProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next) => onChange(next as ResourceCenterMode)}
      activationMode="manual"
    >
      <Tabs.List
        aria-label={t('Resource center')}
        className="inline-flex max-w-full items-center gap-4"
      >
        {(['installed', 'marketplace'] as const)
          .filter((mode) => mode !== 'marketplace' || !marketplaceHidden)
          .map((mode) => (
            <Tabs.Trigger
              key={mode}
              value={mode}
              disabled={mode === 'marketplace' && marketplaceDisabled}
              className={cn(
                'relative flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-0.5 text-sm font-medium transition-colors motion-reduce:transition-none focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
                value === mode
                  ? 'border-primary text-primary'
                  : 'text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              {mode === 'installed' ? (installedLabel ?? t('Installed')) : t('Marketplace')}
              {mode === 'installed' && count !== undefined ? (
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              ) : null}
            </Tabs.Trigger>
          ))}
      </Tabs.List>
    </Tabs.Root>
  )
}
export { ResourceCenterModeTabs }
export type { ResourceCenterMode, ResourceCenterModeTabsProps }

export const ResourceGroupHeader = ({
  label,
  count,
  expanded,
  onToggle,
  children
}: {
  label: string
  count: number
  expanded: boolean
  onToggle: () => void
  children?: ReactNode
}): React.JSX.Element => (
  <div
    className="sticky top-[var(--resource-filter-height,0px)] z-10 -mx-5 flex min-h-10 flex-wrap items-center justify-between gap-2 bg-card px-5 py-1"
    data-slot="resource-group-header"
  >
    <h3 className="min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-h-6 items-center gap-2 rounded-md text-left text-sm font-semibold text-foreground outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {label}
        <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            !expanded && '-rotate-90'
          )}
          aria-hidden="true"
        />
      </button>
    </h3>
    {children}
  </div>
)
