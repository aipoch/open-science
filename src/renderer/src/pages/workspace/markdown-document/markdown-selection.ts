import type { TextAnnotation } from '../../../../../shared/annotation-contract'
import { ANNOTATION_LIMITS } from '../../../../../shared/annotations'
import { createAnnotationId } from '../annotations/annotation-id'
import { markdownSelectionAnchor } from './markdown-codec'

export type MarkdownDocumentSelection = Readonly<{
  quote: string
  prefix?: string
  suffix?: string
}>

type MarkdownDocumentSnapshotInput = Readonly<{
  projectId: string
  fileSource: 'artifact' | 'upload'
  sourceFileId: string
  baseVersionId: string
  path: string
  name: string
  sessionId?: string
  draftRevision: number
  markdown: string
  selection: MarkdownDocumentSelection
}>

const fallbackChecksum = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Array.from({ length: 8 }, (_, index) =>
    ((hash + index * 0x9e3779b9) >>> 0).toString(16).padStart(8, '0')
  ).join('')
}

const checksumForMarkdown = async (markdown: string): Promise<string> => {
  if (!globalThis.crypto?.subtle) return fallbackChecksum(markdown)
  const bytes = new TextEncoder().encode(markdown)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const createMarkdownDocumentDraftAnnotation = async (
  input: MarkdownDocumentSnapshotInput
): Promise<TextAnnotation | undefined> => {
  const { selection } = input
  if (!selection.quote || selection.quote.length > ANNOTATION_LIMITS.quote) return undefined
  const anchor = markdownSelectionAnchor(
    input.markdown,
    selection.quote,
    selection.prefix,
    selection.suffix
  )
  if (!anchor) return undefined
  const checksum = await checksumForMarkdown(input.markdown)
  return {
    id: createAnnotationId(),
    kind: 'text',
    target: 'agent',
    quote: selection.quote,
    anchor: {
      position: { start: anchor.start, end: anchor.end },
      ...(anchor.prefix ? { prefix: anchor.prefix } : {}),
      ...(anchor.suffix ? { suffix: anchor.suffix } : {})
    },
    source: {
      kind: 'document-draft',
      projectId: input.projectId,
      path: input.path,
      name: input.name,
      fileSource: input.fileSource,
      sourceFileId: input.sourceFileId,
      baseVersionId: input.baseVersionId,
      snapshotId: globalThis.crypto?.randomUUID?.() ?? `snapshot-${Date.now()}`,
      draftRevision: input.draftRevision,
      checksum,
      ...(input.sessionId ? { sessionId: input.sessionId } : {})
    }
  }
}
