import type {
  LiteratureCatalogCommand,
  LiteratureCatalogReceipt,
  LiteratureDuplicatePolicy,
  LiteratureItemInput,
  LiteratureItemView
} from '../contracts.js'
type Destination = Extract<
  LiteratureCatalogCommand,
  { kind: 'set-project-item' | 'set-collection-item' }
>
export type CreationIntent<File> = {
  item?: LiteratureItemInput
  duplicatePolicy: LiteratureDuplicatePolicy
  projectId?: string
  collectionId?: string
  smartCollection?: boolean
  file?: File
}
export type LiteratureCreation<File> = {
  readonly pendingId: string | undefined
  readonly failurePhase: 'create' | 'destination' | 'remaining'
  reset(): void
  recoverPdfFailure(): Promise<LiteratureItemView | undefined>
  complete(
    intent: CreationIntent<File>,
    attachPdf: (file: File, itemId: string) => Promise<LiteratureItemView>
  ): Promise<{ item: LiteratureItemView; projectId?: string; collectionId?: string }>
}
/** Retains the committed receipt and original destination across retries. File transport belongs to the caller. */
export function createLiteratureCreation<File>(options: {
  transact(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt>
  onCreated?(id: string): void
  read(id: string): Promise<LiteratureItemView | undefined>
}): LiteratureCreation<File> {
  let pending:
    | {
        id: string
        projectId?: string
        collectionId?: string
        destination?: Destination
        file?: File
        pdfItem?: LiteratureItemView
      }
    | undefined
  return {
    get pendingId() {
      return pending?.id
    },
    get failurePhase(): 'create' | 'destination' | 'remaining' {
      return pending ? (pending.destination ? 'destination' : 'remaining') : 'create'
    },
    reset() {
      pending = undefined
    },
    async recoverPdfFailure(): Promise<LiteratureItemView | undefined> {
      return pending?.file && !pending.destination && !pending.pdfItem
        ? options.read(pending.id).catch(() => undefined)
        : undefined
    },
    async complete(
      intent: CreationIntent<File>,
      attachPdf: (file: File, itemId: string) => Promise<LiteratureItemView>
    ) {
      if (!pending) {
        if (!intent.item) throw new Error('Literature creation requires an item.')
        const receipt = await options.transact({
          kind: 'create-item',
          item: intent.item,
          ...(intent.duplicatePolicy === 'reuse' ? {} : { duplicatePolicy: intent.duplicatePolicy })
        })
        pending = {
          id: receipt.id,
          projectId: intent.projectId,
          collectionId: intent.collectionId,
          file: intent.file,
          destination: intent.projectId
            ? {
                kind: 'set-project-item',
                projectId: intent.projectId,
                itemId: receipt.id,
                included: true,
                source: 'library'
              }
            : intent.collectionId && !intent.smartCollection
              ? {
                  kind: 'set-collection-item',
                  collectionId: intent.collectionId,
                  itemId: receipt.id,
                  included: true
                }
              : undefined
        }
        options.onCreated?.(pending.id)
      }
      if (pending.destination) {
        await options.transact(pending.destination)
        pending.destination = undefined
      }
      if (pending.file && !pending.pdfItem)
        pending.pdfItem = await attachPdf(pending.file, pending.id)
      const item = pending.pdfItem ?? (await options.read(pending.id))
      if (!item) throw new Error('Literature Item is unavailable after creating.')
      return { item, projectId: pending.projectId, collectionId: pending.collectionId }
    }
  }
}
