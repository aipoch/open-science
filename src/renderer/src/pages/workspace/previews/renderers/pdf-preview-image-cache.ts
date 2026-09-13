import type { ReadPdfStructureThumbnailRequest } from '../../../../../../shared/pdf-structure'

type Entry = { url?: string; ready: boolean; pending?: Promise<string | undefined> }
const keyOf = (request: ReadPdfStructureThumbnailRequest): string =>
  JSON.stringify([
    request.attachmentVersionId,
    request.extractionId,
    request.page,
    request.thumbnailId
  ])

/** Owned by one open PDF preview, not shared across documents or persisted. */
export class PdfPreviewImageCache {
  private entries = new Map<string, Entry>()

  peek(request: ReadPdfStructureThumbnailRequest): Entry | undefined {
    return this.entries.get(keyOf(request))
  }

  load(request: ReadPdfStructureThumbnailRequest): Promise<string | undefined> {
    const key = keyOf(request)
    const existing = this.entries.get(key)
    if (existing) {
      this.entries.delete(key)
      this.entries.set(key, existing)
      return existing.pending ?? Promise.resolve(existing.url)
    }
    const entry: Entry = { ready: false }
    this.entries.set(key, entry)
    entry.pending = window.api.pdfStructure
      .readThumbnail(request)
      .then((url) => {
        // A clear/retry must not be undone by an older response.
        if (this.entries.get(key) !== entry) return url
        entry.pending = undefined
        if (!url) this.entries.delete(key)
        else {
          entry.url = url
          this.trim()
        }
        return url
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw error
      })
    this.trim()
    return entry.pending
  }

  markReady(request: ReadPdfStructureThumbnailRequest): void {
    const entry = this.peek(request)
    if (entry?.url) entry.ready = true
  }

  invalidate(request: ReadPdfStructureThumbnailRequest): void {
    this.entries.delete(keyOf(request))
  }

  clear(): void {
    this.entries.clear()
  }

  private trim(): void {
    let bytes = [...this.entries.values()].reduce(
      (sum, entry) => sum + (entry.url?.length ?? 0) * 2,
      0
    )
    while (this.entries.size > 12 || bytes > 64 * 1024 ** 2) {
      const key = this.entries.keys().next().value!
      bytes -= (this.entries.get(key)?.url?.length ?? 0) * 2
      this.entries.delete(key)
    }
  }
}
