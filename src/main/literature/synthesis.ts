import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  annotationQuote,
  literatureSynthesisRequestSchema,
  synthesisNoteSummary,
  type LiteratureSynthesisRequest,
  type LiteratureSynthesisResult,
  type SynthesisNote,
  type SynthesisExcerpt,
  type SynthesisStoredNote,
  type SynthesisCandidate,
  type SynthesisExcerptSelection
} from '../../shared/literature-synthesis'
import type { LiteratureSynthesisStore } from './synthesis-store'
import type { SynthesisSources } from './synthesis-sources'

// Plain-text author copy and source text stay literal in portable Markdown (including HTML).
const escapeMarkdown = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1')
// Keep indentation and setext underlines literal when a plain-text line starts a block.
const escapeBlockText = (value: string): string =>
  escapeMarkdown(value.replace(/\r\n?/g, '\n'))
    .replace(/^[ \t]+(?=\S)/gm, (indent) => indent.replace(/ /g, '&nbsp;').replace(/\t/g, '&#9;'))
    .replace(/^=+(?=[ \t]*$)/gm, (underline) => '\\' + underline)

function markdownFilename(title: string): string {
  const extension = '.md'
  let stem = ''
  let bytes = Buffer.byteLength(extension)
  for (const character of title.replace(/[^\p{L}\p{N}_-]+/gu, '-')) {
    bytes += Buffer.byteLength(character)
    if (bytes > 255 || stem.length + character.length > 100) break
    stem += character
  }
  return (stem || 'synthesis') + extension
}

const quote = (value: string): string =>
  escapeBlockText(value)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
export function exportSynthesisMarkdown(note: SynthesisNote): string {
  const output = [`# ${escapeMarkdown(note.title)}`]
  for (const block of note.blocks) {
    if (block.type === 'heading')
      output.push(
        `${'#'.repeat(block.level + 1)} ${escapeMarkdown(block.text).replace(/\r?\n/g, ' ')}`
      )
    else if (block.type === 'text') output.push(escapeBlockText(block.text))
    else {
      const { annotation, bibliography } = block.snapshot
      const selector = annotation.target.selector
      const original = annotationQuote(selector)
      const page = 'pageNumber' in selector ? `; p. ${selector.pageNumber}` : ''
      output.push(
        `**Source:** ${escapeMarkdown(bibliography.title)}${bibliography.authors ? ` — ${escapeMarkdown(bibliography.authors)}` : ''}${bibliography.year ? ` (${escapeMarkdown(bibliography.year)})` : ''}${page}`
      )
      if (bibliography.doi) output.push(`DOI: ${escapeMarkdown(bibliography.doi)}`)
      if (original) output.push(quote(original))
      if (annotation.note) output.push(`**Annotation note:**\n\n${quote(annotation.note)}`)
      output.push(
        `Source annotation: ${escapeMarkdown(annotation.id)}; revision: ${annotation.updatedAt}; source checksum: ${escapeMarkdown(annotation.target.source.checksum)}; status: ${block.sourceStatus}`
      )
      if (block.snapshot.tags.length)
        output.push(
          `Tags: ${block.snapshot.tags.map((tag) => escapeMarkdown(tag.name)).join(', ')}`
        )
    }
  }
  return output.join('\n\n') + '\n'
}

function comparableSnapshot(snapshot: SynthesisCandidate): unknown {
  // Stored JSON omits undefined fields. Tag query order carries no meaning for source status.
  return JSON.parse(
    JSON.stringify({
      ...snapshot,
      annotation: { ...snapshot.annotation, tagIds: [...snapshot.annotation.tagIds].sort() },
      tags: [...snapshot.tags].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    })
  )
}

function deduplicateSnapshots(
  snapshots: SynthesisCandidate[],
  canonicalIds: Map<string, string>,
  existingIds: Set<string> = new Set()
): SynthesisCandidate[] {
  const seen = new Set(existingIds)
  return snapshots.filter((snapshot) => {
    const id = canonicalIds.get(snapshot.annotationId) ?? snapshot.annotationId
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

type MutationRequest = Extract<
  LiteratureSynthesisRequest,
  { action: 'create' | 'update' | 'append' }
>
type StoredMutationResult =
  | { action: MutationRequest['action']; note: SynthesisStoredNote }
  | Extract<LiteratureSynthesisResult, { action: 'delete' | 'append-rejected' }>

export class LiteratureSynthesisService {
  constructor(
    private readonly store: Pick<LiteratureSynthesisStore, 'run'>,
    private readonly sources: SynthesisSources
  ) {}

  private replay(
    notes: SynthesisStoredNote[],
    request: MutationRequest,
    fingerprint: string
  ): SynthesisStoredNote | undefined {
    if (!request.requestId) return undefined
    for (const note of notes) {
      const receipt =
        note.creationRequest?.id === request.requestId
          ? note.creationRequest
          : note.lastMutation?.id === request.requestId
            ? note.lastMutation
            : note.lastNoopAppend?.id === request.requestId
              ? note.lastNoopAppend
              : undefined
      if (!receipt) continue
      if (receipt.fingerprint !== fingerprint)
        throw new Error('Synthesis request identity was reused with different content.')
      // A replay returns the current durable baseline and never rolls back a later edit.
      return note
    }
    return undefined
  }

  private async snapshots(
    itemIds: string[],
    excerpts: SynthesisExcerptSelection[]
  ): Promise<SynthesisCandidate[]> {
    const keys = new Set<string>()
    const result: SynthesisCandidate[] = []
    for (const excerpt of excerpts) {
      const key = excerpt.annotationId
      if (!itemIds.includes(excerpt.itemId) || keys.has(key))
        throw new Error('Synthesis excerpt selection is invalid.')
      keys.add(key)
      const snapshot = await this.sources.resolve(excerpt)
      if (
        !snapshot ||
        snapshot.annotationId !== excerpt.annotationId ||
        (excerpt.expectedUpdatedAt !== undefined &&
          snapshot.annotation.updatedAt !== excerpt.expectedUpdatedAt)
      )
        throw new Error('A selected annotation is unavailable. Reload annotations and try again.')
      result.push(snapshot)
    }
    return result
  }

  private async currentExcerpt(
    block: Extract<SynthesisStoredNote['blocks'][number], { type: 'excerpt' }>
  ): Promise<SynthesisExcerpt> {
    const { itemId, versionId, annotationId } = block.snapshot
    try {
      const current = await this.sources.resolve({ itemId, versionId, annotationId })
      const sourceStatus = !current
        ? 'unavailable'
        : isDeepStrictEqual(comparableSnapshot(current), comparableSnapshot(block.snapshot))
          ? 'current'
          : 'changed'
      return { ...block, sourceStatus } as const
    } catch {
      // Source checks enrich a complete durable snapshot; they cannot revoke access to it.
      return { ...block, sourceStatus: 'unverified' } as const
    }
  }

  private async current(note: SynthesisStoredNote): Promise<SynthesisNote> {
    return {
      ...note,
      blocks: await Promise.all(
        note.blocks.map((block) => (block.type === 'excerpt' ? this.currentExcerpt(block) : block))
      )
    }
  }

  async run(input: LiteratureSynthesisRequest): Promise<LiteratureSynthesisResult> {
    const request = literatureSynthesisRequestSchema.parse(input)
    if (request.action === 'candidates')
      return {
        action: 'candidates',
        ...(await this.sources.candidates(
          request.itemIds,
          request.tagId,
          request.cursor,
          request.limit
        ))
      }
    if (request.action === 'list')
      return this.store.run((notes) => ({
        result: {
          action: 'list' as const,
          notes: notes
            .map(synthesisNoteSummary)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        }
      }))
    if (request.action === 'revision')
      return this.store.run((notes) => {
        const note = notes.find((value) => value.id === request.noteId)
        if (!note) throw new Error('Synthesis note not found.')
        return { result: { action: 'revision' as const, noteId: note.id, revision: note.revision } }
      })
    if (request.action === 'source') {
      const block = await this.store.run((notes) => ({
        result: notes
          .find((note) => note.id === request.noteId)
          ?.blocks.find((entry) => entry.id === request.blockId)
      }))
      if (!block || block.type !== 'excerpt') throw new Error('Synthesis excerpt not found.')
      return { action: 'source', block: await this.currentExcerpt(block) }
    }
    if (request.action === 'read' || request.action === 'export') {
      const note = await this.store.run((notes) => ({
        result: notes.find((value) => value.id === request.noteId)
      }))
      if (!note) throw new Error('Synthesis note not found.')
      if (request.action === 'export' && note.revision !== request.expectedRevision)
        throw new Error('Synthesis note changed. Reopen it before exporting.')
      const current = await this.current(note)
      if (request.action === 'export') {
        const latestRevision = await this.store.run((notes) => ({
          result: notes.find((value) => value.id === request.noteId)?.revision
        }))
        if (latestRevision !== note.revision)
          throw new Error('Synthesis note changed. Reopen it before exporting.')
      }
      return request.action === 'read'
        ? { action: 'read', note: current }
        : {
            action: 'export',
            filename: markdownFilename(note.title),
            markdown: exportSynthesisMarkdown(current)
          }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const mutation = request.action === 'delete' ? undefined : request
    let existingAnnotationIds: string[] = []
    if (mutation?.requestId || request.action === 'append') {
      const baseline = await this.store.run((notes) => ({
        result: {
          replayed: mutation ? this.replay(notes, mutation, fingerprint) : undefined,
          annotationIds:
            request.action === 'append'
              ? (notes
                  .find((note) => note.id === request.noteId)
                  ?.blocks.flatMap((block) =>
                    block.type === 'excerpt' ? [block.snapshot.annotationId] : []
                  ) ?? [])
              : []
        }
      }))
      if (baseline.replayed && mutation)
        return { action: mutation.action, note: await this.current(baseline.replayed) }
      existingAnnotationIds = baseline.annotationIds
    }
    const snapshots =
      request.action === 'create' || request.action === 'append'
        ? await this.snapshots(request.itemIds, request.excerpts)
        : []
    const canonicalIds =
      request.action === 'create' || request.action === 'append'
        ? await this.sources.canonicalIds([
            ...existingAnnotationIds,
            ...snapshots.map((snapshot) => snapshot.annotationId)
          ])
        : new Map<string, string>()
    const uniqueSnapshots = deduplicateSnapshots(snapshots, canonicalIds)
    const result = await this.store.run<StoredMutationResult>((notes, deletedMutations) => {
      if (mutation?.requestId) {
        const replayed = this.replay(notes, mutation, fingerprint)
        if (replayed) return { result: { action: mutation.action, note: replayed } }
      }
      if (request.action === 'create') {
        const now = new Date().toISOString()
        const note: SynthesisStoredNote = {
          id: randomUUID(),
          title: request.title,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          ...(request.requestId
            ? {
                creationRequest: { id: request.requestId, fingerprint },
                lastMutation: { id: request.requestId, fingerprint }
              }
            : {}),
          blocks: uniqueSnapshots.map((snapshot) => ({
            id: randomUUID(),
            type: 'excerpt',
            snapshot
          }))
        }
        return { result: { action: 'create' as const, note }, notes: [...notes, note] }
      }
      if (request.action === 'delete' && request.requestId) {
        const receipt = deletedMutations.find((entry) => entry.id === request.requestId)
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw new Error('Synthesis request identity was reused with different content.')
          return { result: { action: 'delete', deleted: true } }
        }
      }
      const existing = notes.find((note) => note.id === request.noteId)
      if (!existing || existing.revision !== request.expectedRevision)
        throw new Error('Synthesis note changed. Reload it before saving.')
      if (request.action === 'delete') {
        return {
          result: { action: 'delete' as const, deleted: true },
          notes: notes.filter((note) => note.id !== existing.id),
          deletedMutations: request.requestId
            ? [...deletedMutations, { id: request.requestId, fingerprint }].slice(-200)
            : deletedMutations
        }
      }
      // Resolve aliases before enforcing capacity, using the revision checked in this atomic write.
      const appendedSnapshots =
        request.action === 'append'
          ? deduplicateSnapshots(
              snapshots,
              canonicalIds,
              new Set(
                existing.blocks.flatMap((block) =>
                  block.type === 'excerpt'
                    ? [canonicalIds.get(block.snapshot.annotationId) ?? block.snapshot.annotationId]
                    : []
                )
              )
            )
          : []
      if (request.action === 'append' && appendedSnapshots.length === 0) {
        if (!request.requestId) return { result: { action: 'append', note: existing } }
        // A receipt acknowledges this request without changing the content revision or replacing
        // the last real write receipt that another window may still need for recovery.
        const note: SynthesisStoredNote = {
          ...existing,
          lastNoopAppend: { id: request.requestId, fingerprint }
        }
        return {
          result: { action: 'append', note },
          notes: notes.map((value) => (value.id === note.id ? note : value))
        }
      }
      if (request.action === 'append' && existing.blocks.length + appendedSnapshots.length > 200)
        return { result: { action: 'append-rejected', reason: 'block-limit', maxBlocks: 200 } }
      const blocks =
        request.action === 'append'
          ? [
              ...existing.blocks,
              ...appendedSnapshots.map((snapshot) => ({
                id: randomUUID(),
                type: 'excerpt' as const,
                snapshot
              }))
            ]
          : request.blocks.map((block) => {
              const original = existing.blocks.find((value) => value.id === block.id)
              if (block.type === 'excerpt') {
                if (!original || original.type !== 'excerpt')
                  throw new Error('Synthesis excerpt identity is invalid.')
                return original
              }
              if (original && original.type !== block.type)
                throw new Error('Synthesis block identity is invalid.')
              return block
            })
      if (new Set(blocks.map((block) => block.id)).size !== blocks.length)
        throw new Error('Synthesis block identities must be unique.')
      const note: SynthesisStoredNote = {
        ...existing,
        title: request.action === 'update' ? request.title : existing.title,
        blocks,
        revision: existing.revision + 1,
        lastMutation: request.requestId ? { id: request.requestId, fingerprint } : undefined,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString()
      }
      return {
        result: { action: request.action, note },
        notes: notes.map((value) => (value.id === note.id ? note : value))
      }
    })
    return result.action === 'delete' || result.action === 'append-rejected'
      ? result
      : { action: result.action, note: await this.current(result.note) }
  }
}
