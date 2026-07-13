import { useCallback, useLayoutEffect, useRef } from 'react'

import type { SkillView } from '../../../../../shared/settings'
import { cn } from '@/lib/utils'

import { applyDocToDom, domToDoc, type ComposerDoc, type ComposerNode } from './composer-doc'
import { SkillMentionPopup } from './SkillMentionPopup'
import { useMentionTrigger } from './useMentionTrigger'

// Base editor styling: mirrors the sizing/leading of the legacy composer textarea and adds the
// mockup's empty:before placeholder technique so the hint shows only while the doc is empty.
const composerEditorClassName =
  'min-h-[36px] max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent py-1.5 text-[15px] leading-relaxed text-text-000 outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-text-300 empty:before:pointer-events-none empty:before:whitespace-nowrap empty:before:overflow-hidden empty:before:text-ellipsis empty:before:max-w-full'

type ComposerEditorProps = {
  doc: ComposerDoc
  onDocChange: (doc: ComposerDoc) => void
  onSubmit: () => void
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void
  disabled?: boolean
  placeholder: string
  className?: string
  ariaLabel: string
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

// A rendered skill chip element (atomic, non-editable token).
const asSkillChip = (node: Node | null): HTMLElement | null =>
  node?.nodeType === Node.ELEMENT_NODE &&
  (node as HTMLElement).getAttribute('data-mention-type') === 'skill'
    ? (node as HTMLElement)
    : null

// Find the skill chip immediately on one side of a collapsed caret, so Backspace/Delete can remove the
// whole chip instead of letting the browser edit into it character by character.
const chipBesideCaret = (root: HTMLElement, side: 'before' | 'after'): HTMLElement | null => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!range.collapsed || !root.contains(range.startContainer)) return null
  const node = range.startContainer
  const offset = range.startOffset

  if (node.nodeType === Node.TEXT_NODE) {
    if (side === 'before') return offset === 0 ? asSkillChip(node.previousSibling) : null
    return offset === (node.textContent ?? '').length ? asSkillChip(node.nextSibling) : null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const index = side === 'before' ? offset - 1 : offset
    return asSkillChip(node.childNodes[index] ?? null)
  }
  return null
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
  ariaLabel
}: ComposerEditorProps): React.JSX.Element => {
  const editorRef = useRef<HTMLDivElement>(null)
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
  }, [doc])

  const handleInput = useCallback((): void => emitDocFromDom(), [emitDocFromDom])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    // While the mention popup is open it owns Enter/arrow keys; leave them to its document listener.
    if (mention.active) return
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

  return (
    <div className="relative min-w-0">
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
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
      {mention.active ? (
        <SkillMentionPopup
          query={mention.query}
          onSelect={handleSelectSkill}
          onClose={mention.cancel}
        />
      ) : null}
    </div>
  )
}
