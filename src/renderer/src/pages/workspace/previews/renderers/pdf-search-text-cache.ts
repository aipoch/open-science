/** Retain a document's text within a byte budget; don't cyclically evict pages during full scans. */
export class PdfSearchTextCache {
  private readonly entries = new Map<number, Promise<string>>()
  private bytes = 0
  private generation = 0
  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

  clear(): void {
    this.generation++
    this.entries.clear()
    this.bytes = 0
  }

  get(page: number, load: () => Promise<string>): Promise<string> {
    const cached = this.entries.get(page)
    if (cached) return cached
    const generation = this.generation
    const pending = load().then(
      (text) => {
        const normalized = text.toLocaleLowerCase()
        if (generation === this.generation && this.entries.get(page) === pending) {
          const size = normalized.length * 2
          if (this.bytes + size <= this.maxBytes) this.bytes += size
          else this.entries.delete(page)
        }
        return normalized
      },
      (error) => {
        if (this.entries.get(page) === pending) this.entries.delete(page)
        throw error
      }
    )
    // Also bound bookkeeping for PDFs with many empty pages.
    if (this.entries.size < 20_000) this.entries.set(page, pending)
    return pending
  }
}
