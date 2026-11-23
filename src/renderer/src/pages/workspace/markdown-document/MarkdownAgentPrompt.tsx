import { ArrowUp, Pencil, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RangeApi, type TRange } from 'platejs'
import { useEditorRef } from 'platejs/react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ErrorNotice } from '@/components/error-notice'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ANNOTATION_LIMITS } from '../../../../../shared/annotations'
import type { MarkdownDocumentSelection } from './markdown-selection'

export type MarkdownAgentRequest = {
  instruction: string
  selectionMarkdown?: string
  selectionToken?: string
  selection?: MarkdownDocumentSelection
}

export const MarkdownAgentPrompt = ({
  onSubmitRequest,
  disabled = false
}: {
  onSubmitRequest?: (request: MarkdownAgentRequest, range: TRange | null) => Promise<boolean>
  disabled?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const [context, setContext] = useState<{
    range: TRange | null
    value: typeof editor.children
    quote?: string
  }>()
  const pointerContext = useRef<typeof context>(undefined)
  const readContext = (): NonNullable<typeof context> => {
    const range = editor.selection
    const quote =
      range && !RangeApi.isCollapsed(range) ? editor.api.string(range).trim() : undefined
    return { range, value: editor.children, quote: quote || undefined }
  }
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const close = (): void => {
    if (pending) return
    const range = context?.range
    setContext(undefined)
    setFailed(false)
    if (range && context.value === editor.children) editor.tf.select(range)
    editor.tf.focus()
  }

  return (
    <div className="shrink-0 border-b border-border/50 px-3 py-1" contentEditable={false}>
      <div className="flex justify-end">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('Ask agent')}
                disabled={pending || disabled}
                onPointerDownCapture={() => {
                  pointerContext.current = readContext()
                }}
                onPointerCancel={() => {
                  pointerContext.current = undefined
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  const snapshot = event.detail > 0 ? pointerContext.current : undefined
                  pointerContext.current = undefined
                  if (context) {
                    close()
                    return
                  }
                  setContext(snapshot ?? readContext())
                  setFailed(false)
                }}
              >
                <Pencil aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Ask agent')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {context ? (
        <form
          data-testid="markdown-agent-prompt"
          className="my-2 rounded-lg border border-border bg-muted/30 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
          onSubmit={async (event) => {
            event.preventDefault()
            if (pending || disabled || !instruction.trim() || !onSubmitRequest) return
            setPending(true)
            setFailed(false)
            try {
              if (context.range && context.value !== editor.children) {
                setFailed(true)
                return
              }
              const accepted = await onSubmitRequest(
                {
                  instruction: instruction.trim(),
                  ...(context.quote ? { selection: { quote: context.quote } } : {})
                },
                context.range
              )
              if (accepted) {
                setInstruction('')
                setContext(undefined)
              } else setFailed(true)
            } catch {
              setFailed(true)
            } finally {
              setPending(false)
            }
          }}
        >
          <div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
            <div className="min-w-0 flex-1">
              {context.quote ? (
                <blockquote className="max-h-24 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-2">
                  {context.quote}
                </blockquote>
              ) : (
                t('Ask about the current document')
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('Close')}
              disabled={pending}
              onClick={close}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <Textarea
            autoFocus
            aria-label={t('Tell the agent what to write or edit')}
            placeholder={t('Tell the agent what to write or edit')}
            value={instruction}
            maxLength={ANNOTATION_LIMITS.note}
            disabled={pending || disabled}
            onChange={(event) => setInstruction(event.target.value)}
          />
          {!onSubmitRequest ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Open a conversation to ask the agent about this document.')}
            </p>
          ) : null}
          {failed ? (
            <ErrorNotice
              inline
              role="alert"
              title={t(
                'Could not send the request. Check that the conversation is available and try again.'
              )}
            />
          ) : null}
          <div className="mt-2 flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={pending || disabled || !instruction.trim() || !onSubmitRequest}
            >
              <ArrowUp aria-hidden="true" />
              {pending ? t('Sending…') : t('Send to conversation')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
