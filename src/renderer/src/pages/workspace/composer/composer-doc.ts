// Pure serialization model for the composer: a document is an ordered list of text runs, skill
// chips, and artifact chips. These functions are DOM-free except domToDoc/applyDocToDom, which
// bridge the model to the contenteditable editor.

import type { ArtifactReference } from '../../../../../shared/artifacts'

// One artifact/upload reference chip in the composer doc. Mirrors ArtifactReference plus the DOM
// label; `source` distinguishes a user upload from a generated output for the runtime resolver.
export type ComposerArtifactNode = {
  type: 'artifact'
  id: string
  name: string
  path: string
  source: 'upload' | 'artifact'
  versionId?: string
}

export type ComposerNode =
  | { type: 'text'; text: string }
  | { type: 'skill'; id: string; name: string }
  | ComposerArtifactNode

export type ComposerDoc = { nodes: ComposerNode[] }

// Max artifact `@` mentions per message, mirroring the composer upload attachment cap.
export const MAX_COMPOSER_ARTIFACT_MENTIONS = 10

// Shared canonical empty document.
export const emptyDoc: ComposerDoc = { nodes: [] }

// Render a single node as its plain-text form: skills as `/<name>`, artifacts as `@<name>`.
const nodeToText = (node: ComposerNode): string => {
  if (node.type === 'text') return node.text
  if (node.type === 'skill') return `/${node.name}`
  return `@${node.name}`
}

// Render the document as plain text; chips serialize to their `/` or `@` label.
export const docToText = (doc: ComposerDoc): string => doc.nodes.map(nodeToText).join('')

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
export const docToArtifactRefs = (doc: ComposerDoc): ArtifactReference[] => {
  const refs: ArtifactReference[] = []
  const seenPaths = new Set<string>()
  for (const node of doc.nodes) {
    if (node.type !== 'artifact' || seenPaths.has(node.path)) continue
    seenPaths.add(node.path)
    refs.push({
      id: node.id,
      name: node.name,
      path: node.path,
      source: node.source,
      versionId: node.versionId
    })
  }
  return refs
}

// Count artifact chips, used to enforce the per-message mention cap.
export const docArtifactCount = (doc: ComposerDoc): number =>
  doc.nodes.reduce((total, node) => (node.type === 'artifact' ? total + 1 : total), 0)

// Hydrate a plain-text draft into a single text node; empty text yields the empty doc.
export const docFromText = (text: string): ComposerDoc =>
  text === '' ? emptyDoc : { nodes: [{ type: 'text', text }] }

// A doc is empty when it has no chips and no non-whitespace text.
export const docIsEmpty = (doc: ComposerDoc): boolean =>
  doc.nodes.every((node) => node.type === 'text' && node.text.trim() === '')

// Chip markers on the contenteditable spans.
const SKILL_MENTION_TYPE = 'skill'
const ARTIFACT_MENTION_TYPE = 'artifact'

// Read one artifact chip element back into a node; returns null when required attributes are missing.
const artifactNodeFromEl = (el: HTMLElement): ComposerArtifactNode | null => {
  const id = el.getAttribute('data-mention-id')
  const path = el.getAttribute('data-mention-path')
  if (id === null || path === null) return null
  const source = el.getAttribute('data-mention-source') === 'upload' ? 'upload' : 'artifact'
  // Prefer the stored filename; fall back to the visible label with its leading `@` stripped.
  const name = el.getAttribute('data-mention-filename') ?? (el.textContent ?? '').replace(/^@/, '')
  const versionId = el.getAttribute('data-mention-version-id') ?? undefined
  return { type: 'artifact', id, name, path, source, versionId }
}

// Read a contenteditable root into a doc, mapping chip spans to skill/artifact nodes and collapsing
// runs of adjacent text into a single text node.
export const domToDoc = (root: HTMLElement): ComposerDoc => {
  const nodes: ComposerNode[] = []
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? ''
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

// Render an artifact chip span: an atomic, non-editable green mention token carrying the path/source
// needed to round-trip through the DOM and resolve the file on send.
export const createArtifactChip = (node: ComposerArtifactNode): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('data-mention-type', ARTIFACT_MENTION_TYPE)
  span.setAttribute('data-mention-id', node.id)
  span.setAttribute('data-mention-path', node.path)
  span.setAttribute('data-mention-source', node.source)
  span.setAttribute('data-mention-filename', node.name)
  if (node.versionId) span.setAttribute('data-mention-version-id', node.versionId)
  // Green mention pill, distinct from the blue skill chip.
  span.className = `${CHIP_BASE_CLASS} bg-mention-chip text-mention-chip-foreground`
  span.textContent = `@${node.name}`
  return span
}

// Replace the root's content with the doc rendered as text nodes and chip spans.
export const applyDocToDom = (root: HTMLElement, doc: ComposerDoc): void => {
  root.textContent = ''
  for (const node of doc.nodes) {
    if (node.type === 'text') root.appendChild(document.createTextNode(node.text))
    else if (node.type === 'skill') root.appendChild(createSkillChip(node))
    else root.appendChild(createArtifactChip(node))
  }
}
