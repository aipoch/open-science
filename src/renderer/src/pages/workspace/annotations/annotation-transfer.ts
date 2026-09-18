import type { Annotation } from '../../../../../shared/annotations'

export const ANNOTATION_DRAG_TYPE = 'application/x-open-science-annotation'
export type AnnotationTransfer = Readonly<{
  originId?: string
  projectId: string
  parentSessionId: string
  annotation: Annotation
}>
type Source = { read: () => AnnotationTransfer | undefined; remove: () => void }
// Drag data contains only a one-use token. External payloads cannot inject annotations or callbacks.
class AnnotationTransfers {
  private sources = new Map<string, Source>()
  private pending: { token: string; sourceId: string; snapshot: AnnotationTransfer } | undefined
  register(id: string, source: Source): () => void {
    this.sources.set(id, source)
    return () => {
      if (this.sources.get(id) === source) this.sources.delete(id)
    }
  }
  begin(sourceId: string): string | undefined {
    const snapshot = this.sources.get(sourceId)?.read()
    if (!snapshot) return undefined
    const token = crypto.randomUUID()
    this.pending = { token, sourceId, snapshot: structuredClone(snapshot) }
    return token
  }
  read(token?: string): AnnotationTransfer | undefined {
    const pending = this.pending
    if (!pending || (token !== undefined && pending.token !== token)) return undefined
    const current = this.sources.get(pending.sourceId)?.read()
    return current && JSON.stringify(current) === JSON.stringify(pending.snapshot)
      ? pending.snapshot
      : undefined
  }
  commit(token: string, receive: (transfer: AnnotationTransfer) => boolean): boolean {
    const transfer = this.read(token)
    const source = this.pending && this.sources.get(this.pending.sourceId)
    if (!transfer || !source || !receive(transfer)) return false
    this.pending = undefined
    source.remove()
    return true
  }
  cancel(): void {
    this.pending = undefined
  }
}
export const annotationTransfers = new AnnotationTransfers()
