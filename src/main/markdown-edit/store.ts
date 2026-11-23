import { randomUUID } from 'node:crypto'

export const MAX_MARKDOWN_BYTES = 128 * 1024
const LIFETIME_MS = 15 * 60_000
const MAX_SELECTIONS = 64

interface Selection {
  owner: number
  projectId: string
  markdown: string
  pending: string | null
  listeners: Set<() => void>
  expires: number
  timer: NodeJS.Timeout
}

const checkSize = (markdown: string): void => {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES)
    throw new Error('Markdown exceeds the selection size limit.')
}

export class MarkdownEditStore {
  private readonly selections = new Map<string, Selection>()

  open(owner: number, projectId: string, markdown: string): string {
    if (!Number.isSafeInteger(owner) || !projectId?.trim())
      throw new Error('Invalid selection scope.')
    checkSize(markdown)
    if (this.selections.size >= MAX_SELECTIONS)
      throw new Error('Too many open Markdown selections.')
    const handle = randomUUID()
    this.selections.set(handle, {
      owner,
      projectId,
      markdown,
      pending: null,
      listeners: new Set(),
      expires: Date.now() + LIFETIME_MS,
      timer: setTimeout(() => this.close(owner, handle), LIFETIME_MS).unref()
    })
    return handle
  }

  close(owner: number, handle: string): void {
    const entry = this.selections.get(handle)
    if (entry && entry.owner === owner) {
      clearTimeout(entry.timer)
      entry.listeners.clear()
      this.selections.delete(handle)
    }
  }

  private live(handle: string): Selection | undefined {
    const entry = this.selections.get(handle)
    if (entry && entry.expires <= Date.now()) {
      this.close(entry.owner, handle)
      return undefined
    }
    return entry
  }

  private scoped(projectId: string, handle: string): Selection {
    const entry = this.live(handle)
    if (!entry || entry.projectId !== projectId) throw new Error('Markdown selection unavailable.')
    return entry
  }

  read(projectId: string, handle: string): string {
    return this.scoped(projectId, handle).markdown
  }

  propose(projectId: string, handle: string, markdown: string): void {
    const entry = this.scoped(projectId, handle)
    checkSize(markdown)
    entry.pending = markdown
    for (const callback of entry.listeners) callback()
  }

  take(owner: number, handle: string): string | null {
    const entry = this.live(handle)
    if (!entry || entry.owner !== owner) return null
    const pending = entry.pending
    entry.pending = null
    return pending
  }

  onReady(owner: number, handle: string, callback: () => void): () => void {
    const entry = this.live(handle)
    if (!entry || entry.owner !== owner) return () => {}
    const listeners = entry.listeners
    listeners.add(callback)
    if (entry.pending !== null) callback()
    return () => listeners.delete(callback)
  }
}

export const markdownEditStore = new MarkdownEditStore()
