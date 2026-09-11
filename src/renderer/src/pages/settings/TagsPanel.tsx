import { TooltipProvider } from '@/components/ui/tooltip'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: Tag master-detail + reorder · genre: modern-minimal · tone: technical/utilitarian
 * states: default · hover · focus · active · disabled · loading · error · success
 * theme: project tokens · contrast: pass · slop: pass
 */
import { AlertDialog } from 'radix-ui'
import {
  ChevronDown,
  BookOpenText,
  GripVertical,
  LockKeyhole,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  Users,
  X
} from 'lucide-react'
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
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
import type { LiteratureItemView } from '../../../../shared/literature'
import type { ArtifactLiteratureReference } from '../../../../shared/artifact-literature'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useTagStore } from '@/stores/tag-store'
import { ConnectorsNavIcon } from './connector-icons'
import { SettingsIconAction } from './SettingsLayout'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SettingsPanelHeader } from './SettingsPanelHeader'
import { TAG_COLORS, TAG_ICONS, tagPresentation } from './tag-presentation'
import { TagBadge } from './tag-visuals'
import { ArtifactLiteratureDetailDialog } from '../workspace/ArtifactLiteratureDetailDialog'

type TagResourceRow = TagResourceRef & {
  title: string
  subtitle?: string
  accessibleTitle?: string
  literatureReference?: ArtifactLiteratureReference
}

type TagDraft = { name: string; iconKey: TagIconKey; colorKey: TagColorKey }
type CustomTagView = Extract<TagView, { name: string }>
export type TagsView =
  { kind: 'list'; tagId?: string } | { kind: 'create' } | { kind: 'edit'; tagId: string }
type TagDropTarget = { tagId: string; edge: 'before' | 'after' }
type TagDropZone = { tagId: string; top: number; bottom: number }
type TagPointerDrag = {
  pointerId: number
  tagId: string
  startY: number
  active: boolean
  dropZones: TagDropZone[]
  target?: TagDropTarget
}
const EMPTY_DRAFT: TagDraft = { name: '', iconKey: 'tag', colorKey: 'blue' }

const literatureResourceRow = (item: LiteratureItemView): TagResourceRow => ({
  resourceType: 'literature.item',
  resourceId: item.id,
  title: item.item.title,
  subtitle:
    [item.item.issuedYear, item.item.containerTitle].filter(Boolean).join(' · ') || undefined,
  literatureReference: {
    itemId: item.id,
    metadataRevision: item.metadataRevision,
    item: item.item
  }
})

const RequiredMark = (): React.JSX.Element => (
  <span aria-hidden="true" className="ml-0.5 text-destructive">
    *
  </span>
)

const resourceTypeLabel = (
  t: ReturnType<typeof useTranslation>['t'],
  value: 'all' | TagResourceType
): string => {
  if (value === 'all') return t('All resources')
  if (value === 'catalog.skill') return t('Skills')
  if (value === 'catalog.connector') return t('Connectors')
  if (value === 'literature.item') return t('References')
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

const TagForm = ({
  tag,
  onCancel,
  onSaved
}: {
  tag?: CustomTagView
  onCancel(): void
  onSaved(tagId: string): void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const createTag = useTagStore((state) => state.create)
  const updateTag = useTagStore((state) => state.update)
  const loadTags = useTagStore((state) => state.load)
  const [baseVersion, setBaseVersion] = useState(tag?.updatedAt)
  const [draft, setDraft] = useState<TagDraft>(
    tag ? { name: tag.name, iconKey: tag.iconKey, colorKey: tag.colorKey } : EMPTY_DRAFT
  )
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string>()
  const conflicted = tag !== undefined && tag.updatedAt !== baseVersion
  const LatestIcon = tag ? TAG_ICONS[tag.iconKey] : undefined
  const canSubmit = Boolean(draft.name.trim()) && !saving && !conflicted

  const save = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    setFormError(undefined)
    try {
      if (tag) {
        await updateTag({ id: tag.id, expectedUpdatedAt: baseVersion!, ...draft })
        onSaved(tag.id)
      } else {
        onSaved(await createTag(draft))
      }
    } catch {
      setFormError(t('Could not save Tag.'))
      if (tag) await loadTags()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      data-slot="tag-form"
      className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-5 px-4 py-4 md:px-6"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t('Choose a name, icon, and color. Names are unique regardless of case.')}
      </p>
      {conflicted ? (
        <div>
          <ErrorNotice
            role="alert"
            title={t('Tag version updated')}
            description={t(
              'Your draft is still below. Choose how to handle the latest version before saving.'
            )}
            secondaryButton={{
              label: t('Load latest version'),
              description: t('Replace your draft with the latest values.'),
              onClick: () => {
                setDraft({ name: tag.name, iconKey: tag.iconKey, colorKey: tag.colorKey })
                setBaseVersion(tag.updatedAt)
                setFormError(undefined)
              },
              disabled: saving
            }}
            primaryButton={{
              label: t('Continue editing draft'),
              description: t('Not saved yet. Saving later will replace the latest version.'),
              onClick: () => {
                setBaseVersion(tag.updatedAt)
                setFormError(undefined)
              },
              disabled: saving
            }}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">{t('Latest saved version')}</span>
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground [overflow-wrap:anywhere]">
                {LatestIcon ? (
                  <LatestIcon
                    className={cn('size-4 shrink-0 rounded-sm', TAG_COLORS[tag.colorKey])}
                    aria-hidden="true"
                  />
                ) : null}
                {tag.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('Icon')}: {iconLabel(t, tag.iconKey)} · {t('Color')}:{' '}
                {colorLabel(t, tag.colorKey)}
              </span>
            </div>
          </ErrorNotice>
        </div>
      ) : null}
      <label className="space-y-1.5 text-sm font-medium" htmlFor="tag-form-name">
        <span>
          {t('Name')}
          <RequiredMark />
        </span>
        <Input
          id="tag-form-name"
          name="tag-name"
          autoFocus
          required
          value={draft.name}
          maxLength={64}
          aria-invalid={formError ? true : undefined}
          onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
        />
      </label>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t('Icon')}</legend>
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
                  'active:translate-y-px [@media(pointer:coarse)]:size-11',
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
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t('Color')}</legend>
        <div className="flex flex-wrap gap-2">
          {TAG_COLOR_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-label={colorLabel(t, key)}
              aria-pressed={draft.colorKey === key}
              onClick={() => setDraft((value) => ({ ...value, colorKey: key }))}
              className={cn(
                'size-8 rounded-full border-2 outline-none transition-transform active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none [@media(pointer:coarse)]:size-11',
                TAG_COLORS[key],
                draft.colorKey === key ? 'ring-2 ring-primary ring-offset-2' : 'border-transparent'
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
      <div className="mt-auto flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {saving ? t('Saving…') : tag ? t('Save') : t('Create')}
        </Button>
      </div>
    </form>
  )
}

const useResourceCatalogLoad = (
  load: (retry: boolean) => Promise<void>,
  loaded: boolean,
  loadError?: string
): { status: 'loading' | 'error' | 'ready'; retry(): void } => {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void load(attempt > 0).then(
      () => {
        if (active) setFailed(false)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
    }
  }, [load, attempt])
  return {
    status: loadError || (failed && !loaded) ? 'error' : loaded ? 'ready' : 'loading',
    retry: () => {
      setFailed(false)
      setAttempt((value) => value + 1)
    }
  }
}

const TagsList = ({
  onOpenResource,
  onSelectedTagChange,
  onCreate,
  onEdit
}: {
  onOpenResource(reference: TagResourceRef): void
  onSelectedTagChange?(tagId: string): void
  onCreate(): void
  onEdit(tag: CustomTagView): void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const assignments = useTagStore((state) => state.assignments)
  const status = useTagStore((state) => state.status)
  const error = useTagStore((state) => state.error)
  const deleteTag = useTagStore((state) => state.delete)
  const reorderTags = useTagStore((state) => state.reorder)
  const setAssignment = useTagStore((state) => state.setAssignment)
  const loadTags = useTagStore((state) => state.load)
  const skills = useSettingsStore((state) => state.skills)
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const skillsLoaded = useSettingsStore((state) => state.skillsLoaded)
  const connectorsLoaded = useSettingsStore((state) => state.connectorsLoaded)
  const specialistsLoaded = useSpecialistStore((state) => state.isLoaded)
  const specialistLoadError = useSpecialistStore((state) => state.loadError)
  const refreshSpecialists = useCallback(
    (force: boolean) => loadSpecialists({ force }),
    [loadSpecialists]
  )
  const selectedId = useTagStore((state) => state.browserSelectedId)
  const setSelectedId = useTagStore((state) => state.setBrowserSelectedId)
  const typeFilter = useTagStore((state) => state.browserTypeFilter)
  const setTypeFilter = useTagStore((state) => state.setBrowserTypeFilter)
  const query = useTagStore((state) => state.browserQuery)
  const setQuery = useTagStore((state) => state.setBrowserQuery)
  const scrollTop = useTagStore((state) => state.browserScrollTop)
  const setScrollTop = useTagStore((state) => state.setBrowserScrollTop)
  const resourceListRef = useRef<HTMLElement>(null)
  const [deleting, setDeleting] = useState<TagView>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const [assignmentError, setAssignmentError] = useState<string>()
  const [removingResourceKey, setRemovingResourceKey] = useState<string>()
  const [collapsed, setCollapsed] = useState<Partial<Record<TagResourceType, boolean>>>({})
  const [reorderBusy, setReorderBusy] = useState(false)
  const [reorderError, setReorderError] = useState<string>()
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')
  const [draggedTagId, setDraggedTagId] = useState<string>()
  const [tagDropTarget, setTagDropTarget] = useState<TagDropTarget>()
  const [selectedLiteratureReference, setSelectedLiteratureReference] =
    useState<ArtifactLiteratureReference>()
  const [literatureLoadAttempt, setLiteratureLoadAttempt] = useState(0)
  const [literatureResourceCache, setLiteratureResourceCache] = useState<{
    key: string
    rows: TagResourceRow[]
    failed?: boolean
    attempt?: number
  }>({ key: '', rows: [] })
  const tagPointerDragRef = useRef<TagPointerDrag | undefined>(undefined)
  const currentSelectedId = tags.some((tag) => tag.id === selectedId) ? selectedId : tags[0]?.id
  const selectedTag = tags.find((tag) => tag.id === currentSelectedId)
  const selectedAssignments = assignments.filter(
    (assignment) => assignment.tagId === currentSelectedId
  )
  const literatureResourceIdsKey = assignments
    .filter((assignment) => assignment.resourceType === 'literature.item')
    .map((assignment) => assignment.resourceId)
    .filter((resourceId, index, resourceIds) => resourceIds.indexOf(resourceId) === index)
    .sort()
    .join('\n')
  const literatureResources = useMemo(
    () =>
      literatureResourceCache.key === literatureResourceIdsKey ? literatureResourceCache.rows : [],
    [literatureResourceCache, literatureResourceIdsKey]
  )

  const catalogLoads = {
    'catalog.skill': useResourceCatalogLoad(loadSkills, skillsLoaded),
    'catalog.connector': useResourceCatalogLoad(loadConnectors, connectorsLoaded),
    'catalog.specialist': useResourceCatalogLoad(
      refreshSpecialists,
      specialistsLoaded,
      specialistLoadError
    ),
    'literature.item': {
      status: !literatureResourceIdsKey
        ? 'ready'
        : literatureResourceCache.key !== literatureResourceIdsKey ||
            literatureResourceCache.attempt !== literatureLoadAttempt
          ? 'loading'
          : literatureResourceCache.failed
            ? 'error'
            : 'ready',
      retry: () => setLiteratureLoadAttempt((attempt) => attempt + 1)
    }
  }

  useEffect(() => {
    if (status === 'idle') void loadTags()
  }, [loadTags, status])

  useEffect(() => {
    let active = true
    if (!literatureResourceIdsKey) {
      return () => {
        active = false
      }
    }
    void Promise.resolve()
      .then(() =>
        Promise.all(
          literatureResourceIdsKey
            .split('\n')
            .map((resourceId) => window.api.literature.get(resourceId))
        )
      )
      .then(
        (items) => {
          if (!active) return
          setLiteratureResourceCache({
            key: literatureResourceIdsKey,
            attempt: literatureLoadAttempt,
            rows: items.flatMap((item): TagResourceRow[] => {
              if (!item) return []
              return [literatureResourceRow(item)]
            })
          })
        },
        () => {
          if (active)
            setLiteratureResourceCache({
              key: literatureResourceIdsKey,
              attempt: literatureLoadAttempt,
              rows: [],
              failed: true
            })
        }
      )
    return () => {
      active = false
    }
  }, [literatureResourceIdsKey, literatureLoadAttempt])

  useLayoutEffect(() => {
    if (resourceListRef.current) resourceListRef.current.scrollTop = scrollTop
  }, [scrollTop])

  const resources = useMemo<TagResourceRow[]>(
    () => [
      ...skills
        .filter((skill) => skill.available !== false)
        .map((skill) => ({
          resourceType: 'catalog.skill' as const,
          resourceId: skill.id,
          title: skill.displayName,
          subtitle: skill.description.trim() || undefined
        })),
      ...connectors.map((connector) => ({
        resourceType: 'catalog.connector' as const,
        resourceId: connector.id,
        title: connector.displayName,
        subtitle: connector.description.trim() || undefined
      })),
      ...customServers.map((connector) => ({
        resourceType: 'catalog.connector' as const,
        resourceId: connector.id,
        title: connector.displayName,
        subtitle: connector.description?.trim()
          ? `${connector.name} · ${connector.description.trim()}`
          : connector.name,
        accessibleTitle:
          connector.displayName === connector.name
            ? connector.name
            : `${connector.displayName} (${connector.name})`
      })),
      ...specialistItems
        .filter((item) => item.kind !== 'reviewer')
        .map((specialist) => ({
          resourceType: 'catalog.specialist' as const,
          resourceId: specialist.id,
          title: specialist.displayName ?? specialist.name,
          subtitle: specialist.description.trim() || undefined
        })),
      ...literatureResources
    ],
    [connectors, customServers, literatureResources, skills, specialistItems]
  )
  const resourcesByKey = new Map(
    resources.map((resource) => [`${resource.resourceType}:${resource.resourceId}`, resource])
  )
  useEffect(() => {
    if (!currentSelectedId || selectedId === currentSelectedId) return
    setSelectedId(currentSelectedId)
    onSelectedTagChange?.(currentSelectedId)
  }, [currentSelectedId, onSelectedTagChange, selectedId, setSelectedId])

  const counts = new Map(tags.map((tag) => [tag.id, 0]))
  for (const assignment of assignments) {
    counts.set(assignment.tagId, (counts.get(assignment.tagId) ?? 0) + 1)
  }
  const filteredResources = selectedAssignments
    .map((assignment) => resourcesByKey.get(`${assignment.resourceType}:${assignment.resourceId}`))
    .filter((resource): resource is TagResourceRow => resource !== undefined)
    .filter((resource) => typeFilter === 'all' || resource.resourceType === typeFilter)
    .filter((resource) => resource.title.toLowerCase().includes(query.trim().toLowerCase()))
  const resourceTypes: readonly TagResourceType[] = [
    'catalog.skill',
    'catalog.connector',
    'catalog.specialist',
    'literature.item'
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
  const visibleCatalogTypes = resourceTypes.filter(
    (type) => typeFilter === 'all' || typeFilter === type
  )
  const catalogsReady = visibleCatalogTypes.every((type) => catalogLoads[type].status === 'ready')
  const unavailableAssignmentCount = selectedAssignments.filter(
    (assignment) =>
      visibleCatalogTypes.includes(assignment.resourceType) &&
      catalogLoads[assignment.resourceType].status === 'ready' &&
      !resourcesByKey.has(`${assignment.resourceType}:${assignment.resourceId}`)
  ).length

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
  const removeResource = async (resource: TagResourceRow): Promise<void> => {
    if (!selectedTag || removingResourceKey) return
    const key = `${resource.resourceType}:${resource.resourceId}`
    setRemovingResourceKey(key)
    setAssignmentError(undefined)
    try {
      await setAssignment({
        tagId: selectedTag.id,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        assigned: false
      })
    } catch {
      setAssignmentError(t('Could not update Tags.'))
    } finally {
      setRemovingResourceKey(undefined)
    }
  }

  const customTags = tags.filter((tag): tag is CustomTagView => !('systemKey' in tag))
  const finishTagDrag = (): void => {
    tagPointerDragRef.current = undefined
    setDraggedTagId(undefined)
    setTagDropTarget(undefined)
  }
  const showTagDropTarget = (next?: TagDropTarget): void => {
    const drag = tagPointerDragRef.current
    if (!drag) return
    if (drag.target?.tagId === next?.tagId && drag.target?.edge === next?.edge) return
    drag.target = next
    setTagDropTarget(next)
  }
  const moveTag = async (
    tagId: string,
    targetTagId: string,
    edge: TagDropTarget['edge']
  ): Promise<void> => {
    if (reorderBusy) return
    const fromIndex = customTags.findIndex((tag) => tag.id === tagId)
    const targetIndex = customTags.findIndex((tag) => tag.id === targetTagId)
    if (fromIndex < 0 || targetIndex < 0) return
    let insertionIndex = targetIndex + (edge === 'after' ? 1 : 0)
    if (fromIndex < insertionIndex) insertionIndex -= 1
    if (insertionIndex === fromIndex) return
    const ordered = [...customTags]
    const [moved] = ordered.splice(fromIndex, 1)
    if (!moved) return
    ordered.splice(insertionIndex, 0, moved)
    setReorderBusy(true)
    setReorderError(undefined)
    try {
      await reorderTags({ tagIds: ordered.map((tag) => tag.id) })
      setReorderAnnouncement(
        t('Moved {{tag}} to position {{position}}.', {
          tag: moved.name,
          position: insertionIndex + 2
        })
      )
    } catch {
      setReorderError(t('Could not reorder Tags. Try again.'))
    } finally {
      setReorderBusy(false)
    }
  }
  const moveTagPointer = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = tagPointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < 6) return
      drag.active = true
      setDraggedTagId(drag.tagId)
    }
    event.preventDefault()
    const target = drag.dropZones.reduce<{ zone: TagDropZone; distance: number } | undefined>(
      (closest, zone) => {
        const distance =
          event.clientY < zone.top
            ? zone.top - event.clientY
            : event.clientY > zone.bottom
              ? event.clientY - zone.bottom
              : 0
        return !closest || distance < closest.distance ? { zone, distance } : closest
      },
      undefined
    )?.zone
    if (!target) {
      showTagDropTarget()
      return
    }
    showTagDropTarget({
      tagId: target.tagId,
      edge: event.clientY >= target.top + (target.bottom - target.top) / 2 ? 'after' : 'before'
    })
  }
  const endTagPointer = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = tagPointerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.active && drag.target) {
      void moveTag(drag.tagId, drag.target.tagId, drag.target.edge)
    }
    finishTagDrag()
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div data-slot="tags-panel" className="flex h-full min-h-0 flex-col px-3 py-3 md:px-4">
        <SettingsPanelHeader
          className="mb-3"
          title={t('Tags')}
          description={t('Create and reorder tags, then browse everything attached to each tag.')}
          search={
            <SettingsSearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search resources…')}
              aria-label={t('Search tagged resources')}
              className="h-8"
              containerClassName="w-52 flex-none"
            />
          }
          action={
            <Button type="button" size="sm" onClick={onCreate}>
              <Plus className="size-4" aria-hidden="true" />
              {t('New Tag')}
            </Button>
          }
        />
        {error ? (
          <p role="alert" className="mb-3 text-xs text-destructive">
            {t('Tags could not be loaded.')}
          </p>
        ) : null}
        <div
          data-slot="tag-master-detail"
          className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-lg border border-border md:grid-cols-[220px_minmax(0,1fr)]"
        >
          <aside
            className="min-h-0 overflow-y-auto border-b border-border bg-muted/20 p-2 md:border-r md:border-b-0"
            aria-busy={reorderBusy || undefined}
          >
            {reorderError ? (
              <p role="alert" className="mb-2 px-2 text-xs text-destructive">
                {reorderError}
              </p>
            ) : null}
            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {reorderAnnouncement}
            </p>
            <ol className="space-y-1">
              {tags.map((tag) => {
                const customIndex = customTags.findIndex((candidate) => candidate.id === tag.id)
                const dropBefore =
                  tagDropTarget?.tagId === tag.id && tagDropTarget.edge === 'before'
                const dropAfter = tagDropTarget?.tagId === tag.id && tagDropTarget.edge === 'after'
                return (
                  <li
                    key={tag.id}
                    data-reorderable-tag-id={'systemKey' in tag ? undefined : tag.id}
                    className={cn(
                      'relative flex min-w-0 items-center',
                      draggedTagId === tag.id &&
                        'rounded-md bg-muted/60 ring-1 ring-primary/30 ring-inset'
                    )}
                  >
                    {dropBefore || dropAfter ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-primary',
                          dropBefore ? '-top-px' : '-bottom-px'
                        )}
                      />
                    ) : null}
                    {'systemKey' in tag ? (
                      <span
                        className="flex size-9 shrink-0 items-center justify-center text-muted-foreground/60 [@media(pointer:coarse)]:size-11"
                        role="img"
                        aria-label={t('System Tags stay first')}
                        title={t('System Tags stay first')}
                      >
                        <LockKeyhole className="size-3.5" aria-hidden="true" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={reorderBusy}
                        className="flex size-9 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground select-none hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:size-11"
                        aria-label={t('Reorder {{tag}}', { tag: tag.name })}
                        title={t('Drag or use arrow keys to reorder')}
                        onPointerCancel={finishTagDrag}
                        onPointerDown={(event) => {
                          if (event.isPrimary === false || event.button !== 0 || reorderBusy) return
                          event.currentTarget.setPointerCapture?.(event.pointerId)
                          tagPointerDragRef.current = {
                            pointerId: event.pointerId,
                            tagId: tag.id,
                            startY: event.clientY,
                            active: false,
                            dropZones: Array.from(
                              event.currentTarget
                                .closest('ol')
                                ?.querySelectorAll<HTMLElement>('[data-reorderable-tag-id]') ?? []
                            )
                              .filter((row) => row.dataset.reorderableTagId !== tag.id)
                              .flatMap((row) => {
                                const tagId = row.dataset.reorderableTagId
                                if (!tagId) return []
                                const bounds = row.getBoundingClientRect()
                                return [{ tagId, top: bounds.top, bottom: bounds.bottom }]
                              })
                          }
                        }}
                        onPointerMove={moveTagPointer}
                        onPointerUp={endTagPointer}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                          event.preventDefault()
                          const target =
                            customTags[customIndex + (event.key === 'ArrowUp' ? -1 : 1)]
                          if (target) {
                            void moveTag(
                              tag.id,
                              target.id,
                              event.key === 'ArrowUp' ? 'before' : 'after'
                            )
                          }
                        }}
                      >
                        <GripVertical className="size-4" aria-hidden="true" />
                      </button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-slot="tag-list-row"
                      aria-current={tag.id === currentSelectedId ? 'page' : undefined}
                      onClick={() => {
                        setSelectedId(tag.id)
                        onSelectedTagChange?.(tag.id)
                      }}
                      className={cn(
                        'min-w-0 flex-1 cursor-pointer justify-start gap-2 px-2 text-left font-normal hover:bg-muted',
                        tag.id === currentSelectedId && 'bg-muted font-medium'
                      )}
                    >
                      <TagBadge tag={tag} className="min-w-0" />
                      <span
                        data-slot="tag-list-count"
                        className="ml-auto min-w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                      >
                        {counts.get(tag.id) ?? 0}
                      </span>
                    </Button>
                  </li>
                )
              })}
            </ol>
          </aside>

          <section
            ref={resourceListRef}
            className="min-h-0 min-w-0 overflow-y-auto bg-card p-4"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {selectedTag ? (
              <>
                <div
                  data-slot="tag-detail-header"
                  className="mb-4 flex min-h-7 flex-wrap items-center justify-between gap-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <TagBadge tag={selectedTag} />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t('{{count}} resources', {
                        count: query.trim()
                          ? filteredResources.length
                          : selectedAssignments.filter(
                              (assignment) =>
                                typeFilter === 'all' || assignment.resourceType === typeFilter
                            ).length,
                        defaultValue_one: '{{count}} resource'
                      })}
                    </span>
                  </div>
                  {'systemKey' in selectedTag ? null : (
                    <div
                      data-slot="tag-detail-actions"
                      className="flex shrink-0 items-center gap-1"
                    >
                      <SettingsIconAction
                        label={t('Edit Tag')}
                        icon={Pencil}
                        onClick={() => onEdit(selectedTag)}
                      />
                      <SettingsIconAction
                        label={t('Delete Tag')}
                        icon={Trash2}
                        danger
                        onClick={() => {
                          setDeleteError(undefined)
                          setDeleting(selectedTag)
                        }}
                      />
                    </div>
                  )}
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
                      <SelectItem value="literature.item">
                        {t('References')} ({typeCounts.get('literature.item') ?? 0})
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {assignmentError ? (
                  <p role="alert" className="mb-3 text-xs text-destructive">
                    {assignmentError}
                  </p>
                ) : null}
                {visibleCatalogTypes.map((type) => {
                  const catalog = catalogLoads[type]
                  if (catalog.status === 'ready') return null
                  return catalog.status === 'error' ? (
                    <div key={type} role="alert" className="mb-4">
                      <ErrorNotice
                        title={t('Could not load {{type}}.', { type: resourceTypeLabel(t, type) })}
                        description={t(
                          'Tag assignments are loaded, but these resource details are unavailable.'
                        )}
                        primaryButton={{ label: t('Retry'), onClick: catalog.retry }}
                      />
                    </div>
                  ) : (
                    <p key={type} role="status" className="py-3 text-sm text-muted-foreground">
                      {t('Loading {{type}}…', { type: resourceTypeLabel(t, type) })}
                    </p>
                  )
                })}
                {unavailableAssignmentCount > 0 ? (
                  <div className="mb-4">
                    <ErrorNotice
                      role="status"
                      title={t('{{count}} tagged resources are currently unavailable.', {
                        count: unavailableAssignmentCount,
                        defaultValue_one: '{{count}} tagged resource is currently unavailable.'
                      })}
                      description={t('Tag assignments are preserved.')}
                    />
                  </div>
                ) : null}
                {filteredResources.length > 0 ? (
                  <div data-slot="tag-resource-groups" className="divide-y divide-border">
                    {resourceGroups.map(({ resourceType, resources: groupedResources }) => {
                      const expanded = !collapsed[resourceType]
                      const Icon =
                        resourceType === 'catalog.skill'
                          ? ScrollText
                          : resourceType === 'catalog.connector'
                            ? ConnectorsNavIcon
                            : resourceType === 'literature.item'
                              ? BookOpenText
                              : Users
                      return (
                        <section key={resourceType} className="py-3 first:pt-0 last:pb-0">
                          <button
                            type="button"
                            data-slot="tag-resource-group"
                            aria-expanded={expanded}
                            onClick={() =>
                              setCollapsed((value) => ({
                                ...value,
                                [resourceType]: !value[resourceType]
                              }))
                            }
                            className="flex w-full cursor-pointer items-center gap-1 text-left text-sm font-semibold text-foreground"
                          >
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                            <span>
                              {resourceTypeLabel(t, resourceType)} ({groupedResources.length})
                            </span>
                            <ChevronDown
                              className={cn(
                                'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                                !expanded && '-rotate-90'
                              )}
                              aria-hidden="true"
                            />
                          </button>
                          {expanded ? (
                            <ul className="mt-1">
                              {groupedResources.map((resource) => {
                                const key = `${resource.resourceType}:${resource.resourceId}`
                                return (
                                  <li
                                    key={key}
                                    className="group -mx-2 flex items-center gap-1 rounded-lg px-2 hover:bg-muted/50 focus-within:bg-muted/50"
                                  >
                                    <button
                                      type="button"
                                      data-slot="tag-resource-row"
                                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-3 text-left hover:text-primary"
                                      onClick={() => {
                                        if (resource.literatureReference) {
                                          setSelectedLiteratureReference(
                                            resource.literatureReference
                                          )
                                        } else {
                                          onOpenResource(resource)
                                        }
                                      }}
                                    >
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm">
                                          {resource.title}
                                        </span>
                                        {resource.subtitle ? (
                                          <span
                                            data-slot="tag-resource-subtitle"
                                            className="block truncate text-xs text-muted-foreground"
                                          >
                                            {resource.subtitle}
                                          </span>
                                        ) : null}
                                      </span>
                                    </button>
                                    <SettingsIconAction
                                      label={t('Remove {{resource}} from {{tag}}', {
                                        resource: resource.accessibleTitle ?? resource.title,
                                        tag: tagPresentation(selectedTag, t).name
                                      })}
                                      icon={X}
                                      disabled={removingResourceKey === key}
                                      className="pointer-events-auto shrink-0 opacity-100 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100"
                                      onClick={() => void removeResource(resource)}
                                    />
                                  </li>
                                )
                              })}
                            </ul>
                          ) : null}
                        </section>
                      )
                    })}
                  </div>
                ) : catalogsReady && unavailableAssignmentCount === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    {t('No resources match this Tag.')}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {status === 'loading'
                  ? t('Loading Tags…')
                  : t('Create a Tag to organize resources.')}
              </p>
            )}
          </section>
        </div>

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
        <ArtifactLiteratureDetailDialog
          reference={selectedLiteratureReference}
          onOpenChange={(open) => {
            if (!open) setSelectedLiteratureReference(undefined)
          }}
        />
      </div>
    </TooltipProvider>
  )
}

const TagsPanel = ({
  view,
  onNavigate,
  onOpenResource,
  onSelectedTagChange
}: {
  view: TagsView
  onNavigate(view: TagsView): void
  onOpenResource(reference: TagResourceRef): void
  onSelectedTagChange?(tagId: string): void
}): React.JSX.Element => {
  const tags = useTagStore((state) => state.tags)
  const status = useTagStore((state) => state.status)
  const editTag =
    view.kind === 'edit'
      ? tags.find((tag): tag is CustomTagView => tag.id === view.tagId && !('systemKey' in tag))
      : undefined

  useEffect(() => {
    if (view.kind === 'edit' && status === 'ready' && !editTag) {
      onNavigate({ kind: 'list' })
    }
  }, [editTag, onNavigate, status, view.kind])

  if (view.kind === 'create') {
    return (
      <TagForm
        onCancel={() => onNavigate({ kind: 'list' })}
        onSaved={(tagId) => onNavigate({ kind: 'list', tagId })}
      />
    )
  }

  if (view.kind === 'edit' && editTag) {
    return (
      <TagForm
        key={editTag.id}
        tag={editTag}
        onCancel={() => onNavigate({ kind: 'list', tagId: editTag.id })}
        onSaved={(tagId) => onNavigate({ kind: 'list', tagId })}
      />
    )
  }

  if (view.kind === 'edit') return <div className="h-full" />

  return (
    <TagsList
      onCreate={() => onNavigate({ kind: 'create' })}
      onEdit={(tag) => onNavigate({ kind: 'edit', tagId: tag.id })}
      onOpenResource={onOpenResource}
      onSelectedTagChange={onSelectedTagChange}
    />
  )
}

export { TagsPanel }
