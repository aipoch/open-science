import { Check, Loader2, Plus, Search, Tags, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { TAG_NAME_MAX_LENGTH, type TagResourceRef } from '../../../../shared/tags'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTagStore } from '@/stores/tag-store'
import { tagPresentation } from './tag-presentation'
import { TagBadge } from './tag-visuals'

const ResourceTagMenu = ({
  reference,
  trigger,
  open,
  onOpenChange,
  keepOpenOnSelect = true
}: {
  reference: TagResourceRef
  trigger?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  keepOpenOnSelect?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const assignments = useTagStore((state) => state.assignments)
  const setAssignment = useTagStore((state) => state.setAssignment)
  const createTag = useTagStore((state) => state.create)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [localOpen, setLocalOpen] = useState(false)
  const isOpen = open ?? localOpen
  const [activeKey, setActiveKey] = useState<string>()
  const [pendingKey, setPendingKey] = useState<string>()
  const pending = useRef(false)
  const interactionVersion = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tabDismissal = useRef(false)
  const listboxId = useId()
  const errorId = useId()
  const changeOpen = (nextOpen: boolean): void => {
    interactionVersion.current += 1
    setLocalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }
  const scope = JSON.stringify([isOpen, reference.resourceType, reference.resourceId])
  const [previousScope, setPreviousScope] = useState(scope)
  if (previousScope !== scope) {
    setPreviousScope(scope)
    setQuery('')
    setActiveKey(undefined)
    setError(undefined)
  }
  useEffect(() => {
    interactionVersion.current += 1
    return () => {
      interactionVersion.current += 1
    }
  }, [scope])
  const assignedIds = new Set(
    assignments
      .filter(
        (item) =>
          item.resourceType === reference.resourceType && item.resourceId === reference.resourceId
      )
      .map((item) => item.tagId)
  )
  const normalizeName = (value: string): string =>
    value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
  const normalizedQuery = normalizeName(query)
  const visibleTags = tags.filter((tag) =>
    normalizeName(tagPresentation(tag, t).name).includes(normalizedQuery)
  )
  const canCreate =
    query.trim().length > 0 &&
    !tags.some((tag) => normalizeName(tagPresentation(tag, t).name) === normalizedQuery)

  const options = [
    ...visibleTags.map((tag) => ({ key: `tag:${tag.id}`, tag })),
    ...(canCreate ? [{ key: 'create', tag: undefined }] : [])
  ]
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.key === activeKey)
  )
  const activeOption = options[activeIndex]
  const activeId = activeOption ? `${listboxId}-${activeIndex}` : undefined

  useEffect(() => {
    if (isOpen && activeId) {
      document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [isOpen, activeId, normalizedQuery])

  const activate = async (option: (typeof options)[number]): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setPendingKey(option.key)
    setError(undefined)
    const version = interactionVersion.current
    try {
      if (option.tag) {
        await setAssignment({
          ...reference,
          tagId: option.tag.id,
          assigned: !assignedIds.has(option.tag.id)
        })
      } else {
        const tagId = await createTag({ name: query, iconKey: 'tag', colorKey: 'blue' })
        await setAssignment({ ...reference, tagId, assigned: true })
      }
      if (version === interactionVersion.current) {
        if (!option.tag) {
          setQuery('')
          setActiveKey(undefined)
        }
        if (!keepOpenOnSelect) changeOpen(false)
      }
    } catch {
      if (version === interactionVersion.current) setError(t('Could not update Tags.'))
    } finally {
      pending.current = false
      setPendingKey(undefined)
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <Popover open={isOpen} onOpenChange={changeOpen}>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild ref={triggerRef}>
              {trigger ?? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Manage Tags')}
                  style={{ pointerEvents: 'auto' }}
                >
                  <Tags className="size-4" aria-hidden="true" />
                </Button>
              )}
            </PopoverTrigger>
          </TooltipTrigger>
          <PopoverContent
            align="end"
            aria-label={t('Manage Tags')}
            className="w-64 max-w-[calc(100vw-1rem)] overflow-hidden border border-border bg-popover p-1 text-popover-foreground shadow-menu"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              inputRef.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
              if (tabDismissal.current) event.preventDefault()
              tabDismissal.current = false
            }}
          >
            <div className="px-2 py-1.5 text-xs font-medium">{t('Add or remove Tags')}</div>
            <div className="relative px-1 pb-1">
              <Search
                className="pointer-events-none absolute top-4 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isOpen}
                aria-controls={listboxId}
                aria-activedescendant={activeId}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                autoComplete="off"
                maxLength={TAG_NAME_MAX_LENGTH}
                value={query}
                onChange={(event) => {
                  interactionVersion.current += 1
                  setQuery(event.target.value)
                  setActiveKey(undefined)
                  setError(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (options.length) {
                      const offset = event.key === 'ArrowDown' ? 1 : -1
                      setActiveKey(
                        options[(activeIndex + offset + options.length) % options.length].key
                      )
                    }
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (activeOption) void activate(activeOption)
                  } else if (event.key === 'Tab') {
                    tabDismissal.current = true
                    triggerRef.current?.focus()
                    changeOpen(false)
                  }
                }}
                placeholder={t('Search Tags…')}
                aria-label={t('Search Tags')}
                className="h-8 pl-7 transition-none [@media(pointer:coarse)]:h-11"
              />
            </div>
            <div
              id={listboxId}
              role="listbox"
              aria-label={t('Tags')}
              aria-multiselectable="true"
              aria-busy={Boolean(pendingKey)}
              className="max-h-60 overflow-y-auto overscroll-contain"
            >
              {options.map((option, index) => {
                const assigned = Boolean(option.tag && assignedIds.has(option.tag.id))
                return (
                  <div
                    key={option.key}
                    id={`${listboxId}-${index}`}
                    role="option"
                    aria-selected={assigned}
                    aria-disabled={Boolean(pendingKey)}
                    data-active={index === activeIndex || undefined}
                    onPointerMove={() => setActiveKey(option.key)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void activate(option)}
                    className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[active]:bg-muted data-[active]:text-foreground active:bg-muted aria-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {pendingKey === option.key ? (
                        <Loader2
                          className="size-3.5 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : !option.tag ? (
                        <Plus className="size-4" aria-hidden="true" />
                      ) : assigned ? (
                        <Check className="size-3.5" aria-hidden="true" />
                      ) : null}
                    </span>
                    {option.tag ? (
                      <TagBadge tag={option.tag} className="max-w-full" />
                    ) : (
                      <span className="truncate">
                        {t('Create “{{name}}”', { name: query.trim() })}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {error ? (
              <div id={errorId} role="alert" className="px-2 py-1.5 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
        <TooltipContent>{t('Manage Tags')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const TagFilter = ({
  resourceType,
  value,
  onChange,
  className
}: {
  resourceType: TagResourceRef['resourceType']
  value: string
  onChange(value: string): void
  className?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const assignments = useTagStore((state) => state.assignments)
  const availableIds = new Set(
    assignments.filter((item) => item.resourceType === resourceType).map((item) => item.tagId)
  )
  const selected = tags.find((tag) => tag.id === value)
  const effectiveValue = value === 'all' || selected ? value : 'all'
  useEffect(() => {
    if (effectiveValue !== value) onChange(effectiveValue)
  }, [effectiveValue, onChange, value])
  return (
    <Select value={effectiveValue} onValueChange={onChange}>
      <SelectTrigger aria-label={t('Filter by Tag')} className={className ?? 'w-40'}>
        <span className="truncate">
          {effectiveValue === 'all' || !selected
            ? t('All Tags')
            : tagPresentation(selected, t).name}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('All Tags')}</SelectItem>
        {tags
          .filter((tag) => availableIds.has(tag.id))
          .map((tag) => (
            <SelectItem key={tag.id} value={tag.id}>
              {tagPresentation(tag, t).name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

const ResourceTagBadges = ({
  reference,
  limit = 2,
  removable = true,
  onOpenTag,
  className
}: {
  reference: TagResourceRef
  limit?: number
  removable?: boolean
  onOpenTag?: (tagId: string) => void
  className?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const assignments = useTagStore((state) => state.assignments)
  const setAssignment = useTagStore((state) => state.setAssignment)
  const [removingId, setRemovingId] = useState<string>()
  const [error, setError] = useState<string>()
  const ids = new Set(
    assignments
      .filter(
        (assignment) =>
          assignment.resourceType === reference.resourceType &&
          assignment.resourceId === reference.resourceId
      )
      .map((assignment) => assignment.tagId)
  )
  const assigned = tags.filter((tag) => ids.has(tag.id))
  if (assigned.length === 0) return <></>
  const compact = Number.isFinite(limit)
  const removeTag = async (tagId: string): Promise<void> => {
    if (removingId) return
    setRemovingId(tagId)
    setError(undefined)
    try {
      await setAssignment({ ...reference, tagId, assigned: false })
    } catch {
      setError(t('Could not update Tags.'))
    } finally {
      setRemovingId(undefined)
    }
  }
  return (
    <>
      <div
        className={cn(
          compact
            ? 'flex min-w-0 max-w-52 flex-nowrap items-center justify-end gap-1 overflow-hidden'
            : 'flex flex-wrap items-center gap-1',
          className
        )}
      >
        {assigned.slice(0, limit).map((tag) => {
          const presentation = tagPresentation(tag, t)
          const removeLabel = t('Remove {{tag}} from this resource', {
            tag: presentation.name
          })
          const badge = <TagBadge tag={tag} className={compact ? 'min-w-0 max-w-24' : undefined} />
          if (!removable) {
            return (
              <span key={tag.id} className={cn('inline-flex min-w-0', compact && 'max-w-24')}>
                {badge}
              </span>
            )
          }
          return (
            <span
              key={tag.id}
              className={cn('group/tag relative inline-flex min-w-0', compact && 'max-w-24')}
            >
              {onOpenTag ? (
                <button
                  type="button"
                  className="min-w-0 rounded-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpenTag(tag.id)}
                >
                  {badge}
                </button>
              ) : (
                badge
              )}
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={removeLabel}
                      disabled={removingId === tag.id}
                      className="pointer-events-auto absolute top-1/2 right-1.5 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-background text-foreground opacity-100 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none sm:pointer-events-none sm:opacity-0 sm:group-hover/tag:pointer-events-auto sm:group-hover/tag:opacity-100 sm:group-focus-within/tag:pointer-events-auto sm:group-focus-within/tag:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation()
                        void removeTag(tag.id)
                      }}
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{removeLabel}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          )
        })}
        {assigned.length > limit ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            +{assigned.length - limit}
          </span>
        ) : null}
      </div>
      {error ? (
        <span role="alert" className="shrink-0 text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </>
  )
}

const ResourceTagSummary = ({
  reference,
  className,
  onOpenTag,
  menuOpen,
  onMenuOpenChange,
  keepMenuOpenOnSelect = false
}: {
  reference: TagResourceRef
  className?: string
  onOpenTag?: (tagId: string) => void
  menuOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
  keepMenuOpenOnSelect?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span className="text-xs font-medium text-muted-foreground">{t('Tags')}</span>
      <ResourceTagBadges
        reference={reference}
        limit={Number.POSITIVE_INFINITY}
        onOpenTag={onOpenTag}
      />
      <ResourceTagMenu
        reference={reference}
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        keepOpenOnSelect={keepMenuOpenOnSelect}
      />
    </div>
  )
}

export { ResourceTagBadges, ResourceTagMenu, ResourceTagSummary, TagFilter }
