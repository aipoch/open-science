import { createContext, useContext, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

const DetailActionTarget = createContext<{
  container: HTMLDivElement | null
  onClose: () => void
  closeLabel?: string
} | null>(null)
export const ResourceDetailActionsProvider = DetailActionTarget.Provider

// Keep effects with each resource owner; only move its controls out of the scrolling body.
export const ResourceDetailActions = ({
  leading,
  children,
  inline = false
}: {
  leading?: ReactNode
  children?: ReactNode
  inline?: boolean
}): React.JSX.Element | null => {
  const target = useContext(DetailActionTarget)
  const { t } = useTranslation()
  const actions = (
    <div data-slot="resource-detail-actions" className="flex w-full flex-wrap items-center gap-3">
      {leading ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden">{leading}</div>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {target && !inline ? (
          <Button variant="outline" onClick={target.onClose}>
            {target.closeLabel ?? t('Close')}
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  )
  if (target && !inline) return target.container ? createPortal(actions, target.container) : null
  return actions
}

export const ResourceDetailHeader = ({
  identity,
  headingRef,
  name,
  description,
  children
}: {
  identity: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
  name: string
  description?: string
  children?: ReactNode
}): React.JSX.Element => (
  <header className="space-y-4" data-slot="resource-detail-header">
    <div className="flex min-w-0 items-center gap-3">
      <div className="shrink-0 [&_[data-avatar-size]]:size-10 [&_[data-appearance-state]]:size-10 [&_[data-specialist-icon]]:size-5">
        {identity}
      </div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="min-w-0 break-words text-xl font-semibold tracking-tight"
      >
        {name}
      </h2>
    </div>
    {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
    {children ? (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {children}
      </div>
    ) : null}
  </header>
)
