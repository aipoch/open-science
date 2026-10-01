export type LiteratureSelectionSnapshot = Readonly<{
  selectedIds: ReadonlySet<string>
  allMatchingSelected: boolean
  excludedMatchingIds: ReadonlySet<string>
}>

export type LiteratureSelectionStore = Readonly<{
  getSnapshot: () => LiteratureSelectionSnapshot
  subscribe: (listener: () => void) => () => void
  clear: () => void
  remove: (itemId: string) => void
  replace: (itemIds: Iterable<string>) => void
  selectAllMatching: () => void
  toggle: (itemId: string) => void
}>

export const createLiteratureSelectionStore = (): LiteratureSelectionStore => {
  let snapshot: LiteratureSelectionSnapshot = {
    selectedIds: new Set(),
    allMatchingSelected: false,
    excludedMatchingIds: new Set()
  }
  const listeners = new Set<() => void>()
  const publish = (next: LiteratureSelectionSnapshot): void => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clear: () => {
      if (
        snapshot.selectedIds.size === 0 &&
        !snapshot.allMatchingSelected &&
        snapshot.excludedMatchingIds.size === 0
      ) {
        return
      }
      publish({
        selectedIds: new Set(),
        allMatchingSelected: false,
        excludedMatchingIds: new Set()
      })
    },
    remove: (itemId) => {
      if (!snapshot.selectedIds.has(itemId)) return
      const selectedIds = new Set(snapshot.selectedIds)
      selectedIds.delete(itemId)
      publish({ ...snapshot, selectedIds })
    },
    replace: (itemIds) =>
      publish({
        selectedIds: new Set(itemIds),
        allMatchingSelected: false,
        excludedMatchingIds: new Set()
      }),
    selectAllMatching: () =>
      publish({
        selectedIds: new Set(),
        allMatchingSelected: true,
        excludedMatchingIds: new Set()
      }),
    toggle: (itemId) => {
      if (snapshot.allMatchingSelected) {
        const excludedMatchingIds = new Set(snapshot.excludedMatchingIds)
        if (excludedMatchingIds.has(itemId)) excludedMatchingIds.delete(itemId)
        else excludedMatchingIds.add(itemId)
        publish({ ...snapshot, excludedMatchingIds })
        return
      }
      const selectedIds = new Set(snapshot.selectedIds)
      if (selectedIds.has(itemId)) selectedIds.delete(itemId)
      else selectedIds.add(itemId)
      publish({ ...snapshot, selectedIds })
    }
  }
}

export const isLiteratureItemSelected = (
  snapshot: LiteratureSelectionSnapshot,
  itemId: string
): boolean =>
  snapshot.allMatchingSelected
    ? !snapshot.excludedMatchingIds.has(itemId)
    : snapshot.selectedIds.has(itemId)
