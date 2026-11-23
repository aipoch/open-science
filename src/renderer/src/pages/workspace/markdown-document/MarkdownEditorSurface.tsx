import { RefreshCw } from 'lucide-react'
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type { Value } from 'platejs'
import {
  Plate,
  PlateContent,
  PlateLeaf,
  type PlateLeafProps,
  type PlateEditor
} from 'platejs/react'

import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'

import {
  markdownSourceWithFormat,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  type MarkdownDiagnostic,
  type MarkdownSourceFormat
} from './markdown-codec'
import { createMarkdownEditor, markdownElementPlugins } from './markdown-editor'
import { MarkdownSelectionToolbar } from './MarkdownSelectionToolbar'
import { MarkdownBlockElement } from './MarkdownBlockElement'
import type { MarkdownAgentRequest } from './MarkdownAgentPrompt'
import { MarkdownAgentReview, type MarkdownReplacement } from './MarkdownAgentReview'
import type { MarkdownDocumentSelection } from './markdown-selection'
import { getMarkdownListItemAtCaret, indentMarkdownListItem } from './markdown-list-transforms'

export type MarkdownEditorSurfaceProps = Readonly<{
  replacement?: MarkdownReplacement
  source: string
  sourceFormat?: MarkdownSourceFormat
  disabled?: boolean
  onChange: (markdown: string) => void
  onSendSelection?: (selection: MarkdownDocumentSelection, note?: string) => Promise<boolean>
  onSubmitRequest?: (request: MarkdownAgentRequest) => Promise<boolean>
  onDiagnostics?: (diagnostics: readonly MarkdownDiagnostic[]) => void
  onDirtyChange?: () => void
}>
export type MarkdownEditorSurfaceHandle = Readonly<{
  flush: () => string | undefined
}>

const markdownComponents = {
  ...Object.fromEntries(markdownElementPlugins.map(({ key }) => [key, MarkdownBlockElement])),
  p: MarkdownBlockElement,
  bold: (props: PlateLeafProps) => <PlateLeaf {...props} as="strong" />,
  italic: (props: PlateLeafProps) => <PlateLeaf {...props} as="em" />,
  strikethrough: (props: PlateLeafProps) => <PlateLeaf {...props} as="del" />,
  code: (props: PlateLeafProps) => (
    <PlateLeaf {...props} as="code" className="rounded bg-muted px-1 font-mono text-[0.9em]" />
  )
}

const MarkdownEditorCanvas = memo(
  ({
    editor,
    disabled,
    onChange,
    onSendSelection,
    onSubmitRequest,
    replacement,
    onFlush
  }: Readonly<{
    replacement?: MarkdownReplacement
    editor: PlateEditor
    disabled: boolean
    onChange: (value: Value) => void
    onSendSelection?: MarkdownEditorSurfaceProps['onSendSelection']
    onSubmitRequest?: MarkdownEditorSurfaceProps['onSubmitRequest']
    onFlush: () => void
  }>): React.JSX.Element => {
    return (
      <div>
        <TooltipProvider>
          <Plate editor={editor} onValueChange={({ value }) => onChange(value as Value)}>
            <MarkdownAgentReview
              onSubmitRequest={onSubmitRequest}
              replacement={replacement}
              disabled={disabled}
            />
            {disabled ? null : <MarkdownSelectionToolbar onSendSelection={onSendSelection} />}
            <PlateContent
              data-testid="markdown-plate-editor"
              readOnly={disabled}
              contentEditable={!disabled}
              className="min-h-full pl-16 pr-6 py-6 outline-none [&_h1]:mb-4 [&_h1]:text-3xl [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_ul]:list-disc [&_ol]:list-decimal [&_p]:my-2"
              spellCheck
              onKeyDownCapture={(event) => {
                if (
                  disabled ||
                  event.key !== 'Tab' ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.nativeEvent.isComposing ||
                  !(event.target instanceof HTMLElement) ||
                  event.target.closest('[contenteditable="false"]')
                )
                  return
                const path = getMarkdownListItemAtCaret(editor)
                if (!path) return
                // Own list indentation before Plate's default Tab navigation moves the caret.
                event.preventDefault()
                event.stopPropagation()
                indentMarkdownListItem(editor, path, event.shiftKey)
              }}
              onBlur={onFlush}
            />
          </Plate>
        </TooltipProvider>
      </div>
    )
  }
)
MarkdownEditorCanvas.displayName = 'MarkdownEditorCanvas'

export const MarkdownEditorSurface = forwardRef<
  MarkdownEditorSurfaceHandle,
  MarkdownEditorSurfaceProps
>(
  (
    {
      source,
      replacement,
      sourceFormat,
      disabled = false,
      onChange,
      onSendSelection,
      onSubmitRequest,
      onDiagnostics,
      onDirtyChange
    },
    ref
  ): React.JSX.Element => {
    const { t } = useTranslation()
    const onChangeRef = useRef(onChange)
    const onDiagnosticsRef = useRef(onDiagnostics)
    const onSendSelectionRef = useRef(onSendSelection)
    const onSubmitRequestRef = useRef(onSubmitRequest)
    onChangeRef.current = onChange
    onDiagnosticsRef.current = onDiagnostics
    onSendSelectionRef.current = onSendSelection
    onSubmitRequestRef.current = onSubmitRequest
    const stableOnSendSelection = useCallback<
      NonNullable<MarkdownEditorSurfaceProps['onSendSelection']>
    >(
      (selection, note) => onSendSelectionRef.current?.(selection, note) ?? Promise.resolve(false),
      []
    )
    const stableOnSubmitRequest = useCallback<
      NonNullable<MarkdownEditorSurfaceProps['onSubmitRequest']>
    >((request) => onSubmitRequestRef.current?.(request) ?? Promise.resolve(false), [])
    const [initial] = useState(() => parseMarkdownDocument(source.replace(/^\uFEFF/u, '')))
    const [editor] = useState(() => createMarkdownEditor(initial.value, markdownComponents))
    const hydrationCompleteRef = useRef(false)

    useEffect(() => {
      hydrationCompleteRef.current = true
    }, [])
    useEffect(() => {
      onDiagnosticsRef.current?.(initial.diagnostics)
    }, [initial.diagnostics])

    const emitRichChange = useCallback(
      (value: Value): string | undefined => {
        if (!hydrationCompleteRef.current) return undefined
        const serialized = serializeMarkdownDocument(value)
        const next = sourceFormat ? markdownSourceWithFormat(serialized, sourceFormat) : serialized
        onChangeRef.current(next)
        return next
      },
      [sourceFormat]
    )
    const pendingValueRef = useRef<Value | undefined>(undefined)
    const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const onDirtyChangeRef = useRef(onDirtyChange)
    onDirtyChangeRef.current = onDirtyChange
    const flushRichChange = useCallback((): string | undefined => {
      const value = pendingValueRef.current
      pendingValueRef.current = undefined
      if (pendingTimerRef.current !== undefined) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = undefined
      }
      return value ? emitRichChange(value) : undefined
    }, [emitRichChange])
    const queueRichChange = useCallback(
      (value: Value) => {
        if (!hydrationCompleteRef.current) return
        onDirtyChangeRef.current?.()
        pendingValueRef.current = value
        if (pendingTimerRef.current !== undefined) return
        // Let the native input and paint complete before the O(document) Markdown conversion.
        pendingTimerRef.current = setTimeout(() => {
          pendingTimerRef.current = undefined
          flushRichChange()
        }, 0)
      },
      [flushRichChange]
    )
    useImperativeHandle(ref, () => ({ flush: flushRichChange }), [flushRichChange])
    useEffect(
      () => () => {
        clearTimeout(pendingTimerRef.current)
      },
      []
    )

    if (initial.mode !== 'rich') {
      return (
        <div
          className="flex size-full min-h-0 items-center justify-center bg-bg-000 p-6"
          data-testid="markdown-editor-surface"
        >
          <div role="alert" className="text-sm text-destructive">
            <RefreshCw aria-hidden="true" className="mr-2 inline-block size-3.5" />
            {t('Markdown could not be converted safely.')}
          </div>
        </div>
      )
    }

    return (
      <div
        className={cn(
          'relative size-full min-h-0 overflow-y-auto bg-bg-000',
          disabled && 'opacity-70'
        )}
        data-testid="markdown-editor-surface"
      >
        <MarkdownEditorCanvas
          replacement={replacement}
          editor={editor}
          disabled={disabled}
          onChange={queueRichChange}
          onFlush={flushRichChange}
          onSendSelection={onSendSelection ? stableOnSendSelection : undefined}
          onSubmitRequest={onSubmitRequest ? stableOnSubmitRequest : undefined}
        />
      </div>
    )
  }
)
MarkdownEditorSurface.displayName = 'MarkdownEditorSurface'
