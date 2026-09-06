import type { LiteratureItemView } from '../../../../shared/literature'

export type LiteratureDetailSnapshot = Readonly<{
  item?: LiteratureItemView
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
  let snapshot: LiteratureDetailSnapshot = { open: false }
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
      if (!snapshot.open && !snapshot.item) return
      publish({ open: false })
    },
    open: (item) => publish({ item, open: true }),
    replace: (item) => {
      if (snapshot.item?.id !== item.id) return
      publish({ ...snapshot, item })
    }
  }
}

export { createLiteratureDetailController }
