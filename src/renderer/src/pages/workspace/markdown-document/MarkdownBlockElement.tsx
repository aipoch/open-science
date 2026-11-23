import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  ChevronRight,
  CodeXml,
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Plus,
  SquareChevronDown,
  Table2,
  TextQuote,
  Trash2
} from 'lucide-react'
import { ErrorNotice } from '@/components/error-notice'
import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react'
import { NodeApi, RangeApi, type TElement } from 'platejs'
import {
  PlateElement,
  useEditorRef,
  useReadOnly,
  useSelectionVersion,
  type PlateElementProps
} from 'platejs/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  decodeDropdownDefinition,
  DROPDOWN_LANGUAGE,
  encodeDropdownDefinition,
  deleteMarkdownBlock,
  duplicateMarkdownBlock,
  insertMarkdownBlock,
  isSafeRemoteImageUrl,
  markdownBlockSiblingCount,
  moveMarkdownBlockTo,
  moveMarkdownBlockRelative,
  turnMarkdownBlockInto,
  type DropdownDefinition,
  type MarkdownInsertKind
} from './markdown-blocks'

const drags = new WeakMap<object, { element: TElement; clearDropTarget?: () => void }>()
const DRAG_TYPE = 'application/x-openscience-markdown-block'

const BlockControls = memo(({ element }: { element: TElement }): React.JSX.Element => {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const inserted = useRef(false)
  const insertedPath = useRef<number[] | undefined>(undefined)
  const dragged = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const [date, setDate] = useState('')
  const path = editor.api.findPath(element) ?? []
  const siblingIndex = path.at(-1) ?? -1
  const siblingCount = markdownBlockSiblingCount(editor, path)
  const choiceGroups = useMemo(
    () =>
      [
        [
          ['h1', t('Heading 1'), Heading1],
          ['h2', t('Heading 2'), Heading2],
          ['h3', t('Heading 3'), Heading3]
        ],
        [
          ['bullet', t('Bulleted list'), List],
          ['numbered', t('Numbered list'), ListOrdered],
          ['checklist', t('Checklist'), ListTodo]
        ],
        [
          ['table', t('Table'), Table2],
          ['image', t('Image'), ImageIcon],
          ['code', t('Code block'), CodeXml],
          ['quote', t('Block quote'), TextQuote],
          ['divider', t('Divider'), Minus]
        ],
        [
          ['date', t('Date'), CalendarDays],
          ['dropdown', t('Dropdown'), SquareChevronDown]
        ]
      ] as const,
    [t]
  )
  return (
    <div
      contentEditable={false}
      className={cn(
        'markdown-block-controls absolute top-0.5 z-10 transition-opacity',
        element.type === 'li' ? '-left-20' : '-left-12',
        menuOpen || actionsOpen || dateOpen || dragging ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div className="flex">
        <DropdownMenu onOpenChange={setMenuOpen}>
          <Tooltip>
            <TooltipTrigger
              asChild
              onFocus={(event) => {
                if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('Insert block')}
                  className="size-5 cursor-pointer focus-visible:outline-none! focus-visible:ring-0! focus-visible:shadow-none! data-[state=open]:bg-muted"
                >
                  <Plus aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('Insert block')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            className="w-56"
            onCloseAutoFocus={(event) => {
              if (dateOpen) {
                event.preventDefault()
                return
              }
              if (inserted.current) {
                event.preventDefault()
                inserted.current = false
                editor.tf.focus()
                const path = insertedPath.current
                insertedPath.current = undefined
                const start = path && editor.api.start(path)
                if (start) editor.tf.select(start)
              }
            }}
          >
            {choiceGroups.map((group, index) => (
              <Fragment key={group[0][0]}>
                {index > 0 ? <DropdownMenuSeparator className="mx-2 my-1.5" /> : null}
                <DropdownMenuGroup>
                  {group.map(([kind, label, Icon]) => (
                    <DropdownMenuItem
                      key={kind}
                      className="min-h-9 gap-3 px-2.5"
                      onSelect={() => {
                        if (kind === 'date') {
                          setDate('')
                          setDateOpen(true)
                          return
                        }
                        const currentPath = editor.api.findPath(element)
                        if (!currentPath) return
                        insertedPath.current = insertMarkdownBlock(editor, currentPath, kind)
                        inserted.current = true
                      }}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span>{label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <Tooltip>
            <TooltipTrigger
              asChild
              onFocus={(event) => {
                if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('Drag block')}
                  className="size-5 cursor-grab active:cursor-grabbing focus-visible:outline-none! focus-visible:ring-0! focus-visible:shadow-none! data-[state=open]:bg-muted"
                  draggable
                  onPointerDownCapture={(event) => {
                    // Keep Radix from opening on press without cancelling native HTML dragging.
                    if (event.button === 0 && !event.ctrlKey) {
                      dragged.current = false
                      event.stopPropagation()
                    }
                  }}
                  onClick={(event) => {
                    if (dragged.current && event.detail > 0) {
                      dragged.current = false
                      return
                    }
                    setActionsOpen(true)
                  }}
                  onDragStart={(event) => {
                    // This is a whole-block move, not Slate's selected-text drag operation.
                    event.stopPropagation()
                    dragged.current = true
                    setDragging(true)
                    drags.set(editor, { element })
                    event.dataTransfer.setData(DRAG_TYPE, 'block')
                    event.dataTransfer.effectAllowed = 'move'
                    const block = event.currentTarget.closest<HTMLElement>('[data-markdown-block]')
                    if (block) event.dataTransfer.setDragImage(block, 0, 0)
                  }}
                  onDragEnd={(event) => {
                    event.stopPropagation()
                    drags.get(editor)?.clearDropTarget?.()
                    drags.delete(editor)
                    setDragging(false)
                  }}
                >
                  <GripVertical aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('Drag block')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t('Turn Into')}
                <ChevronRight className="ml-auto size-4" aria-hidden="true" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {choiceGroups
                  .flat()
                  .filter(([kind]) => kind !== 'date')
                  .map(([kind, label]) => (
                    <DropdownMenuItem
                      key={kind}
                      onSelect={() => {
                        const path = editor.api.findPath(element)
                        if (path) turnMarkdownBlockInto(editor, path, kind)
                      }}
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={siblingIndex <= 0}
              onSelect={() => {
                const path = editor.api.findPath(element)
                if (path) moveMarkdownBlockTo(editor, path, path[path.length - 1] - 1)
              }}
            >
              <ArrowUp className="mr-2 size-4" aria-hidden="true" />
              {t('Move Up')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={siblingIndex < 0 || siblingIndex >= siblingCount - 1}
              onSelect={() => {
                const path = editor.api.findPath(element)
                if (path) moveMarkdownBlockTo(editor, path, path[path.length - 1] + 1)
              }}
            >
              <ArrowDown className="mr-2 size-4" aria-hidden="true" />
              {t('Move Down')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                const path = editor.api.findPath(element)
                if (path) duplicateMarkdownBlock(editor, path)
              }}
            >
              <Copy className="mr-2 size-4" aria-hidden="true" />
              {t('Duplicate')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                const path = editor.api.findPath(element)
                if (path) deleteMarkdownBlock(editor, path)
              }}
            >
              <Trash2 className="mr-2 size-4" aria-hidden="true" />
              {t('Delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Popover open={dateOpen} onOpenChange={setDateOpen}>
        <PopoverTrigger asChild>
          <span />
        </PopoverTrigger>
        <PopoverContent>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!date) return
              insertMarkdownBlock(editor, editor.api.findPath(element), 'date', { date })
              setDateOpen(false)
              editor.tf.focus()
            }}
          >
            <Input
              type="date"
              aria-label={t('Date')}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
            <Button type="submit" disabled={!date}>
              {t('Add')}
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  )
})
BlockControls.displayName = 'BlockControls'

const ImageEditor = ({
  element,
  path
}: {
  element: TElement
  path: number[]
}): React.JSX.Element => {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const readOnly = useReadOnly()
  const [loadedUrl, setLoadedUrl] = useState<string>()
  const url = typeof element.url === 'string' ? element.url : ''
  const alt = Array.isArray(element.caption)
    ? element.caption
        .map((leaf) =>
          leaf && typeof leaf === 'object' && 'text' in leaf && typeof leaf.text === 'string'
            ? leaf.text
            : ''
        )
        .join('')
    : ''
  const fileInput = useRef<HTMLInputElement>(null)
  const [draftUrl, setDraftUrl] = useState('')
  const [urlDraft, setUrlDraft] = useState(url)
  const [error, setError] = useState('')
  const embedded = /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(url)
  if (!url)
    return (
      <div
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
      >
        <div className="flex flex-wrap items-center gap-2">
          <ImageIcon aria-hidden="true" className="size-5 shrink-0" />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={readOnly}
            onClick={() => fileInput.current?.click()}
          >
            {t('Upload image')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              const invalid = t('Choose a PNG, JPEG, GIF or WebP image up to 1 MiB.')
              if (
                !/^image\/(png|jpeg|gif|webp)$/.test(file.type) ||
                file.size > 1024 * 1024 ||
                !file.size
              ) {
                setError(invalid)
                return
              }
              const reader = new FileReader()
              reader.onload = () => {
                const at = editor.api.findPath(element)
                if (at && typeof reader.result === 'string')
                  editor.tf.setNodes({ url: reader.result, caption: [{ text: '' }] }, { at })
              }
              reader.onerror = () => setError(invalid)
              reader.readAsDataURL(file)
            }}
          />
          <span>{t('or')}</span>
          <Input
            aria-label={t('Image URL')}
            placeholder={t('Paste an image URL and press Enter')}
            disabled={readOnly}
            value={draftUrl}
            className="h-8 min-w-32 flex-1"
            onChange={(event) => {
              setDraftUrl(event.target.value)
              setError('')
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onPaste={(event) => {
              event.stopPropagation()
              const pasted = event.clipboardData.getData('text/plain').trim()
              if (!pasted) return
              event.preventDefault()
              if (!isSafeRemoteImageUrl(pasted)) {
                setError(t('Enter a safe http(s) URL'))
                return
              }
              setDraftUrl(pasted)
              setLoadedUrl(pasted)
              const at = editor.api.findPath(element)
              if (at) editor.tf.setNodes({ url: pasted }, { at })
              setError('')
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              const next = draftUrl.trim()
              if (!isSafeRemoteImageUrl(next)) {
                setError(t('Enter a safe http(s) URL'))
                return
              }
              setUrlDraft(next)
              setLoadedUrl(next)
              editor.tf.setNodes({ url: next }, { at: path })
            }}
          />
        </div>
        {error && <ErrorNotice inline role="alert" title={error} />}
      </div>
    )
  const safe = isSafeRemoteImageUrl(url)
  if (embedded || safe)
    return (
      <div contentEditable={false} className="pointer-events-none">
        <img
          src={url}
          alt={alt}
          referrerPolicy="no-referrer"
          className="max-h-64 max-w-full rounded object-contain"
        />
      </div>
    )
  return (
    <div
      contentEditable={false}
      className="space-y-2 rounded border border-border bg-muted/30 p-2 text-xs"
    >
      {!embedded && (
        <Input
          aria-label={t('Image URL')}
          value={urlDraft}
          disabled={readOnly}
          onChange={(event) => {
            setLoadedUrl(undefined)
            setUrlDraft(event.target.value)
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onPaste={(event) => {
            event.stopPropagation()
            const pasted = event.clipboardData.getData('text/plain').trim()
            if (!pasted) return
            event.preventDefault()
            setLoadedUrl(undefined)
            setUrlDraft(pasted)
            if (isSafeRemoteImageUrl(pasted)) {
              setLoadedUrl(pasted)
              editor.tf.setNodes({ url: pasted }, { at: path })
            }
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            const next = urlDraft.trim()
            if (!isSafeRemoteImageUrl(next)) return
            setLoadedUrl(next)
            editor.tf.setNodes({ url: next }, { at: path })
          }}
        />
      )}
      <Input
        aria-label={t('Image alt text')}
        value={alt}
        disabled={readOnly}
        onChange={(event) =>
          editor.tf.setNodes({ caption: [{ text: event.target.value }] }, { at: path })
        }
      />
      {embedded || (safe && loadedUrl === url) ? (
        <img
          src={url}
          alt={alt}
          referrerPolicy="no-referrer"
          className="max-h-64 max-w-full rounded object-contain"
        />
      ) : (
        <>
          <p className="text-muted-foreground">
            {safe ? t('Remote image (not loaded)') : t('Enter a safe http(s) URL')}
          </p>
          {safe ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setLoadedUrl(url)}>
              {t('Load image')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}

const DropdownControl = ({
  element,
  path,
  definition
}: {
  element: TElement
  path: number[]
  definition: DropdownDefinition
}): React.JSX.Element => {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const update = (options: readonly string[], selected: string): void => {
    const text = encodeDropdownDefinition({ options, selected })
    editor.tf.withNewBatch(() =>
      editor.tf.withoutNormalizing(() => {
        for (let index = element.children.length - 1; index >= 0; index--)
          editor.tf.removeNodes({ at: [...path, index] })
        editor.tf.insertNodes({ type: 'code_line', children: [{ text }] }, { at: [...path, 0] })
      })
    )
  }
  return (
    <div
      contentEditable={false}
      className="flex flex-wrap gap-2 rounded border border-border bg-muted/30 p-2"
    >
      <select
        aria-label={t('Dropdown value')}
        disabled={readOnly}
        className="rounded border border-input bg-background px-2 text-sm"
        value={definition.selected}
        onChange={(event) => update(definition.options, event.target.value)}
      >
        {definition.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setDraft(definition.options.join('\n'))
          setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="outline" disabled={readOnly}>
            {t('Edit options')}
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              const options = draft
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean)
              if (!options.length) return
              update(options, definition.selected)
              setOpen(false)
            }}
          >
            <textarea
              aria-label={t('Options (one per line)')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-24 w-full rounded border border-input bg-background p-2"
            />
            <Button type="submit" size="sm" disabled={!draft.trim()}>
              {t('Apply')}
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export const MarkdownBlockElement = (props: PlateElementProps): React.JSX.Element => {
  const { element, children } = props
  const editor = useEditorRef()
  const readOnly = useReadOnly()
  const { t } = useTranslation()
  const path = editor.api.findPath(element) ?? []
  const [dropPosition, setDropPosition] = useState<'before' | 'after'>()
  const clearDropTarget = useCallback(() => setDropPosition(undefined), [setDropPosition])
  useSelectionVersion()
  const selection = editor.selection
  const caretInElement = Boolean(
    path.length > 0 &&
    selection &&
    RangeApi.isCollapsed(selection) &&
    path.every((segment, index) => selection.anchor.path[index] === segment)
  )
  const type = element.type
  const block = type === 'li' || (path.length === 1 && type !== 'ul' && type !== 'ol')
  const listItem = type === 'lic' ? editor.api.node<TElement>(path.slice(0, -1))?.[0] : undefined
  // List placeholders belong to the text block, not ul/ol or li: its origin is
  // the caret position, already inset from the marker at every nesting depth.
  const placeholderKind: MarkdownInsertKind | undefined =
    listItem?.type === 'li'
      ? typeof listItem.checked === 'boolean'
        ? 'checklist'
        : editor.api.node(path.slice(0, -2))?.[0].type === 'ol'
          ? 'numbered'
          : 'bullet'
      : 'placeholderKind' in element && typeof element.placeholderKind === 'string'
        ? (element.placeholderKind as MarkdownInsertKind)
        : undefined
  const placeholderLabels: Partial<Record<MarkdownInsertKind, string>> = {
    h1: t('Heading 1'),
    h2: t('Heading 2'),
    h3: t('Heading 3'),
    bullet: t('Bulleted list'),
    numbered: t('Numbered list'),
    checklist: t('Checklist'),
    table: t('Table'),
    image: t('Image'),
    code: t('Code block'),
    quote: t('Block quote'),
    divider: t('Divider'),
    date: t('Date'),
    dropdown: t('Dropdown')
  }
  const placeholderText =
    caretInElement && !['ul', 'ol', 'li', 'img', 'code_block'].includes(type) && !NodeApi.string(element)
      ? placeholderKind
        ? placeholderLabels[placeholderKind]
        : type === 'p'
          ? t('Type / for blocks, @ to mention')
          : undefined
      : undefined
  const dropdown =
    type === 'code_block' && element.lang === DROPDOWN_LANGUAGE
      ? decodeDropdownDefinition(NodeApi.string(element))
      : undefined
  let content: React.ReactNode = children
  let tag: keyof HTMLElementTagNameMap = 'p'
  if (/^h[1-6]$/u.test(type)) tag = type as keyof HTMLElementTagNameMap
  else if (['blockquote', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th'].includes(type))
    tag = type as keyof HTMLElementTagNameMap
  else if (type === 'code_block') tag = 'pre'
  else if (type === 'code_line') tag = 'code'
  else if (type === 'a') tag = 'span'
  else if (type === 'lic') tag = 'div'
  if (type === 'table') content = <tbody>{children}</tbody>
  if (typeof element.checked === 'boolean')
    content = (
      <>
        <input
          type="checkbox"
          className="absolute -left-6 top-[0.5lh] size-3.5 -translate-y-1/2 cursor-pointer accent-primary disabled:cursor-default"
          contentEditable={false}
          checked={element.checked}
          disabled={readOnly}
          aria-label={element.checked ? t('Completed task') : t('Incomplete task')}
          onChange={() => editor.tf.setNodes({ checked: !element.checked }, { at: path })}
        />
        {children}
      </>
    )
  if (type === 'img' || type === 'hr' || dropdown) {
    tag = 'div'
    content = (
      <>
        {type === 'img' ? (
          <ImageEditor element={element} path={path} />
        ) : dropdown ? (
          <DropdownControl element={element} path={path} definition={dropdown} />
        ) : (
          <hr contentEditable={false} className="mt-4 border-border/60" />
        )}
        <span className={dropdown ? 'hidden' : undefined}>{children}</span>
      </>
    )
  }
  const previousBlock =
    path.length > 0 && (path.at(-1) ?? 0) > 0
      ? editor.api.node<TElement>([...path.slice(0, -1), (path.at(-1) ?? 0) - 1])?.[0]
      : undefined
  const blockClassName = cn(
    'relative min-h-7 [&:hover:not(:has([data-markdown-block]:hover))>.markdown-block-controls]:opacity-100 [&:focus-within:not(:has([data-markdown-block]:focus-within))>.markdown-block-controls]:opacity-100',
    type === 'img' && previousBlock?.type === 'img' && 'pt-4',
    dropPosition &&
      'after:pointer-events-none after:absolute after:inset-x-0 after:z-20 after:h-0.5 after:rounded-full after:bg-primary',
    dropPosition === 'before' && 'after:top-0',
    dropPosition === 'after' && 'after:bottom-0'
  )
  const blockAttributes = {
    'data-markdown-block': true,
    'data-drop-position': dropPosition,
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      const drag = drags.get(editor)
      if (readOnly || !drag || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      if (drag.element === element) {
        drag.clearDropTarget?.()
        return
      }
      if (drag.clearDropTarget !== clearDropTarget) {
        drag.clearDropTarget?.()
        drag.clearDropTarget = clearDropTarget
      }
      const bounds = event.currentTarget.getBoundingClientRect()
      setDropPosition(event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after')
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        clearDropTarget()
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const drag = drags.get(editor)
      if (readOnly || !drag || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      drag.clearDropTarget?.()
      drags.delete(editor)
      const from = editor.api.findPath(drag.element)
      const target = editor.api.findPath(element)
      if (!from || !target) return
      const bounds = event.currentTarget.getBoundingClientRect()
      moveMarkdownBlockRelative(
        editor,
        from,
        target,
        event.clientY >= bounds.top + bounds.height / 2
      )
    }
  }
  const rendered = (
    <PlateElement
      {...props}
      as={tag}
      attributes={{
        ...props.attributes,
        ...(type === 'li' ? blockAttributes : {}),
        ...(type === 'ol' && typeof element.start === 'number' ? { start: element.start } : {}),
        'data-markdown-placeholder': placeholderText,
        ...(type === 'a'
          ? {
              role: 'link',
              'aria-label': typeof element.url === 'string' ? element.url : undefined
            }
          : {})
      }}
      className={cn(
        type === 'li' && blockClassName,
        type === 'li' && typeof element.checked === 'boolean' && 'list-none',
        placeholderText &&
          'relative before:absolute before:left-0 before:top-0 before:pointer-events-none before:whitespace-nowrap before:text-muted-foreground before:content-[attr(data-markdown-placeholder)]',
        type === 'a' && 'text-primary underline decoration-dotted underline-offset-2',
        type === 'blockquote' && 'my-2 border-l-2 border-border pl-4',
        type === 'code_block' &&
          !dropdown &&
          'my-2 overflow-x-auto rounded bg-muted p-3 font-mono text-sm',
        type === 'table' &&
          'my-2 w-full border-collapse [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2'
      )}
    >
      {content}
      {type === 'li' && !readOnly ? <BlockControls element={element} /> : null}
    </PlateElement>
  )
  if (!block || type === 'li') return rendered
  return (
    <div className={blockClassName} {...blockAttributes}>
      {rendered}
      {!readOnly ? <BlockControls element={element} /> : null}
    </div>
  )
}
