// Pure serialization model for the composer: a document is an ordered list of text runs and
// skill chips. Task 1 functions are DOM-free; domToDoc/applyDocToDom bridge to contenteditable.

export type ComposerNode =
  { type: 'text'; text: string } | { type: 'skill'; id: string; name: string }

export type ComposerDoc = { nodes: ComposerNode[] }

// Shared canonical empty document.
export const emptyDoc: ComposerDoc = { nodes: [] }

// Render the document as plain text; a skill chip serializes to its `/<name>` label.
export const docToText = (doc: ComposerDoc): string =>
  doc.nodes.map((node) => (node.type === 'text' ? node.text : `/${node.name}`)).join('')

// Collect picked skill ids in document order, dropping duplicates.
export const docToSkillIds = (doc: ComposerDoc): string[] => {
  const ids: string[] = []
  for (const node of doc.nodes) {
    if (node.type === 'skill' && !ids.includes(node.id)) ids.push(node.id)
  }
  return ids
}

// Hydrate a plain-text draft into a single text node; empty text yields the empty doc.
export const docFromText = (text: string): ComposerDoc =>
  text === '' ? emptyDoc : { nodes: [{ type: 'text', text }] }

// A doc is empty when it has no skill chips and no non-whitespace text.
export const docIsEmpty = (doc: ComposerDoc): boolean =>
  doc.nodes.every((node) => node.type === 'text' && node.text.trim() === '')

// Chip markers on the contenteditable span.
const SKILL_MENTION_TYPE = 'skill'

// Read a contenteditable root into a doc, mapping chip spans to skill nodes and collapsing
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
      const id = el.getAttribute('data-skill-id')
      if (id !== null && el.getAttribute('data-mention-type') === SKILL_MENTION_TYPE) {
        // Chip label is `/<name>`; strip the leading slash to recover the display name.
        const label = el.textContent ?? ''
        nodes.push({ type: 'skill', id, name: label.replace(/^\//, '') })
      }
    }
  }
  return nodes.length === 0 ? emptyDoc : { nodes }
}

// Render a skill chip span: an atomic, non-editable blue mention token. Exported so the mention hook
// inserts the exact same markup it re-renders here, and the styling can never drift between the two.
export const createSkillChip = (node: { id: string; name: string }): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('data-mention-type', SKILL_MENTION_TYPE)
  span.setAttribute('data-skill-id', node.id)
  // Blue mention pill using the interactive `primary` token; select-all keeps it atomic to selection.
  span.className =
    'inline-flex items-center rounded px-1.5 py-0.5 mx-0.5 text-sm font-medium bg-primary/15 text-primary select-all'
  span.textContent = `/${node.name}`
  return span
}

// Replace the root's content with the doc rendered as text nodes and chip spans.
export const applyDocToDom = (root: HTMLElement, doc: ComposerDoc): void => {
  root.textContent = ''
  for (const node of doc.nodes) {
    if (node.type === 'text') root.appendChild(document.createTextNode(node.text))
    else root.appendChild(createSkillChip(node))
  }
}
