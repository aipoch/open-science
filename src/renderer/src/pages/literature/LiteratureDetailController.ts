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
  invalidate: () => void
  read: (id: string) => Promise<LiteratureItemView | undefined>
}>

const createLiteratureDetailController = (): LiteratureDetailController => {
  let snapshot: LiteratureDetailSnapshot = { open: false, generation: 0 }
  const listeners = new Set<() => void>()
  const reads = new Map<
    string,
    { promise: Promise<LiteratureItemView | undefined>; invalidated: boolean }
  >()
  const read = (id: string): Promise<LiteratureItemView | undefined> => {
    const previous = reads.get(id)
    if (previous) previous.invalidated = true
    const entry = {
      promise: undefined as unknown as Promise<LiteratureItemView | undefined>,
      invalidated: false
    }
    entry.promise = window.api.literature
      .get(id)
      .then((item): Promise<LiteratureItemView | undefined> | LiteratureItemView | undefined => {
        const newer = reads.get(id)
        if (newer && newer !== entry) return newer.promise
        // A committed relation publication invalidates the whole view, even at equal metadata revision.
        // Merely reopening a detail does not invalidate data already being read for that identity.
        return entry.invalidated ? read(id) : item
      })
      .finally(() => {
        if (reads.get(id) === entry) reads.delete(id)
      })
    reads.set(id, entry)
    return entry.promise
  }
  const publish = (next: LiteratureDetailSnapshot): void => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    read,
    invalidate: () => {
      for (const pending of reads.values()) pending.invalidated = true
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      publish({ open: false, generation: snapshot.generation + 1 })
    },
    open: (item) => publish({ item, open: true, generation: snapshot.generation + 1 }),
    replace: (item) => {
      const pending = reads.get(item.id)
      if (pending) pending.invalidated = true
      if (snapshot.item?.id !== item.id || item.metadataRevision < snapshot.item.metadataRevision)
        return
      publish({ ...snapshot, item })
    }
  }
}

export { createLiteratureDetailController }
