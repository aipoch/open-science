import { useCallback, useId, useLayoutEffect, useRef } from 'react'

import type { SkillView } from '../../../../../shared/settings'
import { cn } from '@/lib/utils'

import { ArtifactMentionPopup, type PickedArtifact } from './ArtifactMentionPopup'
import {
  applyDocToDom,
  docArtifactCount,
  docIsEmpty,
  domToDoc,
  MAX_COMPOSER_ARTIFACT_MENTIONS,
  type ComposerDoc,
  type ComposerNode
} from './composer-doc'
import { SkillMentionPopup } from './SkillMentionPopup'
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
  disabled?: boolean
  placeholder: string
  className?: string
  ariaLabel: string
  // Undefined preserves Main Agent behavior; an empty array intentionally hides every Skill.
  allowedSkillIds?: readonly string[]
  isHistoryBrowsing?: boolean
  historyStatus?: string
  onNavigateHistory?: (direction: 'previous' | 'next') => boolean
  focusRequest?: number
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
const insertPlainTextAtCaret = (text: string): void => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const inserted = document.createTextNode(text)
  range.insertNode(inserted)
  range.setStartAfter(inserted)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

// A rendered mention chip element (skill or artifact) — any atomic, non-editable token span.
const asMentionChip = (node: Node | null): HTMLElement | null =>
  node?.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute('data-mention-type')
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
    if (side === 'before') return offset === 0 ? asMentionChip(node.previousSibling) : null
    return offset === (node.textContent ?? '').length ? asMentionChip(node.nextSibling) : null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const index = side === 'before' ? offset - 1 : offset
    return asMentionChip(node.childNodes[index] ?? null)
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
  range.selectNodeContents(root)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

// A contenteditable composer driven by a pure ComposerDoc model. External doc changes flow into the
// DOM via applyDocToDom; user edits flow out via domToDoc. A `/` mention trigger mounts a skill popup.
export const ComposerEditor = ({
  doc,
  onDocChange,
  onSubmit,
  onPaste,
  disabled = false,
  placeholder,
  className,
  ariaLabel,
  allowedSkillIds,
  isHistoryBrowsing = false,
  historyStatus = '',
  onNavigateHistory,
  focusRequest
}: ComposerEditorProps): React.JSX.Element => {
  const editorRef = useRef<HTMLDivElement>(null)
  const historyDescriptionId = useId()
  const historyStatusId = useId()
  const restoreHistoryCaretRef = useRef(false)
  // Tracks IME composition so Enter never submits mid-composition.
  const composingRef = useRef(false)

  // At most one skill per message: once a chip exists, suppress the trigger so a further `/` does nothing.
  const hasSkill = doc.nodes.some((node) => node.type === 'skill')

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
    if (!nodesEqual(domToDoc(root).nodes, doc.nodes)) applyDocToDom(root, doc)
    if (restoreHistoryCaretRef.current) {
      restoreHistoryCaretRef.current = false
      moveCaretToEnd(root)
    }
  }, [doc])

  useLayoutEffect(() => {
    if (focusRequest !== undefined && editorRef.current) moveCaretToEnd(editorRef.current)
  }, [focusRequest])

  const handleInput = useCallback((): void => emitDocFromDom(), [emitDocFromDom])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    // While either mention popup is open it owns Enter/arrow keys; leave them to its document listener.
    if (mention.active || artifactMention.active) return
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
    // For text, insert it as plain text ourselves to keep the contenteditable free of rich HTML.
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text) {
      event.preventDefault()
      insertPlainTextAtCaret(text)
      emitDocFromDom()
    }
  }

  // Replace the active `/query` token with a skill chip, then close the popup.
  const handleSelectSkill = (skill: SkillView): void => {
    mention.replaceTokenWith({ type: 'skill', id: skill.id, name: skill.name })
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
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className={cn(composerEditorClassName, className)}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
      />
      <span id={historyDescriptionId} className="sr-only">
        At the start of the input, use Up and Down Arrow to browse prompt history.
      </span>
      <span id={historyStatusId} role="status" aria-live="polite" className="sr-only">
        {historyStatus}
      </span>
      {/* Show the placeholder whenever the doc is empty, regardless of focus. */}
      {docIsEmpty(doc) ? (
        <div aria-hidden="true" className={composerPlaceholderClassName}>
          {placeholder}
        </div>
      ) : null}
      {mention.active ? (
        <SkillMentionPopup
          query={mention.query}
          allowedSkillIds={allowedSkillIds}
          onSelect={handleSelectSkill}
          onClose={mention.cancel}
        />
      ) : null}
      {artifactMention.active ? (
        <ArtifactMentionPopup
          query={artifactMention.query}
          onSelect={handleSelectArtifact}
          onClose={artifactMention.cancel}
        />
      ) : null}
    </div>
  )
}
