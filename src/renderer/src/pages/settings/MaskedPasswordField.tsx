import {
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ComponentProps,
  type CompositionEvent,
  type KeyboardEvent
} from 'react'

import { Input } from '@/components/ui/input'

type MaskedPasswordFieldProps = Omit<
  ComponentProps<'input'>,
  'defaultValue' | 'onChange' | 'type' | 'value'
> &
  Readonly<{
    value: string
    onChange(value: string): void
  }>

const MASK = '•'
const masked = (value: string): string => MASK.repeat(value.length)

const selection = (input: HTMLInputElement): readonly [number, number] => [
  input.selectionStart ?? 0,
  input.selectionEnd ?? input.selectionStart ?? 0
]

const beginsInsideSurrogatePair = (value: string, index: number): boolean =>
  index > 0 &&
  index < value.length &&
  /[\uD800-\uDBFF]/u.test(value[index - 1]!) &&
  /[\uDC00-\uDFFF]/u.test(value[index]!)

const normalizedSelection = (
  value: string,
  start: number,
  end: number
): readonly [number, number] => {
  if (start === end && beginsInsideSurrogatePair(value, start)) return [start - 1, start - 1]
  return [
    beginsInsideSurrogatePair(value, start) ? start - 1 : start,
    beginsInsideSurrogatePair(value, end) ? end + 1 : end
  ]
}

const previousCodePointStart = (value: string, index: number): number => {
  if (index < 2) return Math.max(0, index - 1)
  const last = value.charCodeAt(index - 1)
  const previous = value.charCodeAt(index - 2)
  return last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
    ? index - 2
    : index - 1
}

const nextCodePointEnd = (value: string, index: number): number => {
  const first = value.charCodeAt(index)
  const next = value.charCodeAt(index + 1)
  return first >= 0xd800 && first <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? index + 2
    : Math.min(value.length, index + 1)
}

// The DOM and accessibility tree only receive placeholder bullets. The exact candidate remains in
// React state, while editing events are translated from bullet-string selection offsets to that raw
// value. Offsets intentionally use UTF-16 units because that is the selection API's coordinate space.
export function MaskedPasswordField({
  value,
  onChange,
  onKeyDown,
  ...props
}: MaskedPasswordFieldProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  const pendingSelection = useRef<number | undefined>(undefined)
  const composing = useRef(false)
  const compositionSelection = useRef<readonly [number, number] | undefined>(undefined)

  useLayoutEffect(() => {
    valueRef.current = value
  }, [value])

  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input || pendingSelection.current === undefined) return
    const caret = pendingSelection.current
    pendingSelection.current = undefined
    input.setSelectionRange(caret, caret)
  }, [value])

  const replaceSelection = (
    input: HTMLInputElement,
    replacement: string,
    selected: readonly [number, number] = selection(input)
  ): void => {
    const current = valueRef.current
    const [start, end] = normalizedSelection(current, selected[0], selected[1])
    const next = current.slice(0, start) + replacement + current.slice(end)
    const caret = start + replacement.length
    valueRef.current = next
    pendingSelection.current = caret
    input.value = masked(next)
    input.setSelectionRange(caret, caret)
    onChange(next)
  }

  const deleteSelection = (input: HTMLInputElement, backward: boolean): void => {
    const current = valueRef.current
    let [start, end] = normalizedSelection(current, ...selection(input))
    if (start === end) {
      if (backward) start = previousCodePointStart(current, start)
      else end = nextCodePointEnd(current, end)
    }
    replaceSelection(input, '', [start, end])
  }

  const handleBeforeInput = (input: HTMLInputElement, native: InputEvent): void => {
    native.preventDefault()
    if (native.inputType.includes('Composition')) return
    if (native.inputType === 'insertLineBreak' || native.inputType === 'insertParagraph') {
      replaceSelection(input, '\n')
      return
    }
    if (native.inputType.startsWith('insert') && native.data !== null) {
      replaceSelection(input, native.data)
      return
    }
    if (native.inputType.startsWith('delete') && native.inputType.endsWith('Backward')) {
      deleteSelection(input, true)
      return
    }
    if (native.inputType.startsWith('delete') && native.inputType.endsWith('Forward')) {
      deleteSelection(input, false)
    }
  }

  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    const listener = (event: InputEvent): void => handleBeforeInput(input, event)
    input.addEventListener('beforeinput', listener)
    return () => input.removeEventListener('beforeinput', listener)
  })

  const blockClipboardExport = (event: ClipboardEvent<HTMLInputElement>): void => {
    event.preventDefault()
    event.clipboardData.setData('text/plain', '')
  }

  return (
    <Input
      {...props}
      ref={inputRef}
      type="password"
      value={masked(value)}
      autoComplete="new-password"
      spellCheck={false}
      onPaste={(event) => {
        event.preventDefault()
        replaceSelection(event.currentTarget, event.clipboardData.getData('text'))
      }}
      onCopy={blockClipboardExport}
      onCut={blockClipboardExport}
      onDrop={(event) => event.preventDefault()}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key !== 'Enter') return
        event.preventDefault()
        replaceSelection(event.currentTarget, '\n')
      }}
      onCompositionStart={(event: CompositionEvent<HTMLInputElement>) => {
        composing.current = true
        compositionSelection.current = selection(event.currentTarget)
      }}
      onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
        if (!composing.current) return
        composing.current = false
        replaceSelection(
          event.currentTarget,
          event.data,
          compositionSelection.current ?? selection(event.currentTarget)
        )
        compositionSelection.current = undefined
      }}
      onInput={(event) => {
        // Harden against an insertion path the browser did not expose through beforeinput. Never
        // leave browser- or password-manager-inserted literal text in the DOM.
        const input = event.currentTarget
        const caret = Math.min(
          input.selectionStart ?? valueRef.current.length,
          valueRef.current.length
        )
        input.value = masked(valueRef.current)
        input.setSelectionRange(caret, caret)
      }}
      onChange={(event) => {
        event.currentTarget.value = masked(valueRef.current)
      }}
    />
  )
}
