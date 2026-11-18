import { ArrowDown, ArrowUp, ChevronRight, Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { memo, useMemo, useRef, useState } from 'react'
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
  moveMarkdownBlockTo,
  turnMarkdownBlockInto,
  type DropdownDefinition,
  type MarkdownInsertKind
} from './markdown-blocks'

const drags = new WeakMap<object, TElement>()
const DRAG_TYPE = 'application/x-openscience-markdown-block'

const BlockControls = memo(({ element }: { element: TElement }): React.JSX.Element => {
  const { t } = useTranslation()
  const editor = useEditorRef()
  const inserted = useRef(false)
  const insertedPath = useRef<number[] | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const [date, setDate] = useState('')
  const choices = useMemo(
    () =>
      [
        ['h1', t('Heading 1')],
        ['h2', t('Heading 2')],
        ['h3', t('Heading 3')],
        ['bullet', t('Bulleted list')],
        ['numbered', t('Numbered list')],
        ['checklist', t('Checklist')],
        ['table', t('Table')],
        ['image', t('Image')],
        ['code', t('Code block')],
        ['quote', t('Block quote')],
        ['divider', t('Divider')],
        ['dropdown', t('Dropdown')]
      ] as const,
    [t]
  )
  return (
    <div
      contentEditable={false}
      className={cn(
        'absolute -left-14 top-0.5 z-10 transition-opacity',
        menuOpen || dateOpen
          ? 'opacity-100'
          : 'opacity-0 group-hover/block:opacity-100 group-focus-within/block:opacity-100'
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
                  className="focus-visible:outline-none! focus-visible:ring-0! focus-visible:shadow-none! data-[state=open]:bg-muted"
                >
                  <Plus aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('Insert block')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            className="max-h-80 overflow-y-auto"
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
                if (path) editor.tf.select({ path: [...path, 0], offset: 0 })
              }
            }}
          >
            {choices.map(([kind, label]) => (
              <DropdownMenuItem
                key={kind}
                onSelect={() => {
                  const currentPath = editor.api.findPath(element)
                  if (!currentPath) return
                  insertedPath.current = insertMarkdownBlock(editor, currentPath, kind)
                  inserted.current = true
                }}
              >
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onSelect={() => {
                setDate('')
                setDateOpen(true)
              }}
            >
              {t('Date')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
                  aria-label={t('Drag block')}
                  className="focus-visible:outline-none! focus-visible:ring-0! focus-visible:shadow-none! data-[state=open]:bg-muted"
                  draggable
                  onDragStart={(event) => {
                    drags.set(editor, element)
                    event.dataTransfer.setData(DRAG_TYPE, 'block')
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => drags.delete(editor)}
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
                {choices.map(([kind, label]) => (
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
              disabled={!((editor.api.findPath(element)?.[0] ?? 0) > 0)}
              onSelect={() => {
                const path = editor.api.findPath(element)
                if (path && path[0] > 0) moveMarkdownBlockTo(editor, path, path[0] - 1)
              }}
            >
              <ArrowUp className="mr-2 size-4" aria-hidden="true" />
              {t('Move Up')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!((editor.api.findPath(element)?.[0] ?? -1) < editor.children.length - 1)}
              onSelect={() => {
                const path = editor.api.findPath(element)
                if (path && path[0] < editor.children.length - 1)
                  moveMarkdownBlockTo(editor, path, path[0] + 1)
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
  const safe = isSafeRemoteImageUrl(url)
  return (
    <div
      contentEditable={false}
      className="space-y-2 rounded border border-border bg-muted/30 p-2 text-xs"
    >
      <Input
        aria-label={t('Image URL')}
        value={url}
        disabled={readOnly}
        onChange={(event) => {
          setLoadedUrl(undefined)
          editor.tf.setNodes({ url: event.target.value }, { at: path })
        }}
      />
      <Input
        aria-label={t('Image alt text')}
        value={alt}
        disabled={readOnly}
        onChange={(event) =>
          editor.tf.setNodes({ caption: [{ text: event.target.value }] }, { at: path })
        }
      />
      {safe && loadedUrl === url ? (
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
  useSelectionVersion()
  const selection = editor.selection
  const caretInElement = Boolean(
    path.length > 0 &&
    selection &&
    RangeApi.isCollapsed(selection) &&
    path.every((segment, index) => selection.anchor.path[index] === segment)
  )
  const root = path.length === 1
  const type = element.type
  const placeholderKind =
    'placeholderKind' in element && typeof element.placeholderKind === 'string'
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
    caretInElement && !NodeApi.string(element)
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
  const rendered = (
    <PlateElement
      {...props}
      as={tag}
      attributes={{
        ...props.attributes,
        'data-markdown-placeholder': placeholderText,
        ...(type === 'a'
          ? {
              role: 'link',
              'aria-label': typeof element.url === 'string' ? element.url : undefined
            }
          : {})
      }}
      className={cn(
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
    </PlateElement>
  )
  if (!root) return rendered
  return (
    <div
      className="group/block relative min-h-7"
      data-markdown-block
      onDragOver={(event) => {
        if (!readOnly && drags.has(editor) && event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(event) => {
        const source = drags.get(editor)
        if (readOnly || !source || !event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        const from = editor.api.findPath(source)
        if (from) moveMarkdownBlockTo(editor, from, path[0])
        drags.delete(editor)
      }}
    >
      {rendered}
      {!readOnly ? <BlockControls element={element} /> : null}
    </div>
  )
}
