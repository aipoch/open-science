import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SkillView } from '../../../../../shared/settings'
import { resolveLocalPath } from '../../../../../shared/local-fs'
import { cn } from '@/lib/utils'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

import { createPreviewFileItemFromLocal, LOCAL_PREVIEW_SESSION_ID } from '../preview-file-item'
import { createPreviewFileItemFromMention } from '../preview-file-item'
import { createPreviewRequestScope } from '../previews/preview-file-reader'

import { ArtifactMentionPopup, type PickedArtifact } from './ArtifactMentionPopup'
import {
  applyDocToDom,
  createPastedTextAnchor,
  createPastedTextCaretHost,
  docArtifactCount,
  docSessionCount,
  domToDoc,
  isPastedTextCaretHost,
  MAX_COMPOSER_ARTIFACT_MENTIONS,
  MAX_COMPOSER_SESSION_MENTIONS,
  PASTED_TEXT_CARET_MARKER,
  shouldAttachPastedText,
  syncPastedTextAnchors,
  type ComposerCaretPosition,
  type ComposerDoc,
  type ComposerNode,
  type ComposerPastedTextNode,
  type ComposerPastedTextStage
} from './composer-doc'
import { SkillMentionPopup } from './SkillMentionPopup'
import { SessionMentionPopup, type PickedSession } from './SessionMentionPopup'
import { useMentionTrigger } from './useMentionTrigger'

// Base editor styling: mirrors the sizing/leading of the legacy composer textarea. The placeholder is
// rendered as a model-driven overlay (see below) rather than a CSS :empty hint, so it shows whenever
// the doc is empty — including when the editor is blurred or retains a stray browser-inserted node.
const composerEditorClassName =
  'min-h-[36px] max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent py-1.5 text-[15px] leading-relaxed text-text-000 outline-none'

// Placeholder overlay aligned to the editor's text start; pointer-events-none lets clicks reach the box.
const composerPlaceholderClassName =
  'pointer-events-none absolute inset-x-0 top-0 truncate py-1.5 text-[15px] leading-relaxed text-muted-foreground'

type ComposerEditorProps = {
  doc: ComposerDoc
  onDocChange: (doc: ComposerDoc) => void
  onSubmit: () => void
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void
  onLongTextPaste?: (doc: ComposerDoc, node: ComposerPastedTextStage) => void
  onLocatePastedText?: (pastedTextId: string) => void
  onUndoPastedTextRemoval?: () => boolean
  disabled?: boolean
  placeholder: string
  className?: string
  ariaLabel: string
  // Undefined shows Main-enabled Skills; an empty array intentionally hides every Skill.
  allowedSkillIds?: readonly string[]
  isHistoryBrowsing?: boolean
  historyStatus?: string
  onNavigateHistory?: (direction: 'previous' | 'next') => boolean
  // Scope for previewing clicked `@` mention chips (uploads/artifacts); without it those chips
  // stay inert on click (linked-folder chips resolve through the granted-roots store instead).
  mentionPreviewContext?: { sessionId: string; projectId?: string }
  focusRequest?: string | number
  restoreFocusRequest?: number
  caretRequest?: { key: number; position: ComposerCaretPosition }
}

// Structural equality over doc nodes; used to decide whether the incoming prop diverges from what
// the contenteditable already shows, so we only re-render the DOM when an external change requires it.
const nodesEqual = (a: ComposerNode[], b: ComposerNode[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((node, index) => {
    const other = b[index]
    if (node.type !== other.type) return false
    if (node.type === 'text' && other.type === 'text') return node.text === other.text
    if (node.type === 'skill' && other.type === 'skill') {
      return node.id === other.id && node.name === other.name
    }
    if (node.type === 'session' && other.type === 'session') {
      return node.sessionId === other.sessionId && node.title === other.title
    }
    if (node.type === 'pasted-text' && other.type === 'pasted-text') {
      return node.id === other.id && node.text === other.text
    }
    if (node.type === 'artifact' && other.type === 'artifact') {
      if (
        node.id !== other.id ||
        node.name !== other.name ||
        node.source !== other.source ||
        node.mimeType !== other.mimeType
      ) {
        return false
      }
      if (node.source === 'linked-folder' && other.source === 'linked-folder') {
        return node.rootId === other.rootId && node.relativePath === other.relativePath
      }
      if (node.source !== 'linked-folder' && other.source !== 'linked-folder') {
        return node.path === other.path && node.versionId === other.versionId
      }
      return false
    }
    return false
  })
}

// Insert plain text at the current caret and collapse the caret after it. Used for paste so the
// contenteditable never absorbs rich HTML from the clipboard.
const selectedRangeIn = (root: HTMLElement): { selection: Selection; range: Range } | undefined => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  return root.contains(range.commonAncestorContainer) ? { selection, range } : undefined
}

const insertPlainTextAtCaret = (root: HTMLElement, text: string): boolean => {
  const selected = selectedRangeIn(root)
  if (!selected) return false
  const { selection, range } = selected
  range.deleteContents()
  const inserted = document.createTextNode(text)
  range.insertNode(inserted)
  range.setStartAfter(inserted)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

const caretNodeAfterPastedText = (anchor: ChildNode, splitOwnedHost: boolean): Text => {
  const sibling = anchor.nextSibling
  if (
    sibling?.nodeType === Node.TEXT_NODE &&
    sibling.textContent !== '' &&
    (!splitOwnedHost || sibling.textContent !== PASTED_TEXT_CARET_MARKER)
  ) {
    return sibling as Text
  }
  const host = createPastedTextCaretHost()
  if (sibling?.nodeType === Node.TEXT_NODE) sibling.replaceWith(host)
  else anchor.after(host)
  return host
}

const insertPastedTextAtCaret = (root: HTMLElement, node: ComposerPastedTextNode): boolean => {
  const selected = selectedRangeIn(root)
  if (!selected) return false
  const { selection, range } = selected
  const splitOwnedHost = isPastedTextCaretHost(range.startContainer)
  range.deleteContents()
  const inserted = createPastedTextAnchor(node)
  range.insertNode(inserted)
  const caretHost = caretNodeAfterPastedText(inserted, splitOwnedHost)
  range.setStart(caretHost, 0)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

const PASTED_TEXT_CLIPBOARD_TYPE = 'application/x-open-science-composer-fragment'

type ComposerClipboardNode = { type: 'text'; text: string } | { type: 'pasted-text'; text: string }

type ComposerClipboardFragment = { version: 1; nodes: ComposerClipboardNode[] }

const appendClipboardNode = (nodes: ComposerClipboardNode[], node: ComposerClipboardNode): void => {
  if (node.text === '') return
  const previous = nodes.at(-1)
  if (node.type === 'text' && previous?.type === 'text') previous.text += node.text
  else nodes.push(node)
}

const clipboardNodesFromSelection = (
  root: HTMLElement,
  doc: ComposerDoc,
  eventTarget: EventTarget | null
): ComposerClipboardNode[] | undefined => {
  const pastedTextById = new Map(
    doc.nodes
      .filter((node): node is ComposerPastedTextNode => node.type === 'pasted-text')
      .map((node) => [node.id, node])
  )
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return undefined

  let selectedNodes: Node[]
  if (range.collapsed) {
    const marker = (eventTarget as HTMLElement | null)?.closest?.(
      '[data-composer-node-type="pasted-text"]'
    )
    if (!marker || !root.contains(marker)) return undefined
    selectedNodes = [marker]
  } else {
    selectedNodes = Array.from(range.cloneContents().childNodes)
  }

  const nodes: ComposerClipboardNode[] = []
  for (const selected of selectedNodes) {
    if (selected.nodeType === Node.TEXT_NODE) {
      appendClipboardNode(nodes, {
        type: 'text',
        text: (selected.textContent ?? '').replaceAll(PASTED_TEXT_CARET_MARKER, '')
      })
      continue
    }
    if (selected.nodeType !== Node.ELEMENT_NODE) continue
    const element = selected as HTMLElement
    if (element.getAttribute('data-composer-node-type') === 'pasted-text') {
      const id = element.getAttribute('data-pasted-text-id')
      const pastedText = id ? pastedTextById.get(id) : undefined
      if (pastedText) appendClipboardNode(nodes, { type: 'pasted-text', text: pastedText.text })
      continue
    }
    appendClipboardNode(nodes, {
      type: 'text',
      text: (element.textContent ?? '').replaceAll(PASTED_TEXT_CARET_MARKER, '')
    })
  }
  return nodes.some((node) => node.type === 'pasted-text') ? nodes : undefined
}

const writeComposerClipboardSelection = (
  root: HTMLElement,
  doc: ComposerDoc,
  event: React.ClipboardEvent<HTMLDivElement>
): boolean => {
  const nodes = clipboardNodesFromSelection(root, doc, event.target)
  if (!nodes) return false
  const fragment: ComposerClipboardFragment = { version: 1, nodes }
  event.clipboardData.setData(PASTED_TEXT_CLIPBOARD_TYPE, JSON.stringify(fragment))
  event.clipboardData.setData('text/plain', nodes.map((node) => node.text).join(''))
  event.preventDefault()
  return true
}

const parseComposerClipboardFragment = (value: string): ComposerClipboardFragment | undefined => {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const candidate = parsed as { version?: unknown; nodes?: unknown }
    if (candidate.version !== 1 || !Array.isArray(candidate.nodes)) return undefined
    const nodes: ComposerClipboardNode[] = []
    for (const node of candidate.nodes) {
      if (!node || typeof node !== 'object') return undefined
      const valueNode = node as { type?: unknown; text?: unknown }
      if (
        (valueNode.type !== 'text' && valueNode.type !== 'pasted-text') ||
        typeof valueNode.text !== 'string'
      ) {
        return undefined
      }
      appendClipboardNode(nodes, { type: valueNode.type, text: valueNode.text })
    }
    if (!nodes.some((node) => node.type === 'pasted-text')) return undefined
    return { version: 1, nodes }
  } catch {
    return undefined
  }
}

const insertComposerClipboardFragmentAtCaret = (
  root: HTMLElement,
  fragment: ComposerClipboardFragment
): ComposerPastedTextNode[] => {
  const selected = selectedRangeIn(root)
  if (!selected) return []
  const { selection, range } = selected
  const splitOwnedHost = isPastedTextCaretHost(range.startContainer)
  range.deleteContents()
  const inserted = document.createDocumentFragment()
  const pastedTextNodes: ComposerPastedTextNode[] = []
  for (const node of fragment.nodes) {
    if (node.type === 'text') inserted.appendChild(document.createTextNode(node.text))
    else {
      const pastedText: ComposerPastedTextNode = {
        type: 'pasted-text',
        id: crypto.randomUUID(),
        text: node.text
      }
      pastedTextNodes.push(pastedText)
      inserted.appendChild(createPastedTextAnchor(pastedText))
    }
  }
  const lastInserted = inserted.lastChild
  range.insertNode(inserted)
  if (!lastInserted) return []
  if (lastInserted.nodeType === Node.ELEMENT_NODE) {
    const caretHost = caretNodeAfterPastedText(lastInserted, splitOwnedHost)
    range.setStart(caretHost, 0)
  } else {
    range.setStartAfter(lastInserted)
  }
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return pastedTextNodes
}

// A rendered mention chip element (skill or artifact) — any atomic, non-editable token span.
const asAtomicChip = (node: Node | null): HTMLElement | null =>
  node?.nodeType === Node.ELEMENT_NODE &&
  ((node as HTMLElement).hasAttribute('data-mention-type') ||
    (node as HTMLElement).getAttribute('data-composer-node-type') === 'pasted-text')
    ? (node as HTMLElement)
    : null

// Find the mention chip immediately on one side of a collapsed caret, so Backspace/Delete can remove
// the whole chip instead of letting the browser edit into it character by character.
const chipBesideCaret = (root: HTMLElement, side: 'before' | 'after'): HTMLElement | null => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!range.collapsed || !root.contains(range.startContainer)) return null
  const node = range.startContainer
  const offset = range.startOffset

  if (node.nodeType === Node.TEXT_NODE) {
    if (side === 'before') return offset === 0 ? asAtomicChip(node.previousSibling) : null
    return offset === (node.textContent ?? '').length ? asAtomicChip(node.nextSibling) : null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const index = side === 'before' ? offset - 1 : offset
    return asAtomicChip(node.childNodes[index] ?? null)
  }
  return null
}

const hasCollapsedSelection = (root: HTMLElement): boolean => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  return range.collapsed && root.contains(range.startContainer)
}

// A range from the editor start to the caret has no rendered text only at the logical start.
const caretIsAtStart = (root: HTMLElement): boolean => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const caret = selection.getRangeAt(0)
  if (!caret.collapsed || !root.contains(caret.startContainer)) return false
  const beforeCaret = document.createRange()
  beforeCaret.selectNodeContents(root)
  beforeCaret.setEnd(caret.startContainer, caret.startOffset)
  return beforeCaret.toString() === ''
}

const moveCaretToEnd = (root: HTMLElement): void => {
  root.focus()
  const range = document.createRange()
  const last = root.lastChild
  if (last?.nodeType === Node.TEXT_NODE && last.textContent?.endsWith(PASTED_TEXT_CARET_MARKER)) {
    range.setStart(last, last.textContent.length - PASTED_TEXT_CARET_MARKER.length)
  } else {
    range.selectNodeContents(root)
    range.collapse(false)
  }
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const moveCaretToPosition = (root: HTMLElement, position: ComposerCaretPosition): void => {
  const node = root.childNodes[position.nodeIndex]
  if (!node || node.nodeType !== Node.TEXT_NODE) return moveCaretToEnd(root)
  root.focus()
  const range = document.createRange()
  range.setStart(node, Math.min(position.offset, node.textContent?.length ?? 0))
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const canReceiveFocus = (root: HTMLElement): boolean =>
  root.getAttribute('contenteditable') === 'true' && root.closest('[hidden]') === null

// A contenteditable composer driven by a pure ComposerDoc model. External doc changes flow into the
// DOM via applyDocToDom; user edits flow out via domToDoc. A `/` mention trigger mounts a skill popup.
export const ComposerEditor = ({
  doc,
  onDocChange,
  onSubmit,
  onPaste,
  onLongTextPaste,
  onLocatePastedText,
  onUndoPastedTextRemoval,
  disabled = false,
  placeholder,
  className,
  ariaLabel,
  allowedSkillIds,
  isHistoryBrowsing = false,
  historyStatus = '',
  onNavigateHistory,
  mentionPreviewContext,
  focusRequest,
  restoreFocusRequest,
  caretRequest
}: ComposerEditorProps): React.JSX.Element => {
  const { t } = useTranslation()

  const editorRef = useRef<HTMLDivElement>(null)
  const historyDescriptionId = useId()
  const historyStatusId = useId()
  const mentionListboxId = useId()
  const [activeMentionOptionId, setActiveMentionOptionId] = useState<string | undefined>()
  const restoreHistoryCaretRef = useRef(false)
  const handledCaretRequestRef = useRef<number | undefined>(undefined)
  // Tracks IME composition so Enter never submits mid-composition.
  const composingRef = useRef(false)

  // At most one skill per message: once a chip exists, suppress the trigger so a further `/` does nothing.
  const hasSkill = doc.nodes.some((node) => node.type === 'skill')
  const hasVisibleContent = doc.nodes.some(
    (node) => node.type !== 'pasted-text' && (node.type !== 'text' || node.text !== '')
  )
  const hasPastedText = doc.nodes.some((node) => node.type === 'pasted-text')
  const showInlinePlaceholder = hasPastedText && !hasVisibleContent

  // The hook guards a null current internally; widen the element type for its generic ref option.
  const mention = useMentionTrigger({
    editorRef: editorRef as React.RefObject<HTMLElement>,
    trigger: '/',
    disabled: disabled || hasSkill
  })

  // A parallel `@` trigger for artifact mentions, self-suppressing once the per-message cap is reached.
  const artifactMention = useMentionTrigger({
    editorRef: editorRef as React.RefObject<HTMLElement>,
    trigger: '@',
    disabled: disabled || docArtifactCount(doc) >= MAX_COMPOSER_ARTIFACT_MENTIONS
  })
  const sessionMention = useMentionTrigger({
    editorRef: editorRef as React.RefObject<HTMLElement>,
    trigger: '#',
    disabled: disabled || docSessionCount(doc) >= MAX_COMPOSER_SESSION_MENTIONS
  })
  const mentionPopupOpen = mention.active || artifactMention.active || sessionMention.active

  // Read the live DOM back into a doc and notify the parent.
  const emitDocFromDom = useCallback((): void => {
    const root = editorRef.current
    if (root) onDocChange(domToDoc(root))
  }, [onDocChange])

  // Apply the incoming doc to the DOM only when it diverges from what the editor already shows.
  // Comparing against domToDoc(root) avoids clobbering the caret on the keystroke the user just made.
  useLayoutEffect(() => {
    const root = editorRef.current
    if (!root) return
    const shouldPreserveFocus =
      focusRequest !== undefined && canReceiveFocus(root) && document.activeElement === root
    const docChanged = !nodesEqual(domToDoc(root).nodes, doc.nodes)
    if (docChanged) applyDocToDom(root, doc)
    else syncPastedTextAnchors(root, doc)
    const hasCaretRequest =
      caretRequest !== undefined && handledCaretRequestRef.current !== caretRequest.key
    if (hasCaretRequest) {
      handledCaretRequestRef.current = caretRequest.key
      restoreHistoryCaretRef.current = false
      moveCaretToPosition(root, caretRequest.position)
    } else if (restoreHistoryCaretRef.current || (docChanged && shouldPreserveFocus)) {
      restoreHistoryCaretRef.current = false
      moveCaretToEnd(root)
    }
  }, [caretRequest, doc, focusRequest])

  useLayoutEffect(() => {
    const root = editorRef.current
    if (root && focusRequest !== undefined && canReceiveFocus(root)) moveCaretToEnd(root)
  }, [focusRequest])

  useLayoutEffect(() => {
    const root = editorRef.current
    if (root && restoreFocusRequest !== undefined && canReceiveFocus(root)) moveCaretToEnd(root)
  }, [restoreFocusRequest])

  const handleInput = useCallback((): void => emitDocFromDom(), [emitDocFromDom])

  // Clicking an `@` mention chip opens the file in the preview workbench, like the sent-message
  // pills do. Linked-folder chips resolve rootId + relativePath through the granted-roots store
  // (inert once the root is revoked); upload/artifact chips probe first so a stale chip stays
  // inert, then open through the mention preview item.
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const root = editorRef.current
    const pastedTextMarker = (event.target as HTMLElement).closest?.(
      '[data-composer-node-type="pasted-text"]'
    ) as HTMLElement | null
    if (root && pastedTextMarker && root.contains(pastedTextMarker)) {
      const pastedTextId = pastedTextMarker.getAttribute('data-pasted-text-id')
      if (!pastedTextId) return
      event.preventDefault()
      onLocatePastedText?.(pastedTextId)
      return
    }
    const sessionChip = (event.target as HTMLElement).closest?.(
      '[data-mention-type="session"]'
    ) as HTMLElement | null
    if (root && sessionChip && root.contains(sessionChip)) {
      const sessionId = sessionChip.getAttribute('data-session-id')
      if (!sessionId) return
      event.preventDefault()
      useNavigationStore.getState().openSessionById(sessionId, 'user')
      return
    }
    const chip = (event.target as HTMLElement).closest?.(
      '[data-mention-type="artifact"]'
    ) as HTMLElement | null
    if (!root || !chip || !root.contains(chip)) return
    const source = chip.getAttribute('data-mention-source')

    if (source === 'linked-folder') {
      const rootId = chip.getAttribute('data-mention-root-id')
      const relativePath = chip.getAttribute('data-mention-relative-path')
      if (!rootId || !relativePath) return
      const grantedRoot = useGrantedFoldersStore
        .getState()
        .roots.find((candidate) => candidate.id === rootId)
      if (!grantedRoot) return
      event.preventDefault()
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(
        createPreviewFileItemFromLocal({
          sessionId: LOCAL_PREVIEW_SESSION_ID,
          path: resolveLocalPath(grantedRoot.path, relativePath, window.api?.platform ?? 'darwin'),
          name: chip.getAttribute('data-mention-filename') ?? relativePath
        })
      )
      return
    }

    if ((source !== 'upload' && source !== 'artifact') || !mentionPreviewContext) return
    const path = chip.getAttribute('data-mention-path')
    if (!path) return
    event.preventDefault()
    const part: Parameters<typeof createPreviewFileItemFromMention>[0] = {
      type: 'artifact',
      id: chip.getAttribute('data-mention-id') ?? path,
      name: chip.getAttribute('data-mention-filename') ?? path,
      path,
      source,
      mimeType: chip.getAttribute('data-mention-mime-type') ?? undefined,
      versionId: chip.getAttribute('data-mention-version-id') ?? undefined
    }
    const { sessionId, projectId } = mentionPreviewContext
    void (async () => {
      const read =
        source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview
      try {
        await read({
          ...createPreviewRequestScope({ projectId, sessionId, source, path }),
          path,
          maxBytes: 1,
          encoding: 'utf8'
        })
      } catch {
        return
      }
      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(createPreviewFileItemFromMention(part, sessionId, projectId))
    })()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const pastedTextMarker = (event.target as HTMLElement).closest?.(
      '[data-composer-node-type="pasted-text"]'
    ) as HTMLElement | null
    if (
      pastedTextMarker &&
      (event.key === 'Enter' || event.key === ' ') &&
      editorRef.current?.contains(pastedTextMarker)
    ) {
      const pastedTextId = pastedTextMarker.getAttribute('data-pasted-text-id')
      if (pastedTextId) {
        event.preventDefault()
        onLocatePastedText?.(pastedTextId)
      }
      return
    }
    if (disabled) return
    const primaryUndoModifier =
      (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey)
    if (
      event.key.toLowerCase() === 'z' &&
      primaryUndoModifier &&
      !event.altKey &&
      !event.shiftKey &&
      !event.repeat &&
      !event.nativeEvent.isComposing &&
      onUndoPastedTextRemoval?.()
    ) {
      event.preventDefault()
      return
    }
    // While either mention popup is open it owns Enter/arrow keys; leave them to its document listener.
    if (mention.active || artifactMention.active || sessionMention.active) return
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      onNavigateHistory &&
      !composingRef.current &&
      !event.nativeEvent.isComposing &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const root = editorRef.current
      const selectionEligible = root ? hasCollapsedSelection(root) : false
      const direction = event.key === 'ArrowUp' ? 'previous' : 'next'
      const canStartBrowsing = direction === 'previous' && root ? caretIsAtStart(root) : false
      if (
        selectionEligible &&
        (isHistoryBrowsing || canStartBrowsing) &&
        onNavigateHistory(direction)
      ) {
        restoreHistoryCaretRef.current = true
        event.preventDefault()
        return
      }
    }
    // Backspace/Delete next to a chip removes the whole chip atomically (never edits its label).
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const root = editorRef.current
      const chip = root && chipBesideCaret(root, event.key === 'Backspace' ? 'before' : 'after')
      if (chip) {
        event.preventDefault()
        chip.remove()
        emitDocFromDom()
        return
      }
    }
    // Enter submits; Shift+Enter inserts a newline; IME composition never submits.
    if (event.key === 'Enter' && !event.shiftKey && !composingRef.current) {
      event.preventDefault()
      onSubmit()
    }
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    // Forward first so the panel can route file attachments to its intake.
    onPaste(event)
    if (disabled || event.isDefaultPrevented()) return
    const internalFragment = parseComposerClipboardFragment(
      event.clipboardData?.getData(PASTED_TEXT_CLIPBOARD_TYPE) ?? ''
    )
    if (internalFragment && onLongTextPaste) {
      event.preventDefault()
      const root = editorRef.current
      const pastedTextNodes = root
        ? insertComposerClipboardFragmentAtCaret(root, internalFragment)
        : []
      if (root && pastedTextNodes.length > 0) {
        onLongTextPaste(domToDoc(root), pastedTextNodes)
      }
      return
    }
    // For text, insert it as plain text ourselves to keep the contenteditable free of rich HTML.
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text) {
      event.preventDefault()
      const root = editorRef.current
      if (onLongTextPaste && shouldAttachPastedText(text)) {
        const node: ComposerPastedTextNode = {
          type: 'pasted-text',
          id: crypto.randomUUID(),
          text
        }
        if (root && insertPastedTextAtCaret(root, node)) onLongTextPaste(domToDoc(root), node)
      } else {
        if (root && insertPlainTextAtCaret(root, text)) emitDocFromDom()
      }
    }
  }

  const handleCopy = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const root = editorRef.current
    if (!root) return
    writeComposerClipboardSelection(root, doc, event)
  }

  const handleCut = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const root = editorRef.current
    if (!root || !writeComposerClipboardSelection(root, doc, event)) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (range.collapsed) {
      const marker = (event.target as HTMLElement).closest?.(
        '[data-composer-node-type="pasted-text"]'
      )
      if (!marker || !root.contains(marker) || !marker.parentNode) return
      const parent = marker.parentNode
      const offset = Array.prototype.indexOf.call(parent.childNodes, marker) as number
      marker.remove()
      range.setStart(parent, offset)
    } else {
      range.deleteContents()
    }
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    emitDocFromDom()
  }

  // Replace the active `/query` token with a skill chip, then close the popup.
  const handleSelectSkill = (skill: SkillView): void => {
    mention.replaceTokenWith({ type: 'skill', id: skill.id, name: skill.displayName })
    mention.cancel()
  }

  // Replace the active `@query` token with an artifact chip, then close the popup.
  const handleSelectArtifact = (ref: PickedArtifact): void => {
    artifactMention.replaceTokenWith({
      type: 'artifact',
      id: ref.id,
      name: ref.name,
      path: ref.path,
      source: ref.source,
      mimeType: ref.mimeType,
      versionId: ref.versionId
    })
    artifactMention.cancel()
  }

  const handleSelectSession = (session: PickedSession): void => {
    sessionMention.replaceTokenWith(session)
    sessionMention.cancel()
  }

  return (
    <div className="relative min-w-0">
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-describedby={`${historyDescriptionId} ${historyStatusId}`}
        aria-disabled={disabled || undefined}
        aria-haspopup="listbox"
        aria-controls={mentionPopupOpen ? mentionListboxId : undefined}
        aria-activedescendant={mentionPopupOpen ? activeMentionOptionId : undefined}
        aria-autocomplete={mentionPopupOpen ? 'list' : undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-inline-placeholder={showInlinePlaceholder ? 'true' : undefined}
        className={cn(
          composerEditorClassName,
          showInlinePlaceholder &&
            'after:pointer-events-none after:text-muted-foreground after:content-[attr(data-placeholder)]',
          className
        )}
        onInput={handleInput}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onCut={handleCut}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
      />
      <span id={historyDescriptionId} className="sr-only">
        {t('At the start of the input, use Up and Down Arrow to browse prompt history.')}
      </span>
      <span id={historyStatusId} role="status" aria-live="polite" className="sr-only">
        {historyStatus}
      </span>
      {!hasVisibleContent && !hasPastedText ? (
        <div aria-hidden="true" className={composerPlaceholderClassName}>
          {placeholder}
        </div>
      ) : null}
      {mention.active ? (
        <SkillMentionPopup
          query={mention.query}
          allowedSkillIds={allowedSkillIds}
          listboxId={mentionListboxId}
          onActiveOptionIdChange={setActiveMentionOptionId}
          onSelect={handleSelectSkill}
          onClose={mention.cancel}
        />
      ) : null}
      {artifactMention.active ? (
        <ArtifactMentionPopup
          query={artifactMention.query}
          onSelect={handleSelectArtifact}
          onClose={artifactMention.cancel}
          listboxId={mentionListboxId}
          onActiveOptionIdChange={setActiveMentionOptionId}
        />
      ) : null}
      {sessionMention.active ? (
        <SessionMentionPopup
          query={sessionMention.query}
          onSelect={handleSelectSession}
          onClose={sessionMention.cancel}
          listboxId={mentionListboxId}
          onActiveOptionIdChange={setActiveMentionOptionId}
        />
      ) : null}
    </div>
  )
}
