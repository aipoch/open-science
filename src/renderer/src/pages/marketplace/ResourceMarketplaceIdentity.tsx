import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

const identityTones = [
  'bg-chart-1/15 text-chart-1 ring-chart-1/20',
  'bg-chart-2/15 text-chart-2 ring-chart-2/20',
  'bg-chart-3/15 text-chart-3 ring-chart-3/20',
  'bg-chart-4/15 text-chart-4 ring-chart-4/20'
] as const

const resourceInitials = (displayName: string): string => {
  const words = displayName
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
  if (words.length === 0) return 'RS'
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')
}

const ResourceMarketplaceIdentity = ({
  id,
  displayName,
  size = 'md'
}: {
  id: string
  displayName: string
  size?: 'md' | 'lg'
}): React.JSX.Element => {
  const tone =
    identityTones[
      [...id].reduce((total, character) => total + character.charCodeAt(0), 0) %
        identityTones.length
    ]
  return (
    <div
      role="img"
      aria-label={displayName}
      className={`grid shrink-0 place-items-center font-semibold tracking-tight ring-1 ${tone} ${
        size === 'lg' ? 'size-14 rounded-xl text-base' : 'size-10 rounded-lg text-xs'
      }`}
    >
      {resourceInitials(displayName)}
    </div>
  )
}

export { ResourceMarketplaceIdentity }

export const ResourceCardBody = ({
  identity,
  name,
  summary,
  attribution,
  selection,
  onOpen,
  openLabel,
  disabled = false
}: {
  identity: ReactNode
  name: string
  summary: string
  attribution?: string
  selection?: ReactNode
  onOpen?: () => void
  openLabel?: string
  disabled?: boolean
}): React.JSX.Element => (
  <div
    className={`flex min-w-0 flex-col gap-3 ${onOpen && !disabled ? 'cursor-pointer' : ''}`}
    onClick={(event) => {
      const target = event.target
      if (
        !onOpen ||
        disabled ||
        event.defaultPrevented ||
        !(target instanceof Element) ||
        !event.currentTarget.contains(target) ||
        target.closest(
          'button, a, input, select, textarea, [role="button"], [role="checkbox"], [role="switch"]'
        )
      )
        return
      event.stopPropagation()
      onOpen()
    }}
  >
    <div className="flex min-w-0 items-start gap-3">
      {identity}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {selection}
          {onOpen ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onOpen}
              aria-label={openLabel}
              title={name}
              className={`line-clamp-2 min-w-0 cursor-pointer rounded text-left text-sm font-semibold leading-5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-foreground ${attribution ? '' : 'min-h-10'}`}
            >
              {name}
            </button>
          ) : (
            <span
              className={`line-clamp-2 min-w-0 text-sm font-semibold leading-5 ${attribution ? '' : 'min-h-10'}`}
              title={name}
            >
              {name}
            </span>
          )}
        </div>
        {attribution ? (
          <p className="mt-1 truncate text-xs text-muted-foreground" title={attribution}>
            {attribution}
          </p>
        ) : null}
      </div>
    </div>
    <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground" title={summary}>
      {summary}
    </p>
  </div>
)

export const ResourceCardFooter = ({
  leading,
  children,
  onOpen,
  openLabel,
  detailLabel,
  primaryAction,
  selectionMode = false,
  disabled = false
}: {
  leading?: ReactNode
  children?: ReactNode
  onOpen: () => void
  openLabel?: string
  detailLabel?: string
  primaryAction?: ReactNode
  selectionMode?: boolean
  disabled?: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (selectionMode) {
    return leading ? (
      <div
        className="mt-auto flex min-w-0 flex-wrap items-center gap-2 empty:hidden"
        data-slot="resource-card-footer"
      >
        {leading}
      </div>
    ) : null
  }
  return (
    <div className="resource-installed-actions" data-slot="resource-card-footer">
      {leading ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden">{leading}</div>
      ) : null}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
        {children}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled}
          onClick={onOpen}
          aria-label={openLabel}
        >
          {detailLabel ?? t('View details')}
        </Button>
        {primaryAction}
      </div>
    </div>
  )
}

export const ResourceMarketplaceCardContent = ({
  id,
  name,
  publisher,
  summary,
  status,
  selection,
  primaryAction,
  onOpen
}: {
  id: string
  name: string
  publisher: string
  summary: string
  status?: ReactNode
  selection?: ReactNode
  primaryAction?: ReactNode
  onOpen: () => void
}): React.JSX.Element => {
  return (
    <>
      {selection ? <label className="resource-card-selection">{selection}</label> : null}
      <div inert={Boolean(selection)} className="flex min-w-0 flex-1 flex-col gap-3">
        <div className={selection ? 'pr-6' : undefined}>
          <ResourceCardBody
            identity={<ResourceMarketplaceIdentity id={id} displayName={name} />}
            name={name}
            summary={summary}
            attribution={publisher}
            onOpen={onOpen}
          />
        </div>
        <ResourceCardFooter
          selectionMode={Boolean(selection)}
          leading={
            status ? (
              <span className="min-w-0 text-xs text-muted-foreground">{status}</span>
            ) : undefined
          }
          onOpen={onOpen}
          primaryAction={primaryAction}
        />
      </div>
    </>
  )
}
