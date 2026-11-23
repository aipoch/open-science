import {
  Bold,
  Code2,
  Copy,
  Italic,
  Link as LinkIcon,
  MessageSquare,
  Send,
  Strikethrough
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { serializeMarkdownDocument } from './markdown-codec'
import { ElementApi, RangeApi, type TRange, type Value } from 'platejs'
import { useEditorRef, useEditorSelector } from 'platejs/react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ANNOTATION_LIMITS } from '../../../../../shared/annotations'
import type { MarkdownDocumentSelection } from './markdown-selection'
import { isSafeUrl } from './markdown-selection-toolbar-utils'

export type MarkdownSelectionToolbarProps = {
  onSendSelection?: (selection: MarkdownDocumentSelection, note?: string) => Promise<boolean>
}

const Action = ({
  label,
  id,
  children,
  onClick,
  disabled
}: {
  label: string
  id: string
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger
      asChild
      onFocus={(event) => {
        if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        data-testid={id}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
)

export const MarkdownSelectionToolbar = ({
  onSendSelection
}: MarkdownSelectionToolbarProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const selection = useEditorSelector((current) => current.selection, [])
  const toolbarRef = useRef<HTMLDivElement>(null)
  const savedRange = useRef<TRange | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number; owner: HTMLElement }>()
  const [popup, setPopup] = useState<'link' | 'comment'>()
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [failure, setFailure] = useState<{ range: TRange; message: string }>()
  const error =
    failure && selection && RangeApi.equals(failure.range, selection) ? failure.message : undefined
  const setError = (message?: string, range = savedRange.current): void => {
    setFailure(message && range ? { range, message } : undefined)
  }
  useEffect(() => {
    if (failure && selection && !RangeApi.equals(failure.range, selection)) setFailure(undefined)
  }, [selection, failure])
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let frame = 0
    const update = (): void => {
      const range = editor.selection
      if (range && !RangeApi.isCollapsed(range)) savedRange.current = range
      const active = document.activeElement
      const interacting =
        active instanceof Element &&
        !!active.closest(
          '[data-testid="markdown-floating-toolbar"], [data-markdown-selection-popover]'
        )
      if ((!range || RangeApi.isCollapsed(range)) && !popup && !interacting) {
        setPosition(undefined)
        return
      }
      if (!editor.api.isFocused() && !interacting && !popup) {
        setPosition(undefined)
        return
      }
      const current = savedRange.current
      if (!current) {
        setPosition(undefined)
        return
      }
      try {
        const node = editor.api.toDOMNode(editor)
        if (!node) return
        const owner =
          node.closest<HTMLElement>('[data-testid="preview-file-root"]') ??
          node.closest<HTMLElement>('[data-testid="markdown-editor-surface"]')
        if (!owner) return
        const scroll = node.closest<HTMLElement>('[data-testid="markdown-editor-surface"]') ?? owner
        const bounds = scroll.getBoundingClientRect()
        const top = Math.max(0, bounds.top)
        const bottom = Math.min(window.innerHeight, bounds.bottom)
        const left = Math.max(0, bounds.left)
        const right = Math.min(window.innerWidth, bounds.right)
        const domRange = editor.api.toDOMRange(current)
        if (!domRange) return
        const rect = Array.from(domRange.getClientRects()).find(
          (item) => item.height && item.bottom > top && item.top < bottom
        )
        if (!rect) {
          setPosition(undefined)
          return
        }
        const width = toolbarRef.current?.offsetWidth ?? 264
        const height = toolbarRef.current?.offsetHeight ?? 38
        const x = Math.max(
          left + 8,
          Math.min(right - width - 8, rect.left + (rect.width - width) / 2)
        )
        const y =
          rect.top - height - 8 >= top
            ? rect.top - height - 8
            : Math.min(bottom - height - 8, rect.bottom + 8)
        const ownerRect = owner.getBoundingClientRect()
        const next = {
          left: x - ownerRect.left + owner.scrollLeft,
          top: y - ownerRect.top + owner.scrollTop,
          owner
        }
        setPosition((previous) =>
          previous?.owner === owner && previous.left === next.left && previous.top === next.top
            ? previous
            : next
        )
      } catch {
        setPosition(undefined)
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    schedule()
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('focusin', schedule)
    document.addEventListener('focusout', schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('focusin', schedule)
      document.removeEventListener('focusout', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [editor, selection, popup, position?.owner])

  const restore = (): boolean => {
    if (!savedRange.current) return false
    editor.tf.select(savedRange.current)
    return true
  }
  const mark = (key: string): void => {
    if (!restore()) return
    editor.tf.toggleMark(key)
    editor.tf.focus()
  }
  const send = async (comment = false): Promise<void> => {
    if (!onSendSelection || !savedRange.current || pending) return
    const range = savedRange.current
    const quote = editor.api.string(range)
    setPending(true)
    setError(undefined)
    try {
      const [start, end] = RangeApi.edges(range)
      const crossBlock = start.path[0] !== end.path[0]
      let fragment: string | undefined
      try {
        fragment = serializeMarkdownDocument(editor.api.fragment(range) as Value).replace(/\n$/, '')
      } catch {
        // Some custom nodes have no Markdown representation; selected text is still usable.
      }
      const text = quote.trim() ? quote : fragment
      if (!text?.trim()) {
        setError(t('Selection action failed'), range)
        return
      }
      const accepted = await onSendSelection(
        { quote: text, fragment, crossBlock },
        comment ? note.trim() : undefined
      )
      if (accepted) {
        // Finish this selection without focusing the editor or disturbing a newer selection.
        if (editor.selection === range) editor.tf.collapse({ edge: 'end' })
        setPopup(undefined)
        setNote('')
      } else setError(t(comment ? 'Comment failed' : 'Selection action failed'), range)
    } catch {
      setError(t(comment ? 'Comment failed' : 'Selection action failed'), range)
    } finally {
      setPending(false)
    }
  }
  const copy = async (): Promise<void> => {
    if (!savedRange.current) return
    try {
      await navigator.clipboard.writeText(editor.api.string(savedRange.current))
      setError(undefined)
    } catch {
      setError(t('Copy failed'))
    }
  }
  const openLink = (): void => {
    if (!restore()) return
    const [link] = editor.api.nodes({
      at: editor.selection!,
      match: (node) => ElementApi.isElement(node) && node.type === 'a'
    })
    setUrl(link && typeof link[0].url === 'string' ? link[0].url : '')
    setPopup('link')
    setError(undefined)
  }
  const applyLink = (remove = false): void => {
    if (!remove && !isSafeUrl(url)) {
      setError(t('Enter a safe URL'))
      return
    }
    if (!restore()) return
    editor.tf.withNewBatch(() =>
      editor.tf.withoutNormalizing(() => {
        editor.tf.unwrapNodes({
          match: (node) => ElementApi.isElement(node) && node.type === 'a',
          split: true
        })
        if (!remove)
          editor.tf.wrapNodes(
            { type: 'a', url: url.trim(), children: [] },
            { at: editor.selection!, match: (node) => !ElementApi.isElement(node), split: true }
          )
      })
    )
    savedRange.current = editor.selection
    setError(undefined)
    setPopup(undefined)
    editor.tf.focus()
  }
  if (!position) return null
  return createPortal(
    <TooltipProvider>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label={t('Markdown formatting')}
        data-testid="markdown-floating-toolbar"
        className="absolute z-50 max-w-[calc(100%-1rem)] rounded-lg border border-border bg-background p-1 shadow-md"
        style={{ left: position.left, top: position.top }}
      >
        <div className="flex flex-wrap items-center gap-0.5">
          <Action
            label={t('Bold')}
            id="markdown-selection-action-bold"
            onClick={() => mark('bold')}
          >
            <Bold aria-hidden="true" />
          </Action>
          <Action
            label={t('Italic')}
            id="markdown-selection-action-italic"
            onClick={() => mark('italic')}
          >
            <Italic aria-hidden="true" />
          </Action>
          <Action
            label={t('Strikethrough')}
            id="markdown-selection-action-strikethrough"
            onClick={() => mark('strikethrough')}
          >
            <Strikethrough aria-hidden="true" />
          </Action>
          <Action
            label={t('Inline code')}
            id="markdown-selection-action-inline-code"
            onClick={() => mark('code')}
          >
            <Code2 aria-hidden="true" />
          </Action>
          <Popover
            open={popup === 'link'}
            onOpenChange={(open) => {
              if (!open) setPopup(undefined)
            }}
          >
            <PopoverAnchor asChild>
              <span>
                <Action label={t('Link')} id="markdown-selection-action-link" onClick={openLink}>
                  <LinkIcon aria-hidden="true" />
                </Action>
              </span>
            </PopoverAnchor>
            <PopoverContent
              container={position.owner}
              data-markdown-selection-popover
              data-testid="markdown-link-popover"
              className="w-72"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                if (restore()) editor.tf.focus()
              }}
            >
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  applyLink()
                }}
              >
                <Input
                  autoFocus
                  aria-label={t('Link URL')}
                  data-testid="markdown-link-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" data-testid="markdown-link-apply">
                    {t('Apply link')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid="markdown-link-remove"
                    onClick={() => applyLink(true)}
                  >
                    {t('Remove link')}
                  </Button>
                </div>
                {error ? <ErrorNotice inline role="alert" title={error} /> : null}
              </form>
            </PopoverContent>
          </Popover>
          <Popover
            open={popup === 'comment'}
            onOpenChange={(open) => {
              if (!open && !pending) setPopup(undefined)
            }}
          >
            <PopoverAnchor asChild>
              <span>
                <Action
                  label={t('Comment on selection')}
                  id="markdown-selection-action-comment"
                  disabled={!onSendSelection || pending}
                  onClick={() => {
                    setPopup('comment')
                    setError(undefined)
                  }}
                >
                  <MessageSquare aria-hidden="true" />
                </Action>
              </span>
            </PopoverAnchor>
            <PopoverContent
              container={position.owner}
              data-markdown-selection-popover
              data-testid="markdown-comment-popover"
              className="w-72"
            >
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void send(true)
                }}
              >
                <Input
                  autoFocus
                  aria-label={t('Comment note')}
                  data-testid="markdown-comment-note"
                  value={note}
                  maxLength={ANNOTATION_LIMITS.note}
                  disabled={pending}
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={pending || !note.trim()}
                  data-testid="markdown-comment-submit"
                >
                  {t('Send comment')}
                </Button>
                {error ? <ErrorNotice inline role="alert" title={error} /> : null}
              </form>
            </PopoverContent>
          </Popover>
          <Action
            label={t('Copy selection')}
            id="markdown-selection-action-copy"
            onClick={() => void copy()}
          >
            <Copy aria-hidden="true" />
          </Action>
          {onSendSelection ? (
            <Action
              label={t('Send selection to conversation')}
              id="markdown-selection-action-send"
              disabled={pending}
              onClick={() => void send()}
            >
              <Send aria-hidden="true" />
            </Action>
          ) : null}
        </div>
        {error && !popup ? (
          <div className="min-w-0" data-testid="markdown-selection-error">
            <ErrorNotice inline role="alert" title={error} />
          </div>
        ) : null}
      </div>
    </TooltipProvider>,
    position.owner
  )
}
