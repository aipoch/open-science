import { Check, Plus, Search, Tags, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TAG_NAME_MAX_LENGTH, type TagResourceRef } from '../../../../shared/tags'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTagStore } from '@/stores/tag-store'
import { tagPresentation } from './tag-presentation'
import { TagBadge } from './tag-visuals'

const ResourceTagMenu = ({ reference }: { reference: TagResourceRef }): React.JSX.Element => {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const assignments = useTagStore((state) => state.assignments)
  const setAssignment = useTagStore((state) => state.setAssignment)
  const createTag = useTagStore((state) => state.create)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
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

  const createAndAssign = async (): Promise<void> => {
    if (!canCreate || creating) return
    setCreating(true)
    setError(undefined)
    try {
      const tagId = await createTag({ name: query, iconKey: 'tag', colorKey: 'blue' })
      await setAssignment({ ...reference, tagId, assigned: true })
      setQuery('')
    } catch {
      setError(t('Could not update Tags.'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <DropdownMenu>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Manage Tags')}>
                <Tags className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel>{error ?? t('Add or remove Tags')}</DropdownMenuLabel>
            <div className="relative px-2 pb-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                maxLength={TAG_NAME_MAX_LENGTH}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={t('Search Tags…')}
                aria-label={t('Search Tags')}
                className="h-8 pl-7"
              />
            </div>
            {visibleTags.map((tag) => {
              const assigned = assignedIds.has(tag.id)
              return (
                <DropdownMenuItem
                  key={tag.id}
                  className="gap-2"
                  onSelect={(event) => {
                    event.preventDefault()
                    setError(undefined)
                    void setAssignment({ ...reference, tagId: tag.id, assigned: !assigned }).catch(
                      () => setError(t('Could not update Tags.'))
                    )
                  }}
                >
                  <span className="flex size-4 items-center justify-center">
                    {assigned ? <Check className="size-3.5" aria-hidden="true" /> : null}
                  </span>
                  <span className="truncate">{tagPresentation(tag, t).name}</span>
                </DropdownMenuItem>
              )
            })}
            {canCreate ? (
              <DropdownMenuItem
                className="gap-2"
                disabled={creating}
                onSelect={(event) => {
                  event.preventDefault()
                  void createAndAssign()
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
                <span className="truncate">{t('Create “{{name}}”', { name: query.trim() })}</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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
  onOpenTag
}: {
  reference: TagResourceRef
  limit?: number
  onOpenTag?: (tagId: string) => void
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
            : 'flex flex-wrap items-center gap-1'
        )}
      >
        {assigned.slice(0, limit).map((tag) => {
          const presentation = tagPresentation(tag, t)
          const removeLabel = t('Remove {{tag}} from this resource', {
            tag: presentation.name
          })
          const badge = <TagBadge tag={tag} className={compact ? 'min-w-0 max-w-24' : undefined} />
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
  onOpenTag
}: {
  reference: TagResourceRef
  className?: string
  onOpenTag?: (tagId: string) => void
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
      <ResourceTagMenu reference={reference} />
    </div>
  )
}

export { ResourceTagBadges, ResourceTagMenu, ResourceTagSummary, TagFilter }
