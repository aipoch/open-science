import { AlertDialog, Dialog } from 'radix-ui'
import { MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  TAG_COLOR_KEYS,
  TAG_ICON_KEYS,
  type TagColorKey,
  type TagIconKey,
  type TagResourceRef,
  type TagResourceType,
  type TagView
} from '../../../../shared/tags'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogFormInputClassName,
  dialogFormLabelClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useTagStore } from '@/stores/tag-store'
import { TAG_COLORS, TAG_ICONS } from './tag-presentation'
import { TagBadge } from './tag-visuals'

type TagResourceRow = TagResourceRef & {
  title: string
  subtitle: string
}

type TagDraft = { name: string; iconKey: TagIconKey; colorKey: TagColorKey }
const EMPTY_DRAFT: TagDraft = { name: '', iconKey: 'tag', colorKey: 'blue' }

const resourceTypeLabel = (
  t: ReturnType<typeof useTranslation>['t'],
  value: 'all' | TagResourceType
): string => {
  if (value === 'all') return t('All resources')
  if (value === 'catalog.skill') return t('Skills')
  if (value === 'catalog.connector') return t('Connectors')
  return t('Specialists')
}

const iconLabel = (t: ReturnType<typeof useTranslation>['t'], key: TagIconKey): string => {
  if (key === 'tag') return t('Tag')
  if (key === 'star') return t('Star')
  if (key === 'bookmark') return t('Bookmark')
  if (key === 'flask-conical') return t('Flask')
  if (key === 'book-open') return t('Book')
  if (key === 'database') return t('Database')
  if (key === 'code-2') return t('Code')
  return t('Bot')
}

const colorLabel = (t: ReturnType<typeof useTranslation>['t'], key: TagColorKey): string => {
  if (key === 'gray') return t('Gray')
  if (key === 'red') return t('Red')
  if (key === 'orange') return t('Orange')
  if (key === 'amber') return t('Amber')
  if (key === 'green') return t('Green')
  if (key === 'blue') return t('Blue')
  if (key === 'purple') return t('Purple')
  return t('Pink')
}

const TagsPanel = ({
  onOpenResource
}: {
  onOpenResource(reference: TagResourceRef): void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const assignments = useTagStore((state) => state.assignments)
  const status = useTagStore((state) => state.status)
  const error = useTagStore((state) => state.error)
  const createTag = useTagStore((state) => state.create)
  const updateTag = useTagStore((state) => state.update)
  const deleteTag = useTagStore((state) => state.delete)
  const loadTags = useTagStore((state) => state.load)
  const skills = useSettingsStore((state) => state.skills)
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const selectedId = useTagStore((state) => state.browserSelectedId)
  const setSelectedId = useTagStore((state) => state.setBrowserSelectedId)
  const typeFilter = useTagStore((state) => state.browserTypeFilter)
  const setTypeFilter = useTagStore((state) => state.setBrowserTypeFilter)
  const query = useTagStore((state) => state.browserQuery)
  const setQuery = useTagStore((state) => state.setBrowserQuery)
  const scrollTop = useTagStore((state) => state.browserScrollTop)
  const setScrollTop = useTagStore((state) => state.setBrowserScrollTop)
  const resourceListRef = useRef<HTMLElement>(null)
  const [editing, setEditing] = useState<TagView | 'new'>()
  const [draft, setDraft] = useState<TagDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [deleting, setDeleting] = useState<TagView>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()

  useEffect(() => {
    if (status === 'idle') void loadTags()
    void Promise.all([loadSkills(), loadConnectors(), loadSpecialists()])
  }, [loadConnectors, loadSkills, loadSpecialists, loadTags, status])

  useLayoutEffect(() => {
    if (resourceListRef.current) resourceListRef.current.scrollTop = scrollTop
  }, [scrollTop])

  const resources = useMemo<TagResourceRow[]>(
    () => [
      ...skills.map((skill) => ({
        resourceType: 'catalog.skill' as const,
        resourceId: skill.id,
        title: skill.displayName,
        subtitle: t('Skill')
      })),
      ...connectors.map((connector) => ({
        resourceType: 'catalog.connector' as const,
        resourceId: connector.id,
        title: connector.displayName,
        subtitle: t('Connector')
      })),
      ...customServers.map((connector) => ({
        resourceType: 'catalog.connector' as const,
        resourceId: connector.id,
        title: connector.displayName,
        subtitle: `${t('Connector')} · ${connector.name}`
      })),
      ...specialistItems
        .filter((item) => item.kind !== 'reviewer')
        .map((specialist) => ({
          resourceType: 'catalog.specialist' as const,
          resourceId: specialist.id,
          title: specialist.displayName ?? specialist.name,
          subtitle: t('Specialist')
        }))
    ],
    [connectors, customServers, skills, specialistItems, t]
  )
  const resourcesByKey = new Map(
    resources.map((resource) => [`${resource.resourceType}:${resource.resourceId}`, resource])
  )
  const currentSelectedId = tags.some((tag) => tag.id === selectedId) ? selectedId : tags[0]?.id
  const selectedTag = tags.find((tag) => tag.id === currentSelectedId)
  const selectedAssignments = assignments.filter(
    (assignment) => assignment.tagId === currentSelectedId
  )
  const counts = new Map(tags.map((tag) => [tag.id, 0]))
  for (const assignment of assignments) {
    if (resourcesByKey.has(`${assignment.resourceType}:${assignment.resourceId}`)) {
      counts.set(assignment.tagId, (counts.get(assignment.tagId) ?? 0) + 1)
    }
  }
  const filteredResources = selectedAssignments
    .map((assignment) => resourcesByKey.get(`${assignment.resourceType}:${assignment.resourceId}`))
    .filter((resource): resource is TagResourceRow => resource !== undefined)
    .filter((resource) => typeFilter === 'all' || resource.resourceType === typeFilter)
    .filter((resource) => resource.title.toLowerCase().includes(query.trim().toLowerCase()))
  const resourceTypes: readonly TagResourceType[] = [
    'catalog.skill',
    'catalog.connector',
    'catalog.specialist'
  ]
  const typeCounts = new Map(
    resourceTypes.map((resourceType) => [
      resourceType,
      selectedAssignments.filter((assignment) => assignment.resourceType === resourceType).length
    ])
  )
  const resourceGroups = resourceTypes
    .map((resourceType) => ({
      resourceType,
      resources: filteredResources.filter((resource) => resource.resourceType === resourceType)
    }))
    .filter(({ resources }) => resources.length > 0)

  const openEditor = (tag?: TagView): void => {
    setFormError(undefined)
    setEditing(tag ?? 'new')
    setDraft(
      tag && !('systemKey' in tag)
        ? { name: tag.name, iconKey: tag.iconKey, colorKey: tag.colorKey }
        : EMPTY_DRAFT
    )
  }
  const save = async (): Promise<void> => {
    if (!editing || saving) return
    setSaving(true)
    setFormError(undefined)
    try {
      if (editing === 'new') await createTag(draft)
      else await updateTag({ id: editing.id, ...draft })
      setEditing(undefined)
    } catch {
      setFormError(t('Could not save Tag.'))
    } finally {
      setSaving(false)
    }
  }
  const confirmDelete = async (): Promise<void> => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(undefined)
    try {
      await deleteTag(deleting.id)
      setDeleting(undefined)
    } catch {
      setDeleteError(t('Could not delete Tag.'))
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t('Tags')}</h3>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            {t('Organize Skills, Connectors, and Specialists across one shared catalog.')}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => openEditor()}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          {t('New Tag')}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {t('Tags could not be loaded.')}
        </p>
      ) : null}
      <div className="grid min-h-[420px] flex-1 grid-cols-[15rem_minmax(0,1fr)] overflow-hidden rounded-lg border border-border">
        <aside className="border-r border-border bg-background p-2">
          {tags.map((tag) => (
            <div key={tag.id} className="group flex items-center gap-1">
              <button
                type="button"
                aria-current={tag.id === currentSelectedId ? 'page' : undefined}
                onClick={() => setSelectedId(tag.id)}
                className={cn(
                  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted',
                  tag.id === currentSelectedId && 'bg-muted font-medium'
                )}
              >
                <TagBadge tag={tag} className="min-w-0" />
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {counts.get(tag.id) ?? 0}
                </span>
              </button>
              {'systemKey' in tag ? null : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Tag actions')}
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem className="gap-2" onSelect={() => openEditor(tag)}>
                      <Pencil className="size-4" aria-hidden="true" />
                      {t('Edit Tag')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="gap-2 text-destructive"
                      onSelect={() => {
                        setDeleteError(undefined)
                        setDeleting(tag)
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      {t('Delete Tag')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))}
        </aside>

        <section
          ref={resourceListRef}
          className="min-w-0 overflow-y-auto p-4"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {selectedTag ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <TagBadge tag={selectedTag} />
                <span className="text-xs text-muted-foreground">
                  {t('{{count}} resources', {
                    count: filteredResources.length,
                    defaultValue_one: '{{count}} resource'
                  })}
                </span>
              </div>
              <div className="mb-3 flex items-center gap-2">
                <Select
                  value={typeFilter}
                  onValueChange={(value) => setTypeFilter(value as typeof typeFilter)}
                >
                  <SelectTrigger aria-label={t('Filter resources by type')} className="w-40">
                    <span>{resourceTypeLabel(t, typeFilter)}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('All resources')}</SelectItem>
                    <SelectItem value="catalog.skill">
                      {t('Skills')} ({typeCounts.get('catalog.skill') ?? 0})
                    </SelectItem>
                    <SelectItem value="catalog.connector">
                      {t('Connectors')} ({typeCounts.get('catalog.connector') ?? 0})
                    </SelectItem>
                    <SelectItem value="catalog.specialist">
                      {t('Specialists')} ({typeCounts.get('catalog.specialist') ?? 0})
                    </SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative min-w-40 flex-1">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    aria-label={t('Search tagged resources')}
                    placeholder={t('Search resources…')}
                    className="pl-8"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              </div>
              {filteredResources.length > 0 ? (
                <div className="space-y-4">
                  {resourceGroups.map(({ resourceType, resources: groupedResources }) => (
                    <section key={resourceType}>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                        {resourceTypeLabel(t, resourceType)} ({groupedResources.length})
                      </h4>
                      <ul className="divide-y divide-border">
                        {groupedResources.map((resource) => (
                          <li key={`${resource.resourceType}:${resource.resourceId}`}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-3 py-3 text-left hover:text-primary"
                              onClick={() => onOpenResource(resource)}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">{resource.title}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {resource.subtitle}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {t('No resources match this Tag.')}
                </p>
              )}
            </>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {status === 'loading' ? t('Loading Tags…') : t('Create a Tag to organize resources.')}
            </p>
          )}
        </section>
      </div>

      <Dialog.Root
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          <Dialog.Content
            className={dialogPanelClassName('z-[60] w-[min(460px,calc(100vw-2rem))] p-0')}
          >
            <div>
              <div className={dialogHeaderClassName}>
                <Dialog.Title className={dialogTitleClassName}>
                  {editing === 'new' ? t('New Tag') : t('Edit Tag')}
                </Dialog.Title>
                <Dialog.Close asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={dialogCloseButtonClassName}
                    aria-label={t('Close')}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </Dialog.Close>
              </div>
              <div className={`${dialogBodyClassName} space-y-4`}>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {t('Choose a name, icon, and color. Names are unique regardless of case.')}
                </Dialog.Description>
                <div>
                  <label className={dialogFormLabelClassName} htmlFor="tag-form-name">
                    {t('Name')}
                  </label>
                  <Input
                    id="tag-form-name"
                    autoFocus
                    value={draft.name}
                    maxLength={64}
                    className={`${dialogFormInputClassName} h-9 px-3 text-sm`}
                    onChange={(event) =>
                      setDraft((value) => ({ ...value, name: event.target.value }))
                    }
                  />
                </div>
                <fieldset>
                  <legend className={dialogFormLabelClassName}>{t('Icon')}</legend>
                  <div className="flex flex-wrap gap-2">
                    {TAG_ICON_KEYS.map((key) => {
                      const Icon = TAG_ICONS[key]
                      return (
                        <Button
                          key={key}
                          type="button"
                          variant="outline"
                          size="icon-lg"
                          aria-label={iconLabel(t, key)}
                          aria-pressed={draft.iconKey === key}
                          onClick={() => setDraft((value) => ({ ...value, iconKey: key }))}
                          className={cn(
                            draft.iconKey === key &&
                              'border-primary bg-primary/10 text-primary hover:bg-primary/10'
                          )}
                        >
                          <Icon className="size-4" aria-hidden="true" />
                        </Button>
                      )
                    })}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className={dialogFormLabelClassName}>{t('Color')}</legend>
                  <div className="flex flex-wrap gap-2">
                    {TAG_COLOR_KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        aria-label={colorLabel(t, key)}
                        aria-pressed={draft.colorKey === key}
                        onClick={() => setDraft((value) => ({ ...value, colorKey: key }))}
                        className={cn(
                          'size-8 rounded-full border-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                          TAG_COLORS[key],
                          draft.colorKey === key
                            ? 'ring-2 ring-primary ring-offset-2'
                            : 'border-transparent'
                        )}
                      />
                    ))}
                  </div>
                </fieldset>
                {formError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {formError}
                  </p>
                ) : null}
              </div>
              <div className={dialogFooterClassName}>
                <Button
                  type="button"
                  variant="ghost"
                  className={dialogCancelButtonClassName}
                  onClick={() => setEditing(undefined)}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type="button"
                  disabled={saving || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  {saving ? t('Saving…') : t('Save')}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root
        open={deleting !== undefined}
        onOpenChange={(open) => !open && !deleteBusy && setDeleting(undefined)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          <AlertDialog.Content
            className={dialogPanelClassName('z-[60] w-[min(440px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogBodyClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Delete Tag?')}
              </AlertDialog.Title>
              <AlertDialog.Description className={cn(dialogDescriptionClassName, 'mt-2')}>
                {t(
                  'The Tag will be removed from every resource. The resources themselves will not be deleted.'
                )}
              </AlertDialog.Description>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('Assignments to remove: {{count}}.', {
                  count: deleting ? (counts.get(deleting.id) ?? 0) : 0,
                  defaultValue_one: 'Assignment to remove: {{count}}.'
                })}
              </p>
              {deleteError ? (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {deleteError}
                </p>
              ) : null}
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={dialogCancelButtonClassName}
                  disabled={deleteBusy}
                >
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy ? t('Deleting…') : t('Delete Tag')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { TagsPanel }
