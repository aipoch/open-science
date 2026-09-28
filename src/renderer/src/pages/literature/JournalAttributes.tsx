import { Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from 'react-i18next'
import {
  journalChoices,
  journalDatasetLabel,
  type JournalAttribute
} from '../../../../shared/journal-attributes'
import type { LiteratureItemInput } from '../../../../shared/literature'
import { TAG_COLORS } from '@/pages/settings/tag-presentation'
import type { TagColorKey } from '../../../../shared/tags'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useJournalAttributes } from './journal-attribute-store'
import { cn } from '@/lib/utils'

const JOURNAL_POPOVER_OPENED = 'open-science:journal-popover-opened'

const quartileColors: Record<string, TagColorKey> = {
  Q1: 'green',
  Q2: 'blue',
  Q3: 'amber',
  Q4: 'purple'
}
export function JournalAttributeValue({
  attribute,
  singleLine = false
}: {
  attribute: JournalAttribute
  singleLine?: boolean
}): React.JSX.Element {
  const choices =
    attribute.kind === 'multiSelect' ? journalChoices(attribute.value) : [attribute.value]
  return (
    <span
      className={`inline-flex max-w-full gap-1 ${singleLine ? 'flex-nowrap overflow-hidden' : 'flex-wrap'}`}
    >
      {choices.map((choice) =>
        attribute.kind === 'singleSelect' || attribute.kind === 'multiSelect' ? (
          <span
            key={choice}
            title={singleLine ? choice : undefined}
            className={`max-w-full rounded border px-1.5 py-0.5 text-xs ${singleLine ? 'truncate whitespace-nowrap' : 'truncate'} ${TAG_COLORS[attribute.colors[choice] ?? quartileColors[choice.toUpperCase()] ?? 'gray']}`}
          >
            {choice}
          </span>
        ) : (
          <span
            key={choice}
            title={singleLine ? choice : undefined}
            className={`max-w-full text-xs tabular-nums ${singleLine ? 'truncate whitespace-nowrap' : 'whitespace-pre-wrap break-words'}`}
          >
            {choice}
          </span>
        )
      )}
    </span>
  )
}
export function JournalAttributes(props: {
  item: LiteratureItemInput
  itemId?: string
  detail?: boolean
  fieldKey?: string
  className?: string
}): React.JSX.Element | null {
  if (props.item.itemType !== 'journalArticle') return null
  return <JournalArticleAttributes {...props} />
}
function JournalArticleAttributes({
  item,
  itemId,
  detail = false,
  fieldKey,
  className
}: {
  item: LiteratureItemInput
  itemId?: string
  detail?: boolean
  fieldKey?: string
  className?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const switchingPopover = useRef(false)
  useEffect(() => {
    if (!open) return
    const close = (): void => {
      switchingPopover.current = true
      setOpen(false)
    }
    window.addEventListener(JOURNAL_POPOVER_OPENED, close)
    return () => window.removeEventListener(JOURNAL_POPOVER_OPENED, close)
  }, [open])
  const { attributes: all, identity, failed, retry } = useJournalAttributes(item, itemId)
  if (failed)
    return (
      <Button
        variant="ghost"
        size="xs"
        title={t('Journal attributes could not be loaded. Retry.')}
        onClick={(event) => {
          event.stopPropagation()
          retry()
        }}
      >
        {t('Retry journal attributes')}
      </Button>
    )
  const attributes = fieldKey ? all.filter(({ key }) => key === fieldKey) : all
  const externalIds = identity?.externalIds ?? []
  const showIdentity = !fieldKey && externalIds.length > 0
  if (!attributes.length && !showIdentity) return fieldKey ? <span>{'—'}</span> : null
  const content = detail ? (
    <div className="space-y-3">
      {showIdentity ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t('External IDs')}</p>
          <p className="break-all text-xs text-muted-foreground">
            {externalIds.map(({ namespace, value }) => `${namespace}:${value}`).join(', ')}
          </p>
        </div>
      ) : null}
      {attributes.length ? (
        <>
          {detail ? (
            <h3 className="font-medium">{t('Journal attributes')}</h3>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('Current local journal data')}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  'Journal data follows your display settings. Missing values are not taken from other years.'
                )}
              </p>
            </>
          )}
          <div
            className={
              detail
                ? 'grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3'
                : 'space-y-3'
            }
          >
            {attributes.map((attribute) => (
              <div key={attribute.key} className="min-w-0 space-y-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex max-w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 truncate">
                        {`${attribute.label} · ${journalDatasetLabel(attribute)}`}
                      </span>
                      <Info className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs space-y-1 break-words">
                    <p className="font-medium">{attribute.label}</p>
                    <p>
                      {t('Source')}: {attribute.source}
                    </p>
                    <p>
                      {t('Metric year')}: {attribute.year}
                    </p>
                    <p>
                      {t(
                        'Journal data follows your display settings. Missing values are not taken from other years.'
                      )}
                    </p>
                  </TooltipContent>
                </Tooltip>
                <div className="min-w-0 overflow-hidden" title={attribute.value}>
                  <JournalAttributeValue attribute={attribute} singleLine={detail} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  ) : null
  if (detail)
    return (
      <section aria-label={t('Journal attributes')} className="py-4">
        <TooltipProvider>{content}</TooltipProvider>
      </section>
    )
  const groups = new Map<string, JournalAttribute[]>()
  for (const attribute of attributes) {
    const key = JSON.stringify([attribute.source, attribute.year])
    groups.set(key, [...(groups.get(key) ?? []), attribute])
  }
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          window.dispatchEvent(new Event(JOURNAL_POPOVER_OPENED))
          switchingPopover.current = false
        }
        setOpen(nextOpen)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={t('Journal attributes')}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            fieldKey
              ? 'h-auto max-w-full justify-start px-0 py-0.5'
              : '-ml-2 mb-2 h-auto max-w-full flex-wrap justify-start gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-transparent',
            className
          )}
        >
          {attributes.slice(0, fieldKey ? 1 : 3).map((attribute) => (
            <span key={attribute.key} className="inline-flex min-w-0 items-center gap-1.5 text-xs">
              {!fieldKey ? (
                <span className="max-w-24 truncate text-muted-foreground">{attribute.label}</span>
              ) : null}
              <span className="max-w-32 truncate font-medium">
                <JournalAttributeValue attribute={attribute} singleLine />
              </span>
            </span>
          ))}
          {attributes.length > 3 ? (
            <span className="text-xs text-muted-foreground">{`+${attributes.length - 3}`}</span>
          ) : null}
          {!attributes.length && showIdentity ? (
            <span className="max-w-64 truncate text-xs text-muted-foreground">
              {externalIds.map(({ namespace, value }) => `${namespace}: ${value}`).join(' · ')}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card p-0 text-card-foreground shadow-dialog"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        onCloseAutoFocus={(event) => {
          // Switching to another attribute must not return focus to the previous trigger.
          if (switchingPopover.current) event.preventDefault()
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h3 className="text-sm font-medium">{t('Journal attributes')}</h3>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                asChild
                onFocus={(event) => {
                  if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                }}
              >
                <button
                  type="button"
                  aria-label={t('Current local journal data')}
                  className="rounded text-muted-foreground hover:text-foreground focus-visible:keyboard-focus"
                >
                  <Info className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {t(
                  'Journal data follows your display settings. Missing values are not taken from other years.'
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="max-h-80 space-y-4 overflow-y-auto p-4">
          {[...groups.entries()].map(([key, group]) => (
            <section key={key} className="space-y-2.5">
              <p
                className="truncate text-xs font-medium text-muted-foreground"
                title={journalDatasetLabel(group[0])}
              >
                {journalDatasetLabel(group[0])}
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {group.map((attribute) => (
                  <div key={attribute.key} className="min-w-0 space-y-1">
                    <dt className="truncate text-xs text-muted-foreground" title={attribute.label}>
                      {attribute.label}
                    </dt>
                    <dd className="min-w-0 font-medium">
                      <JournalAttributeValue attribute={attribute} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {showIdentity ? (
            <section className={attributes.length ? 'border-t border-border pt-3' : ''}>
              <h4 className="mb-1 text-xs text-muted-foreground">{t('External IDs')}</h4>
              <p className="break-all text-xs">
                {externalIds.map(({ namespace, value }) => `${namespace}: ${value}`).join(' · ')}
              </p>
            </section>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
