import { useCallback, useEffect, useRef, useState } from 'react'

import { createArtifactChip, createSkillChip, type ComposerNode } from './composer-doc'

// A trigger match derived purely from the text before the caret.
export type TriggerMatch = { active: boolean; query: string }

// Detect an active mention trigger at the end of `textBeforeCaret`. The trigger is only valid
// at the very start of the text or immediately after whitespace, and its query runs to the caret
// without containing whitespace. The trailing run of non-whitespace chars is exactly that token:
// it always begins at string start or right after whitespace, so it is our only candidate.
export const detectTrigger = (textBeforeCaret: string, trigger: string): TriggerMatch => {
  if (trigger === '') return { active: false, query: '' }
  const token = textBeforeCaret.match(/\S*$/)?.[0] ?? ''
  if (!token.startsWith(trigger)) return { active: false, query: '' }
  return { active: true, query: token.slice(trigger.length) }
}

// Live trigger state plus the on-screen rect of the trigger position for popup placement.
export type MentionState = { active: boolean; query: string; anchorRect: DOMRect | null }

type UseMentionTriggerOptions = {
  editorRef: React.RefObject<HTMLElement>
  trigger: string
  disabled?: boolean
  onStateChange?: (state: MentionState) => void
}

type UseMentionTriggerResult = MentionState & {
  cancel: () => void
  replaceTokenWith: (node: ComposerNode) => void
}

const INACTIVE: MentionState = { active: false, query: '', anchorRect: null }

// Read the text preceding the caret within its text node. A preceding chip (or any element) acts as a
// clean word boundary, so a trigger at the start of a post-chip text node opens a fresh mention — this
// is what lets a second skill be picked right after an existing chip.
const textBeforeCaretIn = (node: Node, offset: number): string => {
  if (node.nodeType !== Node.TEXT_NODE) return ''
  return (node.textContent ?? '').slice(0, offset)
}

// Build a collapsed range at the trigger's start position to anchor the popup.
const computeAnchorRect = (
  node: Node,
  caretOffset: number,
  tokenLength: number
): DOMRect | null => {
  if (node.nodeType !== Node.TEXT_NODE) return null
  const start = Math.max(0, caretOffset - tokenLength)
  const range = document.createRange()
  range.setStart(node, start)
  range.collapse(true)
  return range.getBoundingClientRect()
}

// A generic mention-trigger hook: watches the live selection inside a contenteditable editor,
// exposes the current trigger state, and can swap the active token for a chip or text node.
export const useMentionTrigger = ({
  editorRef,
  trigger,
  disabled = false,
  onStateChange
}: UseMentionTriggerOptions): UseMentionTriggerResult => {
  const [state, setState] = useState<MentionState>(INACTIVE)

  // Refs keep the latest state and callback available to event handlers without re-subscribing.
  const stateRef = useRef(state)
  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  const emit = useCallback((next: MentionState): void => {
    const prev = stateRef.current
    if (
      prev.active === next.active &&
      prev.query === next.query &&
      prev.anchorRect === next.anchorRect
    ) {
      return
    }
    stateRef.current = next
    setState(next)
    onStateChangeRef.current?.(next)
  }, [])

  const cancel = useCallback((): void => emit(INACTIVE), [emit])

  // Compute the trigger state from the current selection, guarding disabled and out-of-editor cases.
  const sync = useCallback((): void => {
    const editor = editorRef.current
    if (!editor || disabled) return emit(INACTIVE)
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return emit(INACTIVE)
    const { anchorNode, anchorOffset } = selection
    if (!anchorNode || !editor.contains(anchorNode)) return emit(INACTIVE)

    const match = detectTrigger(textBeforeCaretIn(anchorNode, anchorOffset), trigger)
    if (!match.active) return emit(INACTIVE)

    const rect = computeAnchorRect(anchorNode, anchorOffset, trigger.length + match.query.length)
    emit({ active: true, query: match.query, anchorRect: rect })
  }, [editorRef, trigger, disabled, emit])

  // Subscribe to selection and input changes while enabled; reset on teardown or disable.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || disabled) {
      emit(INACTIVE)
      return
    }
    document.addEventListener('selectionchange', sync)
    editor.addEventListener('input', sync)
    return () => {
      document.removeEventListener('selectionchange', sync)
      editor.removeEventListener('input', sync)
    }
  }, [editorRef, disabled, sync, emit])

  // Replace the active trigger token with a chip or text node and place the caret after it.
  const replaceTokenWith = useCallback(
    (node: ComposerNode): void => {
      const editor = editorRef.current
      const selection = window.getSelection()
      if (!editor || !selection || selection.rangeCount === 0) return
      const { anchorNode, anchorOffset } = selection
      if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE || !editor.contains(anchorNode)) {
        return
      }

      const match = detectTrigger(textBeforeCaretIn(anchorNode, anchorOffset), trigger)
      if (!match.active) return

      // Delete the `<trigger><query>` run ending at the caret.
      const tokenLength = trigger.length + match.query.length
      const range = document.createRange()
      range.setStart(anchorNode, Math.max(0, anchorOffset - tokenLength))
      range.setEnd(anchorNode, anchorOffset)
      range.deleteContents()

      // Insert the replacement, then collapse the caret immediately after it.
      const inserted =
        node.type === 'skill'
          ? createSkillChip(node)
          : node.type === 'artifact'
            ? createArtifactChip(node)
            : document.createTextNode(node.text)
      range.insertNode(inserted)
      const after = document.createRange()
      after.setStartAfter(inserted)
      after.collapse(true)
      selection.removeAllRanges()
      selection.addRange(after)

      emit(INACTIVE)
      // Let the editor re-read its DOM into the doc model.
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    },
    [editorRef, trigger, emit]
  )

  return { ...state, cancel, replaceTokenWith }
}
