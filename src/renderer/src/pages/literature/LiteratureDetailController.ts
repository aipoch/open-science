import type { LiteratureItemView } from '../../../../shared/literature'

export type LiteratureDetailSnapshot = Readonly<{
  item?: LiteratureItemView
  generation: number
  open: boolean
}>

export type LiteratureDetailController = Readonly<{
  getSnapshot: () => LiteratureDetailSnapshot
  subscribe: (listener: () => void) => () => void
  close: () => void
  open: (item: LiteratureItemView) => void
  replace: (item: LiteratureItemView) => void
}>

const createLiteratureDetailController = (): LiteratureDetailController => {
  let snapshot: LiteratureDetailSnapshot = { open: false, generation: 0 }
  const listeners = new Set<() => void>()
  const publish = (next: LiteratureDetailSnapshot): void => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      publish({ open: false, generation: snapshot.generation + 1 })
    },
    open: (item) => publish({ item, open: true, generation: snapshot.generation + 1 }),
    replace: (item) => {
      if (snapshot.item?.id !== item.id || item.metadataRevision < snapshot.item.metadataRevision)
        return
      publish({ ...snapshot, item })
    }
  }
}

export { createLiteratureDetailController }
