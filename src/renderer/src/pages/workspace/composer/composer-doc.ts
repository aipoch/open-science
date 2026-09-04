// Pure serialization model for the composer: a document is an ordered list of text runs, skill
// chips, and artifact chips. These functions are DOM-free except domToDoc/applyDocToDom, which
// bridge the model to the contenteditable editor.

import { getExtensionPreservingFileNameParts } from '../extension-preserving-file-name'

import type { FileReference } from '../../../../../shared/artifacts'
import {
  MAX_SESSION_PDF_CONTEXTS,
  MAX_SESSION_REFERENCES_PER_MESSAGE,
  type MessagePart,
  type SessionPdfContextSource,
  type SessionReference
} from '../../../../../shared/session-persistence'

// One file-reference chip in the composer doc. The linked-folder variant deliberately carries only
// a granted root id plus a relative path, reserving the future source without exposing an absolute path.
export type ComposerArtifactNode = { type: 'artifact' } & FileReference
export type ComposerSessionNode = SessionReference

// Live-draft-only anchor for a long plain-text paste staged as an upload. The text stays beside its
// logical insertion point so restoring never has to infer a caret offset. This node is filtered at
// every MessagePart boundary and is never persisted.
export type ComposerPastedTextNode = {
  type: 'pasted-text'
  id: string
  text: string
  transferId?: string
  attachmentId?: string
}

export type ComposerPastedTextStage = ComposerPastedTextNode | readonly ComposerPastedTextNode[]

export type ComposerNode =
  | { type: 'text'; text: string }
  | { type: 'skill'; id: string; name: string }
  | ComposerArtifactNode
  | ComposerSessionNode
  | ComposerPastedTextNode

export type ComposerDoc = { nodes: ComposerNode[] }

// Max artifact `@` mentions per message, mirroring the composer upload attachment cap.
export const MAX_COMPOSER_ARTIFACT_MENTIONS = 10
export const MAX_COMPOSER_SESSION_MENTIONS = MAX_SESSION_REFERENCES_PER_MESSAGE

export const LONG_PASTE_CHARACTER_THRESHOLD = 10_000
export const LONG_PASTE_LINE_THRESHOLD = 300

export const pastedTextPreviewName = (text: string): string =>
  `${Array.from(text.trim().replace(/\s+/gu, ' ')).slice(0, 17).join('')}...`

export const pastedTextAttachmentDomId = (id: string): string =>
  `composer-pasted-text-attachment-${id}`

// Shared canonical empty document.
export const emptyDoc: ComposerDoc = { nodes: [] }

// Render a single node as its plain-text form: skills as `/<name>`, artifacts as `@<name>`, and
// linked-folder artifacts as `@<relativePath>` so the text form mirrors the chip label.
const nodeToText = (node: ComposerNode): string => {
  if (node.type === 'text') return node.text
  if (node.type === 'skill') return `/${node.name}`
  if (node.type === 'session') return `#${node.title}`
  if (node.type === 'pasted-text') return ''
  if (node.source === 'linked-folder') return `@${node.relativePath}`
  return `@${node.name}`
}

// Render the document as plain text; chips serialize to their `/` or `@` label.
export const docToText = (doc: ComposerDoc): string => doc.nodes.map(nodeToText).join('')

// Only durable message parts cross the renderer/runtime boundary. Pasted-text anchors are paired
// with attachments and deliberately stay out of Session JSON.
export const docToMessageParts = (doc: ComposerDoc): MessagePart[] =>
  doc.nodes.filter(
    (node): node is Exclude<ComposerNode, ComposerPastedTextNode> => node.type !== 'pasted-text'
  )

export const shouldAttachPastedText = (text: string): boolean => {
  if (text.length > LONG_PASTE_CHARACTER_THRESHOLD) return true
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n' || (text[index] === '\r' && text[index + 1] !== '\n')) lines += 1
  }
  return lines > LONG_PASTE_LINE_THRESHOLD
}

export type ComposerCaretPosition = { nodeIndex: number; offset: number }

const appendNode = (
  nodes: ComposerNode[],
  node: ComposerNode
): ComposerCaretPosition | undefined => {
  const previous = nodes.at(-1)
  if (node.type === 'text' && previous?.type === 'text') {
    const offset = previous.text.length + node.text.length
    previous.text += node.text
    return { nodeIndex: nodes.length - 1, offset }
  }
  nodes.push(node.type === 'text' ? { ...node } : node)
  return node.type === 'text'
    ? { nodeIndex: nodes.length - 1, offset: node.text.length }
    : undefined
}

export const updatePastedTextNode = (
  doc: ComposerDoc,
  id: string,
  update: (node: ComposerPastedTextNode) => ComposerPastedTextNode
): ComposerDoc => ({
  nodes: doc.nodes.map((node) =>
    node.type === 'pasted-text' && node.id === id ? update(node) : node
  )
})

export const removePastedTextNode = (doc: ComposerDoc, id: string): ComposerDoc => {
  const nodes: ComposerNode[] = []
  for (const node of doc.nodes) {
    if (node.type === 'pasted-text' && node.id === id) continue
    appendNode(nodes, node)
  }
  return nodes.length === 0 ? emptyDoc : { nodes }
}

const logicalNodeLength = (node: ComposerNode): number =>
  node.type === 'pasted-text' ? node.text.length : nodeToText(node).length

export const pastedTextLogicalOffset = (doc: ComposerDoc, id: string): number | undefined => {
  let offset = 0
  for (const node of doc.nodes) {
    if (node.type === 'pasted-text' && node.id === id) return offset
    offset += logicalNodeLength(node)
  }
  return undefined
}

export const insertPastedTextNodeAtLogicalOffset = (
  doc: ComposerDoc,
  pastedText: ComposerPastedTextNode,
  logicalOffset: number
): ComposerDoc => {
  const nodes: ComposerNode[] = []
  let remaining = logicalOffset
  let inserted = false
  for (const node of doc.nodes) {
    const length = logicalNodeLength(node)
    if (!inserted && remaining <= length) {
      if (node.type === 'text' && remaining > 0 && remaining < length) {
        appendNode(nodes, { type: 'text', text: node.text.slice(0, remaining) })
        nodes.push(pastedText)
        appendNode(nodes, { type: 'text', text: node.text.slice(remaining) })
      } else if (remaining === 0) {
        nodes.push(pastedText)
        appendNode(nodes, node)
      } else {
        appendNode(nodes, node)
        nodes.push(pastedText)
      }
      inserted = true
      continue
    }
    appendNode(nodes, node)
    remaining -= length
  }
  if (!inserted) nodes.push(pastedText)
  return { nodes }
}

export const restorePastedTextNode = (
  doc: ComposerDoc,
  id: string
): { doc: ComposerDoc; caret: ComposerCaretPosition } | undefined => {
  const nodes: ComposerNode[] = []
  let caret: ComposerCaretPosition | undefined
  for (const node of doc.nodes) {
    if (node.type === 'pasted-text' && node.id === id) {
      caret = appendNode(nodes, { type: 'text', text: node.text })
    } else {
      appendNode(nodes, node)
    }
  }
  return caret ? { doc: { nodes }, caret } : undefined
}

// Collect picked skill ids in document order, dropping duplicates.
export const docToSkillIds = (doc: ComposerDoc): string[] => {
  const ids: string[] = []
  for (const node of doc.nodes) {
    if (node.type === 'skill' && !ids.includes(node.id)) ids.push(node.id)
  }
  return ids
}

// Collect referenced artifacts in document order, de-duplicated by path so the runtime attaches
// each underlying file once even if the user mentions it twice.
export const docToArtifactRefs = (doc: ComposerDoc): FileReference[] => {
  const refs: FileReference[] = []
  const seenLocations = new Set<string>()
  for (const node of doc.nodes) {
    if (node.type !== 'artifact') continue
    const location =
      node.source === 'linked-folder'
        ? `${node.source}:${node.rootId}:${node.relativePath}`
        : `${node.source}:${node.path}`
    if (seenLocations.has(location)) continue
    seenLocations.add(location)

    if (node.source === 'linked-folder') {
      refs.push({
        id: node.id,
        name: node.name,
        source: node.source,
        rootId: node.rootId,
        relativePath: node.relativePath,
        mimeType: node.mimeType
      })
    } else {
      refs.push({
        id: node.id,
        ...(node.sourceFileId ? { sourceFileId: node.sourceFileId } : {}),
        name: node.name,
        path: node.path,
        source: node.source,
        mimeType: node.mimeType,
        versionId: node.versionId
      })
    }
  }
  return refs
}

// `@`-mentioned immutable PDF Versions become send-time Reading candidates. Main verifies the
// actual page count; this renderer pass only removes obvious non-PDF and compatibility references.
export const docToPdfContextSources = (doc: ComposerDoc): SessionPdfContextSource[] => {
  const sources: SessionPdfContextSource[] = []
  const seen = new Set<string>()
  for (const reference of docToArtifactRefs(doc)) {
    if (
      reference.source === 'linked-folder' ||
      !reference.sourceFileId ||
      !reference.versionId ||
      (reference.mimeType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf' &&
        !reference.name.toLowerCase().endsWith('.pdf'))
    ) {
      continue
    }
    const source: SessionPdfContextSource = {
      sourceKind: reference.source === 'upload' ? 'upload-version' : 'artifact-version',
      sourceFileId: reference.sourceFileId,
      sourceVersionId: reference.versionId
    }
    const identity = `${source.sourceKind}:${source.sourceVersionId}`
    if (seen.has(identity)) continue
    seen.add(identity)
    sources.push(source)
    if (sources.length === MAX_SESSION_PDF_CONTEXTS) break
  }
  return sources
}

// Count artifact chips, used to enforce the per-message mention cap.
export const docArtifactCount = (doc: ComposerDoc): number =>
  doc.nodes.reduce((total, node) => (node.type === 'artifact' ? total + 1 : total), 0)

export const docSessionCount = (doc: ComposerDoc): number =>
  doc.nodes.reduce((total, node) => (node.type === 'session' ? total + 1 : total), 0)

// Adds a complete immutable Artifact reference from a global action without routing it through the
// contenteditable's caret-based mention trigger. Keep the operation pure so Workspace can preserve
// its existing per-draft ownership and tests can cover the spacing/cap behavior directly.
export const appendArtifactMention = (doc: ComposerDoc, reference: FileReference): ComposerDoc => {
  if (docArtifactCount(doc) >= MAX_COMPOSER_ARTIFACT_MENTIONS) return doc

  const previous = doc.nodes.at(-1)
  const needsSpace =
    previous !== undefined && (previous.type !== 'text' || !/\s$/.test(previous.text))

  return {
    nodes: [
      ...doc.nodes,
      ...(needsSpace ? [{ type: 'text' as const, text: ' ' }] : []),
      { type: 'artifact', ...reference }
    ]
  }
}

// Hydrate a plain-text draft into a single text node; empty text yields the empty doc.
export const docFromText = (text: string): ComposerDoc =>
  text === '' ? emptyDoc : { nodes: [{ type: 'text', text }] }

// Rebuild a draft doc from a sent user message's structured parts, restoring skill/artifact chips
// so re-editing the message round-trips mentions instead of flattening them into plain text.
export const docFromMessageParts = (parts: MessagePart[]): ComposerDoc => {
  const nodes: ComposerNode[] = parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'skill') return { type: 'skill', id: part.id, name: part.name }
    if (part.type === 'session') {
      return { type: 'session', sessionId: part.sessionId, title: part.title }
    }
    if (part.source === 'linked-folder') {
      return {
        type: 'artifact',
        id: part.id,
        name: part.name,
        source: part.source,
        rootId: part.rootId,
        relativePath: part.relativePath,
        mimeType: part.mimeType
      }
    }
    return {
      type: 'artifact',
      id: part.id,
      ...(part.sourceFileId ? { sourceFileId: part.sourceFileId } : {}),
      name: part.name,
      path: part.path,
      source: part.source,
      mimeType: part.mimeType,
      versionId: part.versionId
    }
  })

  return nodes.length === 0 ? emptyDoc : { nodes }
}

// A doc is empty when it has no chips and no non-whitespace text.
export const docIsEmpty = (doc: ComposerDoc): boolean =>
  doc.nodes.every((node) => node.type === 'text' && node.text.trim() === '')

// Chip markers on the contenteditable spans.
const SKILL_MENTION_TYPE = 'skill'
const ARTIFACT_MENTION_TYPE = 'artifact'
const SESSION_MENTION_TYPE = 'session'
const PASTED_TEXT_NODE_TYPE = 'pasted-text'
export const PASTED_TEXT_CARET_MARKER = '\u2060'
const pastedTextByAnchor = new WeakMap<HTMLElement, ComposerPastedTextNode>()
const pastedTextCaretHosts = new WeakSet<Text>()

export const isPastedTextCaretHost = (node: Node): node is Text =>
  node.nodeType === Node.TEXT_NODE && pastedTextCaretHosts.has(node as Text)

// Read one artifact chip element back into a node; returns null when required attributes are missing.
const artifactNodeFromEl = (el: HTMLElement): ComposerArtifactNode | null => {
  const id = el.getAttribute('data-mention-id')
  if (id === null) return null
  const source = el.getAttribute('data-mention-source')
  // Prefer the stored filename; fall back to the visible label with its leading `@` stripped.
  const name = el.getAttribute('data-mention-filename') ?? (el.textContent ?? '').replace(/^@/, '')
  const mimeType = el.getAttribute('data-mention-mime-type') ?? undefined
  if (source === 'linked-folder') {
    const rootId = el.getAttribute('data-mention-root-id')
    const relativePath = el.getAttribute('data-mention-relative-path')
    if (rootId === null || relativePath === null) return null
    return { type: 'artifact', id, name, source, rootId, relativePath, mimeType }
  }

  const path = el.getAttribute('data-mention-path')
  if (path === null || (source !== 'upload' && source !== 'artifact')) return null
  const sourceFileId = el.getAttribute('data-mention-source-file-id') ?? undefined
  const versionId = el.getAttribute('data-mention-version-id') ?? undefined
  return {
    type: 'artifact',
    id,
    ...(sourceFileId ? { sourceFileId } : {}),
    name,
    path,
    source,
    mimeType,
    versionId
  }
}

// Read a contenteditable root into a doc, mapping chip spans to skill/artifact nodes and collapsing
// runs of adjacent text into a single text node.
export const domToDoc = (root: HTMLElement): ComposerDoc => {
  const nodes: ComposerNode[] = []
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const rawText = child.textContent ?? ''
      const text = isPastedTextCaretHost(child)
        ? rawText.replace(PASTED_TEXT_CARET_MARKER, '')
        : rawText
      if (text === '') continue
      const last = nodes[nodes.length - 1]
      // Merge into a preceding text node so adjacent text collapses.
      if (last && last.type === 'text') last.text += text
      else nodes.push({ type: 'text', text })
      continue
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement
      const mentionType = el.getAttribute('data-mention-type')
      if (mentionType === SKILL_MENTION_TYPE) {
        const id = el.getAttribute('data-skill-id')
        if (id !== null) {
          // Chip label is `/<name>`; strip the leading slash to recover the display name.
          const label = el.textContent ?? ''
          nodes.push({ type: 'skill', id, name: label.replace(/^\//, '') })
        }
        continue
      }
      if (mentionType === ARTIFACT_MENTION_TYPE) {
        const node = artifactNodeFromEl(el)
        if (node) nodes.push(node)
        continue
      }
      if (mentionType === SESSION_MENTION_TYPE) {
        const sessionId = el.getAttribute('data-session-id')
        const title = el.getAttribute('data-session-title')
        if (sessionId && title) nodes.push({ type: 'session', sessionId, title })
        continue
      }
      if (el.getAttribute('data-composer-node-type') === PASTED_TEXT_NODE_TYPE) {
        const node = pastedTextByAnchor.get(el)
        if (node) nodes.push({ ...node })
      }
    }
  }
  return nodes.length === 0 ? emptyDoc : { nodes }
}

// Shared chip base styling; a capped width with truncation keeps a long name from stretching the
// composer, and select-all keeps a chip atomic to text selection. Truncation is visual only, so
// domToDoc still reads the full name back from textContent / the stored filename attribute.
const CHIP_BASE_CLASS =
  'inline-block max-w-[220px] truncate align-middle rounded px-1.5 py-0.5 mx-0.5 text-sm font-medium select-all'
// Artifact chips are click-to-preview, so they opt out of text selection entirely — a click must
// not paint the select-all highlight.
const ARTIFACT_CHIP_BASE_CLASS =
  'inline-flex max-w-[220px] align-middle rounded px-1.5 py-0.5 mx-0.5 text-sm font-medium select-none'

// Render a skill chip span: an atomic, non-editable blue mention token. Exported so the mention hook
// inserts the exact same markup it re-renders here, and the styling can never drift between the two.
export const createSkillChip = (node: { id: string; name: string }): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('data-mention-type', SKILL_MENTION_TYPE)
  span.setAttribute('data-skill-id', node.id)
  // Blue mention pill using the dedicated skill-chip token.
  span.className = `${CHIP_BASE_CLASS} bg-skill-chip text-skill-chip-foreground`
  span.textContent = `/${node.name}`
  return span
}

// Render an artifact chip span: an atomic, non-editable mention token carrying the path/source
// needed to round-trip through the DOM and resolve the file on send. Uploads/artifacts use the
// green mention pill with an `@<name>` label; linked-folder references use the dark-gray path
// pill with an `@<relativePath>` label (the stored filename attribute keeps the plain name,
// so domToDoc is unaffected by the label change).
export const createArtifactChip = (node: ComposerArtifactNode): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('data-mention-type', ARTIFACT_MENTION_TYPE)
  span.setAttribute('data-mention-id', node.id)
  span.setAttribute('data-mention-source', node.source)
  span.setAttribute('data-mention-filename', node.name)
  const linkedFolder = node.source === 'linked-folder'
  if (linkedFolder) {
    span.setAttribute('data-mention-root-id', node.rootId)
    span.setAttribute('data-mention-relative-path', node.relativePath)
  } else {
    span.setAttribute('data-mention-path', node.path)
    if (node.sourceFileId) span.setAttribute('data-mention-source-file-id', node.sourceFileId)
  }
  if (node.mimeType) span.setAttribute('data-mention-mime-type', node.mimeType)
  if (!linkedFolder && node.versionId) {
    span.setAttribute('data-mention-version-id', node.versionId)
  }
  // Green mention pill for uploads/artifacts; dark gray for linked-folder paths. Both stay
  // distinct from the blue skill chip. All mention chips open the preview panel on click, so
  // they get the pointer cursor.
  span.className = `${ARTIFACT_CHIP_BASE_CLASS} cursor-pointer ${
    linkedFolder
      ? 'bg-path-chip text-path-chip-foreground'
      : 'bg-mention-chip text-mention-chip-foreground'
  }`
  const labelPrefix = '@'
  // The label truncates the relative path for linked-folder chips, the plain name otherwise.
  const labelSource = linkedFolder ? node.relativePath : node.name
  // Linked-folder chips tooltip the full `@` label; others keep the original bare name.
  span.title = linkedFolder ? `${labelPrefix}${labelSource}` : node.name
  const { head, tail, extension } = getExtensionPreservingFileNameParts(labelSource)
  const headSpan = document.createElement('span')
  headSpan.className = 'min-w-0 flex-1 truncate'
  headSpan.textContent = `${labelPrefix}${head}`
  span.append(headSpan)

  for (const segment of [tail, extension]) {
    if (!segment) continue
    const segmentSpan = document.createElement('span')
    segmentSpan.className = 'shrink-0'
    segmentSpan.textContent = segment
    span.append(segmentSpan)
  }
  return span
}

// Session chips are atomic navigation links. The full snapshot title stays in attributes/title while
// the visible label truncates to a single line inside the composer.
export const createSessionChip = (node: ComposerSessionNode): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('data-mention-type', SESSION_MENTION_TYPE)
  span.setAttribute('data-session-id', node.sessionId)
  span.setAttribute('data-session-title', node.title)
  span.className = `${CHIP_BASE_CLASS} cursor-pointer select-none bg-accent text-accent-foreground`
  span.textContent = `#${node.title}`
  span.title = node.title
  return span
}

// The compact marker preserves the pasted text's logical position without rendering the payload.
// A WeakMap lets domToDoc recover the live node while only a short preview reaches the DOM.
export const createPastedTextAnchor = (node: ComposerPastedTextNode): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('role', 'button')
  span.setAttribute('tabindex', '0')
  span.setAttribute('aria-label', pastedTextPreviewName(node.text))
  span.setAttribute('aria-controls', pastedTextAttachmentDomId(node.id))
  span.setAttribute('data-composer-node-type', PASTED_TEXT_NODE_TYPE)
  span.setAttribute('data-pasted-text-id', node.id)
  span.className =
    'mx-0.5 inline-flex h-5 min-w-5 cursor-pointer select-all items-center justify-center rounded border border-border-200 bg-bg-200 px-1 align-middle text-[11px] leading-none text-text-300 transition-[background-color,color,transform,opacity] duration-150 ease-out hover:bg-bg-300 hover:text-text-000 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:active:translate-y-0'
  span.title = pastedTextPreviewName(node.text)
  span.textContent = '…'
  pastedTextByAnchor.set(span, { ...node })
  return span
}

export const createPastedTextCaretHost = (): Text => {
  const host = document.createTextNode(PASTED_TEXT_CARET_MARKER)
  pastedTextCaretHosts.add(host)
  return host
}

// Refresh renderer-only upload metadata without replacing anchor elements, which would discard the
// browser selection when an upload finishes binding while the user keeps typing after the paste.
export const syncPastedTextAnchors = (root: HTMLElement, doc: ComposerDoc): void => {
  const nodesById = new Map(
    doc.nodes
      .filter((node): node is ComposerPastedTextNode => node.type === 'pasted-text')
      .map((node) => [node.id, node])
  )
  for (const anchor of root.querySelectorAll<HTMLElement>(
    `[data-composer-node-type="${PASTED_TEXT_NODE_TYPE}"]`
  )) {
    const id = anchor.getAttribute('data-pasted-text-id')
    const node = id === null ? undefined : nodesById.get(id)
    if (node) pastedTextByAnchor.set(anchor, { ...node })
  }
}

// Replace the root's content with the doc rendered as text nodes and chip spans.
export const applyDocToDom = (root: HTMLElement, doc: ComposerDoc): void => {
  root.textContent = ''
  for (const node of doc.nodes) {
    if (node.type === 'text') root.appendChild(document.createTextNode(node.text))
    else if (node.type === 'skill') root.appendChild(createSkillChip(node))
    else if (node.type === 'artifact') root.appendChild(createArtifactChip(node))
    else if (node.type === 'session') root.appendChild(createSessionChip(node))
    else root.appendChild(createPastedTextAnchor(node))
  }
  if (doc.nodes.at(-1)?.type === 'pasted-text') root.appendChild(createPastedTextCaretHost())
}
