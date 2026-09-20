import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useSpecialistStore } from '@/stores/specialist-store'
import { bulkResourceActions, type AssignableResource } from './resource-assignment'
import { setResourceAssignments } from './resource-assignment-actions'

export type ResourceSelection = {
  resources: AssignableResource[]
  selected: AssignableResource[]
  ids: Set<string>
  groups: Set<string>
  busy: boolean
  error: boolean
  completed: boolean
  review: AssignableResource[] | undefined
  locked: boolean
  actions: ReturnType<typeof bulkResourceActions>
  available: boolean
  toggleIds: (targets: string[]) => void
  toggleGroup: (group: string) => void
  stopMain: () => Promise<void>
  deleteSelected: () => Promise<void>
  openReview: () => void
  cancelReview: () => void
  clear: () => void
  assign: (id: string) => Promise<void>
  unlink: () => Promise<void>
}

export const useStickyResourceFilters = (): {
  panelRef: RefObject<HTMLDivElement | null>
  filterRef: RefObject<HTMLDivElement | null>
} => {
  const panelRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  // Measure wrapping filters as well as single-line layouts; category headings never overlap them.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const filters = filterRef.current
    if (!panel || !filters) return
    const measure = (): void =>
      panel.style.setProperty(
        '--resource-filter-height',
        `${filters.getBoundingClientRect().height}px`
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(filters)
    return () => observer.disconnect()
  })
  return { panelRef, filterRef }
}

export const useResourceSelection = ({
  resources,
  onSetMain,
  onDelete
}: {
  resources: AssignableResource[]
  onSetMain: (id: string, enabled: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
}): ResourceSelection => {
  const items = useSpecialistStore((state) => state.items)
  const integrity = useSpecialistStore((state) => state.integrity)
  const loadError = useSpecialistStore((state) => state.loadError)
  const [groups, setGroups] = useState<Set<string>>(() => new Set())
  const [ids, setIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [review, setReview] = useState<AssignableResource[] | undefined>()
  const pending = useRef(false)
  const selected = resources.filter((resource) => ids.has(resource.id))
  const actions = bulkResourceActions(selected, items)
  const locked = busy || Boolean(review)
  const available = integrity.status === 'ok' && !loadError
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(false)
    setCompleted(false)
    try {
      await action()
      setCompleted(true)
    } catch {
      setError(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const toggleIds = (targets: string[]): void => {
    if (pending.current || review) return
    setCompleted(false)
    setIds((current) => {
      const next = new Set(current)
      const remove = targets.every((id) => next.has(id))
      targets.forEach((id) => (remove ? next.delete(id) : next.add(id)))
      return next
    })
  }
  const toggleGroup = (group: string): void => {
    if (pending.current || review) return
    setGroups((current) => {
      const next = new Set(current)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
    if (groups.has(group))
      setIds(
        (current) =>
          new Set(
            [...current].filter(
              (id) => !resources.some((resource) => resource.id === id && resource.group === group)
            )
          )
      )
  }
  const stopMain = (): Promise<void> =>
    run(async () => {
      let failed = false
      // Settings snapshots can arrive out of order; serialize writes to the same catalog.
      for (const resource of actions.stopMain) {
        try {
          await onSetMain(resource.id, false)
        } catch {
          failed = true
        }
      }
      if (failed) throw new Error('Some updates failed')
    })
  const deleteSelected = (): Promise<void> =>
    run(async () => {
      if (!review) return
      // Re-check the live catalog after review. Never expand a confirmed deletion to new targets.
      const deleted = new Set<string>()
      let failed = false
      for (const target of review) {
        try {
          // Earlier removals may await cleanup while another window edits Specialist references.
          await useSpecialistStore.getState().load({ force: true })
          const latest = useSpecialistStore.getState()
          if (latest.integrity.status !== 'ok' || latest.loadError)
            throw new Error('Specialist catalog unavailable')
          const resource = resources.find((resource) => resource.id === target.id)
          if (!resource || !bulkResourceActions([resource], latest.items).deletable.length) {
            failed = true
            continue
          }
          await onDelete(resource.id)
          deleted.add(resource.id)
        } catch {
          failed = true
        }
      }
      setIds((current) => new Set([...current].filter((id) => !deleted.has(id))))
      setReview(undefined)
      if (failed) throw new Error('Some deletions failed')
    })
  return {
    resources,
    selected,
    ids,
    groups,
    busy,
    error,
    completed,
    review,
    locked,
    actions,
    available,
    toggleIds,
    toggleGroup,
    stopMain,
    deleteSelected,
    openReview: () => setReview(actions.deletable),
    cancelReview: () => setReview(undefined),
    clear: () => {
      if (!pending.current) {
        setGroups(new Set())
        setIds(new Set())
        setError(false)
        setCompleted(false)
      }
    },
    assign: (id: string) => run(() => setResourceAssignments(selected, true, id)),
    unlink: () => run(() => setResourceAssignments(actions.unlink, false))
  }
}
