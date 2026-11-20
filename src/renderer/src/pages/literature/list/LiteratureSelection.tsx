import { useSyncExternalStore, type ReactNode } from 'react'
import {
  isLiteratureItemSelected,
  type LiteratureSelectionSnapshot,
  type LiteratureSelectionStore
} from './literature-selection'

export const LiteratureSelectionBoundary = ({
  children,
  store
}: Readonly<{
  children: (snapshot: LiteratureSelectionSnapshot) => ReactNode
  store: LiteratureSelectionStore
}>): React.JSX.Element => {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return <>{children(snapshot)}</>
}

export const LiteratureSelectionCheckbox = ({
  className,
  disabled,
  itemId,
  label,
  store
}: Readonly<{
  className?: string
  disabled?: boolean
  itemId: string
  label: string
  store: LiteratureSelectionStore
}>): React.JSX.Element => {
  const selected = useSyncExternalStore(
    store.subscribe,
    () => isLiteratureItemSelected(store.getSnapshot(), itemId),
    () => isLiteratureItemSelected(store.getSnapshot(), itemId)
  )
  return (
    <input
      type="checkbox"
      checked={selected}
      disabled={disabled}
      onChange={() => store.toggle(itemId)}
      aria-label={label}
      className={className}
    />
  )
}

export const LiteratureSelectPageCheckbox = ({
  className,
  disabled,
  itemIds,
  label,
  preserveOtherSelections = false,
  store
}: Readonly<{
  className?: string
  disabled?: boolean
  itemIds: readonly string[]
  label: string
  preserveOtherSelections?: boolean
  store: LiteratureSelectionStore
}>): React.JSX.Element => {
  const selectedCount = useSyncExternalStore(
    store.subscribe,
    () => {
      const snapshot = store.getSnapshot()
      return itemIds.filter((itemId) => isLiteratureItemSelected(snapshot, itemId)).length
    },
    () => 0
  )
  const allSelected = itemIds.length > 0 && selectedCount === itemIds.length
  const mixed = selectedCount > 0 && !allSelected
  return (
    <input
      ref={(input) => {
        if (input) input.indeterminate = mixed
      }}
      type="checkbox"
      checked={allSelected}
      disabled={disabled}
      onChange={() => {
        const snapshot = store.getSnapshot()
        if (preserveOtherSelections) {
          if (snapshot.allMatchingSelected) {
            for (const itemId of itemIds)
              if (isLiteratureItemSelected(snapshot, itemId) === allSelected) store.toggle(itemId)
          } else {
            const selectedIds = new Set(snapshot.selectedIds)
            for (const itemId of itemIds) {
              if (allSelected) selectedIds.delete(itemId)
              else selectedIds.add(itemId)
            }
            store.replace(selectedIds)
          }
        } else if (snapshot.allMatchingSelected || allSelected) store.clear()
        else store.replace(itemIds)
      }}
      aria-label={label}
      className={className}
    />
  )
}
